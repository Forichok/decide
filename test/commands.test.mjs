/**
 * Feature:    one command table behind the MCP tools and the CLI
 * Layer:      Unit (table, argv, tools/list) and integration (in-process commands against scratch homes, CLI children)
 * Contract:   test/fixtures/2.1/surface.json (tools/list and flags of 2.1.1, f62a924); lib/commands/
 * Covers:
 *   - tools/list is built from the table and equals 2.1's, plus lint and stop, plus the type lines on ask and swipe
 *   - every 2.1 flag still runs its command; `notice` is a command name only as the first word
 *   - an unknown argument is an error on both sides and names the nearest one
 *   - commands that need no server start none; the others start one; stop racing stop is not a refusal
 *   - import, export and wait on a home with no server work through a started one
 *   - explain: media of every kind and alias, paths against the project's working tree
 * Isolation:  every test has its own DECIDE_HOME; no test binds 47474 or opens a browser; every process is stopped by its pid.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { PROTOCOL } from "../lib/protocol.mjs";
import { nearest } from "../lib/registry/strict.mjs";
import { MEDIA, MEDIA_FIELDS, TYPES } from "../lib/registry/index.mjs";
import { deckLines, deckSchema, specSchema, typeLines } from "../lib/registry/docs.mjs";
import { COMMANDS, UserError, contextFor, runCommand, toolList } from "../lib/commands/index.mjs";
import { parseArgv } from "../lib/commands/argv.mjs";
import { alive, asAgent, asPage, collect, enginePath, envOf, exitOf, fakeServer, homeOf, notePid, pluginDir, scratchDir, silentServer, spawnServer } from "./helpers.mjs";

delete process.env.DECIDE_PORT;
process.env.DECIDE_NOTIFY = "0";

const surface = JSON.parse(readFileSync(path.join(pluginDir, "test/fixtures/2.1/surface.json"), "utf8"));
const names = COMMANDS.map((c) => c.name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spec = { title: "Colour", questions: [{ id: "color", title: "Which colour?", options: [{ id: "pink", label: "Pink" }, { id: "blue", label: "Blue" }] }] };

async function inHome(home, fn) {
  const saved = process.env.DECIDE_HOME;
  process.env.DECIDE_HOME = home;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.DECIDE_HOME;
    else process.env.DECIDE_HOME = saved;
  }
}
// What the MCP side does for one call.
const call = (home, name, args, extra = {}) => inHome(home, () => runCommand(name, args, contextFor(args, extra)));
const cliCall = (home, name, args) => call(home, name, args, { cli: true });

async function scratch(t) {
  const dir = await scratchDir(t);
  mkdirSync(homeOf(dir), { recursive: true });
  return { dir, home: homeOf(dir) };
}

// A round open on a server of the home that is then stopped: the round is on disk, no server runs.
async function roundOnDisk(t, { answer = false, title = "Colour" } = {}) {
  const { dir, home } = await scratch(t);
  const server = await spawnServer(t, home);
  const posted = await fetch(`http://127.0.0.1:${server.port}/api/rounds`, {
    method: "POST",
    headers: asAgent(server.port),
    body: JSON.stringify({ project: dir, spec: { ...spec, title }, outPath: path.join(dir, "colour.answers.json"), source: "colour.questions.json", open: false, live: true }),
  }).then((r) => r.json());
  if (answer) {
    const r = await fetch(`http://127.0.0.1:${server.port}/api/rounds/${posted.id}/submit`, { method: "POST", headers: asPage(server.port), body: JSON.stringify({ answers: { color: { selected: ["blue"] } } }) });
    assert.equal(r.status, 200);
  }
  await fetch(`http://127.0.0.1:${server.port}/api/stop`, { method: "POST", headers: asAgent(server.port) });
  for (let i = 0; i < 100 && alive(server.pid); i++) await sleep(50);
  assert.equal(alive(server.pid), false, "the server is gone");
  assert.equal(existsSync(path.join(home, "daemon.json")), false);
  return { dir, home, id: posted.id };
}

const logOf = (home, dir, id) => {
  const projects = path.join(home, "projects");
  for (const p of readdirSync(projects)) {
    const file = path.join(projects, p, "rounds", id, "events.jsonl");
    if (existsSync(file)) return readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  }
  throw new Error(`no log for ${id}`);
};

// ---- the table

test("lib/tools.mjs and lib/commands.mjs are gone; the table has the fifteen commands plus 3.0 patch", () => {
  assert.equal(existsSync(path.join(pluginDir, "lib/tools.mjs")), false);
  assert.equal(existsSync(path.join(pluginDir, "lib/commands.mjs")), false);
  assert.deepEqual(names, ["ask", "swipe", "wait", "push", "explain", "screenshot", "history", "supersede", "adr", "export", "import", "lint", "stop", "open", "notice", "patch"]);
  for (const c of COMMANDS) {
    assert.equal(typeof c.summary, "string", c.name);
    assert.equal(typeof c.run, "function", c.name);
    assert.equal(typeof c.mcp, "boolean", c.name);
    assert.equal(typeof c.cli, "boolean", c.name);
  }
});

test("swipe, push, lint and stop exist as MCP tools and as CLI commands; open and notice are CLI only", () => {
  const tools = toolList().map((t) => t.name);
  for (const name of ["swipe", "push", "lint", "stop"]) {
    assert.ok(tools.includes(name), `${name} is a tool`);
    assert.equal(parseArgv([name, ...(name === "push" ? ["1-abc"] : [])], { cwd: "/x" }).command, name, `${name} is a CLI command`);
  }
  for (const name of ["open", "notice"]) {
    assert.equal(tools.includes(name), false, `${name} is not a tool`);
    assert.equal(parseArgv([name], { cwd: "/x" }).command, name);
  }
});

test("tools/list has the eleven 2.1 tools plus lint, stop and patch, as 2.1 spelled them", () => {
  const tools = toolList();
  assert.deepEqual(tools.map((t) => t.name), [...surface.tools.map((t) => t.name), "lint", "stop", "patch"]);
  const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
  for (const old of surface.tools) {
    const now = tools.find((t) => t.name === old.name);
    assert.deepEqual(now.inputSchema.required ?? [], old.inputSchema.required ?? [], `${old.name}: required`);
    // 3.0 added one parameter to export, last: outside (a file outside the project).
    const added = old.name === "export" ? ["outside"] : old.name === "explain" ? ["patch"] : [];
    assert.deepEqual(Object.keys(now.inputSchema.properties), [...Object.keys(old.inputSchema.properties), ...added], `${old.name}: parameter names, in order`);
    if (old.name === "ask" || old.name === "swipe") {
      assert.ok(now.description.startsWith(old.description), `${old.name}: description starts as before`);
      const lines = old.name === "ask" ? typeLines() : deckLines();
      assert.equal(now.description, `${old.description}\n\n${lines}`, `${old.name}: the old description, then exactly its lines from the registry`);
      for (const [key, prop] of Object.entries(old.inputSchema.properties)) {
        if (key !== "spec") assert.equal(canon(now.inputSchema.properties[key]), canon(prop), `${old.name}.${key}`);
      }
      assert.equal(now.inputSchema.properties.spec.type, "object");
      assert.ok(now.inputSchema.properties.spec.description.startsWith(old.inputSchema.properties.spec.description.slice(0, 20)));
    } else {
      assert.equal(now.description, old.description, `${old.name}: description`);
      const { outside: _added, ...kept } = now.inputSchema.properties;
      // 3.0 added explain's optional patch.
      const { patch: _patch, ...keptExplain } = now.inputSchema.properties;
      const props = old.name === "export" ? kept : old.name === "explain" ? keptExplain : now.inputSchema.properties;
      assert.equal(canon({ ...now.inputSchema, properties: props }), canon(old.inputSchema), `${old.name}: schema`);
    }
  }
});

test("the spec property of ask and swipe is the registry's schema, built when asked, with its $defs at the tool's root", () => {
  const tools = toolList();
  for (const [name, schema] of [["ask", specSchema()], ["swipe", deckSchema()]]) {
    const input = tools.find((t) => t.name === name).inputSchema;
    assert.deepEqual(Object.keys(input.$defs).sort(), Object.keys(schema.$defs).sort(), `${name}: $defs`);
    assert.deepEqual(Object.keys(input.properties.spec.properties), Object.keys(schema.properties), `${name}: fields`);
    assert.equal(input.properties.spec.$defs, undefined, "no $defs nested where a $ref could not find them");
    const refs = [];
    JSON.stringify(input, (k, v) => (k === "$ref" && refs.push(v), v));
    assert.ok(refs.length > 0);
    for (const ref of refs) assert.ok(input.$defs[ref.replace("#/$defs/", "")], `${name}: ${ref} resolves in the tool's own schema`);
  }
});

test("explain takes the same fields on both sides, and every media kind and alias a question takes", () => {
  const explain = COMMANDS.find((c) => c.name === "explain");
  const toolFields = Object.keys(toolList().find((t) => t.name === "explain").inputSchema.properties);
  const cliFields = Object.entries(explain.params).filter(([, d]) => d.only !== "mcp" && !d.hidden).map(([n]) => n);
  for (const f of toolFields) assert.ok(cliFields.includes(f), `${f} is a CLI flag too`);
  for (const f of ["html", "preview", "image", "link", "videos", "links"]) assert.ok(f in explain.params, `${f} is accepted`);
  for (const f of Object.keys(MEDIA_FIELDS)) assert.ok(f in explain.params, `${f} (a media name) is accepted`);
  assert.deepEqual(parseArgv(["explain", "1-ab", "--question", "q", "--text", "t", "--ask-id", "a1", "--images", "a.png", "--images", "b.png"], { cwd: "/w" }).args, {
    round: "1-ab", question: "q", text: "t", askId: "a1", images: ["a.png", "b.png"],
  });
});

// ---- argv

const FLAG_TABLE = [
  [["x.questions.json"], "ask"], [["--demo"], "ask"], [["--live", "x.json", "--no-open"], "ask"],
  [["--wait", "1-ab"], "wait"], [["--wait", "1-ab", "--live"], "wait"],
  [["--reply", "1-ab", "--question", "q", "--text", "t"], "explain"],
  [["--shot", "http://x"], "screenshot"], [["--sim", "ios"], "screenshot"],
  [["--journal", "--limit", "3", "--query", "a", "--status", "live", "--topic", "t"], "history"],
  [["--supersede", "1-ab", "--by", "2-cd", "--reason", "r"], "supersede"],
  [["--export", "1-ab", "--out", "p.html"], "export"], [["--export", "x.questions.json"], "export"],
  [["--import", "a.answers.json", "b.answers.json", "--round", "1-ab", "--spec", "x.questions.json"], "import"],
  [["--adr", "1-ab", "--consequences", "c", "--adr-dir", "docs/d"], "adr"], [["--adr"], "adr"],
  [["--lint", "x.questions.json"], "lint"], [["--stop"], "stop"],
  [["--lint", "x.json", "--project", "/p"], "lint"], [["notice"], "notice"], [["--project", "/p", "notice"], "notice"],
];

test("every 2.1 flag still runs its command", () => {
  for (const [argv, command] of FLAG_TABLE) assert.equal(parseArgv(argv, { cwd: "/w" }).command, command, argv.join(" "));
  const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const known = new Set(["--project", ...COMMANDS.flatMap((c) => Object.entries(c.params).flatMap(([n, p]) => [`--${kebab(n)}`, ...(p.flags || [])]))]);
  for (const flag of [...surface.valueFlags, ...surface.booleanFlags]) {
    const used = FLAG_TABLE.some(([argv]) => argv.includes(flag));
    assert.ok(used || known.has(flag), `${flag} of 2.1 is covered by the table`);
  }
});

test("the flags of 2.1 fill the parameters they always did, and paths are read from the caller's directory", () => {
  const p = (argv) => parseArgv(argv, { cwd: "/w" }).args;
  assert.deepEqual(p(["a.json", "--out", "o.json", "--live", "--no-open", "--port", "5"]), { specPath: path.resolve("/w", "a.json"), out: path.resolve("/w", "o.json"), live: true, open: false, port: 5 });
  assert.deepEqual(p(["--import", "a.json", "b.json", "--round", "r", "--spec", "s.json"]), { files: [path.resolve("/w", "a.json"), path.resolve("/w", "b.json")], round: "r", specPath: path.resolve("/w", "s.json") });
  assert.deepEqual(p(["--reply", "r", "--question", "q", "r.json"]), { round: "r", question: "q", file: path.resolve("/w", "r.json") });
  assert.deepEqual(p(["--shot", "http://x", "--wait-ms", "9"]), { url: "http://x", waitMs: 9 });
  assert.deepEqual(p(["--adr", "r", "--adr-dir", "d"]), { round: "r", dir: "d" });
  assert.deepEqual(p(["--journal", "--limit", "3"]), { limit: 3 });
});

test("`notice` is a command name only as the first word: an argument called notice is an argument", () => {
  const imported = parseArgv(["--import", "notice"], { cwd: "/w" });
  assert.equal(imported.command, "import");
  assert.deepEqual(imported.args.files, [path.resolve("/w", "notice")]);
  assert.equal(parseArgv(["--lint", "notice"], { cwd: "/w" }).command, "lint");
  assert.equal(parseArgv(["wait", "notice"], { cwd: "/w" }).args.round, "notice");
  assert.equal(parseArgv(["notice", "--bogus"], { cwd: "/w" }).command, "notice", "the session-start hook never fails on a flag");
});

test("`decide.mjs --import notice` tries to read a file called notice, and does not print the notice", async (t) => {
  const { dir } = await scratch(t);
  const run = spawnSync(process.execPath, [enginePath, "--import", "notice", "--project", dir], { env: envOf(dir, { DECIDE_NOTIFY: "0" }), encoding: "utf8", cwd: dir });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Cannot read .*notice/);
});

test("an unknown option or command word is an error that names the nearest", () => {
  assert.throws(() => parseArgv(["wait", "1-ab", "--rond", "x"], { cwd: "/w" }), /unknown option "--rond"; did you mean "--round"\?/);
  assert.throws(() => parseArgv(["wiat", "1-ab"], { cwd: "/w" }), /unknown command "wiat"; did you mean "wait"\?/);
  assert.throws(() => parseArgv(["--adr", "r", "extra"], { cwd: "/w" }), /unexpected argument "extra"/);
});

// ---- unknown arguments on the MCP side

test("an MCP call with an unknown argument names the nearest one", async (t) => {
  const { home } = await scratch(t);
  await assert.rejects(call(home, "wait", { rond: "1-ab" }), (e) => e instanceof UserError && /Unknown argument "rond" for wait; did you mean "round"\?/.test(e.message));
  await assert.rejects(call(home, "history", { limt: 3 }), /did you mean "limit"\?/);
  await assert.rejects(call(home, "history", { live: true }), /Unknown argument "live" for history/, "a CLI-only flag is not an MCP argument");
});

test("no short wrong guess: a slip in a parameter name never points at another parameter", () => {
  for (const c of COMMANDS) {
    const known = Object.entries(c.params).filter(([, d]) => d.only !== "cli").map(([n]) => n);
    for (const p of known) {
      const slips = new Set();
      if (p.length > 3) for (let i = 0; i < p.length; i++) slips.add(p.slice(0, i) + p.slice(i + 1));
      for (let i = 0; i + 1 < p.length; i++) slips.add(p.slice(0, i) + p[i + 1] + p[i] + p.slice(i + 2));
      slips.delete(p);
      for (const slip of slips) {
        if (known.includes(slip)) continue;
        const guess = nearest(slip, known);
        // video and videos are both parameters: either is a fair answer for a slip of the other.
        assert.ok(guess === null || guess === p || guess.startsWith(p) || p.startsWith(guess), `${c.name}: "${slip}" (for ${p}) points at "${guess}"`);
      }
    }
  }
});

// ---- no server for what needs none

test("lint, history, adr, supersede, notice and screenshot start no server and leave no daemon.json", async (t) => {
  const { dir, home } = await scratch(t);
  const file = path.join(dir, "x.questions.json");
  writeFileSync(file, JSON.stringify(spec));
  const run = (name, args) =>
    inHome(home, () => {
      // The context is built inside the scratch home too: its project's data dir is looked up there.
      const never = { ...contextFor({ project: dir }), server: () => assert.fail("a server was asked for") };
      return runCommand(name, { project: dir, ...args }, { ...never, project: never.project });
    });
  assert.match((await run("lint", { specPath: file })).text, /decide lint: ok/);
  assert.match((await run("history", {})).text, /./);
  await assert.rejects(run("adr", {}), /No decisions recorded/);
  await assert.rejects(run("supersede", { round: "9-zzzzzz" }));
  await assert.rejects(run("screenshot", { simulator: "bogus" }));
  assert.equal((await inHome(home, () => runCommand("notice", { project: dir }, { ...contextFor({ project: dir }), noticeDir: dir }))).text, "");
  assert.equal(existsSync(path.join(home, "daemon.json")), false);
});

test("the CLI's lint and history leave no daemon.json in a cold home", async (t) => {
  const { dir, home } = await scratch(t);
  const file = path.join(dir, "x.questions.json");
  writeFileSync(file, JSON.stringify(spec));
  for (const argv of [["--lint", file], ["lint", file], ["--journal"], ["history"]]) {
    const run = spawnSync(process.execPath, [enginePath, ...argv, "--project", dir], { env: envOf(dir, { DECIDE_NOTIFY: "0" }), encoding: "utf8" });
    assert.equal(run.status, 0, `${argv.join(" ")}: ${run.stderr}`);
    assert.equal(existsSync(path.join(home, "daemon.json")), false, argv.join(" "));
  }
});

// ---- field modes

test("lint reads a spec strictly; import reads the saved spec leniently", async (t) => {
  const { dir, home } = await scratch(t);
  const odd = { title: "Odd", questions: [{ id: "q", title: "Which?", options: [{ id: "a", label: "A" }], bogus: 1 }] };
  const file = path.join(dir, "odd.questions.json");
  writeFileSync(file, JSON.stringify(odd));
  const linted = await call(home, "lint", { project: dir, specPath: file });
  assert.equal(linted.exit, 1);
  assert.match(linted.text, /unknown field "bogus"/);
  const answers = path.join(dir, "odd.answers.json");
  writeFileSync(answers, JSON.stringify({ round: "x-lenient", name: "Ann", answers: { q: { selected: ["a"] } } }));
  const imported = await call(home, "import", { project: dir, files: [answers], specPath: file });
  assert.match(imported.text, /answered/);
  assert.match(imported.text, /unknown field "bogus"/, "a warning, not an error");
});

// ---- the parked bugs

test("stop racing stop: a server that is already stopping is reported as stopping, exit 0", async (t) => {
  const { home } = await scratch(t);
  await fakeServer(t, home, PROTOCOL, (req, res) => {
    res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "this decide server is stopping" }));
  });
  const out = await call(home, "stop", {});
  assert.match(out.text, /is already stopping/);
  assert.doesNotMatch(out.text, /refused/);
  assert.equal(out.exit ?? 0, 0);
});

test("import on a home with no server settles the round through a started one", async (t) => {
  const { dir, home, id } = await roundOnDisk(t);
  const answers = path.join(dir, "ann.answers.json");
  writeFileSync(answers, JSON.stringify({ round: id, name: "Ann", answers: { color: { selected: ["blue"] } } }));
  const out = await call(home, "import", { project: dir, files: [answers] });
  assert.match(out.text, /answered/);
  await out.delivered?.();
  const kinds = logOf(home, dir, id).map((e) => e.type);
  assert.ok(kinds.includes("imported"), kinds.join());
  assert.equal(kinds.at(-1), "acked", "the importer has its answers: acknowledged");
  assert.ok(existsSync(path.join(home, "daemon.json")), "a server was started for it");
  const info = JSON.parse(readFileSync(path.join(home, "daemon.json"), "utf8"));
  const view = await fetch(`http://127.0.0.1:${info.port}/api/rounds/${id}`).then((r) => r.json());
  assert.equal(view.status, "answered", "the page does not show it pending after a restart");
});

test("export of an open round on a home with no server starts one and writes the page", async (t) => {
  const { dir, home, id } = await roundOnDisk(t);
  const out = await call(home, "export", { project: dir, round: id, out: "round.html" });
  assert.match(out.text, /Exported «Colour»/);
  assert.ok(existsSync(path.join(dir, "round.html")), "a relative out is read from the working tree");
});

test("an unknown round on export says the server does not know it", async (t) => {
  const { dir, home } = await scratch(t);
  await assert.rejects(call(home, "export", { project: dir, round: "9-aaaaaa" }), /Round 9-aaaaaa is unknown to the decide server/);
});

test("wait on a home with no server and a round on disk starts one and never says the page is not running", async (t) => {
  const { dir, home, id } = await roundOnDisk(t, { answer: true });
  const out = await call(home, "wait", { project: dir, round: id, timeoutSec: 5 });
  assert.match(out.text, /answered/);
  assert.doesNotMatch(out.text, /not running/);
  assert.equal(typeof out.delivered, "function");
  assert.equal(out.collects, id);
});

test("the CLI's --wait on a home with no server starts one too", async (t) => {
  const { dir, home, id } = await roundOnDisk(t, { answer: true });
  const child = spawn(process.execPath, [enginePath, "--wait", id, "--project", dir], { env: envOf(dir, { DECIDE_NOTIFY: "0" }), stdio: ["ignore", "pipe", "pipe"] });
  notePid(child.pid);
  t.after(() => child.exitCode === null && child.kill());
  const output = collect(child);
  assert.equal(await exitOf(child), 0, output.stderr);
  assert.match(output.stdout, /=== DECIDE ===/);
});

test("explain: relative paths are read from the project's working tree, not from the directory the caller named", async (t) => {
  const { dir, home } = await scratch(t);
  mkdirSync(path.join(dir, ".git"));
  mkdirSync(path.join(dir, "sub"));
  mkdirSync(path.join(dir, "shots"));
  writeFileSync(path.join(dir, "shots", "a.png"), "png");
  const server = await spawnServer(t, home);
  const posted = await fetch(`http://127.0.0.1:${server.port}/api/rounds`, {
    method: "POST",
    headers: asAgent(server.port),
    body: JSON.stringify({ project: dir, spec, outPath: path.join(dir, "c.answers.json"), source: "c.questions.json", open: false, live: true }),
  }).then((r) => r.json());
  const out = await call(home, "explain", { project: path.join(dir, "sub"), round: posted.id, question: "color", text: "because", images: "shots/a.png" });
  assert.match(out.text, /Explanation shown under question color\./);
  assert.doesNotMatch(out.text, /missing file/, out.text);
});

test("explain: every media kind and alias reaches the page as a question would have it; a string images works", async (t) => {
  const { dir, home } = await scratch(t);
  writeFileSync(path.join(dir, "a.png"), "png");
  writeFileSync(path.join(dir, "v.mp4"), "mp4");
  writeFileSync(path.join(dir, "p.html"), "<p>hi</p>");
  const server = await spawnServer(t, home);
  const posted = await fetch(`http://127.0.0.1:${server.port}/api/rounds`, {
    method: "POST",
    headers: asAgent(server.port),
    body: JSON.stringify({ project: dir, spec, outPath: path.join(dir, "c.answers.json"), source: "c.questions.json", open: false, live: true }),
  }).then((r) => r.json());
  const media = { html: "<b>x</b>", preview: "p.html", image: "a.png", link: { label: "L", url: "https://example.com" }, videos: "v.mp4", mermaid: "graph TD; A-->B" };
  const out = await call(home, "explain", { project: dir, round: posted.id, question: "color", text: "t", images: "a.png", ...media });
  assert.doesNotMatch(out.text, /Warnings/, out.text);
  const dialog = await fetch(`http://127.0.0.1:${server.port}/api/rounds/${posted.id}`).then((r) => r.json()).then((v) => v.dialog);
  const entry = dialog.flatMap((d) => (Array.isArray(d.entries) ? d.entries : [d])).find((e) => e.reply || e.media) || dialog[0];
  const shown = JSON.stringify(entry);
  for (const kind of ["images", "preview", "html", "mermaid", "links", "video"]) assert.match(shown, new RegExp(kind), `${kind} reached the page`);
  const q = await fetch(`http://127.0.0.1:${server.port}/api/rounds/${posted.id}`).then((r) => r.json());
  assert.ok(q);
});

test("explain says about an unknown media field that it is a warning, not a refusal", async (t) => {
  const { dir, home } = await scratch(t);
  const server = await spawnServer(t, home);
  const posted = await fetch(`http://127.0.0.1:${server.port}/api/rounds`, {
    method: "POST",
    headers: asAgent(server.port),
    body: JSON.stringify({ project: dir, spec, outPath: path.join(dir, "c.answers.json"), source: "c.questions.json", open: false, live: true }),
  }).then((r) => r.json());
  const out = await call(home, "explain", { project: dir, round: posted.id, question: "color", text: "t", chart: { type: "bar", labels: ["a"], series: [{ name: "s", values: [1] }], bogus: 1 } });
  assert.match(out.text, /Warnings: .*bogus/);
});

// ---- notice and open

test("the CLI gets the notice prefix; `notice` itself prints the line once", async (t) => {
  const { dir, home, id } = await roundOnDisk(t, { answer: true });
  const env = envOf(dir, { DECIDE_NOTIFY: "0", DECIDE_TEST_NOTICE_GRACE_MS: "0" });
  const history = spawnSync(process.execPath, [enginePath, "--journal", "--project", dir], { env, encoding: "utf8" });
  assert.equal(history.status, 0, history.stderr);
  assert.ok(history.stderr.startsWith(`decide: round ${id} "Colour" was answered at`), history.stderr);
  assert.match(history.stderr, new RegExp(`not collected; run node \\S*decide\\.mjs wait ${id}\\.`), "the CLI's wording, not the tool's");
  assert.doesNotMatch(history.stderr, /call wait \{/);
  assert.doesNotMatch(history.stdout, /decide: round/, "stdout is the command's own output");
  const notice = spawnSync(process.execPath, [enginePath, "notice", "--project", dir], { env, encoding: "utf8" });
  assert.equal(notice.stdout.split("\n").filter((l) => l.startsWith("decide: round")).length, 1);
  assert.equal(notice.status, 0);
});

test("open starts the server, says the page's address and opens nothing when DECIDE_NOTIFY=0", async (t) => {
  const { dir, home, id } = await roundOnDisk(t);
  const opened = [];
  const out = await call(home, "open", { project: dir, round: id }, { cli: true, openUrl: (u) => opened.push(u) });
  assert.match(out.text, /http:\/\/127\.0\.0\.1:\d+\/#r=/);
  assert.deepEqual(opened, [], "DECIDE_NOTIFY=0 keeps the browser shut");
  process.env.DECIDE_NOTIFY = "1";
  try {
    await call(home, "open", { project: dir, round: id }, { cli: true, openUrl: (u) => opened.push(u) });
  } finally {
    process.env.DECIDE_NOTIFY = "0";
  }
  assert.equal(opened.length, 1);
});

// ---- the real MCP process

test("a real MCP session: tools/list is the table's, and mcp.mjs carries no tool of its own", async (t) => {
  const { dir } = await scratch(t);
  const child = spawn(process.execPath, [path.join(pluginDir, "mcp.mjs")], { cwd: pluginDir, env: envOf(dir, { DECIDE_NOTIFY: "0" }), stdio: ["pipe", "pipe", "pipe"] });
  notePid(child.pid);
  t.after(() => child.exitCode === null && child.kill());
  const output = collect(child);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  for (let i = 0; i < 100 && output.stdout.split("\n").filter(Boolean).length < 2; i++) await sleep(50);
  const list = JSON.parse(output.stdout.split("\n").filter(Boolean)[1]);
  assert.deepEqual(list.result.tools, JSON.parse(JSON.stringify(toolList())));
  child.stdin.end();
  assert.equal(await exitOf(child), 0);
  const src = readFileSync(path.join(pluginDir, "mcp.mjs"), "utf8");
  assert.doesNotMatch(src, /inputSchema|HANDLERS|noticeFor/);
});

// ---- fix round 1: the default home, the CLI's batches, the notice, the busy server

const sleepMs = sleep;
// A CLI child that is not waited for: its output and the promise of its exit code.
function cliChild(dir, args, env = {}) {
  const child = spawn(process.execPath, [enginePath, ...args, "--project", dir], { env: envOf(dir, { DECIDE_NOTIFY: "0", ...env }), stdio: ["ignore", "pipe", "pipe"] });
  notePid(child.pid);
  const output = collect(child);
  return { child, output, exit: exitOf(child) };
}
const until = async (what, fn, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleepMs(25)) {
    const got = fn();
    if (got) return got;
  }
  throw new Error(`timed out waiting for ${what}`);
};

test("no test reaches the default home: with only HOME pointed at a scratch dir, commands create nothing in $HOME/.decide", async (t) => {
  const dir = await scratchDir(t);
  const fakeHome = path.join(dir, "userhome");
  mkdirSync(fakeHome);
  const file = path.join(dir, "x.questions.json");
  writeFileSync(file, JSON.stringify(spec));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: fakeHome, USERPROFILE: fakeHome });
  try {
    assert.ok(process.env.DECIDE_HOME, "test/helpers.mjs gives every test a scratch DECIDE_HOME of its own");
    assert.ok(!path.resolve(process.env.DECIDE_HOME).startsWith(path.join(fakeHome, ".decide")));
    // Outside inHome(): what a test that forgets to name its home does.
    const run = (name, args) => runCommand(name, { project: dir, ...args }, { ...contextFor({ project: dir }), server: () => assert.fail("a server was asked for") });
    await run("lint", { specPath: file });
    await run("history", {});
    await assert.rejects(run("adr", {}));
    await assert.rejects(run("supersede", { round: "9-zzzzzz" }));
    await assert.rejects(run("screenshot", { simulator: "bogus" }));
    await run("notice", {});
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
  assert.equal(existsSync(path.join(fakeHome, ".decide")), false, "nothing was written to the default home");
});

test("screenshot checks its arguments before it creates anything", async (t) => {
  const { dir, home } = await scratch(t);
  const bad = [
    [{ simulator: "bogus" }, /unknown simulator "bogus"/],
    [{ url: "http://localhost:1/", viewport: "tiny" }, /unknown viewport "tiny"/],
    [{ url: "ftp://x/y" }, /only http\(s\) pages/],
    [{ url: "not a url" }, /only http\(s\) pages/],
  ];
  for (const [args, message] of bad) {
    await assert.rejects(call(home, "screenshot", { project: dir, ...args }), message);
    await assert.rejects(call(home, "screenshot", { project: dir, ...args }, { cli: true }), message);
  }
  assert.equal(existsSync(path.join(home, "projects")), false, "no data dir was made for a call that could not run");
  // And the CLI of a process that has only a HOME.
  const userHome = path.join(dir, "userhome");
  mkdirSync(userHome);
  for (const argv of [["--sim", "bogus"], ["--shot", "ftp://x/y"], ["--shot", "http://localhost:1/", "--viewport", "tiny"]]) {
    const env = { ...process.env, HOME: userHome, USERPROFILE: userHome, DECIDE_NOTIFY: "0" };
    delete env.DECIDE_HOME;
    const run = spawnSync(process.execPath, [enginePath, ...argv, "--project", dir], { env, encoding: "utf8" });
    assert.notEqual(run.status, 0, argv.join(" "));
    assert.equal(existsSync(path.join(userHome, ".decide")), false, `${argv.join(" ")} created ~/.decide`);
  }
});

async function swipeRound(t, extra = {}) {
  const { dir, home } = await scratch(t);
  const deck = path.join(dir, "s.deck.json");
  const card = (id) => ({ id, title: `${id}?`, left: { label: `${id}-L` }, right: { label: `${id}-R` } });
  writeFileSync(deck, JSON.stringify({ title: "Deck", goal: "g", batch: 2, cards: ["a", "b", "c", "d", "e"].map(card), ...extra }));
  const started = spawnSync(process.execPath, [enginePath, "swipe", deck, "--no-open", "--project", dir], { env: envOf(dir, { DECIDE_NOTIFY: "0" }), encoding: "utf8" });
  assert.equal(started.status, 0, started.stderr);
  const [, id, url] = started.stdout.match(/Swipe round (\S+) .+: (http:\/\/127\.0\.0\.1:\d+\/)/);
  const port = Number(new URL(url).port);
  const post = (route, body) => fetch(`${url}api/rounds/${id}/${route}`, { method: "POST", headers: asPage(port), body: JSON.stringify(body) });
  return { dir, home, id, url, post };
}

test("CLI: a swipe batch is printed as a batch, exits with the ask code, and is acknowledged only after it was printed", async (t) => {
  const { dir, home, id, post } = await swipeRound(t);
  const waiting = cliChild(dir, ["wait", id, "--live"]);
  await sleepMs(300);
  await post("swipe", { card: "a", side: "left" });
  await post("swipe", { card: "b", side: "right" });
  assert.equal(await waiting.exit, 3, waiting.output.stderr);
  assert.match(waiting.output.stdout, /Batch 1 from swipe round \S+: 2 new answers; 2 answered, 3 left in the deck of 5\./);
  assert.match(waiting.output.stdout, /\[a\] a\? → a-L \(left\)/);
  assert.doesNotMatch(waiting.output.stdout, /undefined|=== DECIDE ===/);
  assert.match(waiting.output.stdout, new RegExp(`node \\S*decide\\.mjs push ${id}`), "it says how to go on from the CLI");
  const types = logOf(home, dir, id).map((e) => e.type);
  assert.equal(types.filter((x) => x === "acked").length, 1, types.join());
  assert.ok(types.lastIndexOf("acked") > types.indexOf("batch"), "acked after the batch");
  // It was collected: the next wait is not handed the same batch.
  const again = cliChild(dir, ["wait", id, "--live"]);
  await sleepMs(1200);
  assert.equal(again.child.exitCode, null, "nothing new: still waiting");
  again.child.kill();
  await again.exit;
});

test("CLI: a dig-deeper press is printed as one, exits with the ask code and is acknowledged", async (t) => {
  const { dir, home, id, post } = await swipeRound(t, { batch: 5 });
  await post("swipe", { card: "a", side: "left" });
  const waiting = cliChild(dir, ["wait", id, "--live"]);
  await sleepMs(300);
  assert.equal((await post("deeper", { note: "dig into money" })).status, 200);
  assert.equal(await waiting.exit, 3, waiting.output.stderr);
  assert.match(waiting.output.stdout, /asked to dig deeper in swipe round \S+ \(time 1\)/);
  assert.match(waiting.output.stdout, /> dig into money/);
  assert.doesNotMatch(waiting.output.stdout, /undefined/);
  const types = logOf(home, dir, id).map((e) => e.type);
  assert.ok(types.includes("acked"), types.join());
});

test("CLI: an item of a kind it cannot format is never acknowledged", async (t) => {
  const { dir, home } = await scratch(t);
  const acks = [];
  await fakeServer(t, home, PROTOCOL, (req, res, body) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.includes("/ack")) {
      acks.push(body);
      return res.end("{}");
    }
    res.end(JSON.stringify({ kind: "mystery", seq: 7, payload: { round: "1-ab" } }));
  });
  const run = cliChild(dir, ["wait", "1-ab", "--live"]);
  const code = await run.exit;
  assert.notEqual(code, 0);
  assert.notEqual(code, 3, "not the ask code: nothing was handed to the agent");
  assert.match(run.output.stderr, /mystery/);
  assert.deepEqual(acks, [], "no ack for an item that was not printed");
});

test("the CLI's notice goes to stderr in the CLI's words and never into the output; an agent's result keeps its prefix", async (t) => {
  const { dir, home, id } = await roundOnDisk(t, { answer: true });
  const env = envOf(dir, { DECIDE_NOTIFY: "0", DECIDE_TEST_NOTICE_GRACE_MS: "0" });
  for (const argv of [["--journal"], ["--lint", path.join(dir, "colour.questions.json")]]) {
    writeFileSync(path.join(dir, "colour.questions.json"), JSON.stringify(spec));
    const run = spawnSync(process.execPath, [enginePath, ...argv, "--project", dir], { env, encoding: "utf8" });
    assert.match(run.stderr, new RegExp(`^decide: round ${id} "Colour" was answered at .*run node \\S*decide\\.mjs wait ${id}\\.`), argv.join(" "));
    assert.doesNotMatch(run.stdout, /decide: round/, argv.join(" "));
  }
  process.env.DECIDE_TEST_NOTICE_GRACE_MS = "0";
  try {
    const out = await call(home, "history", { project: dir });
    assert.ok(out.text.startsWith(`decide: round ${id} "Colour" was answered at`), out.text);
    assert.match(out.text.split("\n")[0], /call wait \{round: "/);
  } finally {
    delete process.env.DECIDE_TEST_NOTICE_GRACE_MS;
  }
});

test("an agent that names no project still hears the notice: the project is found as the command finds it", async (t) => {
  const { dir, home, id } = await roundOnDisk(t, { answer: true });
  process.env.DECIDE_TEST_NOTICE_GRACE_MS = "0";
  const saved = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = dir;
  try {
    const out = await call(home, "history", {});
    assert.ok(out.text.startsWith(`decide: round ${id} "Colour"`), out.text);
  } finally {
    delete process.env.DECIDE_TEST_NOTICE_GRACE_MS;
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = saved;
  }
});

test("ask, swipe and open give a busy server the patience of ensureServer before they say it is busy; the others fail at once", async (t) => {
  const { dir, home } = await scratch(t);
  await silentServer(t, home, PROTOCOL);
  const timed = async (name, args) => {
    const began = Date.now();
    await assert.rejects(call(home, name, { project: dir, ...args }), /is not answering/);
    return Date.now() - began;
  };
  assert.ok((await timed("push", { round: "1-ab" })) < 3_000, "push fails fast");
  assert.ok((await timed("explain", { round: "1-ab", question: "q", text: "t" })) < 3_000, "explain fails fast");
  const deck = { title: "D", goal: "g", cards: [{ id: "a", title: "a?", left: { label: "l" }, right: { label: "r" } }] };
  for (const [name, args] of [["ask", { spec }], ["swipe", { spec: deck }]]) assert.ok((await timed(name, args)) >= 5_000, `${name} waits as 2.1 did`);
  const began = Date.now();
  await assert.rejects(call(home, "open", { project: dir }, { cli: true }), /is not answering/);
  assert.ok(Date.now() - began >= 5_000, "open waits too");
});

test("open puts the round id in the page address encoded", async (t) => {
  const { dir, home } = await scratch(t);
  await fakeServer(t, home, PROTOCOL, (req, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
  const out = await call(home, "open", { project: dir, round: "a b#c" }, { cli: true });
  assert.match(out.text, /\/#r=a%20b%23c$/);
});

test("lib/transfer.mjs, a lower layer, imports nothing from lib/commands", () => {
  assert.doesNotMatch(readFileSync(path.join(pluginDir, "lib/transfer.mjs"), "utf8"), /commands\//);
});

test("swipe's description ends with what a deck carries (card fields, media kinds), not the question types", () => {
  const swipe = toolList().find((x) => x.name === "swipe").description;
  const lines = deckLines();
  assert.ok(swipe.endsWith(lines));
  for (const type of TYPES.keys()) assert.doesNotMatch(swipe, new RegExp(`^${type}: `, "m"), `no question type "${type}"`);
  for (const field of ["left", "right", "recommended", "tldr", "from"]) assert.match(lines, new RegExp(`^${field}: `, "m"), `card field ${field}`);
  for (const kind of MEDIA.keys()) assert.match(lines, new RegExp(`^${kind}: `, "m"), `media kind ${kind}`);
  assert.doesNotMatch(lines, /^(question|options|type): /m, "nothing only a question has");
  assert.doesNotMatch(lines, /^(images|preview|chart): .*(can be marked up|notes pinned|share a scale)/m, "a card has no mark-up, pinned notes or sibling options");
  assert.ok(toolList().find((x) => x.name === "ask").description.endsWith(typeLines()), "ask keeps the question types");
});
