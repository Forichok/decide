/**
 * Feature:    nothing is delivered until the agent has it
 * Layer:      Integration (in-process servers, `decide.mjs serve` processes and real `node mcp.mjs` children
 *             over loopback HTTP and stdio)
 * Covers:
 *   - GET …/next hands out the first item not acknowledged, again and again, until POST …/ack names it
 *   - an ask turns seen only on ack, and the page hears it then; a final item goes to anyone who asks
 *   - one waiter per round: a newer one supersedes the older; a superseded MCP wait stops and says so
 *   - a cancelled MCP wait acknowledges nothing; two waits of one session never push each other out
 *   - the server dies, or hands over, during a wait: the wait survives and gets the item
 *   - a finished round's answers reach any session, and one ack is enough
 *   - a busy server during a wait is "still waiting", never a second server; an unknown round is named
 * Isolation:  every test has its own DECIDE_HOME; no test binds 47474; every process is stopped by its pid.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { readInfo } from "../lib/home.mjs";
import { PROTOCOL } from "../lib/protocol.mjs";
import { openProject } from "../lib/project.mjs";
import { roundDir } from "../lib/store/rounds.mjs";
import { startServer } from "../lib/server.mjs";
import { ack, api, ensureServer, findServer, waitNext } from "../lib/client.mjs";
import { HANDLERS, alive, collect, enginePath, envOf, exitOf, fakeServer, homeOf, notePid, ping, pluginDir, scratchDir, silentServer, spawnServer, stopServer, asAgent, asPage } from "./helpers.mjs";

delete process.env.DECIDE_PORT;
process.env.DECIDE_NOTIFY = "0";

const spec = {
  title: "Colour",
  questions: [{ id: "color", title: "Which colour?", options: [{ id: "pink", label: "Pink" }, { id: "blue", label: "Blue" }] }],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (port, route) => `http://127.0.0.1:${port}${route}`;
const get = async (port, route) => (await fetch(url(port, route))).json();
// The page's side (its Origin) and the agent's (the token of the home's daemon.json).
const post = (port, route, body) => fetch(url(port, route), { method: "POST", headers: asPage(port), body: body === undefined ? undefined : JSON.stringify(body) });
const agentPost = (port, route, body) => fetch(url(port, route), { method: "POST", headers: asAgent(port), body: body === undefined ? undefined : JSON.stringify(body) });

async function until(check, what, ms = 5_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

async function scratch(t) {
  const dir = await scratchDir(t);
  await mkdir(homeOf(dir), { recursive: true });
  return { dir, home: homeOf(dir) };
}

const roundOf = (dir) => ({ project: dir, spec, outPath: path.join(dir, "colour.answers.json"), source: "colour.questions.json", open: false, live: true });

// An in-process server of a scratch home, the client's handle on it, and one open round.
async function served(t) {
  const { dir, home } = await scratch(t);
  const started = await startServer({ home, embedded: true });
  assert.ok(started);
  t.after(() => started.stop());
  const s = await findServer(home);
  assert.equal(s.port, started.port);
  const { id } = await api(s, "/api/rounds", { method: "POST", body: roundOf(dir) });
  return { dir, home, s, id, port: started.port };
}

const view = (port, id) => get(port, `/api/rounds/${id}`);
const waiting = async (port, id) => (await get(port, "/api/state")).rounds.find((r) => r.id === id)?.waiting === true;
const eventsOf = (dir, home, id) =>
  readFileSync(path.join(roundDir(openProject(dir, home).dataDir, id), "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

// The page's event stream: every event it gets, in order.
function stream(t, port) {
  const seen = [];
  const req = request({ host: "127.0.0.1", port, path: "/api/events" }, (res) => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const name = block.match(/^event: (.+)$/m)?.[1];
        const data = block.match(/^data: (.+)$/m)?.[1];
        if (name) seen.push({ name, data: JSON.parse(data) });
      }
    });
  });
  req.on("error", () => {});
  req.end();
  t.after(() => req.destroy());
  return seen;
}

// A real `node mcp.mjs` for the scratch home, started outside any project (as Codex starts it).
// call() sends tools/call and returns { id, result } (result: a promise of the JSON-RPC answer);
// cancel(id) sends notifications/cancelled for it.
function mcp(t, dir) {
  const child = spawn(process.execPath, [path.join(pluginDir, "mcp.mjs")], { cwd: pluginDir, env: envOf(dir, { CLAUDE_PROJECT_DIR: "", DECIDE_NOTIFY: "0" }), stdio: ["pipe", "pipe", "pipe"] });
  notePid(child.pid);
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await exitOf(child);
  });
  const pending = new Map();
  const answered = new Set();
  let stderr = "";
  let buf = "";
  let next = 1;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => (stderr += c));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      answered.add(msg.id);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  const call = (name, args) => {
    const id = next++;
    const result = new Promise((resolve) => pending.set(id, resolve));
    send({ id, method: "tools/call", params: { name, arguments: args } });
    return { id, result };
  };
  const text = async (name, args) => {
    const msg = await call(name, args).result;
    return msg.result.content.map((c) => c.text).join("\n");
  };
  return {
    child,
    call,
    text,
    cancel: (id) => send({ method: "notifications/cancelled", params: { requestId: id, reason: "the user interrupted" } }),
    answered: (id) => answered.has(id),
    stderr: () => stderr,
  };
}

// ask through an MCP child: the round id and the port of the server it opened the round on.
async function askThrough(agent, dir) {
  const opened = await agent.text("ask", { project: dir, spec, open: false });
  const [, id, port] = opened.match(/Round (\S+) .+: http:\/\/127\.0\.0\.1:(\d+)\//) || [];
  assert.ok(id, opened);
  notePid(readInfo(homeOf(dir))?.pid);
  return { id, port: Number(port) };
}

test("an item not acknowledged is returned again", async (t) => {
  const { s, id, port } = await served(t);
  assert.equal((await post(port, `/api/rounds/${id}/ask`, { question: "color", text: "Why pink?" })).status, 200);
  const first = await waitNext(s, id, { waiter: "a", events: true, timeoutMs: 2_000 });
  assert.equal(first.kind, "ask");
  assert.equal(first.payload.ask.text, "Why pink?");
  assert.ok(Number.isInteger(first.seq));
  assert.deepEqual(await waitNext(s, id, { waiter: "a", events: true, timeoutMs: 2_000 }), first, "not acknowledged: handed out again");
  await ack(s, id, first.seq, "a");
  const started = Date.now();
  assert.equal(await waitNext(s, id, { waiter: "a", events: true, timeoutMs: 1_000 }), null, "acknowledged: nothing left, it waits");
  assert.ok(Date.now() - started >= 900, "it was held, not answered at once");
  await ack(s, id, first.seq, "a"); // an ack of a seq already acknowledged is a no-op that answers 200

  // The final item: handed out until acknowledged, and to anyone who asks after that.
  assert.equal((await post(port, `/api/rounds/${id}/submit`, { answers: { color: { selected: ["blue"] } } })).status, 200);
  const final = await waitNext(s, id, { waiter: "a", timeoutMs: 2_000 });
  assert.equal(final.kind, "final");
  assert.deepEqual(final.payload.answers.color.selected, ["blue"]);
  assert.deepEqual(await waitNext(s, id, { waiter: "a", timeoutMs: 2_000 }), final);
  assert.equal((await view(port, id)).delivered, false);
  await ack(s, id, final.seq, "a");
  assert.equal((await view(port, id)).delivered, true);
  assert.deepEqual(await waitNext(s, id, { waiter: "b", timeoutMs: 2_000 }), final, "a final item goes to anyone, acknowledged or not");
});

test("a question typed on the page is delivered only on ack", async (t) => {
  const { s, id, port } = await served(t);
  const page = stream(t, port);
  await until(() => page.length, "the page stream");
  assert.equal((await post(port, `/api/rounds/${id}/ask`, { question: "color", text: "Why pink?" })).status, 200);
  assert.equal((await view(port, id)).dialog[0].seen, false);
  const item = await waitNext(s, id, { waiter: "a", events: true, timeoutMs: 2_000 });
  assert.equal(item.kind, "ask");
  await sleep(200);
  assert.equal((await view(port, id)).dialog[0].seen, false, "handed out is not delivered");
  const before = page.length;
  await ack(s, id, item.seq, "a");
  assert.equal((await view(port, id)).dialog[0].seen, true, "seen once acknowledged");
  const told = await until(() => page.slice(before).find((e) => e.name === "dialog"), "a dialog event after the ack");
  assert.deepEqual([told.data.round, told.data.dialog[0].seen], [id, true]);
});

test("a newer wait supersedes the older one", async (t) => {
  const { s, id, port } = await served(t);
  const older = waitNext(s, id, { waiter: "a", events: true, timeoutMs: 20_000 });
  await until(() => waiting(port, id), "the older waiter to be held");
  const newer = waitNext(s, id, { waiter: "b", events: true, timeoutMs: 20_000 });
  assert.deepEqual(await older, { superseded: true });
  await until(() => waiting(port, id), "the newer waiter to be held");
  await post(port, `/api/rounds/${id}/ask`, { question: "color", text: "Which is ours?" });
  const item = await newer;
  assert.deepEqual([item.kind, item.payload.ask.text], ["ask", "Which is ours?"]);
});

test("the interim wait route is gone; an ack is answered on a finished round", async (t) => {
  const { id, port } = await served(t);
  assert.equal((await fetch(url(port, `/api/rounds/${id}/wait?timeout=1000`))).status, 404);
  await agentPost(port, `/api/rounds/${id}/dismiss`);
  const res = await agentPost(port, `/api/rounds/${id}/ack`, { seq: 1, waiter: "a" });
  assert.equal(res.status, 200, "an ack on a dismissed round does nothing and says ok");
});

test("an unknown round is an error that names it, never 'not running'", async (t) => {
  const { s } = await served(t);
  await assert.rejects(waitNext(s, "9-abcdef", { waiter: "a", timeoutMs: 2_000 }), (e) => {
    assert.match(e.message, /9-abcdef/);
    assert.doesNotMatch(e.message, /not running/);
    return true;
  });
});

test("a busy server during a wait is still waiting: nothing is started beside it", async (t) => {
  const { home } = await scratch(t);
  // The handle names a port that refuses (the server went), and daemon.json now names a server that does not answer.
  const silent = await silentServer(t, home, PROTOCOL);
  const gone = { port: 1, token: "x", protocol: PROTOCOL, home };
  const started = Date.now();
  const got = await waitNext(gone, "1-abcdef", { waiter: "a", timeoutMs: 2_000 });
  assert.equal(got, null, "still waiting");
  assert.ok(Date.now() - started < 15_000);
  assert.equal(readInfo(home).pid, process.pid, "nothing was started beside it");
  assert.equal(readInfo(home).port, silent.port);
});

test("a handover during a held wait: the wait survives and gets the next item", async (t) => {
  const { dir, home } = await scratch(t);
  const older = await spawnServer(t, home);
  assert.equal(older.exited, null, older.output.stderr);
  const s = await findServer(home);
  const { id } = await api(s, "/api/rounds", { method: "POST", body: roundOf(dir) });
  const held = waitNext(s, id, { waiter: "a", events: true, timeoutMs: 30_000 });
  await until(() => waiting(older.port, id), "the waiter to be held");

  // A client one protocol newer takes the home over; the waiting client speaks the new server's protocol.
  const next = path.join(pluginDir, "test", "fixtures", "server-next.mjs");
  const newer = await ensureServer({ home, engine: next, protocol: PROTOCOL + 1 });
  notePid(readInfo(home)?.pid);
  assert.equal(await exitOf(older.child), 0, "the older server handed over");
  assert.equal((await ping(newer.port)).protocol, PROTOCOL + 1);
  await until(() => waiting(newer.port, id), "the wait to come back on the newer server", 15_000);
  await post(newer.port, `/api/rounds/${id}/ask`, { question: "color", text: "Still there?" });
  const item = await held;
  assert.deepEqual([item.kind, item.payload.ask.text], ["ask", "Still there?"]);
});

test("a cancelled wait does not acknowledge", async (t) => {
  const { dir } = await scratch(t);
  const agent = mcp(t, dir);
  const { id, port } = await askThrough(agent, dir);
  const page = stream(t, port);

  const first = agent.call("wait", { project: dir, round: id, timeoutSec: 60 });
  await until(() => waiting(port, id), "the wait to be held");
  agent.cancel(first.id);
  await until(async () => !(await waiting(port, id)), "the cancelled wait to let go of the round");
  await post(port, `/api/rounds/${id}/ask`, { question: "color", text: "Why pink?" });
  await sleep(200);
  assert.equal((await view(port, id)).dialog[0].seen, false, "nobody has it");
  const heard = await agent.text("wait", { project: dir, round: id, timeoutSec: 10 });
  assert.match(heard, /Why pink\?/);
  await until(async () => (await view(port, id)).dialog[0].seen, "the ask to be seen once the result is out");
  assert.equal(agent.answered(first.id), false, "a cancelled request gets no answer");

  // Interrupted and resumed at once: the two waits of one session do not push each other out.
  const third = agent.call("wait", { project: dir, round: id, timeoutSec: 60 });
  await until(() => waiting(port, id), "the third wait to be held");
  agent.cancel(third.id);
  const fourth = agent.call("wait", { project: dir, round: id, timeoutSec: 60 });
  await sleep(300);
  const from = page.filter((e) => e.name === "state").length;
  await sleep(1_500);
  const churn = page.filter((e) => e.name === "state").length - from;
  assert.ok(churn <= 3, `${churn} state events in 1.5 s while one wait was held`);
  assert.equal(await waiting(port, id), true);
  await post(port, `/api/rounds/${id}/submit`, { answers: { color: { selected: ["blue"] } } });
  const done = (await fourth.result).result.content[0].text;
  assert.match(done, /Which colour\? → Blue/);
  assert.equal(agent.answered(third.id), false);
});

test("two waits of one session on one round: the older stops at once, they never push each other out", async (t) => {
  const { dir } = await scratch(t);
  const agent = mcp(t, dir);
  const { id, port } = await askThrough(agent, dir);
  const page = stream(t, port);
  const older = agent.call("wait", { project: dir, round: id, timeoutSec: 60 });
  await until(() => waiting(port, id), "the first wait to be held");
  const newer = agent.call("wait", { project: dir, round: id, timeoutSec: 60 });
  const said = (await older.result).result;
  assert.equal(said.isError, undefined);
  assert.match(said.content[0].text, /newer wait/i);
  await sleep(300);
  const from = page.filter((e) => e.name === "state").length;
  await sleep(1_500);
  const churn = page.filter((e) => e.name === "state").length - from;
  assert.ok(churn <= 3, `${churn} state events in 1.5 s while one wait was held`);
  assert.equal(await waiting(port, id), true);
  await post(port, `/api/rounds/${id}/submit`, { answers: { color: { selected: ["pink"] } } });
  assert.match((await newer.result).result.content[0].text, /Which colour\? → Pink/);
});

test("a wait that keeps coming back empty before its time does not spin", async (t) => {
  const { home } = await scratch(t);
  // A server of the home that lets go of every waiter at once, as one pushed out by another wait would be.
  let asked = 0;
  await fakeServer(t, home, PROTOCOL, (req, res) => {
    if (req.url.includes("/next?")) asked += 1;
    res.writeHead(204).end();
  });
  const saved = process.env.DECIDE_HOME;
  process.env.DECIDE_HOME = home;
  let text;
  try {
    text = await HANDLERS.wait({ round: "1-abcdef", timeoutSec: 5 });
  } finally {
    process.env.DECIDE_HOME = saved;
  }
  assert.match(text, /Still waiting/);
  assert.ok(asked >= 2 && asked <= 8, `${asked} waits in 5 s`);
});

test("a superseded wait stops and says another session took over; it never waits again on its own", async (t) => {
  const { dir } = await scratch(t);
  const a = mcp(t, dir);
  const b = mcp(t, dir);
  const { id, port } = await askThrough(a, dir);
  const first = a.call("wait", { project: dir, round: id, timeoutSec: 60 });
  await until(() => waiting(port, id), "A's wait to be held");
  const second = b.call("wait", { project: dir, round: id, timeoutSec: 60 });
  const said = (await first.result).result;
  assert.equal(said.isError, undefined);
  assert.match(said.content[0].text, new RegExp(`Another session took over the wait for round ${id}`));
  assert.equal(said.content[0].text.trim().split("\n").length, 1, "one line");
  await sleep(1_500);
  assert.equal(b.answered(second.id), false, "A did not come back and push B out");
  assert.equal(await waiting(port, id), true);
  await post(port, `/api/rounds/${id}/submit`, { answers: { color: { selected: ["pink"] } } });
  assert.match((await second.result).result.content[0].text, /Which colour\? → Pink/);
});

test("the server dies during wait: the call survives and returns the answers (skipped on win32: needs SIGKILL)", { skip: process.platform === "win32" }, async (t) => {
  const { dir, home } = await scratch(t);
  const agent = mcp(t, dir);
  const { id, port } = await askThrough(agent, dir);
  const first = readInfo(home);
  assert.equal(first.port, port);
  const pending = agent.call("wait", { project: dir, round: id, timeoutSec: 60 });
  await until(() => waiting(port, id), "the wait to be held");
  process.kill(first.pid, "SIGKILL");
  await until(() => !alive(first.pid), "the server to die");

  const second = await until(
    async () => {
      const info = readInfo(home);
      return info && info.pid !== first.pid && alive(info.pid) && (await ping(info.port)) && (await waiting(info.port, id)) ? info : null;
    },
    "a restarted server holding the wait",
    20_000,
  );
  notePid(second.pid);
  await post(second.port, `/api/rounds/${id}/submit`, { answers: { color: { selected: ["blue"] } } });
  const msg = await pending.result;
  assert.equal(msg.result.isError, undefined, msg.result.content[0].text);
  assert.match(msg.result.content[0].text, /Which colour\? → Blue/);
  await until(async () => (await view(second.port, id)).delivered, "the answers to be acknowledged");
});

test("a finished round returns its answers to any session", async (t) => {
  const { dir } = await scratch(t);
  const a = mcp(t, dir);
  const { id, port } = await askThrough(a, dir);
  await post(port, `/api/rounds/${id}/submit`, { answers: { color: { selected: ["pink"] } } });
  a.child.kill();
  await exitOf(a.child);
  // Another session, which never saw the round and names no project: the round is found by its id.
  const b = mcp(t, dir);
  const got = await b.text("wait", { round: id, timeoutSec: 5 });
  assert.match(got, /Which colour\? → Pink/);
  assert.match(got, /colour\.answers\.json|answers\.json/);
  await until(async () => (await view(port, id)).delivered, "the answers to be acknowledged");
});

test("two sessions collect one finished round: both get it, one ack is enough", async (t) => {
  const { dir, home } = await scratch(t);
  const a = mcp(t, dir);
  const b = mcp(t, dir);
  const { id, port } = await askThrough(a, dir);
  await post(port, `/api/rounds/${id}/submit`, { answers: { color: { selected: ["blue"] } } });
  const [one, two] = await Promise.all([a.text("wait", { project: dir, round: id, timeoutSec: 5 }), b.text("wait", { project: dir, round: id, timeoutSec: 5 })]);
  assert.match(one, /Which colour\? → Blue/);
  assert.match(two, /Which colour\? → Blue/);
  await until(async () => (await view(port, id)).delivered, "the answers to be acknowledged");
  // Both acknowledged the same item; the second ack changed nothing.
  await sleep(300);
  assert.match(await b.text("wait", { project: dir, round: id, timeoutSec: 5 }), /Which colour\? → Blue/, "and again, to anyone");
  await sleep(300);
  assert.equal(eventsOf(dir, home, id).filter((e) => e.type === "acked").length, 1);
});

// ---- fix round 1

// Runs fn with DECIDE_HOME naming home, as an MCP server of that home sees it.
async function inHome(home, fn) {
  const saved = process.env.DECIDE_HOME;
  process.env.DECIDE_HOME = home;
  try {
    return await fn();
  } finally {
    process.env.DECIDE_HOME = saved;
  }
}

const json = (res, status, data) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));

test("a server error on next reaches the agent at once; only a 503 is waited out", async (t) => {
  const { home } = await scratch(t);
  let asked = 0;
  let status = 507;
  await fakeServer(t, home, PROTOCOL, (req, res) => {
    if (req.url.includes("/next?")) asked += 1;
    json(res, status, { error: status === 507 ? "the round could not be saved: ENOSPC" : "stopping" });
  });
  const started = Date.now();
  const err = await inHome(home, () => HANDLERS.wait({ round: "1-abcdef", timeoutSec: 5 })).then(
    (text) => assert.fail(`wait answered: ${text}`),
    (e) => e,
  );
  assert.match(err.message, /the round could not be saved: ENOSPC/);
  assert.match(err.message, /The round is still open and its answers are on disk: tell the user what the server said, then call wait again./);
  assert.doesNotMatch(err.message, /Still waiting/);
  assert.ok(asked <= 2, `${asked} requests`);
  assert.ok(Date.now() - started < 3_000, "at once");

  // A server that is stopping (503) is not an answer: the wait goes on until its time is up.
  status = 503;
  asked = 0;
  const text = await inHome(home, () => HANDLERS.wait({ round: "1-abcdef", timeoutSec: 5 }));
  assert.match(text, /Still waiting/);
  assert.ok(asked >= 3, `${asked} requests`);
});

// A stand-in server whose acks take 1.5 s: the item comes until an ack of it is done, then `then` (or
// nothing, held 2 s). log: what it was asked, in order.
async function slowAcks(t, then) {
  const { dir, home } = await scratch(t);
  const item = (seq, text) => ({ seq, kind: "ask", payload: { event: "ask", round: "1-abcdef", ask: { question: "color", title: "Which colour?", text } } });
  const log = [];
  let acked = 0;
  await fakeServer(t, home, PROTOCOL, async (req, res, body) => {
    if (req.url.includes("/next?")) {
      log.push(`next acked=${acked}`);
      const it = acked < 1 ? item(1, "first question") : then && item(2, then);
      if (it) return json(res, 200, it);
      await sleep(2_000);
      return res.writeHead(204).end();
    }
    if (req.url.endsWith("/ack")) {
      const { seq } = JSON.parse(body);
      log.push(`ack ${seq} start`);
      await sleep(1_500);
      acked = Math.max(acked, seq);
      log.push(`ack ${seq} done`);
      return json(res, 200, { ok: true, acked });
    }
    res.writeHead(404).end();
  });
  return { dir, log };
}

test("a wait that follows a delivered item waits for its ack: it never gets that item again", async (t) => {
  const { dir, log } = await slowAcks(t, null);
  const agent = mcp(t, dir);
  assert.match(await agent.text("wait", { round: "1-abcdef", timeoutSec: 5 }), /first question/);
  const second = await agent.text("wait", { round: "1-abcdef", timeoutSec: 5 });
  assert.doesNotMatch(second, /first question/, "handed out twice");
  assert.match(second, /Still waiting/);
  assert.equal(log.indexOf("ack 1 done") < log.indexOf("next acked=1"), true, log.join(", "));
  assert.equal(log.filter((l) => l === "next acked=0").length, 1, log.join(", "));
});

test("a wait cancelled while an earlier ack is on its way gets no answer and acknowledges nothing", async (t) => {
  const { dir, log } = await slowAcks(t, "second question");
  const agent = mcp(t, dir);
  assert.match(await agent.text("wait", { round: "1-abcdef", timeoutSec: 5 }), /first question/);
  const second = agent.call("wait", { round: "1-abcdef", timeoutSec: 5 });
  await sleep(100);
  agent.cancel(second.id);
  // The earlier ack lands; then the cancelled call would have run and answered by now.
  await until(() => log.includes("ack 1 done"), "the earlier ack to land");
  await sleep(500);
  assert.equal(agent.answered(second.id), false, "the cancelled call was answered");
  assert.equal(log.includes("ack 2 start"), false, `the cancelled call acknowledged item 2: ${log.join(", ")}`);
  // The item it would have had comes to the next wait.
  assert.match(await agent.text("wait", { round: "1-abcdef", timeoutSec: 5 }), /second question/);
});

test("an item that comes again after a failed ack says it may have reached the agent already", async (t) => {
  const { dir, home } = await scratch(t);
  const item = { seq: 1, kind: "ask", payload: { event: "ask", round: "1-abcdef", ask: { question: "color", title: "Which colour?", text: "Why pink?" } } };
  let acks = 0;
  let acked = 0;
  await fakeServer(t, home, PROTOCOL, async (req, res, body) => {
    if (req.url.includes("/next?")) {
      if (acked < 1) return json(res, 200, item);
      await sleep(1_000);
      return res.writeHead(204).end();
    }
    if (req.url.endsWith("/ack")) {
      acks += 1;
      if (acks === 1) return json(res, 500, { error: "the round could not be saved" });
      acked = JSON.parse(body).seq;
      return json(res, 200, { ok: true, acked });
    }
    res.writeHead(404).end();
  });
  const agent = mcp(t, dir);
  const first = await agent.text("wait", { round: "1-abcdef", timeoutSec: 5 });
  assert.match(first, /Why pink\?/);
  assert.doesNotMatch(first, /may have reached you already/);
  const again = await agent.text("wait", { round: "1-abcdef", timeoutSec: 5 });
  assert.match(again, /Why pink\?/);
  const lines = again.split("\n");
  assert.equal(lines[0], "This item may have reached you already: its acknowledgement did not reach the decide server, so it came again. If you already acted on it, don't act again.", again);
  assert.match(agent.stderr(), /could not be recorded/);
  await until(() => acked === 1, "the second ack");
  assert.match(await agent.text("wait", { round: "1-abcdef", timeoutSec: 5 }), /Still waiting/);
});

test("the CLI --wait does not spin on a server that lets go of it at once", async (t) => {
  const { dir, home } = await scratch(t);
  const at = [];
  await fakeServer(t, home, PROTOCOL, (req, res) => {
    if (req.url.includes("/next?")) at.push(Date.now());
    res.writeHead(204).end();
  });
  const child = spawn(process.execPath, [enginePath, "--wait", "1-abcdef", "--project", dir], { stdio: ["ignore", "pipe", "pipe"], env: envOf(dir, { DECIDE_HOME: home }) });
  notePid(child.pid);
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await exitOf(child);
  });
  const output = collect(child);
  await until(() => at.length >= 3 || child.exitCode !== null, "three waits", 10_000);
  assert.equal(child.exitCode, null, output.stderr);
  const gaps = at.slice(1).map((t1, i) => t1 - at[i]);
  assert.ok(gaps.every((g) => g >= 900), `waits came back after  ms`);
});

test("explain on a round whose server stopped starts one and lands in the round's dialog", async (t) => {
  const { dir, home } = await scratch(t);
  const agent = mcp(t, dir);
  const { id } = await askThrough(agent, dir);
  const first = readInfo(home);
  await stopServer(home);
  await until(() => !alive(first.pid), "the server to stop");
  const said = await agent.text("explain", { project: dir, round: id, question: "color", text: "Pink is the brand colour." });
  assert.match(said, /Explanation shown under question color/);
  const info = readInfo(home);
  assert.notEqual(info.pid, first.pid);
  notePid(info.pid);
  const entry = (await view(info.port, id)).dialog.find((e) => e.qid === "color");
  assert.ok(entry, "a dialog entry for the question");
  assert.match(JSON.stringify(entry), /Pink is the brand colour\./);
});

test("push and explain name an unknown round and say to ask again", async (t) => {
  const { dir } = await scratch(t);
  const agent = mcp(t, dir);
  await askThrough(agent, dir);
  for (const [tool, args] of [
    ["explain", { project: dir, round: "9-abcdef", question: "color", text: "x" }],
    ["push", { project: dir, round: "9-abcdef", add: [] }],
  ]) {
    const msg = await agent.call(tool, args).result;
    assert.equal(msg.result.isError, true, tool);
    assert.match(msg.result.content[0].text, /Round 9-abcdef is unknown to the decide server of .+Ask again/, tool);
  }
});

// ---- R8: "None, suggest others" is a request for a listening agent, a flag for none

test("none, suggest others: a request item for a listening agent, only a flag when nobody listens", async (t) => {
  const { mkdtempSync, rmSync, realpathSync, writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  const { createStore } = await import("../lib/store/rounds.mjs");
  const { createRoots } = await import("../lib/assets.mjs");
  const { prepareSpec, formatRequest } = await import("../lib/prepare.mjs");
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "decide-req-")));
  const prev = process.env.DECIDE_HOME;
  process.env.DECIDE_HOME = path.join(dir, ".home");
  const project = openProject(dir);
  const raw = { title: "R", questions: [{ id: "c", title: "Colour?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] };
  const { spec } = await prepareSpec(raw, { specDir: dir, dataDir: project.dataDir, shots: false });
  const store = createStore({ home: process.env.DECIDE_HOME, roots: createRoots(), listenGraceMs: 0 });
  t.after(() => {
    store.close();
    if (prev === undefined) delete process.env.DECIDE_HOME;
    else process.env.DECIDE_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  const round = store.create({ project, spec, raw, outPath: path.join(dir, "r.answers.json"), live: true, mode: "questions" });
  const none = (note) => ({ answers: { c: { selected: [], flag: "none", note } } });

  // Nobody listens: the flag stays in the draft, nothing is queued.
  store.saveDraft(round, none("nope"));
  assert.equal(round.draft.answers.c.flag, "none");

  // An agent waits: a new press is handed out like an ask.
  store.saveDraft(round, { answers: { c: { selected: [] } } });
  const held = store.next(round, { waiter: "w", events: true, timeoutMs: 5000 });
  store.saveDraft(round, none("try warm colours"));
  const item = await Promise.race([held, new Promise((r) => setTimeout(() => r(null), 3000))]);
  assert.equal(item.kind, "request");
  assert.deepEqual(item.payload.request, { qid: "c", title: "Colour?", note: "try warm colours" });
  assert.match(formatRequest(item.payload), /None, suggest others.*\[c\].*warm colours/s);
  store.ack(round, item.seq, "w");
  // The same flag saved again asks nothing new.
  store.saveDraft(round, none("try warm colours"));
  const again = await Promise.race([store.next(round, { waiter: "w", events: true, timeoutMs: 5000 }), new Promise((r) => setTimeout(() => r("quiet"), 1200))]);
  assert.equal(again, "quiet");
});

test("an explain reply lists what it changed", async () => {
  const { changesOf } = await import("../ui/js/logic.js");
  assert.deepEqual(changesOf({ patch: { add: [{ id: "n", title: "New one" }], remove: ["old"] } }), [{ op: "add", title: "New one" }, { op: "remove", title: "old" }]);
  assert.deepEqual(changesOf({ changes: [{ op: "replace", title: "Q2" }, { title: "Q3" }] }), [{ op: "replace", title: "Q2" }, { op: "replace", title: "Q3" }]);
  assert.deepEqual(changesOf({ text: "only text" }), []);
});
