/**
 * Feature:    uncollected answers announce themselves
 * Layer:      Integration (an in-process server of a scratch home, `decide.mjs notice`, real `node mcp.mjs` children)
 * Covers:
 *   - uncollected() lists answered rounds whose final item has no acked event, reads only, and ignores the rest
 *   - noticeLine() is the one line per round the agent and the user read
 *   - `decide.mjs notice` prints the line or nothing, exits 0, starts no server and creates nothing in the home
 *   - an MCP tool result of that project starts with the line; another project's result does not; the wait that
 *     collects the round leaves it out
 *   - an agent that got the answers but died before the ack: the line stays
 *   - hooks/hooks.json declares a SessionStart command hook that runs `notice`
 * Isolation:  every test has its own DECIDE_HOME; no test binds 47474; every process is stopped by its pid.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { openProject } from "../lib/project.mjs";
import { roundDir } from "../lib/store/rounds.mjs";
import { noticeLine, uncollected } from "../lib/store/scan.mjs";
import { startServer } from "../lib/server.mjs";
import { ack, api, findServer, waitNext } from "../lib/client.mjs";
import { enginePath, envOf, exitOf, homeOf, notePid, pluginDir, scratchDir, asAgent, asPage } from "./helpers.mjs";

delete process.env.DECIDE_PORT;
process.env.DECIDE_NOTIFY = "0";

const spec = {
  title: "Colour",
  questions: [{ id: "color", title: "Which colour?", options: [{ id: "pink", label: "Pink" }, { id: "blue", label: "Blue" }] }],
};
// The page's side (its Origin) and the agent's (the token of the home's daemon.json).
const post = (port, route, body) => fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: asPage(port), body: body === undefined ? undefined : JSON.stringify(body) });
const agentPost = (port, route, body) => fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: asAgent(port), body: body === undefined ? undefined : JSON.stringify(body) });

async function served(t, title = "Colour") {
  const dir = await scratchDir(t);
  const home = homeOf(dir);
  await mkdir(home, { recursive: true });
  const started = await startServer({ home, embedded: true });
  assert.ok(started);
  t.after(() => started.stop());
  const s = await findServer(home);
  const open = async (project, name = title) => (await api(s, "/api/rounds", { method: "POST", body: { project, spec: { ...spec, title: name }, outPath: path.join(project, "colour.answers.json"), source: "colour.questions.json", open: false, live: true } })).id;
  return { dir, home, s, port: started.port, open, dataDir: openProject(dir, home).dataDir };
}

const answer = (port, id) => post(port, `/api/rounds/${id}/submit`, { answers: { color: { selected: ["blue"] } } });

function mcp(t, dir) {
  const child = spawn(process.execPath, [path.join(pluginDir, "mcp.mjs")], { cwd: pluginDir, env: envOf(dir, { CLAUDE_PROJECT_DIR: "", DECIDE_NOTIFY: "0", DECIDE_TEST_NOTICE_GRACE_MS: "0" }), stdio: ["pipe", "pipe", "pipe"] });
  notePid(child.pid);
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await exitOf(child);
  });
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
  const text = (name, args) => {
    const id = next++;
    const result = new Promise((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
    return result.then((msg) => msg.result.content.map((c) => c.text).join("\n"));
  };
  return { text };
}

// graceMs "0" is the test seam that lets a round announce itself at once; null runs the real default.
const notice = (dir, extra = [], graceMs = "0") => spawnSync(process.execPath, [enginePath, "notice", "--project", dir, ...extra], { env: envOf(dir, graceMs === null ? {} : { DECIDE_TEST_NOTICE_GRACE_MS: graceMs }), encoding: "utf8" });

test("a round answered with no agent shows up; after ack it does not", async (t) => {
  const { dir, s, port, open, dataDir } = await served(t);
  const id = await open(dir);
  assert.deepEqual(uncollected(dataDir, { graceMs: 0 }), [], "a pending round says nothing");
  assert.equal((await answer(port, id)).status, 200);
  const list = uncollected(dataDir, { graceMs: 0 });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].title, "Colour");
  assert.ok(!Number.isNaN(Date.parse(list[0].at)));
  const final = await waitNext(s, id, { waiter: "a", timeoutMs: 2_000 });
  assert.equal(final.kind, "final");
  assert.equal(uncollected(dataDir, { graceMs: 0 }).length, 1, "received but not acknowledged: still there");
  await ack(s, id, final.seq, "a");
  assert.deepEqual(uncollected(dataDir, { graceMs: 0 }), []);
});

test("cancelled and dismissed rounds say nothing; answered ones come oldest first", async (t) => {
  const { dir, port, open, dataDir } = await served(t);
  const [a, b, c, d] = [await open(dir, "First"), await open(dir, "Second"), await open(dir, "Third"), await open(dir, "Fourth")];
  await post(port, `/api/rounds/${b}/cancel`);
  await agentPost(port, `/api/rounds/${c}/dismiss`);
  await answer(port, d);
  await new Promise((r) => setTimeout(r, 20));
  await answer(port, a);
  assert.deepEqual(uncollected(dataDir, { graceMs: 0 }).map((r) => r.id), [d, a]);
});

test("the scan writes nothing, ignores a torn last line and a missing directory", async (t) => {
  const { dir, port, open, dataDir } = await served(t);
  assert.deepEqual(uncollected(path.join(dir, "nowhere"), { graceMs: 0 }), []);
  assert.equal(existsSync(path.join(dir, "nowhere")), false, "nothing was created");
  const id = await open(dir);
  await answer(port, id);
  const log = path.join(roundDir(dataDir, id), "events.jsonl");
  appendFileSync(log, '{"seq":99,"at":"2026-01-01T00:00:00.000Z","type":"ack');
  const before = readFileSync(log);
  assert.equal(uncollected(dataDir, { graceMs: 0 }).length, 1);
  assert.deepEqual(readFileSync(log), before, "the torn tail is left as it was");
  mkdirSync(path.join(dataDir, "rounds", "9-abcdef"), { recursive: true }); // a directory with no files
  assert.equal(uncollected(dataDir, { graceMs: 0 }).length, 1, "an unreadable round is skipped");
});

const pad = (n) => String(n).padStart(2, "0");

test("noticeLine: empty for none; one line per round; HH:MM today, the date before it on another day", () => {
  assert.equal(noticeLine([]), "");
  const answered = new Date(2026, 10, 15, 8, 5); // local time, so the expectation holds in any time zone
  const at = answered.toISOString();
  const today = new Date(2026, 10, 15, 23, 59).getTime();
  assert.equal(noticeLine([{ id: "1-abc123", title: "Colour", at }], { now: today }), 'decide: round 1-abc123 "Colour" was answered at 08:05 and not collected; call wait {round: "1-abc123"}.');
  const nextDay = new Date(2026, 10, 16, 0, 1).getTime();
  assert.equal(noticeLine([{ id: "1-abc123", title: "Colour", at }], { now: nextDay }), 'decide: round 1-abc123 "Colour" was answered at 2026-11-15 08:05 and not collected; call wait {round: "1-abc123"}.');
  const two = noticeLine([{ id: "1-abc123", title: 'Say "hi"\nnow', at }, { id: "2-abc123", title: "x".repeat(100), at }], { now: today }).split("\n");
  assert.equal(two.length, 2);
  assert.ok(two[0].includes(`"Say 'hi' now"`), two[0]);
  assert.ok(two[1].includes(`"${"x".repeat(60)}"`) && !two[1].includes("x".repeat(61)));
});

test("a title is cut by code points, never inside a surrogate pair", () => {
  const at = new Date(2026, 10, 15, 8, 5).toISOString();
  const title = "a".repeat(59) + "😀😀";
  const line = noticeLine([{ id: "1-abc123", title, at }], { now: Date.parse(at) });
  assert.ok(line.includes(`"${"a".repeat(59)}😀"`), line);
  assert.equal(line.includes("\ufffd"), false);
  assert.doesNotMatch(line, /[\ud800-\udbff](?![\udc00-\udfff])/);
});

test("a round announces itself only once its final event is older than the listen grace", async (t) => {
  const { dir, port, open, dataDir } = await served(t);
  await answer(port, await open(dir));
  const [{ at }] = uncollected(dataDir, { graceMs: 0 });
  const t0 = Date.parse(at);
  assert.deepEqual(uncollected(dataDir, { now: t0 + 10_000 }), [], "10 s old: the agent that asked may still collect it");
  assert.equal(uncollected(dataDir, { now: t0 + 91_000 }).length, 1, "91 s old: nobody is listening");
  assert.equal(uncollected(dataDir, { now: t0 + 91_000, graceMs: 120_000 }).length, 0, "the grace is a parameter");
  assert.equal(notice(dir, [], null).stdout, "", "the real notice command stays silent for a fresh answer");
});

test("the scan agrees with the store: a last line with no newline does not count", async (t) => {
  const { dir, port, open, dataDir } = await served(t);
  const id = await open(dir);
  const log = path.join(roundDir(dataDir, id), "events.jsonl");
  const lines = readFileSync(log, "utf8").trimEnd().split("\n");
  await answer(port, id);
  const all = readFileSync(log, "utf8");
  assert.equal(uncollected(dataDir, { graceMs: 0 }).length, 1);
  writeFileSync(log, all.replace(/\n$/, "")); // the `sent` line is whole but has no newline: the store's log cuts it
  assert.equal(lines.length >= 1, true);
  assert.deepEqual(uncollected(dataDir, { graceMs: 0 }), []);
});

test("the scan agrees with the store: a round the store would not load is not announced", async (t) => {
  const { dir, port, open, dataDir } = await served(t);
  const id = await open(dir);
  await answer(port, id);
  const meta = path.join(roundDir(dataDir, id), "meta.json");
  const good = readFileSync(meta, "utf8");
  const broken = (change) => writeFileSync(meta, JSON.stringify({ ...JSON.parse(good), ...change }));
  for (const change of [{ format: 2 }, { id: "9-ffffff" }, { mode: "other" }]) {
    broken(change);
    assert.deepEqual(uncollected(dataDir, { graceMs: 0 }), [], JSON.stringify(change));
  }
  writeFileSync(meta, good);
  assert.equal(uncollected(dataDir, { graceMs: 0 }).length, 1);
  const spec = path.join(roundDir(dataDir, id), "spec.json");
  const goodSpec = readFileSync(spec, "utf8");
  writeFileSync(spec, "{}");
  assert.deepEqual(uncollected(dataDir, { graceMs: 0 }), [], "a spec with no questions");
  writeFileSync(spec, goodSpec);
  // a directory whose name is not a round id, with the same files
  cpSync(roundDir(dataDir, id), path.join(dataDir, "rounds", "not-a-round"), { recursive: true });
  assert.equal(uncollected(dataDir, { graceMs: 0 }).length, 1, "only the real directory counts");
});

const answersFile = (dir, id) => {
  const file = path.join(dir, `${id}.theirs.json`);
  writeFileSync(file, JSON.stringify({ version: 2, round: id, name: "Ann", answers: { color: { selected: ["pink"] } } }));
  return file;
};

test("MCP import on a pending round: its result and the next one carry no line, and nothing stays uncollected", async (t) => {
  const { dir, open, dataDir } = await served(t);
  const agent = mcp(t, dir);
  const id = await open(dir);
  const text = await agent.text("import", { project: dir, files: [answersFile(dir, id)] });
  assert.ok(!text.includes("not collected"), text);
  assert.match(text, /imported from/);
  const after = await agent.text("history", { project: dir });
  assert.ok(!after.includes("not collected"), after);
  assert.deepEqual(uncollected(dataDir, { graceMs: 0 }), []);
});

test("CLI --import on a pending round leaves nothing uncollected", async (t) => {
  const { dir, open, dataDir } = await served(t);
  const id = await open(dir);
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [enginePath, "--import", answersFile(dir, id), "--project", dir], { env: envOf(dir), stdio: ["ignore", "pipe", "pipe"] });
    notePid(child.pid);
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("exit", (code) => resolve({ code, out }));
  });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /imported from/);
  assert.deepEqual(uncollected(dataDir, { graceMs: 0 }), []);
});

test("an import with no server running (offline) settles no round log, so nothing is announced", async (t) => {
  const dir = await scratchDir(t);
  const specFile = path.join(dir, "colour.questions.json");
  writeFileSync(specFile, JSON.stringify(spec));
  const res = spawnSync(process.execPath, [enginePath, "--import", answersFile(dir, "5-abcdef"), "--spec", specFile, "--project", dir], { env: envOf(dir), encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(notice(dir).stdout, "");
  assert.equal(existsSync(path.join(homeOf(dir), "daemon.json")), false, "no server was started for it");
});

test("notice with a deleted working directory prints nothing and exits 0 (skipped on win32: needs a POSIX shell)", { skip: process.platform === "win32" }, async (t) => {
  const dir = await scratchDir(t);
  const res = spawnSync("sh", ["-c", 'mkdir gone && cd gone && rmdir ../gone && exec "$0" "$1" notice', process.execPath, enginePath], { cwd: dir, env: envOf(dir), encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "");
  assert.equal(existsSync(homeOf(dir)), false);
});

test("notice given after --project still is notice: nothing printed, nothing created, exit 0", async (t) => {
  const dir = await scratchDir(t);
  const res = spawnSync(process.execPath, [enginePath, "--project", dir, "notice"], { env: envOf(dir), encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "");
  assert.equal(existsSync(homeOf(dir)), false);
});

test("notice prints the line for an uncollected round, nothing after ack, and exits 0 both times", async (t) => {
  const { dir, s, port, open } = await served(t);
  const id = await open(dir);
  await answer(port, id);
  const first = notice(dir);
  assert.equal(first.status, 0);
  assert.match(first.stdout, new RegExp(`^decide: round ${id} "Colour" was answered at \\d\\d:\\d\\d and not collected; call wait \\{round: "${id}"\\}\\.\\n$`));
  const final = await waitNext(s, id, { waiter: "a", timeoutMs: 2_000 });
  await ack(s, id, final.seq, "a");
  const second = notice(dir);
  assert.equal(second.status, 0);
  assert.equal(second.stdout, "");
});

test("notice prints nothing and starts no server when there is nothing", async (t) => {
  const dir = await scratchDir(t);
  const res = notice(dir);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.equal(existsSync(path.join(homeOf(dir), "daemon.json")), false);
  assert.equal(existsSync(homeOf(dir)), false, "the home was not even created");
  const bad = notice(path.join(dir, "no", "such", "dir"));
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, "");
  assert.equal(existsSync(homeOf(dir)), false);
});

test("notice creates nothing in a home that exists", async (t) => {
  const dir = await scratchDir(t);
  mkdirSync(homeOf(dir), { recursive: true });
  assert.equal(notice(dir).status, 0);
  assert.deepEqual(readdirSync(homeOf(dir)), []);
});

test("the line is the first line of the next tool result in that project", async (t) => {
  const { dir, port, open } = await served(t);
  const agent = mcp(t, dir);
  const id = await open(dir);
  const plain = await agent.text("history", { project: dir });
  assert.ok(!plain.startsWith("decide: round"), plain);
  await answer(port, id);
  const text = await agent.text("history", { project: dir });
  assert.ok(text.startsWith(`decide: round ${id} "Colour" was answered at `), text);
  const [first, blank] = text.split("\n");
  assert.match(first, /not collected; call wait \{round: "[^"]+"\}\.$/);
  assert.equal(blank, "", "an empty line separates it from the result");
});

test("another project's tool results do not carry it", async (t) => {
  const { dir, port, open } = await served(t);
  const other = path.join(dir, "other");
  mkdirSync(other);
  const agent = mcp(t, dir);
  await answer(port, await open(dir));
  const text = await agent.text("history", { project: other });
  assert.ok(!text.includes("decide: round"), text);
  assert.ok(!(await agent.text("history", {})).includes("decide: round"), "no project, no line");
});

test("the wait that collects the round leaves it out; the next result is clean", async (t) => {
  const { dir, port, open } = await served(t);
  const agent = mcp(t, dir);
  const [a, b] = [await open(dir, "First"), await open(dir, "Second")];
  await answer(port, a);
  await answer(port, b);
  const got = await agent.text("wait", { project: dir, round: a, timeoutSec: 5 });
  assert.ok(!got.includes(`round ${a} "`), "the collected round is not announced in its own result");
  assert.ok(got.startsWith(`decide: round ${b} "Second"`), "the other round is");
  const after = await agent.text("history", { project: dir });
  assert.ok(!after.includes(`round ${a} "`), after);
  assert.ok(after.includes(`round ${b} "Second"`), after);
});

test("the agent session died after the result was written but before ack: the line stays", async (t) => {
  const { dir, s, port, open, dataDir } = await served(t);
  const id = await open(dir);
  await answer(port, id);
  const final = await waitNext(s, id, { waiter: "dead", timeoutMs: 2_000 }); // the agent got it, then died: no ack
  assert.equal(final.kind, "final");
  assert.ok(notice(dir).stdout.includes(`round ${id} `));
  assert.equal(uncollected(dataDir, { graceMs: 0 }).length, 1);
});

test("hooks/hooks.json runs notice at session start with a short timeout", () => {
  const file = path.join(pluginDir, "hooks", "hooks.json");
  const hooks = JSON.parse(readFileSync(file, "utf8")).hooks;
  const entry = hooks.SessionStart[0].hooks[0];
  assert.equal(entry.type, "command");
  assert.match(entry.command, /\$\{CLAUDE_PLUGIN_ROOT\}.*decide\.mjs.* notice/);
  assert.ok(entry.timeout > 0 && entry.timeout <= 30);
});
