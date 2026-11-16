/**
 * Feature:    a client and the home's server agree on a protocol
 * Layer:      Integration (real `serve` processes and in-process servers over loopback HTTP)
 * Covers:
 *   - a newer client asks an older server to hand over; the server tells pages, stops, and the round survives
 *   - an older client uses a newer server as it is; a client two protocols behind is told to restart
 *   - every /api route but ping answers 426 to a protocol the server does not speak
 *   - POST /api/handover needs the token and a newer client; the client has no path to /api/stop
 *   - the product makes no request through fetch; its node:http request sorts what a port gives and caps a body
 *   - a server already going when its handover is asked is waited out; a refused handover says what to do
 * Isolation:  DECIDE_HOME names a scratch guard home before anything runs, and every test passes its own
 *             home; no test binds 47474; every process a test starts is stopped by its pid.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

// Before anything can resolve a home: whatever wrongly reads the environment lands in a scratch home.
delete process.env.DECIDE_PORT;
process.env.DECIDE_NOTIFY = "0";
const guard = mkdtempSync(path.join(tmpdir(), "decide-test-guard-"));
process.env.DECIDE_HOME = guard;
after(() => rmSync(guard, { recursive: true, force: true }));

const { readInfo } = await import("../lib/home.mjs");
const { PROTOCOL } = await import("../lib/protocol.mjs");
const { startServer } = await import("../lib/server.mjs");
const { api, ensureServer } = await import("../lib/client.mjs");
const { BODY_MAX, PING_BODY_MAX, request: ask } = await import("../lib/request.mjs");
const { alive, enginePath, exitOf, fakeServer, homeOf, notePid, ping, scratchDir, spawnServer, asAgent, asPage } = await import("./helpers.mjs");

const nextEngine = fileURLToPath(new URL("./fixtures/server-next.mjs", import.meta.url));
const spec = {
  title: "Colour",
  questions: [{ id: "color", title: "Which colour?", options: [{ id: "pink", label: "Pink" }, { id: "blue", label: "Blue" }] }],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The page's side (its Origin) and the agent's (the token of the home's daemon.json).
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

async function scratch(t) {
  const dir = await scratchDir(t);
  mkdirSync(homeOf(dir), { recursive: true });
  return { dir, home: homeOf(dir) };
}

// An engine that writes down the pid of every process started with it, then runs the real one. Whatever
// it started and is still running after the test is stopped by its pid.
function loggingEngine(t, engine = enginePath) {
  const dir = mkdtempSync(path.join(tmpdir(), "decide-test-engine-"));
  const pids = path.join(dir, "pids");
  const file = path.join(dir, "engine.mjs");
  writeFileSync(file, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");\nawait import(${JSON.stringify(pathToFileURL(engine).href)});\n`);
  const started = () => (existsSync(pids) ? readFileSync(pids, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);
  t.after(async () => {
    for (const pid of started().filter(alive)) {
      notePid(pid);
      process.kill(pid);
      await until(() => !alive(pid), `pid ${pid} to exit`);
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { file, started };
}

async function inProcess(t, home, options = {}) {
  const started = await startServer({ home, embedded: true, ...options });
  assert.ok(started);
  t.after(() => started.stop());
  return started;
}

// An SSE connection; the event names it has seen.
function events(t, port) {
  const seen = [];
  const req = request({ host: "127.0.0.1", port, path: "/api/events" }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => seen.push(...[...chunk.matchAll(/^event: (.+)$/gm)].map((m) => m[1])));
  });
  req.on("error", () => {});
  req.end();
  t.after(() => req.destroy());
  return seen;
}

const roundOf = (dir) => ({ project: dir, spec, outPath: path.join(dir, "colour.answers.json"), source: "colour.questions.json", open: false, live: true });

test("a newer client asks an older server to hand over; the round survives", async (t) => {
  const { dir, home } = await scratch(t);
  const old = await spawnServer(t, home);
  assert.equal(old.exited, null, old.output.stderr);
  const res = await agentPost(old.port, "/api/rounds", roundOf(dir));
  const { id } = await res.json();
  assert.equal(res.status, 200);
  const page = events(t, old.port);
  await until(() => page.includes("state"), "the page's stream to open");
  const engine = loggingEngine(t, nextEngine);

  const s = await ensureServer({ home, engine: engine.file, protocol: PROTOCOL + 1 });

  assert.notEqual(readInfo(home).pid, old.pid);
  assert.equal(readInfo(home).protocol, PROTOCOL + 1);
  assert.equal(s.protocol, PROTOCOL + 1);
  assert.deepEqual(engine.started(), [readInfo(home).pid], "the newer engine serves the home");
  assert.equal(await exitOf(old.child), 0, "the older server stopped on its own");
  assert.ok(page.includes("handover"), "the page was told");
  assert.equal((await api(s, `/api/rounds/${id}`)).status, "pending");
});

test("an older client uses a newer server and does not ask for a handover", async (t) => {
  const { home } = await scratch(t);
  const next = await spawnServer(t, home, { engine: nextEngine });
  assert.equal(next.exited, null, next.output.stderr);
  const engine = loggingEngine(t);

  const s = await ensureServer({ home, engine: engine.file });

  assert.equal(s.port, next.port);
  assert.equal(s.protocol, PROTOCOL + 1);
  assert.equal(readInfo(home).pid, next.pid, "same pid before and after");
  assert.ok(alive(next.pid));
  assert.deepEqual(engine.started(), [], "nothing was started");
  assert.ok(Array.isArray((await api(s, "/api/state")).rounds), "the client speaks to it");
});

test("a client two versions behind is told to restart its session", async (t) => {
  const { home } = await scratch(t);
  const newer = await inProcess(t, home, { protocol: PROTOCOL + 2 });
  const engine = loggingEngine(t);

  await assert.rejects(ensureServer({ home, engine: engine.file }), (err) => {
    assert.match(err.message, new RegExp(`protocol ${PROTOCOL}\\b`));
    assert.match(err.message, new RegExp(`protocol ${PROTOCOL + 2}\\b`));
    assert.match(err.message, /restart/i);
    return true;
  });
  assert.deepEqual(engine.started(), [], "it starts nothing");
  assert.equal(readInfo(home).pid, process.pid);
  assert.equal(readInfo(home).port, newer.port);

  // The server says so itself, and api() turns its 426 into the same advice.
  const res = await fetch(`http://127.0.0.1:${newer.port}/api/state`, { headers: { "x-decide-protocol": String(PROTOCOL) } });
  assert.equal(res.status, 426);
  const body = await res.json();
  assert.equal(body.protocol, PROTOCOL + 2);
  assert.ok(body.error);
  await assert.rejects(api({ port: newer.port, token: newer.token, protocol: PROTOCOL + 2 }, "/api/state"), (err) => err.status === 426 && /restart/i.test(err.message));
});

test("every /api route but ping answers 426 to a protocol the server does not speak", async (t) => {
  const { dir, home } = await scratch(t);
  const s = await inProcess(t, home);
  const foreign = { "x-decide-protocol": String(PROTOCOL + 5) };
  const at = (route, init = {}) => fetch(`http://127.0.0.1:${s.port}${route}`, { ...init, headers: { ...asAgent(s.port), ...foreign, ...init.headers } });
  assert.equal((await at("/api/ping")).status, 200);
  assert.equal((await at("/api/state")).status, 426);
  assert.equal((await at("/api/journal")).status, 426);
  assert.equal((await at("/api/events")).status, 426);
  assert.equal((await at("/api/rounds", { method: "POST", body: JSON.stringify(roundOf(dir)) })).status, 426);
  assert.equal((await at("/api/rounds/1-abcdef")).status, 426);
  assert.equal((await at("/api/stop", { method: "POST", headers: { "x-decide-token": s.token } })).status, 426);
  // The protocol before the server's, its own, and none at all (the page) are spoken.
  for (const headers of [{ "x-decide-protocol": String(PROTOCOL - 1) }, { "x-decide-protocol": String(PROTOCOL) }, {}]) {
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/api/state`, { headers })).status, 200);
  }
  assert.equal((await agentPost(s.port, "/api/rounds", roundOf(dir), { "x-decide-protocol": String(PROTOCOL) })).status, 200);
});

test("POST /api/handover needs the token and a newer client; it tells pages and stops the server", async (t) => {
  const { home } = await scratch(t);
  const s = await inProcess(t, home);
  const page = events(t, s.port);
  await until(() => page.includes("state"), "the page's stream to open");
  const newer = { "x-decide-protocol": String(PROTOCOL + 1) };
  assert.equal((await post(s.port, "/api/handover", undefined, newer)).status, 403);
  assert.equal((await post(s.port, "/api/handover", undefined, { ...newer, "x-decide-token": "0".repeat(32) })).status, 403);
  assert.equal((await post(s.port, "/api/handover", undefined, { "x-decide-protocol": String(PROTOCOL), "x-decide-token": s.token })).status, 409);
  assert.equal((await post(s.port, "/api/handover", undefined, { "x-decide-token": s.token })).status, 409);
  assert.equal((await ping(s.port))?.pid, process.pid, "still serving");

  const res = await post(s.port, "/api/handover", undefined, { ...newer, "x-decide-token": s.token });
  assert.equal(res.status, 200);
  await until(async () => (await ping(s.port)) === null, "the server to stop");
  assert.ok(page.includes("handover"));
  assert.equal(readInfo(home), null, "daemon.json is gone");
});

test("the client never stops a server: lib/client.mjs has no path to /api/stop", () => {
  const source = readFileSync(fileURLToPath(new URL("../lib/client.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /\/api\/stop|\/api\/shutdown/);
});


test("the product makes no HTTP request through fetch", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith(".mjs") ? [path.join(dir, d.name)] : []));
  const found = [...files(path.join(root, "lib")), path.join(root, "decide.mjs"), path.join(root, "mcp.mjs")].filter((f) => readFileSync(f, "utf8").includes("fetch("));
  assert.deepEqual(found, []);
});

// A TCP listener in this process that does onSocket with each connection; closed after the test.
async function rawListener(t, onSocket) {
  const sockets = new Set();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    onSocket(socket);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => (sockets.forEach((s) => s.destroy()), server.close(() => r()))));
  return server.address().port;
}

test("request() over node:http sorts what a port gives: an answer, refused, no answer in time, or a failure", async (t) => {
  const http = await rawListener(t, (socket) => socket.once("data", () => socket.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\nconnection: close\r\n\r\n{"ok":true}')));
  assert.deepEqual(await ask(http, "/api/ping"), { status: 200, data: { ok: true } });

  const refusedPort = await new Promise((resolve) => {
    const s = createTcpServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  // Not measured on Windows, where a refusal may take up to about 2 s: the default 1.5 s could run out first.
  await assert.rejects(ask(refusedPort, "/api/ping", { timeoutMs: 5_000 }), (err) => err.kind === "refused" && err.code === "ECONNREFUSED");

  const silent = await rawListener(t, () => {});
  await assert.rejects(ask(silent, "/api/ping", { timeoutMs: 200 }), (err) => err.kind === "timeout");

  const gone = new AbortController();
  const held = ask(silent, "/api/ping", { timeoutMs: 0, signal: gone.signal });
  gone.abort();
  await assert.rejects(held, (err) => err.kind === "aborted");

  // Not HTTP: a decide server always speaks HTTP. None of these may throw past the promise.
  const kinds = {
    banner: (socket) => socket.write("SSH-2.0-OpenSSH_9.6\r\n"),
    "closed at once": (socket) => socket.end(),
    "reset at once": (socket) => socket.resetAndDestroy(),
    "cut mid-answer": (socket) => socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\ncontent-length: 50\r\n\r\n{")),
  };
  for (const [what, onSocket] of Object.entries(kinds)) {
    const port = await rawListener(t, onSocket);
    await assert.rejects(ask(port, "/api/ping", { timeoutMs: 2_000 }), (err) => {
      assert.equal(err.kind, "failed", `${what}: ${err.message}`);
      return true;
    });
  }
});

test("request() caps the body it reads: a port that streams on is a failure, not a long wait", async (t) => {
  assert.ok(PING_BODY_MAX < BODY_MAX);
  const streaming = await rawListener(t, (socket) =>
    socket.once("data", () => {
      socket.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n[");
      const chunk = Buffer.alloc(16 * 1024, "1,");
      const timer = setInterval(() => socket.writable && socket.write(chunk), 5);
      socket.on("close", () => clearInterval(timer));
    }),
  );
  const started = Date.now();
  await assert.rejects(ask(streaming, "/api/ping", { timeoutMs: 10_000, maxBytes: PING_BODY_MAX }), (err) => (assert.equal(err.kind, "failed", err.message), true));
  assert.ok(Date.now() - started < 5_000, "it stops reading at the cap");
  const declared = await rawListener(t, (socket) => socket.once("data", () => socket.write(`HTTP/1.1 200 OK\r\ncontent-length: ${BODY_MAX + 1}\r\n\r\n`)));
  await assert.rejects(ask(declared, "/api/state", { timeoutMs: 5_000 }), (err) => (assert.equal(err.kind, "failed", err.message), true));
});

test("a second newer client whose handover finds the server already going waits it out", async (t) => {
  // The older server stops between this client's ping and its handover: it answers 503, or cuts the request.
  const answers = {
    "503": (req, res) => res.writeHead(503, { "content-type": "application/json" }).end('{"error":"stopping"}'),
    cut: (req) => req.socket.destroy(),
  };
  for (const [what, answer] of Object.entries(answers)) {
    const { home } = await scratch(t);
    const older = await fakeServer(t, home, PROTOCOL, (req, res) => {
      if (req.url !== "/api/handover") return res.writeHead(404).end();
      answer(req, res);
      older.close();
    });
    const engine = loggingEngine(t, nextEngine);
    const s = await ensureServer({ home, engine: engine.file, protocol: PROTOCOL + 1 });
    assert.equal(s.protocol, PROTOCOL + 1, what);
    assert.deepEqual(engine.started(), [readInfo(home).pid], `${what}: the newer engine serves the home`);
  }
});

test("a handover the older server refuses says which server was asked, what happened and what to do", async (t) => {
  const { home } = await scratch(t);
  await fakeServer(t, home, PROTOCOL, (req, res) => res.writeHead(403, { "content-type": "application/json" }).end('{"error":"bad token"}'));
  const engine = loggingEngine(t, nextEngine);
  await assert.rejects(ensureServer({ home, engine: engine.file, protocol: PROTOCOL + 1 }), (err) => {
    assert.match(err.message, new RegExp(`pid ${process.pid}\\b`));
    assert.match(err.message, new RegExp(`protocol ${PROTOCOL}\\b`));
    assert.match(err.message, /asked the older decide server .* to hand over/);
    assert.match(err.message, /403/);
    assert.match(err.message, /try again/i);
    assert.match(err.message, /rounds are on disk/);
    return true;
  });
  assert.deepEqual(engine.started(), [], "nothing was started beside it");
});
