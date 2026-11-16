/**
 * Feature:    live dialog, journal, MCP server, screenshots
 * Layer:      Agent tooling integration (CLI, MCP stdio server, daemon over loopback HTTP)
 * Contract:   skills/decide/SKILL.md + spec.md
 * Covers:
 *   - A live round hands the user's question to the agent (exit 3), shows the reply on the page,
 *     and the final answers carry the dialog; x.questions.json answers land in x.answers.json
 *   - Questions are refused on a round nobody listens to live
 *   - Answered rounds go to the project journal; cancelled ones don't
 *   - The MCP server speaks JSON-RPC over stdio: initialize, tools/list, ask → wait → explain → wait,
 *     history, and asks for `project` when started outside one (as under Codex)
 *   - Screenshot arguments accept only http(s) pages; failed shots become lint warnings
 * Why exists: one plugin serves Claude Code and Codex; these are the paths each agent relies on.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { envOf, exitOf, pluginDir, readJson, runEngine, scratchDir, waitForReadyUrl, asPage } from "./helpers.mjs";

const spec = {
  title: "Цвет кнопки",
  questions: [
    { id: "color", title: "Какой цвет кнопки?", options: [{ id: "pink", label: "Розовый", recommended: "бренд" }, { id: "blue", label: "Синий" }] },
  ],
};
// The page's side: its own Origin.
const post = (url, route, body) => fetch(`${url}${route}`, { method: "POST", headers: asPage(Number(new URL(url).port)), body: JSON.stringify(body) });

test("live round: the user's question reaches the agent and the reply lands on the page", async (context) => {
  const dir = await scratchDir(context);
  const q = path.join(dir, "pick.questions.json");
  await writeFile(q, JSON.stringify(spec));

  const first = runEngine(context, dir, [q, "--live", "--no-open"]);
  const { url, round } = await waitForReadyUrl(first.child, first.output);
  assert.match(first.output.stdout, /pick\.answers\.json/);
  assert.equal((await post(url, `api/rounds/${round}/ask`, { question: "color", text: "Какой у нас бренд-цвет?" })).status, 200);
  assert.equal(await exitOf(first.child), 3, "an ask ends the CLI wait with exit 3");
  const event = JSON.parse(first.output.stdout.match(/DECIDE ask: (.+)/)[1]);
  assert.deepEqual([event.round, event.ask.question, event.ask.text], [round, "color", "Какой у нас бренд-цвет?"]);
  assert.match(first.output.stdout, /--reply .+ --question color/);

  const reply = runEngine(context, dir, ["--reply", round, "--question", "color", "--text", "Розовый, как логотип."]);
  assert.equal(await exitOf(reply.child), 0, reply.output.stderr);
  const view = await (await fetch(`${url}api/rounds/${round}`)).json();
  assert.equal(view.live, true);
  assert.deepEqual(
    view.dialog.map((d) => [d.qid, d.ask, d.reply.text, d.seen]),
    [["color", "Какой у нас бренд-цвет?", "Розовый, как логотип.", true]],
  );

  const again = runEngine(context, dir, ["--wait", round, "--live"]);
  await post(url, `api/rounds/${round}/submit`, { answers: { color: { selected: ["pink"] } } });
  assert.equal(await exitOf(again.child), 0, again.output.stderr);
  assert.match(again.output.stdout, /\[color\] Какой цвет кнопки\? → Розовый/);
  assert.match(again.output.stdout, /pick\.answers\.json/, "--wait knows where the answers were saved");
  const saved = await readJson(path.join(dir, "pick.answers.json"));
  assert.deepEqual(saved.dialog, [{ question: "color", ask: "Какой у нас бренд-цвет?", answer: "Розовый, как логотип." }]);

  const journal = runEngine(context, dir, ["--journal", "--query", "цвет кнопки"]);
  assert.equal(await exitOf(journal.child), 0);
  assert.match(journal.output.stdout, /Цвет кнопки/);
});

test("refuses questions on a round nobody listens to live, and keeps cancelled rounds out of the journal", async (context) => {
  const dir = await scratchDir(context);
  const q = path.join(dir, "plain.questions.json");
  await writeFile(q, JSON.stringify(spec));
  const run = runEngine(context, dir, [q, "--no-open"]);
  const { url, round } = await waitForReadyUrl(run.child, run.output);
  assert.equal((await post(url, `api/rounds/${round}/ask`, { question: "color", text: "?" })).status, 409);
  await post(url, `api/rounds/${round}/cancel`, {});
  assert.equal(await exitOf(run.child), 0);
  const journal = await (await fetch(`${url}api/journal`)).json();
  assert.deepEqual(journal.entries, []);
});

function rpcClient(child) {
  const pending = new Map();
  let buf = "";
  let next = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  return (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
}

test("MCP server: ask → wait → explain → wait → history over stdio", async (context) => {
  const dir = await scratchDir(context);
  // Started in the plugin dir with no CLAUDE_PROJECT_DIR, as Codex does.
  const child = spawn(process.execPath, [path.join(pluginDir, "mcp.mjs")], { cwd: pluginDir, env: envOf(dir, { CLAUDE_PROJECT_DIR: "" }), stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => child.kill());
  const rpc = rpcClient(child);
  const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
  const text = (result) => result.content.map((c) => c.text).join("\n");

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  const { VERSION } = await import(path.join(pluginDir, "lib/server.mjs"));
  assert.deepEqual([init.result.protocolVersion, init.result.serverInfo.name, init.result.serverInfo.version], ["2025-06-18", "decide", VERSION]);
  assert.match(init.result.instructions, /wait/);
  const tools = (await rpc("tools/list", {})).result.tools.map((t) => t.name);
  assert.deepEqual(tools, ["ask", "swipe", "wait", "push", "explain", "screenshot", "history", "supersede", "adr", "export", "import", "lint", "stop"]);
  assert.equal((await rpc("nope", {})).error.code, -32601);

  const lost = await call("history", {});
  assert.equal(lost.isError, true);
  assert.match(text(lost), /Pass project/);

  const asked = await call("ask", { project: dir, spec, open: false });
  assert.equal(asked.isError, undefined, text(asked));
  const [, round, url] = text(asked).match(/Round (\S+) .+: (http:\/\/127\.0\.0\.1:\d+\/)/);
  assert.equal((await post(url, `api/rounds/${round}/ask`, { question: "color", text: "Почему розовый?" })).status, 200);
  const heard = text(await call("wait", { project: dir, round, timeoutSec: 10 }));
  assert.match(heard, /\[color\]/);
  assert.match(heard, /Почему розовый\?/);
  assert.match(heard, /explain tool/);

  const shown = await call("explain", { project: dir, round, question: "color", text: "Так выглядит логотип.", mermaid: "flowchart LR\n A --> B" });
  assert.match(text(shown), /shown under question color/);
  const view = await (await fetch(`${url}api/rounds/${round}`)).json();
  assert.deepEqual([view.dialog[0].reply.text, view.dialog[0].reply.mermaid], ["Так выглядит логотип.", "flowchart LR\n A --> B"]);

  await post(url, `api/rounds/${round}/submit`, { answers: { color: { selected: ["blue"] } } });
  const done = text(await call("wait", { project: dir, round, timeoutSec: 10 }));
  assert.match(done, /\[color\] Какой цвет кнопки\? → Синий \(against the recommendation: Розовый\)/);
  const answersPath = done.match(/Full JSON: (.+)/)[1];
  assert.match(answersPath, /[\\/]rounds[\\/].+-цвет-кнопки\.answers\.json$/, "inline specs keep their answers in the project data dir");
  assert.equal((await readJson(answersPath)).answers.color.selected[0], "blue");
  assert.match(text(await call("history", { project: dir })), /Цвет кнопки/);
});

test("screenshots take http(s) pages only; a failed shot is a lint warning", async (context) => {
  const { shotArgs } = await import(path.join(pluginDir, "lib/shot.mjs"));
  const { prepareSpec } = await import(path.join(pluginDir, "lib/prepare.mjs"));
  const desktop = shotArgs({ url: "http://localhost:5173/", out: "/tmp/a.png", profile: "/tmp/p" });
  assert.ok(desktop.includes("--window-size=1440,900") && desktop.at(-1) === "http://localhost:5173/");
  const mobile = shotArgs({ url: "https://example.com", out: "/tmp/a.png", profile: "/tmp/p", viewport: "mobile" });
  assert.ok(mobile.includes("--window-size=390,844") && mobile.includes("--force-device-scale-factor=2"));
  assert.ok(mobile.some((a) => a.startsWith("--user-agent=")));
  for (const url of ["file:///etc/hosts", "javascript:alert(1)"]) assert.throws(() => shotArgs({ url, out: "a", profile: "p" }), /http\(s\)/);
  assert.throws(() => shotArgs({ url: "http://x", out: "a", profile: "p", viewport: "watch" }), /unknown viewport/);

  const dir = await scratchDir(context);
  const raw = { title: "t", questions: [{ id: "q", title: "?", images: [{ shot: "file:///etc/hosts" }], options: [{ id: "a", label: "A" }] }] };
  const { spec: ready, issues, errors } = await prepareSpec(raw, { specDir: dir, dataDir: dir });
  assert.equal(errors.length, 0);
  assert.ok(issues.some((i) => i.level === "warn" && i.where === "shot file:///etc/hosts"));
  assert.deepEqual(ready.questions[0].images ?? [], []);
});

test("the page knows whether the agent is listening and whether the answers reached it", async (context) => {
  const dir = await scratchDir(context);
  const child = spawn(process.execPath, [path.join(pluginDir, "mcp.mjs")], { cwd: pluginDir, env: envOf(dir, { CLAUDE_PROJECT_DIR: "" }), stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => child.kill());
  const rpc = rpcClient(child);
  const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
  const text = (result) => result.content.map((c) => c.text).join("\n");
  const state = async (url) => (await fetch(`${url}api/state`)).json();
  // The ack follows the tool result: the server hears it a moment after the agent has the text.
  const delivered = async (url, id) => {
    for (let i = 0; i < 100; i++) {
      const entry = (await state(url)).history.find((h) => h.id === id);
      if (entry?.delivered) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  // Sent while nobody waits: saved, but not delivered until the agent comes back.
  const [, first, url] = text(await call("ask", { project: dir, spec, open: false })).match(/Round (\S+) .+: (http:\/\/127\.0\.0\.1:\d+\/)/);
  await post(url, `api/rounds/${first}/submit`, { answers: { color: { selected: ["pink"] } } });
  assert.deepEqual([(await state(url)).history[0].id, (await state(url)).history[0].delivered], [first, false]);
  assert.equal((await (await fetch(`${url}api/rounds/${first}`)).json()).delivered, false);
  assert.match(text(await call("wait", { project: dir, round: first, timeoutSec: 5 })), /Розовый/);
  assert.equal(await delivered(url, first), true, "the late wait delivers the answers");

  // Sent while the agent waits: delivered at once, and the round showed as listened to.
  const [, second] = text(await call("ask", { project: dir, spec, open: false })).match(/Round (\S+) /);
  const waiting = call("wait", { project: dir, round: second, timeoutSec: 20 });
  for (let i = 0; i < 50 && !(await state(url)).rounds.find((r) => r.id === second)?.waiting; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal((await state(url)).rounds.find((r) => r.id === second).listening, true);
  await post(url, `api/rounds/${second}/submit`, { answers: { color: { selected: ["blue"] } } });
  assert.match(text(await waiting), /Синий/);
  assert.equal((await state(url)).history[0].id, second);
  assert.equal(await delivered(url, second), true);
});

// ---- R7: live questions rounds hand the agent batches of answers

import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import os from "node:os";
const { createStore } = await import("../lib/store/rounds.mjs");
const { createRoots } = await import("../lib/assets.mjs");
const { openProject } = await import("../lib/project.mjs");
const { prepareSpec, formatBatch } = await import("../lib/prepare.mjs");

async function liveRound(t, live, env = {}) {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "decide-live-")));
  const saved = { DECIDE_HOME: process.env.DECIDE_HOME, DECIDE_LIVE_COUNT: process.env.DECIDE_LIVE_COUNT, DECIDE_LIVE_PAUSE_MS: process.env.DECIDE_LIVE_PAUSE_MS };
  process.env.DECIDE_HOME = path.join(dir, ".home");
  delete process.env.DECIDE_LIVE_COUNT;
  delete process.env.DECIDE_LIVE_PAUSE_MS;
  Object.assign(process.env, env);
  const project = openProject(dir);
  const q = (id) => ({ id, title: `Q ${id}?`, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
  const raw = { title: "Live", ...(live ? { live: true } : {}), questions: ["q1", "q2", "q3", "q4"].map(q) };
  const { spec, errors } = await prepareSpec(raw, { specDir: dir, dataDir: project.dataDir, shots: false });
  assert.deepEqual(errors, []);
  const store = createStore({ home: process.env.DECIDE_HOME, roots: createRoots() });
  t.after(() => {
    store.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const round = store.create({ project, spec, raw, outPath: path.join(dir, "x.answers.json"), live: true, mode: "questions" });
  return { store, round };
}
// A held waiter's timer is unref'd (it never keeps the process alive), so a wait that should stay empty is raced against a ref'd timer.
const quiet = (p, ms = 1200) => Promise.race([p, new Promise((r) => setTimeout(() => r("quiet"), ms))]);
const pick = (...ids) => ({ answers: Object.fromEntries(ids.map((id) => [id, { selected: ["a"] }])) });

test("live questions round: a batch after 3 new answers", async (t) => {
  const { store, round } = await liveRound(t, true, { DECIDE_LIVE_PAUSE_MS: "600000" });
  assert.equal(round.spec.live, true, "the spec keeps live");
  const held = store.next(round, { waiter: "w", events: true, timeoutMs: 5000 });
  store.saveDraft(round, pick("q1", "q2"));
  store.saveDraft(round, pick("q1", "q2", "q3"));
  const item = await held;
  assert.equal(item.kind, "batch");
  assert.deepEqual(Object.keys(item.payload.answers).sort(), ["q1", "q2", "q3"]);
  assert.match(formatBatch(item.payload), /3 new answers; 3 of 4/);
  store.ack(round, item.seq, "w");
  store.saveDraft(round, pick("q1", "q2", "q3", "q4"));
  assert.equal(await quiet(store.next(round, { waiter: "w", events: true, timeoutMs: 5000 })), "quiet", "one new answer is below the count and the pause is long");
});

test("live questions round: a batch after the pause; a round without live sends none", async (t) => {
  const { store, round } = await liveRound(t, true, { DECIDE_LIVE_PAUSE_MS: "150" });
  const held = store.next(round, { waiter: "w", events: true, timeoutMs: 5000 });
  store.saveDraft(round, pick("q2"));
  const item = await quiet(held, 3000);
  assert.deepEqual(Object.keys(item.payload.answers), ["q2"]);

  const plain = await liveRound(t, false, { DECIDE_LIVE_PAUSE_MS: "10", DECIDE_LIVE_COUNT: "1" });
  plain.store.saveDraft(plain.round, pick("q1", "q2", "q3"));
  assert.equal(await quiet(plain.store.next(plain.round, { waiter: "w", events: true, timeoutMs: 5000 })), "quiet", "the agent hears only the final answers");
  plain.store.finish(plain.round, { answers: { q1: { selected: ["a"] } } });
  assert.equal((await plain.store.next(plain.round, { waiter: "w", events: true })).kind, "final");
});
