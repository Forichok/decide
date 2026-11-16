/**
 * Feature:    a client finds, or starts, the server of its own home and of no other
 * Layer:      Integration (real client processes, `serve` processes and in-process servers over loopback HTTP)
 * Covers:
 *   - findServer reads only <home>/daemon.json and wants a decide server of that very home
 *   - a client given a home never reaches the server of the home the environment names
 *   - three clients on a cold home share one server; the embedded fallback when no engine starts
 *   - a server given a home never resolves one from the environment (its rounds go under its home)
 *   - a load that fails leaves no half-server behind
 *   - a named server that does not answer is busy, never "not running": push, explain, --reply, import say so at once;
 *     MCP wait and CLI --wait keep waiting, and say the server did not answer
 *   - import settles offline only when there is no server or the round is unknown there (404)
 *   - stop says so when the server does not answer its stop in time
 * Isolation:  DECIDE_HOME names a scratch guard home before anything runs, and every test passes its own
 *             home; no test binds 47474; every process a test starts is stopped by its pid.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";

// Before anything can resolve a home: whatever wrongly reads the environment lands in a scratch home.
delete process.env.DECIDE_PORT;
process.env.DECIDE_NOTIFY = "0";
const guard = mkdtempSync(path.join(tmpdir(), "decide-test-guard-"));
process.env.DECIDE_HOME = guard;
after(() => rmSync(guard, { recursive: true, force: true }));

const { DEFAULT_PORT, lockPath, portForHome, readInfo } = await import("../lib/home.mjs");
const { PROTOCOL } = await import("../lib/protocol.mjs");
const { startServer } = await import("../lib/server.mjs");
const { api, ensureServer, findServer, handover, waitNext } = await import("../lib/client.mjs");
const { alive, collect, enginePath, exitOf, fakeServer, homeOf, notePid, ping, scratchDir, silentServer } = await import("./helpers.mjs");
const { HANDLERS } = await import("./helpers.mjs");
const { importAnswers } = await import("../lib/transfer.mjs");
const { contextFor } = await import("../lib/commands/index.mjs");
const { openProject } = await import("../lib/project.mjs");
const { readJournal } = await import("../lib/journal.mjs");

const clientUrl = new URL("../lib/client.mjs", import.meta.url).href;
const spec = {
  title: "Colour",
  questions: [{ id: "color", title: "Which colour?", options: [{ id: "pink", label: "Pink" }, { id: "blue", label: "Blue" }] }],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// An engine that writes down the pid of every process started with it, then runs decide.mjs. Whatever
// it started and is still running after the test is stopped by its pid.
function loggingEngine(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "decide-test-engine-"));
  const pids = path.join(dir, "pids");
  const file = path.join(dir, "engine.mjs");
  writeFileSync(file, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");\nawait import(${JSON.stringify(pathToFileURL(enginePath).href)});\n`);
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

// The round directories under a home: <home>/projects/<project>/rounds/<id>.
function roundsUnder(home) {
  const projects = path.join(home, "projects");
  if (!existsSync(projects)) return [];
  return readdirSync(projects).flatMap((p) => {
    const rounds = path.join(projects, p, "rounds");
    return existsSync(rounds) ? readdirSync(rounds, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  });
}

const roundOf = (dir) => ({ project: dir, spec, outPath: path.join(dir, "colour.answers.json"), source: "colour.questions.json", open: false, live: true });

test("a server for another home on the expected port is ignored", async (t) => {
  const a = await scratch(t);
  const b = await scratch(t);
  // B's server, on A's port when it is free, and named by A's daemon.json as if it were A's.
  const other = await startServer({ home: b.home, embedded: true, port: portForHome(a.home) });
  assert.ok(other);
  t.after(() => other.stop());
  writeFileSync(path.join(a.home, "daemon.json"), JSON.stringify({ pid: process.pid, port: other.port, protocol: PROTOCOL, version: "2.1.1", home: a.home, token: other.token, startedAt: 1 }));

  assert.equal((await ping(other.port)).home, b.home);
  assert.equal(await findServer(a.home), null);
  const found = await findServer(b.home);
  assert.equal(found?.port, other.port, "B's own client finds it");
  assert.equal(found.token, other.token);
});

test("a client in a test home never reaches the default home's server", async (t) => {
  // The home the environment names (the guard) has a server that writes down every request it gets.
  const hits = [];
  const recorder = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, app: "decide", protocol: PROTOCOL, version: "2.1.1", home: guard, pid: process.pid }));
  });
  await new Promise((r) => recorder.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => (recorder.closeAllConnections(), recorder.close(r))));
  writeFileSync(path.join(guard, "daemon.json"), JSON.stringify({ pid: process.pid, port: recorder.address().port, protocol: PROTOCOL, version: "2.1.1", home: guard, token: "t", startedAt: 1 }));
  t.after(() => rmSync(path.join(guard, "daemon.json"), { force: true }));
  assert.equal((await findServer(guard))?.port, recorder.address().port, "it looks like the default home's server");
  hits.length = 0;

  const { home } = await scratch(t);
  const engine = loggingEngine(t);
  assert.notEqual(portForHome(home), DEFAULT_PORT);
  assert.equal(await findServer(home), null);
  const s = await ensureServer({ home, engine: engine.file });
  assert.notEqual(s.port, recorder.address().port);
  assert.equal((await ping(s.port)).home, home);
  assert.equal(readInfo(home).port, s.port);
  assert.deepEqual(hits, [], "nothing was asked of the other home's server");
});

test("three clients on a cold home: one server, three rounds, none gets 404 on its first wait", async (t) => {
  const { dir, home } = await scratch(t);
  const engine = loggingEngine(t);
  const script = [
    `import { api, ensureServer } from ${JSON.stringify(clientUrl)};`,
    `const s = await ensureServer({ home: process.env.DECIDE_HOME, engine: process.env.TEST_ENGINE });`,
    `const posted = await api(s, "/api/rounds", { method: "POST", body: JSON.parse(process.env.TEST_ROUND), timeoutMs: 5000 });`,
    "const res = await fetch(`http://127.0.0.1:${s.port}/api/rounds/${posted.id}/next?timeout=300`, { headers: { \"x-decide-token\": s.token } });",
    `console.log(JSON.stringify({ id: posted.id, port: s.port, embedded: Boolean(s.embedded), wait: res.status }));`,
    `process.exit(0);`,
  ].join("\n");
  const env = { ...process.env, DECIDE_HOME: home, TEST_ENGINE: engine.file, TEST_ROUND: JSON.stringify(roundOf(dir)) };
  const clients = [0, 1, 2].map(() => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], env });
    notePid(child.pid);
    t.after(() => child.exitCode === null && child.signalCode === null && child.kill());
    return { child, output: collect(child) };
  });
  const codes = await Promise.all(clients.map((c) => exitOf(c.child)));
  assert.deepEqual(codes, [0, 0, 0], clients.map((c) => c.output.stderr).join("\n"));
  const seen = clients.map((c) => JSON.parse(c.output.stdout.trim().split("\n").at(-1)));

  const info = readInfo(home);
  assert.ok(alive(info.pid));
  assert.deepEqual(seen.map((s) => s.port), [info.port, info.port, info.port], "one server");
  assert.deepEqual(seen.map((s) => s.embedded), [false, false, false]);
  assert.equal(new Set(seen.map((s) => s.id)).size, 3, "three rounds");
  for (const s of seen) assert.ok([200, 204].includes(s.wait), `first wait on ${s.id} got ${s.wait}`);
  const state = await (await fetch(`http://127.0.0.1:${info.port}/api/state`)).json();
  assert.equal(state.rounds.length, 3);
  // Every other serve the clients started stepped back and exited.
  await until(() => engine.started().filter(alive).every((pid) => pid === info.pid), "the losing serves to exit", 10_000);
  assert.ok(engine.started().includes(info.pid));
});

test("the engine cannot be spawned: the client serves in-process", async (t) => {
  const { dir, home } = await scratch(t);
  const s = await ensureServer({ home, engine: path.join(dir, "no-such-engine.mjs") });
  t.after(() => fetch(`http://127.0.0.1:${s.port}/api/stop`, { method: "POST", headers: { "x-decide-token": s.token } }).catch(() => {}));
  assert.equal(s.embedded, true);
  assert.equal(readInfo(home).pid, process.pid);
  assert.equal((await ping(s.port)).home, home);
  // It serves the home it was started for, not the one DECIDE_HOME names.
  const posted = await api(s, "/api/rounds", { method: "POST", body: roundOf(dir), timeoutMs: 5000 });
  assert.deepEqual(roundsUnder(home), [posted.id]);
  assert.equal((await api(s, `/api/rounds/${posted.id}`)).status, "pending");
  assert.equal(existsSync(path.join(guard, "projects")), false);
});

test("a server given a home never resolves one from the environment: its rounds go under that home", async (t) => {
  const { dir, home } = await scratch(t);
  assert.notEqual(process.env.DECIDE_HOME, home);
  const s = await startServer({ home, embedded: true });
  assert.ok(s);
  t.after(() => s.stop());
  const res = await fetch(`http://127.0.0.1:${s.port}/api/rounds`, { method: "POST", headers: { "content-type": "application/json", "x-decide-token": s.token }, body: JSON.stringify(roundOf(dir)) });
  const body = await res.json();
  assert.equal(res.status, 200, body.error);
  assert.deepEqual(roundsUnder(home), [body.id]);
  const journal = await fetch(`http://127.0.0.1:${s.port}/api/journal?project=${encodeURIComponent(dir)}`);
  assert.equal(journal.status, 200);
  assert.equal(existsSync(path.join(guard, "projects")), false, "nothing appears under the environment's home");
});

test("a load that fails leaves no half-server: the start rejects, its files go, the next start serves", async (t) => {
  const { home } = await scratch(t);
  let port = 0;
  await assert.rejects(
    startServer({
      home,
      embedded: true,
      beforeLoad: () => {
        port = readInfo(home).port;
        throw new Error("the load failed on purpose");
      },
    }),
    /on purpose/,
  );
  assert.ok(port > 0);
  assert.equal(readInfo(home), null, "daemon.json is gone");
  assert.equal(existsSync(lockPath(home)), false, "the lock is gone");
  assert.equal(await ping(port), null, "nothing listens for it");

  const next = await startServer({ home, embedded: true });
  assert.ok(next, "the same process can serve the home now");
  t.after(() => next.stop());
  assert.equal((await ping(next.port))?.home, home);
});

// Runs fn with DECIDE_HOME naming home, as the MCP server and the CLI of that home see it; the guard after.
async function inHome(home, fn) {
  process.env.DECIDE_HOME = home;
  try {
    return await fn();
  } finally {
    process.env.DECIDE_HOME = guard;
  }
}

// decide.mjs run for a project of the home; resolves { code, stdout, stderr } once it exits.
async function cli(t, dir, home, args) {
  const child = spawn(process.execPath, [enginePath, ...args, "--project", dir], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DECIDE_HOME: home, DECIDE_NOTIFY: "0" } });
  t.after(() => child.exitCode === null && child.kill());
  const output = collect(child);
  const code = await exitOf(child);
  return { code, ...output };
}

const BUSY = /is not answering/;
const GONE = /not running/;

test("a named server that does not answer is busy, not gone: push, explain and CLI --reply say so; a wait keeps waiting", async (t) => {
  const { dir, home } = await scratch(t);
  const silent = await silentServer(t, home, PROTOCOL);
  // A wait keeps trying within its own time, and then says the server did not answer during the call.
  const started = Date.now();
  const waited = await inHome(home, () => HANDLERS.wait({ round: "r1", project: dir, timeoutSec: 5 }));
  assert.ok(Date.now() - started >= 4_000, "it waited its time out");
  assert.match(waited, /Still waiting for the user on round r1/);
  assert.match(waited, new RegExp(`The decide server \\(pid ${process.pid}, port ${silent.port}\\) did not answer during this call\\.`));
  assert.doesNotMatch(waited, GONE);
  const calls = {
    push: { round: "r1", project: dir, add: [] },
    explain: { round: "r1", question: "color", text: "because", project: dir },
  };
  for (const [tool, args] of Object.entries(calls)) {
    const err = await inHome(home, () => HANDLERS[tool](args)).then(
      () => assert.fail(`${tool} answered`),
      (e) => e,
    );
    assert.match(err.message, BUSY, `${tool}: ${err.message}`);
    assert.doesNotMatch(err.message, GONE, tool);
    assert.match(err.message, new RegExp(`pid ${process.pid}, port ${silent.port}`), tool);
    assert.ok(err.user || err.constructor.name === "UserError", `${tool}: the agent sees the text as it is`);
  }
  const run = await cli(t, dir, home, ["--reply", "r1", "--question", "color", "--text", "because"]);
  assert.notEqual(run.code, 0, "--reply");
  assert.match(run.stderr, BUSY, `--reply: ${run.stderr}`);
  assert.doesNotMatch(run.stderr + run.stdout, GONE, "--reply");

  // CLI --wait has no time of its own: it says the server is not answering and goes on waiting.
  const child = spawn(process.execPath, [enginePath, "--wait", "r1", "--project", dir], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DECIDE_HOME: home, DECIDE_NOTIFY: "0" } });
  notePid(child.pid);
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await exitOf(child);
  });
  const output = collect(child);
  await until(() => /still waiting/i.test(output.stderr) || child.exitCode !== null, "--wait to say it is still waiting", 10_000);
  assert.equal(child.exitCode, null, `--wait exited: ${output.stderr}`);
  assert.match(output.stderr, BUSY, `--wait: ${output.stderr}`);
  assert.match(output.stderr, /still waiting/i, `--wait: ${output.stderr}`);
  assert.doesNotMatch(output.stderr + output.stdout, GONE, "--wait");
  assert.equal(readInfo(home).pid, process.pid, "nothing was started beside it");
});

test("import settles offline only when the server does not know the round", async (t) => {
  const { dir, home } = await scratch(t);
  const project = openProject(dir, home);
  const specPath = path.join(dir, "colour.questions.json");
  writeFileSync(specPath, JSON.stringify(spec));
  const ann = path.join(dir, "ann.answers.json");
  writeFileSync(ann, JSON.stringify({ round: "x1", name: "Ann", answers: { color: { selected: ["pink"] } } }));
  const answers = path.join(dir, "colour.answers.json");
  const importOnce = () => inHome(home, () => importAnswers({ project, files: [ann], specPath, getServer: () => contextFor({}).server() }));
  const settledNothing = (what) => {
    assert.equal(existsSync(answers), false, `${what}: no answers file`);
    assert.equal(readJournal(project.dataDir).length, 0, `${what}: no journal line`);
  };

  // Busy: the round may still be open there.
  const silent = await silentServer(t, home, PROTOCOL);
  await assert.rejects(importOnce(), (e) => (assert.match(e.message, BUSY), true));
  settledNothing("a silent server");
  await silent.close();

  // A server that answers, but not with the round: neither a 426 nor a 500 means the round is closed.
  for (const [status, data] of [[426, { error: "protocol", protocol: PROTOCOL + 1 }], [500, { error: "boom" }]]) {
    const fake = await fakeServer(t, home, PROTOCOL, (req, res) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data)));
    await assert.rejects(importOnce(), (e) => (status === 426 ? assert.match(e.message, /restart the session/) : assert.doesNotMatch(e.message, GONE), true));
    settledNothing(`a server answering ${status}`);
    await fake.close();
  }

  // The round is unknown there (404): it is settled offline.
  const fake = await fakeServer(t, home, PROTOCOL, (req, res) => res.writeHead(404, { "content-type": "application/json" }).end('{"error":"no such round"}'));
  assert.match(await importOnce(), /by Ann/);
  assert.equal(JSON.parse(readFileSync(answers, "utf8")).round, "x1");
  await fake.close();
});

test("stop says the server did not answer in time, naming its pid and port, rather than that none runs", async (t) => {
  const { dir, home } = await scratch(t);
  const fake = await fakeServer(t, home, PROTOCOL, () => {}); // never answers /api/stop
  const run = await cli(t, dir, home, ["--stop"]);
  assert.doesNotMatch(run.stdout, /no running server/);
  assert.match(run.stdout, new RegExp(`pid ${process.pid}.*port ${fake.port}|port ${fake.port}.*pid ${process.pid}`));
  assert.match(run.stdout, /did not answer within 5 s/);
  assert.notEqual(run.code, 0);
});

// ---- what the agent reads (final fix wave A6)

test("a handover cut short by the time left says how long it really waited, not 5 s", async (t) => {
  const { home } = await scratch(t);
  const mute = await fakeServer(t, home, PROTOCOL, () => {}); // never answers /api/handover
  await assert.rejects(handover(home, readInfo(home), PROTOCOL + 1, Date.now() + 1_200), (e) => {
    assert.match(e.message, /it did not answer within 1\.[0-2] s\./);
    assert.doesNotMatch(e.message, /\b5 s/);
    return true;
  });
  await mute.close();
  // It agrees, and keeps the port (its pid, this process, stays alive).
  const stubborn = await fakeServer(t, home, PROTOCOL, (req, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
  await assert.rejects(handover(home, readInfo(home), PROTOCOL + 1, Date.now() + 1_500), (e) => {
    assert.match(e.message, new RegExp(`still holds port ${stubborn.port} after 1\\.[0-5] s\\.`));
    return true;
  });
  await stubborn.close();
});

test("a server error that ends with a period is quoted without a doubled period", async (t) => {
  const { home } = await scratch(t);
  for (const said of ["the disk is full.", "the disk is full"]) {
    const fake = await fakeServer(t, home, PROTOCOL, (req, res) => res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: said })));
    const server = await findServer(home);
    await assert.rejects(waitNext(server, "1-abcdef", { timeoutMs: 2_000 }), (e) => {
      assert.match(e.message, /\(HTTP 500\): the disk is full\. The round is still open/, said);
      assert.doesNotMatch(e.message, /\.\./, said);
      assert.equal(e.status, 500);
      return true;
    });
    await fake.close();
  }
});

// ---- a private home (final fix wave A3)

const posix = process.platform === "win32" ? "POSIX file modes and owners" : false;
const modeOf = (p) => statSync(p).mode & 0o777;

test("the home, round dirs and round files are private: 0700 and 0600, an existing home of ours is tightened (skipped on win32: POSIX file modes)", { skip: posix }, async (t) => {
  const { dir, home } = await scratch(t);
  chmodSync(home, 0o755);
  const s = await startServer({ home, embedded: true });
  assert.ok(s);
  t.after(() => s.stop());
  assert.equal(modeOf(home), 0o700, "the home");
  const res = await fetch(`http://127.0.0.1:${s.port}/api/rounds`, { method: "POST", headers: { "content-type": "application/json", "x-decide-token": s.token }, body: JSON.stringify({ ...roundOf(dir), outPath: path.join(dir, "c.answers.json") }) });
  const { id } = await res.json();
  assert.equal(res.status, 200);
  const roundDir = path.join(home, "projects", readdirSync(path.join(home, "projects"))[0], "rounds", id);
  assert.equal(modeOf(path.dirname(roundDir)), 0o700, "rounds/");
  assert.equal(modeOf(roundDir), 0o700, "the round dir");
  const upload = await fetch(`http://127.0.0.1:${s.port}/api/rounds/${id}/upload`, { method: "POST", headers: { origin: `http://127.0.0.1:${s.port}`, "content-type": "text/plain", "x-file-name": "n.txt" }, body: "note" });
  assert.equal(upload.status, 200);
  const submitted = await fetch(`http://127.0.0.1:${s.port}/api/rounds/${id}/submit`, { method: "POST", headers: { origin: `http://127.0.0.1:${s.port}`, "content-type": "application/json" }, body: JSON.stringify({ answers: {} }) });
  assert.equal(submitted.status, 200);
  assert.equal(modeOf(path.join(roundDir, "files")), 0o700, "files/");
  for (const name of ["meta.json", "spec.json", "raw.json", "events.jsonl", "answers.json", ...readdirSync(path.join(roundDir, "files")).map((f) => path.join("files", f))]) {
    assert.equal(modeOf(path.join(roundDir, name)), 0o600, name);
  }
});

test("a home that is not ours, or stays open to others, is refused with a clear message (skipped on win32: POSIX owners)", { skip: posix }, async (t) => {
  const { ensureHome } = await import("../lib/home.mjs");
  const { home } = await scratch(t);
  chmodSync(home, 0o777);
  assert.throws(() => ensureHome(home, { uid: process.getuid() + 1 }), (err) => err.user === true && err.message.includes(home) && /belongs to uid \d+, not to this user/.test(err.message));
  assert.equal(modeOf(home), 0o777, "someone else's home is not touched");
  assert.throws(() => ensureHome(home, { chmod: () => {} }), (err) => err.user === true && /writable by group or others/.test(err.message) && err.message.includes(`chmod 700 ${home}`));
  ensureHome(home);
  assert.equal(modeOf(home), 0o700, "ours: tightened");
  const fresh = path.join(home, "new", "home");
  ensureHome(fresh);
  assert.equal(modeOf(fresh), 0o700, "created private");
});
