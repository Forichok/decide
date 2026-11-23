/**
 * Feature:    one server per decide home
 * Layer:      Integration (real `node decide.mjs serve` processes over loopback HTTP)
 * Covers:
 *   - Election: the home's port elects one server; the lock file elects one when a foreign process
 *     holds the port; daemon.json naming a dead or a foreign pid does not stop a new server
 *   - daemon.json is private and carries the token POST /api/stop needs
 *   - GET …/next and POST …/ack: acknowledged only by ack, a dismissed round answers at once
 *   - Explanation media are published once; the page hears when an agent stops listening; idle stop
 * Isolation:  every test has its own DECIDE_HOME; no test binds 47474; every server is stopped by pid.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { request, createServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_PORT, lockPath, portForHome, readInfo } from "../lib/home.mjs";
import { PROTOCOL, speaks } from "../lib/protocol.mjs";
import { formatResult } from "../lib/prepare.mjs";
import { alive, enginePath, exitOf, homeOf, notePid, ping, runEngine, scratchDir, spawnServer, asAgent, asPage } from "./helpers.mjs";

// A scratch home maps to 44000 + fnv1a(home) % 2000; DECIDE_PORT from the shell must not move it.
delete process.env.DECIDE_PORT;

const spec = {
  title: "Colour",
  questions: [{ id: "color", title: "Which colour?", options: [{ id: "pink", label: "Pink" }, { id: "blue", label: "Blue" }] }],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (port, route) => (await fetch(`http://127.0.0.1:${port}${route}`)).json();
// The page's side (its Origin) and the agent's (the token of the home's daemon.json).
const agentGet = async (port, route) => (await fetch(`http://127.0.0.1:${port}${route}`, { headers: asAgent(port) })).json();
const post = (port, route, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: asPage(port, headers), body: body === undefined ? undefined : JSON.stringify(body) });
const agentPost = (port, route, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: asAgent(port, headers), body: body === undefined ? undefined : JSON.stringify(body) });

async function until(check, what, ms = 5_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

// A pid that surely belongs to no process: a child that has already exited.
async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await exitOf(child);
  return child.pid;
}

// An HTTP server that is not decide, on a free port. silent: it accepts and never answers, as a busy server would.
function foreignServer(t, { silent = false } = {}) {
  const server = createServer((req, res) => {
    if (!silent) res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return server;
}

async function foreignOn(t, port, options) {
  const server = foreignServer(t, options);
  const bound = await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
  return bound ? server : null;
}

async function home(t) {
  const dir = await scratchDir(t);
  const h = homeOf(dir);
  mkdirSync(h, { recursive: true });
  return { dir, home: h };
}

// A home whose port this test itself holds, with something that is not decide, for the whole test.
// A port another suite holds may be let go of mid-test: such a home is skipped for another.
async function homeWithPortHeld(t, options) {
  for (let i = 0; i < 20; i++) {
    const h = await home(t);
    const holder = await foreignOn(t, portForHome(h.home), options);
    if (holder) return { ...h, port: portForHome(h.home), holder };
  }
  throw new Error("no scratch home with a free port");
}

// A home whose port nothing holds when the test starts (a port another suite holds is skipped).
async function homeWithFreePort(t) {
  for (let i = 0; i < 20; i++) {
    const h = await home(t);
    if (!(await bound(portForHome(h.home)))) return { ...h, port: portForHome(h.home) };
  }
  throw new Error("no scratch home with a free port");
}

// A home whose port this test holds with a TCP listener that does not speak HTTP: onSocket decides what it does.
async function homeWithRawPortHeld(t, onSocket) {
  for (let i = 0; i < 20; i++) {
    const h = await home(t);
    const sockets = new Set();
    const holder = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      onSocket(socket);
    });
    const ok = await new Promise((resolve) => {
      holder.once("error", () => resolve(false));
      holder.listen(portForHome(h.home), "127.0.0.1", () => resolve(true));
    });
    if (!ok) continue;
    t.after(
      () =>
        new Promise((r) => {
          for (const socket of sockets) socket.destroy();
          holder.close(() => r());
        }),
    );
    return { ...h, port: portForHome(h.home), holder };
  }
  throw new Error("no scratch home with a free port");
}

// A live process that is not decide: what a reused pid looks like.
function sleeper(t) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  notePid(child.pid);
  t.after(async () => {
    child.kill();
    await exitOf(child);
  });
  return child.pid;
}

// The files a crashed server left, its pid since reused by a live process: an old lock and daemon.json.
function leftBehind(h, pid, port) {
  writeFileSync(lockPath(h), String(pid));
  utimesSync(lockPath(h), anHourAgo(), anHourAgo());
  writeFileSync(path.join(h, "daemon.json"), JSON.stringify({ pid, port, protocol: PROTOCOL, version: "2.1.1", home: h, token: "old", startedAt: 1 }));
}

async function freePort(t) {
  const server = await foreignOn(t, 0);
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

// Whether something accepts TCP connections on the port: true while a server is bound, busy or not.
const bound = (port) =>
  new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

// /api/ping with a short budget: null when the server does not answer in time.
async function pingWithin(port, ms) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(ms) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const anHourAgo = () => new Date(Date.now() - 3_600_000);

async function serving(t) {
  const { dir, home: h } = await home(t);
  const server = await spawnServer(t, h);
  assert.equal(server.exited, null, server.output.stderr);
  return { dir, home: h, port: server.port, server };
}

async function openRound(port, dir, extra = {}) {
  const res = await agentPost(port, "/api/rounds", { project: dir, spec, outPath: path.join(dir, "colour.answers.json"), specFile: path.join(dir, "colour.questions.json"), source: "colour.questions.json", open: false, live: true, ...extra });
  const body = await res.json();
  assert.equal(res.status, 200, body.error);
  return body.id;
}

test("protocol: a server speaks its own protocol and the one before", () => {
  assert.equal(speaks(2, PROTOCOL), false, "a review daemon hands over to a visual client");
  assert.equal(speaks(PROTOCOL, 2), true, "existing clients can still use the upgraded daemon");
  assert.deepEqual([speaks(2, 2), speaks(2, 1), speaks(2, 0), speaks(2, 3)], [true, true, false, false]);
});

test("ports: the real home gets 47474, a scratch home its own port in 44000-45999, DECIDE_PORT wins", (t) => {
  t.after(() => delete process.env.DECIDE_PORT);
  assert.equal(portForHome(path.join(homedir(), ".decide")), DEFAULT_PORT);
  const p = portForHome(path.join(tmpdir(), "some-home"));
  assert.ok(p >= 44000 && p < 46000);
  assert.equal(portForHome(path.join(tmpdir(), "some-home")), p, "stable");
  process.env.DECIDE_PORT = "45555";
  assert.equal(portForHome(path.join(tmpdir(), "some-home")), 45555);
});

test("three servers started at once: one serves, two resolve null", async (t) => {
  const { home: h } = await home(t);
  const pids = await Promise.all([1, 2, 3].map(() => spawnServer(t, h)));
  const info = readInfo(h);
  assert.equal(pids.filter((p) => p.exited === 0 && p.pid !== info.pid).length, 2, pids.map((p) => p.output.stdout + p.output.stderr).join("\n"));
  assert.equal(pids.find((p) => p.pid === info.pid).exited, null);
  const pong = await ping(info.port);
  assert.equal(pong.home, h);
  assert.deepEqual([pong.ok, pong.app, pong.protocol, pong.version, pong.pid], [true, "decide", PROTOCOL, "3.2.2", info.pid]);
});

test("a second home gets its own port and its own server", async (t) => {
  const one = await serving(t);
  let two = await home(t);
  while (portForHome(two.home) === portForHome(one.home)) two = await home(t);
  const second = await spawnServer(t, two.home);
  assert.equal(second.exited, null);
  assert.notEqual(second.port, one.port);
  assert.equal((await ping(one.port)).home, one.home);
  assert.equal((await ping(second.port)).home, two.home);
  assert.equal(readInfo(two.home).port, second.port);
});

test("the port is taken by a foreign HTTP server: the lock file elects one, daemon.json names its port", async (t) => {
  const { home: h, port: fixed } = await homeWithPortHeld(t);
  const pids = await Promise.all([1, 2, 3].map(() => spawnServer(t, h)));
  const info = readInfo(h);
  const winners = pids.filter((p) => p.exited === null);
  assert.equal(winners.length, 1, pids.map((p) => p.output.stdout + p.output.stderr).join("\n"));
  assert.equal(pids.filter((p) => p.exited === 0).length, 2);
  assert.equal(info.pid, winners[0].pid);
  assert.notEqual(info.port, fixed);
  assert.equal(info.port, winners[0].port);
  assert.equal((await ping(info.port)).home, h);
  assert.equal(readFileSync(lockPath(h), "utf8").trim(), String(info.pid), "the lock holds the winner's pid");
});

test("a stale lock (its pid is dead) is replaced", async (t) => {
  const { home: h } = await homeWithPortHeld(t);
  writeFileSync(lockPath(h), String(await deadPid()));
  const server = await spawnServer(t, h);
  assert.equal(server.exited, null, server.output.stderr);
  assert.equal(readFileSync(lockPath(h), "utf8").trim(), String(server.pid));
  assert.equal((await ping(readInfo(h).port)).pid, server.pid);
});

test("daemon.json points at a dead pid: a new server starts", async (t) => {
  const { home: h } = await home(t);
  const dead = await deadPid();
  // Its port is not the home's: a server elected while the home's port was taken, now gone.
  const closed = await foreignOn(t, 0);
  const oldPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  writeFileSync(path.join(h, "daemon.json"), JSON.stringify({ pid: dead, port: oldPort, protocol: PROTOCOL, version: "2.1.1", home: h, token: "old", startedAt: 1 }));
  const server = await spawnServer(t, h);
  assert.equal(server.exited, null, server.output.stderr);
  const info = readInfo(h);
  assert.equal(info.pid, server.pid);
  assert.notEqual(info.token, "old");
  assert.equal((await ping(info.port)).pid, server.pid);
});

test("daemon.json points at a live pid that is not decide: it is ignored", async (t) => {
  const { home: h } = await home(t);
  const foreign = await foreignOn(t, 0);
  // This test process is alive, and its HTTP server answers /api/ping without app: "decide".
  writeFileSync(path.join(h, "daemon.json"), JSON.stringify({ pid: process.pid, port: foreign.address().port, protocol: PROTOCOL, version: "2.1.1", home: h, token: "x", startedAt: 1 }));
  const server = await spawnServer(t, h);
  assert.equal(server.exited, null, server.output.stderr);
  assert.equal(readInfo(h).pid, server.pid);
  assert.equal((await ping(readInfo(h).port)).home, h);
});

test("daemon.json is mode 0600 and carries a token", async (t) => {
  const { home: h, server } = await serving(t);
  const info = readInfo(h);
  assert.match(info.token, /^[0-9a-f]{32,}$/);
  assert.deepEqual([info.pid, info.port, info.protocol, info.version, info.home], [server.pid, server.port, PROTOCOL, "3.2.2", h]);
  assert.ok(Number.isFinite(info.startedAt));
  if (process.platform !== "win32") assert.equal(statSync(path.join(h, "daemon.json")).mode & 0o777, 0o600);
});

test("POST /api/stop needs the token; /api/shutdown is gone", async (t) => {
  const { home: h, port, server } = await serving(t);
  assert.equal((await post(port, "/api/shutdown")).status, 404);
  assert.equal((await post(port, "/api/stop")).status, 403);
  assert.equal((await post(port, "/api/stop", undefined, { "x-decide-token": "wrong" })).status, 403);
  assert.equal(alive(server.pid), true);
  assert.equal((await agentPost(port, "/api/stop")).status, 200);
  assert.equal(await exitOf(server.child), 0);
  assert.equal(readInfo(h), null, "a server that stops removes its daemon.json");
});

test("a round lives in its own project; the journal line goes there; a round needs a project", async (t) => {
  const { dir, port } = await serving(t);
  assert.equal((await agentPost(port, "/api/rounds", { spec, outPath: path.join(dir, "a.json") })).status, 400);
  const id = await openRound(port, dir);
  const state = await get(port, "/api/state");
  assert.equal(state.rounds[0].id, id);
  assert.equal(state.rounds[0].project, (await import("../lib/project.mjs")).projectRoot(dir));
  assert.equal((await post(port, `/api/rounds/${id}/submit`, { answers: { color: { selected: ["pink"] } } })).status, 200);
  const mine = await get(port, `/api/journal?project=${encodeURIComponent(dir)}`);
  assert.deepEqual(mine.entries.map((e) => e.round), [id]);
  const all = await get(port, "/api/journal");
  assert.deepEqual(all.entries.map((e) => e.round), [id]);
});

test("next: an item is acknowledged only by ack, and not handed out after it", async (t) => {
  const { dir, port } = await serving(t);
  const id = await openRound(port, dir);
  assert.equal((await post(port, `/api/rounds/${id}/ask`, { question: "color", text: "Why pink?" })).status, 200);
  assert.equal((await get(port, `/api/rounds/${id}`)).dialog[0].seen, false);
  const asked = await agentGet(port, `/api/rounds/${id}/next?waiter=a&events=1&timeout=5000`);
  assert.equal(asked.kind, "ask");
  assert.deepEqual([asked.payload.event, asked.payload.round, asked.payload.ask.question, asked.payload.ask.text], ["ask", id, "color", "Why pink?"]);
  assert.equal((await get(port, `/api/rounds/${id}`)).dialog[0].seen, false, "a response written is not an acknowledgement");
  assert.equal((await agentPost(port, `/api/rounds/${id}/ack`, { seq: asked.seq, waiter: "a" })).status, 200);
  assert.equal((await get(port, `/api/rounds/${id}`)).dialog[0].seen, true);
  const again = await fetch(`http://127.0.0.1:${port}/api/rounds/${id}/next?waiter=a&events=1&timeout=1000`, { headers: asAgent(port) });
  assert.equal(again.status, 204, "an acknowledged ask is not handed out twice");

  // An agent that gave up before the answers came: nothing was handed to it, nothing is acknowledged.
  const gone = new AbortController();
  const held = fetch(`http://127.0.0.1:${port}/api/rounds/${id}/next?waiter=a&timeout=20000`, { headers: asAgent(port), signal: gone.signal }).catch(() => null);
  await until(async () => (await get(port, "/api/state")).rounds[0]?.waiting, "the waiter to be held");
  gone.abort();
  await held;
  await until(async () => !(await get(port, "/api/state")).rounds[0]?.waiting, "the waiter to be freed");
  await post(port, `/api/rounds/${id}/submit`, { answers: { color: { selected: ["blue"] } } });
  assert.equal((await get(port, `/api/rounds/${id}`)).delivered, false);
  assert.equal((await get(port, "/api/state")).history[0].delivered, false);

  const final = await agentGet(port, `/api/rounds/${id}/next?waiter=a&timeout=5000`);
  const result = final.payload;
  assert.deepEqual([final.kind, result.round, result.answers.color.selected, result.file], ["final", id, ["blue"], path.join(dir, "colour.answers.json")]);
  assert.equal((await get(port, `/api/rounds/${id}`)).delivered, false);
  assert.equal((await agentPost(port, `/api/rounds/${id}/ack`, { seq: final.seq, waiter: "a" })).status, 200);
  assert.equal((await get(port, `/api/rounds/${id}`)).delivered, true);
  assert.equal((await get(port, "/api/state")).history[0].delivered, true);
});

test("a dismissed round answers a wait at once, held or new", async (t) => {
  const { dir, port } = await serving(t);
  const id = await openRound(port, dir);
  await fetch(`http://127.0.0.1:${port}/api/rounds/${id}/draft`, { method: "PUT", headers: asPage(port), body: JSON.stringify({ answers: { color: { selected: ["pink"] } } }) });
  const held = agentGet(port, `/api/rounds/${id}/next?waiter=a&timeout=20000`);
  await until(async () => (await get(port, "/api/state")).rounds[0]?.waiting, "the waiter to be held");
  const res = await agentPost(port, `/api/rounds/${id}/dismiss`);
  assert.equal(res.status, 200);
  const first = await held;
  assert.deepEqual([first.kind, first.payload.dismissed, first.payload.round, first.payload.answers.color.selected], ["dismissed", true, id, ["pink"]]);
  const started = Date.now();
  const second = await agentGet(port, `/api/rounds/${id}/next?waiter=a&timeout=20000`);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(second.kind, "dismissed");
  assert.equal((await agentPost(port, `/api/rounds/${id}/dismiss`)).status, 409);
  const text = formatResult({ ...second.payload, status: "dismissed" }, second.payload.file);
  assert.match(text.split("\n")[0], /^The user dismissed round «Colour»/);
  assert.match(text, /Pink/);
});

test("an explanation's media are published once: the page can load them", async (t) => {
  const { dir, port } = await serving(t);
  const id = await openRound(port, dir);
  const png = path.join(dir, "logo.png");
  writeFileSync(png, "not-really-a-png");
  const res = await agentPost(port, `/api/rounds/${id}/explain`, { question: "color", text: "Like the logo.", images: [png] });
  assert.equal(res.status, 200);
  const view = await get(port, `/api/rounds/${id}`);
  const src = view.dialog[0].reply.images[0].src;
  assert.match(src, /^\/r\/[0-9a-f]{8}\/logo\.png$/);
  const file = await fetch(`http://127.0.0.1:${port}${src}`);
  assert.equal(file.status, 200);
  assert.equal(await file.text(), "not-really-a-png");
});

// In-process servers (startServer) for what needs short timers: the listening notice and the idle stop.
async function inProcess(t, options, prepared) {
  const { dir, home: h } = prepared || (await home(t));
  const saved = process.env.DECIDE_HOME;
  process.env.DECIDE_HOME = h;
  const { startServer } = await import("../lib/server.mjs");
  const started = await startServer({ home: h, embedded: true, ...options });
  t.after(() => {
    started?.stop();
    saved === undefined ? delete process.env.DECIDE_HOME : (process.env.DECIDE_HOME = saved);
  });
  assert.ok(started);
  return { dir, home: h, ...started };
}

function events(t, port) {
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

test("the page hears when an agent stops listening, with nothing else changing", async (t) => {
  const { dir, port } = await inProcess(t, { listenGraceMs: 300, tickMs: 50 });
  const seen = events(t, port);
  const id = await openRound(port, dir);
  const listening = (e) => e.name === "state" && e.data.rounds.find((r) => r.id === id)?.listening;
  await until(() => seen.some((e) => listening(e) === true), "a state saying the agent listens");
  await until(() => seen.some((e) => listening(e) === false), "a state saying it stopped", 3_000);
});

test("idle stop: no waiting agent and no page for idleMs stops the server, even with a round open", async (t) => {
  const { dir, port } = await inProcess(t, { idleMs: 300, tickMs: 50 });
  await openRound(port, dir);
  await until(async () => (await ping(port)) === null, "the server to stop", 5_000);
});

// ---- fix round 1: a slow answer is never taken for absence

test("a server still loading is not doubled: a second serve steps back, daemon.json names the first", async (t) => {
  const { home: h } = await home(t);
  // Seam: DECIDE_TEST_LOAD_BLOCK_MS blocks the first server's event loop while it loads its rounds.
  const first = spawnServer(t, h, { env: { DECIDE_TEST_LOAD_BLOCK_MS: "2500" } });
  await until(() => bound(portForHome(h)), "the first server to bind the home's port");
  const namedEarly = await until(() => readInfo(h)?.pid, "daemon.json to name the server before it loads", 1_000).catch(() => null);
  const second = await spawnServer(t, h);
  assert.equal(second.exited, 0, second.output.stdout + second.output.stderr);
  assert.match(second.output.stdout, /already running/);
  const one = await first;
  assert.equal(one.exited, null, one.output.stderr);
  assert.equal(namedEarly, one.pid, "daemon.json names the winner before its load");
  assert.equal(readInfo(h).pid, one.pid);
  assert.equal(readFileSync(lockPath(h), "utf8").trim(), String(one.pid), "a winner of the home's port holds the lock too");
  assert.equal((await ping(one.port)).pid, one.pid);
});

test("a server busy after it started is not doubled: a second serve steps back", async (t) => {
  const { home: h } = await home(t);
  // Seam: DECIDE_TEST_BUSY_MS="<after>:<for>" blocks the event loop of a serving server once.
  const first = await spawnServer(t, h, { env: { DECIDE_TEST_BUSY_MS: "300:3000" } });
  assert.equal(first.exited, null, first.output.stderr);
  await until(async () => !(await pingWithin(first.port, 150)), "the first server to be busy");
  const second = await spawnServer(t, h);
  assert.equal(second.exited, 0, second.output.stdout + second.output.stderr);
  assert.equal(readInfo(h).pid, first.pid);
  await until(async () => (await ping(first.port))?.pid === first.pid, "the first server to answer again");
});

// Silent holder: the rival's probe of the home's port times out and it waits on the named server.
// Answering holder: the rival goes to the lock, which a busy server named by daemon.json still holds.
for (const silent of [true, false]) {
test(`a lock held by a live server on another port is not replaced by a rival whose probe timed out, whatever its age (${silent ? "silent" : "answering"} holder of the home's port)`, async (t) => {
  const { home: h, port: fixed } = await homeWithPortHeld(t, { silent });
  const first = await spawnServer(t, h, { env: { DECIDE_TEST_BUSY_MS: "300:4000" } });
  assert.equal(first.exited, null, first.output.stderr);
  assert.notEqual(first.port, fixed);
  assert.equal(readFileSync(lockPath(h), "utf8").trim(), String(first.pid));
  utimesSync(lockPath(h), anHourAgo(), anHourAgo());
  await until(async () => !(await pingWithin(first.port, 150)), "the first server to be busy");
  const second = await spawnServer(t, h);
  assert.equal(second.exited, 0, second.output.stdout + second.output.stderr);
  assert.equal(readInfo(h).pid, first.pid);
  assert.equal(readFileSync(lockPath(h), "utf8").trim(), String(first.pid));
  await until(async () => (await ping(first.port))?.pid === first.pid, "the first server to answer again");
});
}

test("a winner of the home's port steps back when daemon.json names a live server of the home on another port", async (t) => {
  const { home: h } = await home(t);
  const elsewhere = await freePort(t);
  const first = await spawnServer(t, h, { env: { DECIDE_PORT: String(elsewhere) } });
  assert.equal(first.exited, null, first.output.stderr);
  assert.equal(first.port, elsewhere);
  assert.equal(readFileSync(lockPath(h), "utf8").trim(), String(first.pid), "a winner of its port holds the lock");
  utimesSync(lockPath(h), anHourAgo(), anHourAgo());
  const second = await spawnServer(t, h);
  assert.equal(second.exited, 0, second.output.stdout + second.output.stderr);
  assert.equal(readInfo(h).pid, first.pid);
});

test("the timer starts once the election is won: a tiny idleMs cannot stop a server mid-election", async (t) => {
  // The silent holder makes the election wait out a probe; the old timer stopped the server during it.
  const held = await homeWithPortHeld(t, { silent: true });
  const { port, home: h } = await inProcess(t, { idleMs: 300, tickMs: 50 }, held);
  assert.equal((await ping(port))?.pid, process.pid);
  assert.equal(readInfo(h)?.pid, process.pid);
  await until(async () => (await ping(port)) === null, "the idle stop after the election", 3_000);
  assert.equal(readInfo(h), null);
});

test("--stop asks only a decide server of this home: a live pid that is not decide gets no request", async (t) => {
  const { dir, home: h } = await home(t);
  const hits = [];
  const foreign = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  t.after(() => new Promise((r) => foreign.close(r)));
  await new Promise((r) => foreign.listen(0, "127.0.0.1", r));
  const file = path.join(h, "daemon.json");
  writeFileSync(file, JSON.stringify({ pid: process.pid, port: foreign.address().port, protocol: PROTOCOL, version: "2.1.1", home: h, token: "x", startedAt: 1 }));
  try {
    const { child, output } = runEngine(t, dir, ["--stop"]);
    assert.equal(await exitOf(child), 0, output.stderr);
    assert.match(output.stdout, /no running server/);
    assert.deepEqual(hits.filter((hit) => hit.startsWith("POST")), []);
  } finally {
    rmSync(file, { force: true });
  }
});

test("a server that has begun to stop answers 503 to a request in flight and writes nothing", async (t) => {
  const { dir, home: h, port, stop } = await inProcess(t, {});
  const id = await openRound(port, dir);
  const body = JSON.stringify({ answers: { color: { selected: ["pink"] } } });
  const status = await new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, method: "PUT", path: `/api/rounds/${id}/draft`, headers: { ...asPage(port), "content-length": Buffer.byteLength(body) } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", (e) => resolve(e.code));
    req.write(body.slice(0, 5));
    setTimeout(() => {
      stop();
      req.end(body.slice(5));
    }, 200);
  });
  assert.equal(status, 503);
  assert.equal(await ping(port), null);
  assert.equal(readInfo(h), null);
  const { createStore } = await import("../lib/store/rounds.mjs");
  const { createRoots } = await import("../lib/assets.mjs");
  const store = createStore({ home: h, roots: createRoots() });
  try {
    store.load();
    assert.equal(store.get(id).draft ?? null, null, "the draft that came in after stop was not written");
  } finally {
    store.close();
  }
});

test("ensureServer throws, naming the pid, the port and how to check them, when the named server does not answer; it starts nothing beside it", async (t) => {
  const { dir, home: h, port: fixed } = await homeWithPortHeld(t, { silent: true });
  // A live pid that is not decide, named by the lock and by daemon.json on the silent port: a hung server.
  const hung = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  notePid(hung.pid);
  t.after(async () => {
    hung.kill();
    await exitOf(hung);
  });
  writeFileSync(lockPath(h), String(hung.pid));
  writeFileSync(path.join(h, "daemon.json"), JSON.stringify({ pid: hung.pid, port: fixed, protocol: PROTOCOL, version: "2.1.1", home: h, token: "x", startedAt: 1 }));
  // The engine the client spawns: decide.mjs, with each pid written down so the test can check it exited.
  const pids = path.join(dir, "serve.pids");
  const engine = path.join(dir, "engine.mjs");
  writeFileSync(engine, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");\nawait import(${JSON.stringify(new URL(`file://${enginePath}`).href)});\n`);
  const saved = process.env.DECIDE_HOME;
  process.env.DECIDE_HOME = h;
  t.after(() => (saved === undefined ? delete process.env.DECIDE_HOME : (process.env.DECIDE_HOME = saved)));
  const { ensureServer } = await import("../lib/client.mjs");
  await assert.rejects(ensureServer({ home: h, engine }), (err) => {
    assert.match(err.message, new RegExp(`pid ${hung.pid}`));
    assert.match(err.message, new RegExp(`port ${fixed}`));
    assert.doesNotMatch(err.message, /\bkill\b/, "nobody confirmed that pid is decide: the user is not told to kill it");
    // Removing the files of a live decide server lets a second one start: the message says how to check first.
    if (process.platform !== "win32") assert.match(err.message, new RegExp(`ps -p ${hung.pid} -o command=`));
    assert.match(err.message, /decide\.mjs serve/);
    return true;
  });
  // A busy server is never doubled, and the in-process fallback is not for it either.
  const spawned = existsSync(pids) ? readFileSync(pids, "utf8").trim().split("\n").map(Number) : [];
  spawned.forEach(notePid);
  assert.deepEqual(spawned, [], "no serve was started beside it");
  assert.equal(readInfo(h).pid, hung.pid, "nothing replaced the named server");
});

// ---- fix round 2

// Whatever answers on the home's port in something other than HTTP is not a decide server: decide always speaks HTTP.
const nonHttp = {
  "a banner (an ssh-like listener)": (socket) => socket.write("SSH-2.0-OpenSSH_9.6\r\n"),
  "a connection closed at once": (socket) => socket.end(),
  "a connection reset at once": (socket) => socket.resetAndDestroy(),
};
for (const [what, onSocket] of Object.entries(nonHttp)) {
  test(`the home's port answers with ${what}, and a reused pid is named: a server still starts`, async (t) => {
    const { home: h, port: fixed } = await homeWithRawPortHeld(t, onSocket);
    leftBehind(h, sleeper(t), fixed);
    const server = await spawnServer(t, h);
    assert.equal(server.exited, null, server.output.stdout + server.output.stderr);
    assert.notEqual(server.port, fixed);
    assert.equal(readInfo(h).pid, server.pid);
    assert.equal(readFileSync(lockPath(h), "utf8").trim(), String(server.pid));
  });
}

test("the home's port hangs, and only an old lock names a reused pid: a server still starts, without waiting", async (t) => {
  const { home: h } = await homeWithPortHeld(t, { silent: true });
  writeFileSync(lockPath(h), String(sleeper(t)));
  utimesSync(lockPath(h), anHourAgo(), anHourAgo());
  const started = Date.now();
  const server = await spawnServer(t, h);
  assert.equal(server.exited, null, server.output.stdout + server.output.stderr);
  assert.equal(readInfo(h).pid, server.pid);
  assert.ok(Date.now() - started < 5_000, "no 6 s wait on a pid nothing names as serving");
});

test("the home's port hangs, and the reused pid it names serves nothing on its own port: a server still starts", async (t) => {
  const { home: h, port: fixed } = await homeWithPortHeld(t, { silent: true });
  leftBehind(h, sleeper(t), await freePort(t));
  const started = Date.now();
  const server = await spawnServer(t, h);
  assert.equal(server.exited, null, server.output.stdout + server.output.stderr);
  assert.equal(readInfo(h).pid, server.pid);
  assert.ok(Date.now() - started < 5_000, "no 6 s wait on a pid whose port refuses");
});

test("a slow server that dies while a rival waits for it: the rival takes over", async (t) => {
  const { home: h } = await homeWithPortHeld(t, { silent: true });
  const first = await spawnServer(t, h, { env: { DECIDE_TEST_BUSY_MS: "300:20000" } });
  assert.equal(first.exited, null, first.output.stderr);
  await until(async () => !(await pingWithin(first.port, 150)), "the first server to be busy");
  const second = spawnServer(t, h);
  // By now the rival has found the first server busy and waits for it; then the first one dies.
  await sleep(3_500);
  first.child.kill("SIGKILL");
  await exitOf(first.child);
  const rival = await second;
  assert.equal(rival.exited, null, rival.output.stdout + rival.output.stderr);
  assert.equal(readInfo(h).pid, rival.pid);
});

test("a server answers its home's ping while it is still being elected", async (t) => {
  const { home: h, port: fixed } = await homeWithFreePort(t);
  // The left-behind daemon.json names a port that answers slowly as something else: deciding the lock is stale takes a while.
  const slow = createServer((req, res) => setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'), 800));
  t.after(() => new Promise((r) => (slow.closeAllConnections(), slow.close(() => r()))));
  await new Promise((r) => slow.listen(0, "127.0.0.1", r));
  leftBehind(h, sleeper(t), slow.address().port);
  const first = spawnServer(t, h);
  await until(() => bound(fixed), "the server to bind the home's port");
  const pong = await ping(fixed);
  assert.equal(pong?.home, h, "a rival's ping during the election is answered as this home, not 403");
  const server = await first;
  assert.equal(server.exited, null, server.output.stderr);
  assert.equal(pong.pid, server.pid);
});

test("two servers of one home started at once in one process: one serves, the other resolves null", async (t) => {
  const { home: h } = await homeWithFreePort(t);
  const { startServer } = await import("../lib/server.mjs");
  const results = await Promise.all([startServer({ home: h, embedded: true }), startServer({ home: h, embedded: true })]);
  t.after(() => results.forEach((r) => r?.stop()));
  assert.equal(results.filter(Boolean).length, 1);
  const [one] = results.filter(Boolean);
  assert.equal(readInfo(h).port, one.port);
  // Once it stops, the home is free for the next one in this process.
  one.stop();
  const next = await startServer({ home: h, embedded: true });
  t.after(() => next?.stop());
  assert.ok(next, "a stopped server leaves its home to the next start");
});

test("--stop on a server that is only busy says it is not answering, names it, and sends nothing", async (t) => {
  const { dir, home: h } = await home(t);
  const first = await spawnServer(t, h, { env: { DECIDE_TEST_BUSY_MS: "300:3000" } });
  assert.equal(first.exited, null, first.output.stderr);
  await until(async () => !(await pingWithin(first.port, 150)), "the server to be busy");
  const { child, output } = runEngine(t, dir, ["--stop"]);
  assert.equal(await exitOf(child), 1, output.stdout + output.stderr);
  const said = output.stdout + output.stderr;
  assert.match(said, /not answering/);
  assert.match(said, new RegExp(`pid ${first.pid}`));
  assert.match(said, new RegExp(`port ${first.port}`));
  assert.doesNotMatch(said, /no running server/);
  await until(async () => (await ping(first.port))?.pid === first.pid, "the server to answer again", 6_000);
  assert.equal(alive(first.pid), true, "the busy server was not stopped");
});

test("a live server on another port whose lock file is gone keeps its home: a rival on the free home port steps back", async (t) => {
  const { home: h } = await homeWithFreePort(t);
  const first = await spawnServer(t, h, { env: { DECIDE_PORT: String(await freePort(t)) } });
  assert.equal(first.exited, null, first.output.stderr);
  rmSync(lockPath(h));
  const second = await spawnServer(t, h);
  assert.equal(second.exited, 0, second.output.stdout + second.output.stderr);
  assert.equal(readInfo(h).pid, first.pid);
  assert.equal((await ping(first.port))?.pid, first.pid);
});

test("a process that squats the home's port and answers as this home is not stepped back for: its pid is in no lock and no daemon.json", async (t) => {
  for (let i = 0; i < 20; i++) {
    const { home: h, port: fixed } = await homeWithFreePort(t);
    // It says app: "decide" and this home, with a live pid (this test's) that neither the lock nor daemon.json names.
    const squatter = createServer((req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, app: "decide", protocol: PROTOCOL, version: "2.1.1", home: h, pid: process.pid })));
    t.after(() => new Promise((r) => (squatter.closeAllConnections(), squatter.close(() => r()))));
    const bound = await new Promise((resolve) => {
      squatter.once("error", () => resolve(false));
      squatter.listen(fixed, "127.0.0.1", () => resolve(true));
    });
    if (!bound) continue;
    const server = await spawnServer(t, h);
    assert.equal(server.exited, null, server.output.stdout + server.output.stderr);
    assert.notEqual(server.port, fixed);
    assert.deepEqual([readInfo(h).pid, readInfo(h).port], [server.pid, server.port], "daemon.json names the real server");
    assert.equal(readFileSync(lockPath(h), "utf8").trim(), String(server.pid));
    return;
  }
  throw new Error("no scratch home with a free port");
});

// ---- server-side paths and races (final fix wave A5)

test("explain without a base reads relative media paths from the round's working tree, not the server's cwd", async (t) => {
  const { dir, port } = await serving(t);
  const id = await openRound(port, dir);
  writeFileSync(path.join(dir, "logo.png"), "not-really-a-png");
  const res = await agentPost(port, `/api/rounds/${id}/explain`, { question: "color", text: "Like the logo.", images: ["logo.png"] });
  const body = await res.json();
  assert.equal(res.status, 200, body.error);
  assert.deepEqual(body.warnings, []);
  const view = await get(port, `/api/rounds/${id}`);
  const file = await fetch(`http://127.0.0.1:${port}${view.dialog[0].reply.images[0].src}`);
  assert.equal(await file.text(), "not-really-a-png");
});

test("an import whose body arrives after the page's answers loses: 409, and the page's answers stand", async (t) => {
  const { dir, port } = await serving(t);
  const id = await openRound(port, dir);
  const body = JSON.stringify({ files: [{ file: "a.answers.json", name: "Ann", answers: { color: { selected: ["pink"] } } }] });
  const half = Math.floor(body.length / 2);
  const reply = new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path: `/api/rounds/${id}/import`, headers: { ...asAgent(port), "content-length": Buffer.byteLength(body) } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.write(body.slice(0, half));
    // The route has passed its first status check and waits for the rest of the body; the page answers meanwhile.
    setTimeout(async () => {
      try {
        assert.equal((await post(port, `/api/rounds/${id}/submit`, { answers: { color: { selected: ["blue"] } } })).status, 200);
        req.end(body.slice(half));
      } catch (e) {
        reject(e);
      }
    }, 200);
  });
  const res = await reply;
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /^round is answered: it was settled while the import was on its way; nothing was imported$/);
  const view = await get(port, `/api/rounds/${id}`);
  assert.deepEqual(view.result.answers.color.selected, ["blue"]);
});
