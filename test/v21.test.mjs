// What 2.1 added: md tables with | inside links and code, attention budget,
// questions only the user answers, hesitation in swipe, superseded decisions
// and overlap warnings, ADR files, export / import of a round, and
// simulator screenshots.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { md } from "../ui/js/md.js";
import { finalizeAnswers, missingMine } from "../ui/js/logic.js";
import { normalizeSpec } from "../lib/spec.mjs";
import { batchDigest, normalizeDeck } from "../lib/swipe.mjs";
import { createRoots } from "../lib/assets.mjs";
import { createStore } from "../lib/store/rounds.mjs";
import { appendJournal, formatJournal, overlaps, readJournal, supersedeJournal } from "../lib/journal.mjs";
import { markAdrSuperseded, writeAdr } from "../lib/adr.mjs";
import { exportSpec, findExport, rewriteImports } from "../lib/export.mjs";
import { checkAnswers, compareAnswers } from "../lib/answers.mjs";
import { exportRound, importAnswers } from "../lib/transfer.mjs";
import { captureSim } from "../lib/shot.mjs";
import { prepareSpec } from "../lib/prepare.mjs";
import { PROTOCOL } from "../lib/protocol.mjs";
import { fakeServer, homeOf, pluginDir, scratchDir } from "./helpers.mjs";

const choice = (id, title, extra = {}) => ({
  id,
  title,
  type: "single",
  options: [
    { id: "a", label: "Option A", recommended: true, pros: ["fast"], cons: ["costly"] },
    { id: "b", label: "Option B" },
  ],
  ...extra,
});

test("md: a | inside a link or code stays in its table cell", () => {
  const html = md("| link | code |\n|---|---|\n| [x|y](https://e.com/a|b) | `c|d` |");
  const row = html.match(/<tbody>[\s\S]*?<\/tbody>/)[0];
  assert.equal((row.match(/<td/g) || []).length, 2);
  assert.match(row, /href="https:\/\/e\.com\/a\|b"/);
  assert.match(row, /<code>c\|d<\/code>/);
  assert.match(md("| a \\| b | c |\n|---|---|\n| 1 | 2 |"), /a \| b/);
});

test("budget keeps what fits by priority and lists the rest as left out", () => {
  const questions = Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, title: `Question ${i}`, type: "text", priority: i === 7 ? 1 : 3 }));
  const { spec } = normalizeSpec({ title: "Budget", budget: 1, questions });
  assert.ok(spec.questions.length >= 1 && spec.questions.length < 12);
  assert.ok(spec.questions.some((q) => q.id === "q7"), "priority 1 is kept");
  assert.equal(spec.questions.length + spec.leftOut.length, 12);
  assert.ok(spec.estimateMin <= 1);
});

test("budget never drops every question when the first pick depends on another", () => {
  const opts = Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
  const { spec } = normalizeSpec({
    title: "Budget",
    budget: 1,
    questions: [
      { id: "base", title: "Base", priority: 3, options: opts },
      { id: "main", title: "Main", priority: 1, options: opts, showIf: { q: "base", is: "o1" } },
    ],
  });
  assert.deepEqual(spec.questions.map((q) => q.id), ["base", "main"]);
});

test("mine: never auto-filled and blocks review until answered", () => {
  const { spec } = normalizeSpec({ title: "Mine", questions: [choice("own", "Theirs to pick", { mine: true }), choice("free", "Anyone")] });
  const final = finalizeAnswers(spec, {}, { fill: "recommend" });
  assert.equal(final.own.flag, "skip");
  assert.deepEqual(final.free.selected, ["a"]);
  assert.deepEqual(
    missingMine(spec, {}).map((q) => q.id),
    ["own"],
  );
});

test("swipe: a long read or a retaken card is marked hesitated", async (t) => {
  const dir = await scratchDir(t);
  const { deck } = normalizeDeck({ title: "Deck", goal: "g", cards: [{ id: "c1", title: "Short", left: "No", right: "Yes" }] });
  const store = createStore({ home: homeOf(dir), roots: createRoots() });
  try {
    const project = { root: dir, dataDir: path.join(homeOf(dir), "projects", "p") };
    const round = store.create({ project, spec: deck, raw: deck, outPath: path.join(dir, "d.answers.json"), source: "d", mode: "swipe" });
    store.swipeAnswer(round, { card: "c1", side: "right", ms: 1000 });
    assert.equal(round.state.swipe.answers.c1.hesitated, undefined);
    store.swipeAnswer(round, { card: "c1", undo: true });
    store.swipeAnswer(round, { card: "c1", side: "left", ms: 1000 });
    assert.equal(round.state.swipe.answers.c1.hesitated, true);
    assert.match(batchDigest(round.spec, round.state.swipe.log.slice(-1)), /not sure or hesitated/);
  } finally {
    store.close(); // the log is closed before the scratch dir goes (Windows cannot remove open files)
  }
});

function journalWith(dataDir, specFile, outPath, title, questions, answers = {}) {
  const spec = normalizeSpec({ title, questions }).spec;
  const round = { mode: "questions", spec, specFile, outPath };
  const id = `r-${title.length}-${questions.length}`;
  const result = { round: id, title, submittedAt: "2026-10-01T10:00:00.000Z", answers, digest: `1. ${questions[0].title} → Option A` };
  writeFileSync(outPath, JSON.stringify(result));
  appendJournal(dataDir, round, result);
  return id;
}

test("supersede folds into the journal; overlaps warn only about live decisions", async (t) => {
  const dir = await scratchDir(t);
  const old = journalWith(dir, "", path.join(dir, "a.answers.json"), "Storage", [choice("db", "Which database engine do we store orders in?")]);
  const other = journalWith(dir, "", path.join(dir, "b.answers.json"), "Login method", [choice("auth", "How do people sign in?"), choice("x", "Something else")]);
  assert.equal(overlaps(dir, ["Which database engine should store the orders?"]).length, 1);
  assert.equal(overlaps(dir, ["What colour is the button?"]).length, 0);
  assert.throws(() => supersedeJournal(dir, { round: "nope" }), /no decision/);
  assert.throws(() => supersedeJournal(dir, { round: old, by: old }), /itself/);
  const marked = supersedeJournal(dir, { round: old, by: other, reason: "moved to SQLite" });
  assert.equal(marked.superseded.by, other);
  assert.equal(overlaps(dir, ["Which database engine should store the orders?"]).length, 0);
  assert.deepEqual(
    readJournal(dir, { status: "superseded" }).map((e) => e.round),
    [old],
  );
  assert.deepEqual(
    readJournal(dir, { status: "live" }).map((e) => e.round),
    [other],
  );
  assert.match(formatJournal(readJournal(dir, { status: "superseded" })), /Superseded by round .*moved to SQLite/);
});

test("adr: numbered file with context, options, decision, consequences; rewritten in place", async (t) => {
  const dir = await scratchDir(t);
  const specFile = path.join(dir, "store.questions.json");
  const raw = { title: "Storage", intro: "Orders outgrow the JSON file.", questions: [choice("db", "Which database?")] };
  writeFileSync(specFile, JSON.stringify(raw));
  mkdirSync(path.join(dir, "docs/decisions"), { recursive: true });
  writeFileSync(path.join(dir, "docs/decisions/0003-older.md"), "# 3. Older\n");
  const id = journalWith(dir, specFile, path.join(dir, "store.answers.json"), "Storage", raw.questions, { db: { selected: ["a"] } });
  const entry = readJournal(dir).find((e) => e.round === id);
  const first = writeAdr({ root: dir, entry, consequences: "We run a migration." });
  assert.equal(path.basename(first.file), "0004-storage.md");
  assert.ok(first.created);
  const text = readFileSync(first.file, "utf8");
  for (const part of ["# 0004. Storage", "- Status: Accepted", "## Context", "Orders outgrow the JSON file.", "## Options", "Option A (recommended)", "## Decision", "**Which database?** → Option A", "## Consequences", "We run a migration.", "Option A, cost: costly"]) {
    assert.ok(text.includes(part), `missing ${part}`);
  }
  const again = writeAdr({ root: dir, entry });
  assert.equal(again.file, first.file);
  assert.equal(again.created, false);
  const gone = supersedeJournal(dir, { round: id, reason: "changed our mind" });
  markAdrSuperseded(dir, gone);
  assert.match(readFileSync(first.file, "utf8"), /- Status: Superseded: changed our mind/);
  markAdrSuperseded(dir, { ...gone, superseded: { reason: "costs $& and $' more" } });
  assert.match(readFileSync(first.file, "utf8"), /- Status: Superseded: costs \$& and \$' more$/m);
});

test("export: one self-contained page, its modules resolved through the import map", async (t) => {
  const dir = await scratchDir(t);
  const specPath = path.join(pluginDir, "examples/showcase.questions.json");
  const { spec } = await prepareSpec(JSON.parse(readFileSync(specPath, "utf8")), { specDir: path.dirname(specPath), dataDir: dir, shots: false });
  const out = path.join(dir, "tour.decide.html");
  const built = await exportSpec(spec, { id: "x1", from: "showcase.questions.json", out });
  const html = readFileSync(out, "utf8");
  assert.equal(built.missing.length, 0);
  assert.doesNotMatch(html, /["(]\/ui\//);
  assert.doesNotMatch(html, /\/r\/[0-9a-f]{8,}\//);
  assert.match(html, /data:image\/svg\+xml;name=home-list\.svg;base64,/);
  assert.match(html, /data:text\/html;charset=utf-8;name=card\.html;base64,/);
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
  for (const [key, uri] of Object.entries(map.imports)) {
    const source = Buffer.from(uri.split(",")[1], "base64").toString("utf8");
    for (const [, spec] of source.matchAll(/^\s*(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']/gm)) assert.ok(map.imports[spec], `${key} imports ${spec}, missing from the map`);
  }
  assert.match(Buffer.from(map.imports["@decide/net.js"].split(",")[1], "base64").toString(), /export const offline = true/);
  // $-patterns in spec text stay literal; a file name with ")" is still inlined.
  const odd = path.join(dir, "odd");
  mkdirSync(odd);
  writeFileSync(path.join(odd, "shot (1).svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  const tricky = await prepareSpec(
    { title: "Cost $& x", questions: [{ id: "q", title: "echo $'a' and $$", images: ["shot (1).svg"], options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] },
    { specDir: odd, dataDir: dir, shots: false },
  );
  const oddOut = path.join(dir, "odd.decide.html");
  const oddBuilt = await exportSpec(tricky.spec, { id: "x2", out: oddOut });
  const oddHtml = readFileSync(oddOut, "utf8");
  assert.deepEqual(oddBuilt.missing, []);
  assert.match(oddHtml, /<title>Cost \$&amp; x — decide<\/title>/);
  const payload = JSON.parse(oddHtml.match(/<script type="application\/json" id="decide-export">([\s\S]*?)<\/script>/)[1]);
  assert.equal(payload.round.spec.questions[0].title, "echo $'a' and $$");
  assert.match(payload.round.spec.questions[0].images[0].src, /^data:image\/svg\+xml;name=shot%20\(1\)\.svg;base64,/);
  assert.equal(rewriteImports('import en from "./lang/en.js";', "i18n.js"), 'import en from "@decide/lang/en.js";');
  assert.equal(rewriteImports('import { x } from "../dom.js";', "lang/en.js"), 'import { x } from "@decide/dom.js";');
});

test("import: a round the server does not know: one file settles it offline, several show disagreements", async (t) => {
  const dir = await scratchDir(t);
  const project = { root: dir, dataDir: path.join(dir, ".data") };
  const specPath = path.join(dir, "pick.questions.json");
  const raw = { title: "Pick", questions: [choice("db", "Which database?"), choice("ui", "Which layout?")] };
  writeFileSync(specPath, JSON.stringify(raw));
  const { id, file } = await exportRound({ project, raw, specPath, specDir: dir });
  assert.ok(existsSync(file));
  assert.equal(findExport(project.dataDir, id).specFile, specPath);
  const ann = path.join(dir, "ann.answers.json");
  const bob = path.join(dir, "bob.answers.json");
  writeFileSync(ann, JSON.stringify({ round: id, name: "Ann", answers: { db: { selected: ["a"] }, ui: { selected: ["a"] }, ghost: { text: "?" } } }));
  writeFileSync(bob, JSON.stringify({ round: id, name: "Bob", answers: { db: { selected: ["b"] }, ui: { selected: ["a", "zz"] } } }));

  // A server that does not know the round (404): the answers are read offline, as for a round of another version.
  const fake = await fakeServer(t, homeOf(dir), PROTOCOL, (req, res) => res.writeHead(404, { "content-type": "application/json" }).end('{"error":"no such round"}'));
  const getServer = async () => fake;
  const both = await importAnswers({ project, files: [ann, bob], getServer });
  assert.match(both, /They disagree on 1 question:\n- Which database\?/);
  assert.match(both, /ghost.*not in this round/);
  assert.match(both, /zz/);
  assert.equal(readJournal(project.dataDir).length, 0, "several files settle nothing");

  const one = await importAnswers({ project, files: [ann], getServer });
  assert.match(one, /answered \(2 answers\) by Ann/);
  const saved = JSON.parse(readFileSync(path.join(dir, "pick.answers.json"), "utf8"));
  assert.equal(saved.name, "Ann");
  assert.deepEqual(saved.answers.db.selected, ["a"]);
  assert.equal(readJournal(project.dataDir)[0].round, id);
  await assert.rejects(importAnswers({ project, files: [ann], getServer }), /already settled/);
});

test("checkAnswers keeps a question only the user may answer out of someone else's auto-fill", () => {
  const { spec } = normalizeSpec({ title: "T", questions: [choice("q", "Q", { mine: true })] });
  const { answers } = checkAnswers(spec, { answers: { q: { selected: ["a"], flag: "delegate", auto: true } } });
  assert.equal(answers.q.flag, "skip");
  assert.deepEqual(compareAnswers(spec, [{ answers: { q: { selected: ["a"] } } }, { answers: { q: { selected: ["a"] } } }]).disagreements, []);
});

test("simulator screenshots run simctl / adb and explain a missing device", async (t) => {
  const dir = await scratchDir(t);
  const bin = (name, body) => {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const saved = { simctl: process.env.DECIDE_SIMCTL, adb: process.env.DECIDE_ADB };
  t.after(() => {
    for (const [k, v] of [["DECIDE_SIMCTL", saved.simctl], ["DECIDE_ADB", saved.adb]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
  process.env.DECIDE_SIMCTL = bin("simctl", '[ "$1 $2 $3" = "io booted screenshot" ] && printf IOSPNG > "$4"');
  process.env.DECIDE_ADB = bin("adb", '[ "$1 $2 $3" = "exec-out screencap -p" ] && printf DROIDPNG');
  const ios = await captureSim({ simulator: "ios", dir: path.join(dir, "shots"), name: "home" });
  assert.equal(readFileSync(ios, "utf8"), "IOSPNG");
  const droid = await captureSim({ simulator: "android", dir: path.join(dir, "shots") });
  assert.equal(readFileSync(droid, "utf8"), "DROIDPNG");
  process.env.DECIDE_SIMCTL = bin("simctl-off", 'echo "No devices are booted." >&2; exit 149');
  await assert.rejects(captureSim({ simulator: "ios", dir: path.join(dir, "shots") }), /No devices are booted\..*simctl boot/);
  await assert.rejects(captureSim({ simulator: "watch", dir }), /unknown simulator/);
});


// ---- export limits (Task 15)

const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("export outside the project is refused without the flag, and the error names it", async (t) => {
  const dir = await scratchDir(t);
  const elsewhere = await scratchDir(t);
  const project = { root: dir, top: dir, dataDir: path.join(dir, ".data") };
  const raw = { title: "Pick", questions: [choice("db", "Which database?")] };
  const specPath = path.join(dir, "pick.questions.json");
  writeFileSync(specPath, JSON.stringify(raw));
  const target = path.join(elsewhere, "out.decide.html");
  await assert.rejects(exportRound({ project, raw, specPath, specDir: dir, out: target }), /--outside/);
  assert.equal(existsSync(target), false, "nothing was written");
  // Inside the project, and inside the data dir, it goes through.
  const inside = await exportRound({ project, raw, specPath, specDir: dir, out: "sub/in.decide.html" });
  assert.ok(existsSync(inside.file));
  const data = await exportRound({ project, raw, specPath, specDir: dir, out: path.join(project.dataDir, "kept.html") });
  assert.ok(existsSync(data.file));
  // The flag lets it out.
  const out = await exportRound({ project, raw, specPath, specDir: dir, out: target, outside: true });
  assert.ok(existsSync(out.file));
  // ".." is judged after it is resolved.
  await assert.rejects(exportRound({ project, raw, specPath, specDir: dir, out: path.join("..", path.basename(elsewhere), "again.html") }), /--outside/);
});

test("export outside is judged on real paths: a symlink in the project that points out is outside (skipped on win32: needs symlinks)", { skip: process.platform === "win32" }, async (t) => {
  const dir = await scratchDir(t);
  const elsewhere = await scratchDir(t);
  const project = { root: dir, top: dir, dataDir: path.join(dir, ".data") };
  const raw = { title: "Pick", questions: [choice("db", "Which database?")] };
  const specPath = path.join(dir, "pick.questions.json");
  writeFileSync(specPath, JSON.stringify(raw));
  symlinkSync(elsewhere, path.join(dir, "link"));
  await assert.rejects(exportRound({ project, raw, specPath, specDir: dir, out: "link/out.html" }), /--outside/);
  assert.equal(readdirSync(elsewhere).length, 0);
  writeFileSync(path.join(elsewhere, "taken.html"), "old");
  symlinkSync(path.join(elsewhere, "taken.html"), path.join(dir, "taken.html"));
  await assert.rejects(exportRound({ project, raw, specPath, specDir: dir, out: "taken.html" }), /--outside/);
  assert.equal(readFileSync(path.join(elsewhere, "taken.html"), "utf8"), "old");
});

test("an export over 60 MB fails before reading the media, and leaves no file", async (t) => {
  const dir = await scratchDir(t);
  writeFileSync(path.join(dir, "big.png"), PNG1);
  truncateSync(path.join(dir, "big.png"), 61 * 1024 * 1024); // sparse: no disk, and reading it would take far longer
  const { spec } = await prepareSpec({ title: "Big", questions: [{ id: "q", title: "Q", images: ["big.png"], options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] }, { specDir: dir, dataDir: dir, shots: false });
  const out = path.join(dir, "big.decide.html");
  const started = Date.now();
  await assert.rejects(exportSpec(spec, { id: "x9", out }), (err) => err.name === "UserError" || err.user === true ? /60 MB/.test(err.message) : false);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  assert.deepEqual(readdirSync(dir).filter((f) => f !== "big.png"), [], "no half file, no temp file");
});

test("the 60 MB counts what is written: base64 growth and the Mermaid frame, estimated by stat before any read", async (t) => {
  const dir = await scratchDir(t);
  const png = (mb) => {
    writeFileSync(path.join(dir, "mid.png"), PNG1);
    truncateSync(path.join(dir, "mid.png"), mb * 1024 * 1024); // sparse
  };
  const q = (extra = {}) => ({ id: "q", title: "Q", images: ["mid.png"], ...extra, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
  // 46 MB raw is under 60 MB, but it is 61 MB once written as base64.
  png(46);
  let { spec } = await prepareSpec({ title: "Mid", questions: [q()] }, { specDir: dir, dataDir: dir, shots: false });
  const started = Date.now();
  await assert.rejects(exportSpec(spec, { id: "x6", out: path.join(dir, "mid.decide.html") }), /60 MB/);
  // 44 MB raw is 58.7 MB written; with the diagram frame (4.8 MB written) it is over.
  png(44);
  ({ spec } = await prepareSpec({ title: "Mid", questions: [q({ mermaid: "flowchart LR\n  A --> B" })] }, { specDir: dir, dataDir: dir, shots: false }));
  await assert.rejects(exportSpec(spec, { id: "x5", out: path.join(dir, "mid2.decide.html") }), /60 MB/);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms: nothing was read`);
  assert.deepEqual(readdirSync(dir).filter((f) => f !== "mid.png"), [], "no half file, no temp file");
});

test("a failed export leaves the file that was there", async (t) => {
  const dir = await scratchDir(t);
  const out = path.join(dir, "keep.decide.html");
  writeFileSync(out, "old export");
  writeFileSync(path.join(dir, "big.png"), PNG1);
  truncateSync(path.join(dir, "big.png"), 61 * 1024 * 1024);
  const { spec } = await prepareSpec({ title: "Big", questions: [{ id: "q", title: "Q", images: ["big.png"], options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] }, { specDir: dir, dataDir: dir, shots: false });
  await assert.rejects(exportSpec(spec, { id: "x9", out }));
  assert.equal(readFileSync(out, "utf8"), "old export");
});

test("a mockup's own files count toward the 60 MB, (a mockup's files are counted once per use, like a picture)", async (t) => {
  const dir = await scratchDir(t);
  writeFileSync(path.join(dir, "card.html"), '<img src="huge.png"><p>x</p>');
  writeFileSync(path.join(dir, "huge.png"), PNG1);
  truncateSync(path.join(dir, "huge.png"), 61 * 1024 * 1024);
  const { spec } = await prepareSpec({ title: "M", questions: [{ id: "q", title: "Q", preview: "card.html", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] }, { specDir: dir, dataDir: dir, shots: false });
  await assert.rejects(exportSpec(spec, { id: "x8", out: path.join(dir, "m.decide.html") }), /60 MB/);
});

test("a picture used in several questions counts once per use, because each use is written into the page", async (t) => {
  const dir = await scratchDir(t);
  writeFileSync(path.join(dir, "one.png"), PNG1);
  truncateSync(path.join(dir, "one.png"), 12 * 1024 * 1024); // 16 MB written: fine once, 96 MB in six questions
  const q = (n) => ({ id: `q${n}`, title: `Q${n}`, images: ["one.png"], options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
  const { spec } = await prepareSpec({ title: "Six", questions: [1, 2, 3, 4, 5, 6].map(q) }, { specDir: dir, dataDir: dir, shots: false });
  const started = Date.now();
  await assert.rejects(exportSpec(spec, { id: "x4", out: path.join(dir, "six.decide.html") }), /60 MB/);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms: nothing was read`);
  assert.deepEqual(readdirSync(dir).filter((f) => f !== "one.png"), [], "no half file, no temp file");
});

test("an exported round with mermaid has no external URL in script or link tags, and draws offline", async (t) => {
  const dir = await scratchDir(t);
  const { spec } = await prepareSpec({ title: "Flow", questions: [{ id: "q", title: "Q", mermaid: "flowchart LR\n  A --> B", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] }, { specDir: dir, dataDir: dir, shots: false });
  const out = path.join(dir, "flow.decide.html");
  const built = await exportSpec(spec, { id: "x7", out });
  const html = readFileSync(out, "utf8");
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/gi) || []) assert.doesNotMatch(tag, /(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i, tag.slice(0, 120));
  assert.doesNotMatch(html, /cdn\.jsdelivr|unpkg\.com|cdnjs/i);
  const frame = JSON.parse(html.match(/<script type="application\/json" id="decide-mermaid">([\s\S]*?)<\/script>/)[1]);
  assert.match(frame.frame, /^<!doctype html>/i);
  assert.match(frame.frame, /<script src="data:text\/javascript;base64,/);
  assert.ok(built.bytes > 3_000_000, "the bundle is inside");
  // A round without a diagram carries none of it.
  const plain = await prepareSpec({ title: "Plain", questions: [{ id: "q", title: "Q", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] }, { specDir: dir, dataDir: dir, shots: false });
  const plainBuilt = await exportSpec(plain.spec, { id: "x6", out: path.join(dir, "plain.decide.html") });
  assert.ok(plainBuilt.bytes < 1_500_000, `${plainBuilt.bytes} bytes`);
  assert.doesNotMatch(readFileSync(path.join(dir, "plain.decide.html"), "utf8"), /id="decide-mermaid"/);
});
