/**
 * Feature:    code review mode (/decide:review)
 * Layer:      the diff parser, hunk-to-chapter assignment, the spec lint and the verdict digest (pure);
 *             read-only git and the snapshot (a fixture repository); MCP review → wait → explain → verdict
 * Contract:   skills/review/SKILL.md, docs/plans/2026-11-17-review.md
 * Covers:
 *   - The unified-diff parser: line numbers, renames, binary files, "\ No newline at end of file", quoted names, mode changes
 *   - A hunk goes to the first chapter that names it, then to a mechanical group; the rest is counted and named
 *   - The spec lint: what stops a review and what only warns
 *   - git refuses a ref or a path that starts with "-", a path outside the project, and a file not in the snapshot
 *   - The snapshot is the branch against its base, taken once and read back from the round's folder
 *   - A question on a line reaches the agent at once; the verdict comes with every comment, by kind
 * Why exists: the reviewer's verdict is only worth something if every hunk of the diff was on the page,
 *             on the right line, and nothing the page or a spec names can make git do more than read.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkPath, checkRef, checkSnapshotPath, fileAt, resolveCommit } from "../lib/git.mjs";
import { assign, isTestFile, piecesOf, refMatcher } from "../lib/review/chapters.mjs";
import { formatReviewResult, reviewResult } from "../lib/review/digest.mjs";
import { parsePatch, patchStats, unquote } from "../lib/review/patch.mjs";
import { buildReview, groupPieces, lineOf, loadSnapshot, reviewIndex, saveSnapshot, takeSnapshot } from "../lib/review/snapshot.mjs";
import { checkState, normalizeReview } from "../lib/review/spec.mjs";
import { asPage, envOf, hasGit, homeOf, pluginDir, scratchDir } from "./helpers.mjs";

const errorsOf = (issues) => issues.filter((i) => i.level === "error").map((i) => `${i.where}: ${i.message}`);
const warnsOf = (issues) => issues.filter((i) => i.level === "warn").map((i) => `${i.where}: ${i.message}`);

// ---------- the parser ----------

const PATCH = `diff --git a/lib/a.mjs b/lib/a.mjs
index 1111111..2222222 100644
--- a/lib/a.mjs
+++ b/lib/a.mjs
@@ -1,5 +1,6 @@ export function first() {
 line 1
-line 2
+line two
+line two and a half
 line 3
 line 4
 line 5
@@ -40,4 +41,3 @@
 line 40
-line 41
 line 42
 line 43
diff --git a/lib/old-name.mjs b/lib/new-name.mjs
similarity index 100%
rename from lib/old-name.mjs
rename to lib/new-name.mjs
diff --git a/logo.png b/logo.png
index 3333333..4444444 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/notes.txt b/notes.txt
index 5555555..6666666 100644
--- a/notes.txt
+++ b/notes.txt
@@ -1,2 +1,3 @@
 one
-two
\\ No newline at end of file
+two
+three
\\ No newline at end of file
diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
diff --git a/test/a.test.mjs b/test/a.test.mjs
new file mode 100644
index 0000000..7777777
--- /dev/null
+++ b/test/a.test.mjs
@@ -0,0 +1,2 @@
+import test from "node:test";
+test("a", () => {});
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 8888888..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

test("the parser numbers every line on its own side", () => {
  const files = parsePatch(PATCH);
  assert.deepEqual(files.map((f) => [f.path, f.status]), [
    ["lib/a.mjs", "modified"],
    ["lib/new-name.mjs", "renamed"],
    ["logo.png", "modified"],
    ["notes.txt", "modified"],
    ["run.sh", "modified"],
    ["test/a.test.mjs", "added"],
    ["gone.txt", "deleted"],
  ]);
  const [a] = files;
  assert.equal(a.hunks.length, 2);
  assert.deepEqual([a.hunks[0].oldStart, a.hunks[0].oldLines, a.hunks[0].newStart, a.hunks[0].newLines, a.hunks[0].section], [1, 5, 1, 6, "export function first() {"]);
  assert.deepEqual(
    a.hunks[0].lines.map((l) => [l.t, l.o ?? null, l.n ?? null, l.text]),
    [
      ["ctx", 1, 1, "line 1"],
      ["del", 2, null, "line 2"],
      ["add", null, 2, "line two"],
      ["add", null, 3, "line two and a half"],
      ["ctx", 3, 4, "line 3"],
      ["ctx", 4, 5, "line 4"],
      ["ctx", 5, 6, "line 5"],
    ],
  );
  assert.deepEqual(a.hunks[1].lines.map((l) => [l.t, l.o ?? null, l.n ?? null]), [["ctx", 40, 41], ["del", 41, null], ["ctx", 42, 42], ["ctx", 43, 43]]);
  assert.deepEqual([a.added, a.removed], [2, 2]);
  assert.deepEqual(patchStats(files), { files: 7, added: 6, removed: 4, binary: 1 });
});

test("the parser: a rename, a binary file, a mode change, a new and a deleted file", () => {
  const byPath = Object.fromEntries(parsePatch(PATCH).map((f) => [f.path, f]));
  const renamed = byPath["lib/new-name.mjs"];
  assert.deepEqual([renamed.oldPath, renamed.similarity, renamed.hunks.length, renamed.binary], ["lib/old-name.mjs", 100, 0, false]);
  assert.deepEqual([byPath["logo.png"].binary, byPath["logo.png"].hunks.length], [true, 0]);
  assert.deepEqual([byPath["run.sh"].oldMode, byPath["run.sh"].newMode, byPath["run.sh"].hunks.length], ["100644", "100755", 0]);
  assert.deepEqual(byPath["test/a.test.mjs"].hunks[0].lines.map((l) => [l.t, l.n]), [["add", 1], ["add", 2]]);
  assert.deepEqual(byPath["gone.txt"].hunks[0].lines.map((l) => [l.t, l.o]), [["del", 1]]);
});

test("the parser: no newline at end of file marks the line before it, on either side", () => {
  const notes = parsePatch(PATCH).find((f) => f.path === "notes.txt");
  assert.deepEqual(
    notes.hunks[0].lines.map((l) => [l.t, l.text, l.noeol === true]),
    [
      ["ctx", "one", false],
      ["del", "two", true],
      ["add", "two", false],
      ["add", "three", true],
    ],
  );
  assert.deepEqual([notes.added, notes.removed], [2, 1]);
});

test("the parser: a renamed file with an edit, quoted names, and a line that looks like a header", () => {
  const text = `diff --git "a/docs/a \\"b\\".md" "b/docs/\\321\\204\\320\\260\\320\\271\\320\\273.md"
similarity index 80%
rename from "docs/a \\"b\\".md"
rename to "docs/\\321\\204\\320\\260\\320\\271\\320\\273.md"
index 1111111..2222222 100644
--- "a/docs/a \\"b\\".md"
+++ "b/docs/\\321\\204\\320\\260\\320\\271\\320\\273.md"
@@ -1,3 +1,3 @@
 # Title
--- not a header: a deleted line that starts with two dashes
+++ not a header either
 tail
diff --git a/with space.txt b/with space.txt
new file mode 100644
index 0000000..e69de29
`;
  const files = parsePatch(text);
  assert.deepEqual(files.map((f) => [f.path, f.oldPath ?? null, f.status]), [
    ["docs/файл.md", 'docs/a "b".md', "renamed"],
    ["with space.txt", null, "added"],
  ]);
  assert.deepEqual(files[0].hunks[0].lines.map((l) => [l.t, l.text]), [
    ["ctx", "# Title"],
    ["del", "-- not a header: a deleted line that starts with two dashes"],
    ["add", "++ not a header either"],
    ["ctx", "tail"],
  ]);
  assert.equal(files[1].hunks.length, 0, "an empty new file has no hunks");
  assert.equal(unquote('"a\\tb\\\\c"'), "a\tb\\c");
  assert.equal(unquote("plain.txt"), "plain.txt");
  assert.deepEqual(parsePatch(""), []);
});

// ---------- chapters ----------

test("pieces: one per hunk, one per file without hunks, tests marked", () => {
  const pieces = piecesOf(parsePatch(PATCH));
  assert.deepEqual(pieces.map((p) => [p.id, p.file, p.kind]), [
    ["h1", "lib/a.mjs", "hunk"],
    ["h2", "lib/a.mjs", "hunk"],
    ["h3", "lib/new-name.mjs", "rename"],
    ["h4", "logo.png", "binary"],
    ["h5", "notes.txt", "hunk"],
    ["h6", "run.sh", "mode"],
    ["h7", "test/a.test.mjs", "hunk"],
    ["h8", "gone.txt", "hunk"],
  ]);
  assert.deepEqual(pieces.filter((p) => p.test).map((p) => p.id), ["h7"]);
  assert.deepEqual([pieces[0].added, pieces[0].removed, pieces[1].added, pieces[1].removed], [2, 1, 0, 1]);
  assert.deepEqual(["test/x.mjs", "e2e/a.spec.mjs", "src/__tests__/a.js", "lib/a.test.ts", "lib/contest/a.js", "lib/latest.mjs"].map(isTestFile), [true, true, true, true, false, false]);
});

test("a hunk goes to the first chapter that names it, then to a mechanical group; the rest is counted", () => {
  const pieces = piecesOf(parsePatch(PATCH));
  const placed = assign(pieces, {
    chapters: [
      { id: "top", hunks: ["lib/a.mjs:1-10", "test/**"] },
      { id: "tail", hunks: ["lib/a.mjs", "lib/old-name.mjs"] },
    ],
    mechanical: [{ title: "assets", hunks: ["*.png", "lib/"] }],
  });
  assert.deepEqual(placed.chapters, [["h1", "h7"], ["h2", "h3"]]);
  assert.deepEqual(placed.mechanical, [["h4"]]);
  assert.deepEqual(placed.rest, ["h5", "h6", "h8"]);
  assert.deepEqual([placed.sorted, placed.total], [5, 8]);
  assert.deepEqual(placed.where.h1, { chapter: "top" });
  assert.deepEqual(placed.where.h4, { mechanical: 0 });
  assert.deepEqual(placed.where.h5, {});
  assert.deepEqual(errorsOf(placed.issues), []);
  assert.deepEqual(warnsOf(placed.issues), [
    'mechanical[0]: "lib/" adds nothing: all 3 of its hunks are already in chapter "top", chapter "tail"',
    'chapters: 3 hunks in no chapter: the page shows them under "The rest" (notes.txt, run.sh, gone.txt)',
  ]);
});

test("hunk references: a line range, a single line, a directory, a glob, a deleted run of lines", () => {
  const pieces = piecesOf(parsePatch(PATCH));
  const ids = (ref) => pieces.filter((p) => refMatcher(ref).match(p)).map((p) => p.id);
  assert.deepEqual(ids("lib/a.mjs:6"), ["h1"], "a context line counts");
  assert.deepEqual(ids("lib/a.mjs:7-40"), []);
  assert.deepEqual(ids("lib/a.mjs:7-41"), ["h2"]);
  assert.deepEqual(ids("lib/"), ["h1", "h2", "h3"]);
  assert.deepEqual(ids("lib/*.mjs"), ["h1", "h2", "h3"]);
  assert.deepEqual(ids("*.mjs"), [], "* does not cross a directory");
  assert.deepEqual(ids("**/*.mjs"), ["h1", "h2", "h3", "h7"]);
  assert.deepEqual(ids("logo.png:1"), [], "a file without hunks has no lines");
  assert.deepEqual(ids("gone.txt:0"), ["h8"], "a deleted file's hunk sits at line 0 of the new side");
  assert.equal(refMatcher("lib/a.mjs:9-3").ok, false);
  assert.equal(refMatcher("").ok, false);

  const none = assign(pieces, { chapters: [{ id: "x", hunks: ["nope.txt", "lib/a.mjs:9-3"] }] });
  assert.deepEqual(errorsOf(none.issues), ['chapters[0] (x): "lib/a.mjs:9-3" is not a hunk reference: write "path", "path:from-to", "dir/" or a glob']);
  assert.ok(warnsOf(none.issues).includes('chapters[0] (x): "nope.txt" names no hunk of this diff'));
  assert.ok(warnsOf(none.issues).includes("chapters[0] (x): the chapter has no hunks of this diff"));
  assert.match(warnsOf(none.issues).at(-1), /^chapters: 8 hunks in no chapter: .+\(lib\/a\.mjs, lib\/new-name\.mjs, logo\.png, notes\.txt and 3 more\)$/);
});

// ---------- the spec ----------

const SPEC = {
  title: "Review mode: the core",
  summary: "The server reads the diff from git and the page shows it by chapters.",
  risks: [{ level: "high", what: "git runs on a ref the page names", why: "an option would run", chapter: "top" }],
  checks: [
    { command: "node --test test/review.test.mjs", exit: 0, seconds: 4.2 },
    { command: "npx playwright test", exit: 1, seconds: 61, note: "one spec is flaky" },
    { command: "npm run lint" },
  ],
  chapters: [
    { id: "top", title: "The top of a.mjs", summary: "Line two is rewritten.", watch: "The order of the two new lines.", risk: "high", hunks: ["lib/a.mjs:1-10", "test/**"] },
    { id: "tail", title: "The tail and the rename", summary: "Line 41 is gone.", hunks: ["lib/a.mjs", "lib/old-name.mjs"] },
  ],
  mechanical: [{ title: "The logo is redrawn", hunks: ["*.png"] }],
};

test("the spec: shaped with defaults, checks told apart by exit code", () => {
  const { spec, issues } = normalizeReview(SPEC);
  assert.deepEqual(issues, []);
  assert.deepEqual([spec.mode, spec.lang, spec.title], ["review", "en", "Review mode: the core"]);
  assert.deepEqual(spec.chapters.map((c) => [c.id, c.risk, c.watch !== ""]), [["top", "high", true], ["tail", "low", false]]);
  assert.deepEqual(spec.checks.map(checkState), ["ok", "failed", "missing"]);
  assert.deepEqual(spec.checks.map((c) => c.seconds), [4.2, 61, null]);
  assert.deepEqual(spec.risks, [{ level: "high", what: "git runs on a ref the page names", why: "an option would run", chapter: "top" }]);
  assert.equal(normalizeReview({ ...SPEC, summary: "Сервер сам читает дифф из git.", chapters: [{ id: "a", title: "Ядро", summary: "Что изменилось.", hunks: ["lib/"] }] }).spec.lang, "ru");
});

test("the spec lint: what stops a review", () => {
  assert.deepEqual(errorsOf(normalizeReview({ title: "x" }).issues), ['chapters: expected { "chapters": [ ... ] } with at least one chapter']);
  assert.equal(normalizeReview({ title: "x" }).spec, null);
  const bad = normalizeReview({
    chapters: [{ id: "a", summary: "s", hunks: ["lib/", 7] }, { id: "a", title: "Twice", summary: "s" }, { id: "h3", title: "Looks like a hunk", summary: "s" }, "not an object"],
    risks: [{ level: "high" }],
    checks: [{ exit: 0 }],
    map: {},
  });
  assert.deepEqual(errorsOf(bad.issues), [
    'review: unknown field "map"',
    'chapters[0]: "a" needs a title: what this part of the change does',
    'chapters[0].hunks[1]: a hunk reference is a string: "path", "path:from-to", "dir/" or a glob',
    'chapters[1]: duplicate chapter id "a"',
    'chapters[2]: chapter id "h3" reads as a hunk\'s id (h1, h2, …): pick a word',
    "chapters[3]: a chapter is an object: {id, title, summary, risk, hunks}",
    "risks[0]: a risk needs what: what can go wrong, in one line",
    "checks[0]: a check needs command: the command as you ran it",
  ]);
  assert.equal(errorsOf(normalizeReview({ ...SPEC, map: {} }, { fields: "lenient" }).issues).length, 0, "a spec read back from disk only warns");
});

test("the spec lint: what only warns", () => {
  const { spec, issues } = normalizeReview({
    chapters: [{ id: "core", title: "Core", risk: "critical", hunks: "lib/" }, { id: "auth", title: "Auth", summary: "s", risk: "high" }],
    risks: [{ level: "severe", what: "tokens leak", chapter: "nope" }],
    checks: [{ command: "npm test", exit: "0" }],
    mechanical: [{ hunks: ["*.lock"] }],
  });
  assert.deepEqual(errorsOf(issues), []);
  assert.deepEqual(warnsOf(issues), [
    'chapters[0]: "core" has no summary: say what changed here and why',
    'chapters[0]: risk is one of high, medium, low, got "critical"',
    "mechanical[0]: no title: say what the edit is (a rename, formatting, a lock file)",
    'risks[0]: level is one of high, medium, low, got "severe"',
    'risks[0]: no chapter "nope": the risk will not jump anywhere',
    'checks[0]: exit is the command\'s exit code, a whole number; got "0": shown as not run',
    "summary: no summary: the overview opens with what changed and why",
    'risks: chapter "auth" marked high risk but no risk in the overview points there',
  ]);
  assert.deepEqual(spec.chapters[0].hunks, ["lib/"], "one reference may come without the list");
  assert.deepEqual([spec.chapters[0].risk, spec.risks[0].level, spec.risks[0].chapter, spec.checks[0].exit], ["low", "medium", "", null]);
  assert.ok(warnsOf(normalizeReview({ chapters: [{ id: "a", title: "A", summary: "s" }], summary: "s" }).issues).some((m) => m.startsWith("checks: no checks")));
});

// ---------- the digest ----------

test("the verdict digest: every comment by kind, with its file, line and code", () => {
  const { spec } = normalizeReview(SPEC);
  const built = buildReview(spec, PATCH);
  const meta = { base: "b".repeat(40), head: "a".repeat(40), baseRef: "main", headRef: "HEAD" };
  const review = {
    comments: [
      { id: "c1", kind: "fix", hunk: "h1", file: "lib/a.mjs", line: 3, side: "new", code: "line two and a half", text: "Drop this line.\nIt repeats the one above." },
      { id: "c2", kind: "nit", hunk: "h2", file: "lib/a.mjs", line: 41, side: "old", code: "line 41", text: "Say why in the commit." },
      { id: "c3", kind: "nit", hunk: "h4", file: "logo.png", text: "The old one was sharper." },
    ],
    read: { top: true },
  };
  const dialog = [
    { id: "a1", qid: "h1", ask: "Why two lines?", file: "lib/a.mjs", line: 2, side: "new", code: "line two", reply: { text: "One per caller." } },
    { id: "a2", qid: "h5", ask: "Is the newline lost on purpose?", file: "notes.txt" },
    { id: "a3", qid: "h1", reply: { text: "an explanation nobody asked for" } },
  ];
  const result = reviewResult({ base: { title: spec.title, mode: "review" }, spec, meta, placed: built.placed, review, dialog, payload: { verdict: "return", note: " Close, but not yet. " } });
  assert.deepEqual([result.verdict, result.note, result.read, result.unread, result.sorted, result.total], ["return", "Close, but not yet.", ["top"], ["tail"], 5, 8]);
  assert.deepEqual(result.checks, { failed: 1, missing: 1, total: 3 });
  assert.deepEqual(result.range, meta);
  assert.deepEqual(result.comments.map((c) => [c.id, c.kind, c.chapter, c.line ?? null]), [
    ["c1", "fix", "top", 3],
    ["c2", "nit", "tail", 41],
    ["c3", "nit", "", null],
    ["a1", "question", "top", 2],
    ["a2", "question", "", null],
  ]);
  assert.equal(
    result.digest,
    [
      "Verdict: RETURNED. Comments: 1 to fix, 2 nits, 2 questions (1 not answered). Chapters read: 1 of 2 (not read: «The tail and the rename»). 3 of 8 hunks were in no chapter.",
      "The reviewer's note:\n> Close, but not yet.",
      "To fix (1):\n1. lib/a.mjs:3 · chapter «The top of a.mjs»\n   + line two and a half\n   Drop this line.\n   It repeats the one above.",
      "Nits (2):\n1. lib/a.mjs:41 (old side) · chapter «The tail and the rename»\n   - line 41\n   Say why in the commit.\n2. logo.png\n   The old one was sharper.",
      "Questions (2):\n1. lib/a.mjs:2 · chapter «The top of a.mjs»\n   + line two\n   Why two lines?\n   (you answered on the page)\n2. notes.txt\n   Is the newline lost on purpose?\n   NOT answered yet: answer it in chat",
    ].join("\n\n"),
  );
  const text = formatReviewResult(result, "/tmp/x.answers.json");
  assert.match(text, /^Review «Review mode: the core» is finished\./);
  assert.match(text, /Full JSON: \/tmp\/x\.answers\.json\n\nThe change was returned\. Fix what is under "To fix"/);

  const approved = reviewResult({ base: { title: spec.title }, spec, meta, placed: built.placed, review: { comments: [], read: { top: true, tail: true } }, dialog: [], payload: { verdict: "approve" } });
  assert.equal(approved.digest, "Verdict: APPROVED. No comments. Chapters read: 2 of 2. Approved with checks not green: 1 failed, 1 not run. 3 of 8 hunks were in no chapter.");
  assert.match(formatReviewResult(approved, "x"), /the page merged nothing\.$/);
  assert.equal(reviewResult({ base: { title: "t" }, spec, meta, placed: built.placed, review, dialog, payload: { verdict: "nits" } }).verdict, "nits");
  assert.deepEqual(reviewResult({ base: { title: "t" }, spec, meta, placed: built.placed, review, dialog, payload: { cancelled: true } }), { title: "t", cancelled: true });
});

// ---------- git: the refusals ----------

test("git refuses a ref that starts with a dash, a range, a rev:path and blanks", () => {
  for (const ref of ["-h", "--upload-pack=touch /tmp/x", "--output=/tmp/x", "a..b", "main:lib/a.mjs", "main lib", "a\nb", "", null, "x".repeat(300)]) {
    assert.throws(() => checkRef(ref), (e) => e.refused === true && e.status === 400 && e.user === true, `ref ${JSON.stringify(ref)}`);
  }
  assert.match((() => { try { checkRef("--output=/tmp/x", "base"); } catch (e) { return e.message; } })(), /^base "--output=\/tmp\/x" starts with "-": refused/);
  for (const ref of ["HEAD", "main", "origin/main", "feature/review-mode", "HEAD~2", "v3.0.0^", "main@{upstream}", "a".repeat(40)]) assert.equal(checkRef(ref), ref);
});

test("git refuses a path that starts with a dash and a path outside the project", () => {
  const top = path.resolve("/srv/project");
  for (const p of ["-rf", "--help", "../secrets.txt", "lib/../../etc/passwd", "/etc/passwd", path.join(top, "..", "other", "x"), ":(glob)**", "a\0b", "", ".", null]) {
    assert.throws(() => checkPath(top, p), (e) => e.refused === true && e.status === 400, `path ${JSON.stringify(p)}`);
  }
  assert.match((() => { try { checkPath(top, "-rf"); } catch (e) { return e.message; } })(), /starts with "-": refused/);
  assert.match((() => { try { checkPath(top, "../secrets.txt"); } catch (e) { return e.message; } })(), /is outside the project$/);
  assert.equal(checkPath(top, "lib/a.mjs"), "lib/a.mjs");
  assert.equal(checkPath(top, "lib/../ui/a.js"), "ui/a.js");
  assert.equal(checkPath(top, "lib/-odd.mjs"), "lib/-odd.mjs", "a dash inside a path is a name");
});

test("git refuses a file that is not in the snapshot", () => {
  const top = path.resolve("/srv/project");
  const files = ["lib/a.mjs", "notes.txt"];
  assert.equal(checkSnapshotPath(top, "lib/a.mjs", files), "lib/a.mjs");
  assert.equal(checkSnapshotPath(top, "./lib/../notes.txt", files), "notes.txt");
  for (const p of ["package.json", ".env", "lib/b.mjs", "lib"]) {
    assert.throws(() => checkSnapshotPath(top, p, files), (e) => e.refused === true && /is not a file of this review's snapshot$/.test(e.message), p);
  }
  assert.throws(() => checkSnapshotPath(top, "../notes.txt", files), /outside the project/);
});

// ---------- a fixture repository ----------

const lines = (n, change = {}) => `${Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join("\n")}\n`;

// A repository with a base commit on main and one commit on the branch `feature`: two hunks in one
// file, a rename, a binary file, a file without a trailing newline, a mode change, a new test.
async function reviewRepo(context) {
  const dir = realpathSync.native(await scratchDir(context));
  const git = (...args) => {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
    for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
    const r = spawnSync("git", ["-c", "user.name=decide-test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (name, content) => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  };
  git("init", "-q", "-b", "main");
  write(".gitignore", ".home/\n*.answers.json\n");
  write("lib/a.mjs", lines(60));
  write("lib/old-name.mjs", lines(10));
  write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  write("notes.txt", "one\ntwo");
  write("run.sh", "#!/bin/sh\necho hi\n");
  write("secret.env", "TOKEN=base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "feature");
  write("lib/a.mjs", lines(60, { 3: "line three", 50: "line fifty" }));
  git("mv", "lib/old-name.mjs", "lib/new-name.mjs");
  write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]));
  write("notes.txt", "one\ntwo\nthree");
  chmodSync(path.join(dir, "run.sh"), 0o755);
  write("test/a.test.mjs", 'import test from "node:test";\ntest("a", () => {});\n');
  git("add", "-A");
  git("commit", "-q", "-m", "the change");
  return { dir, git, write, base, head: git("rev-parse", "HEAD") };
}

const REPO_SPEC = {
  title: "The fixture change",
  summary: "Two lines of a.mjs are rewritten and a module is renamed.",
  risks: [{ level: "high", what: "line three is read by a parser", chapter: "top" }],
  checks: [{ command: "node --test", exit: 0, seconds: 1.5 }, { command: "npx playwright test" }],
  chapters: [
    { id: "top", title: "Line three", summary: "The word instead of the digit.", risk: "high", hunks: ["lib/a.mjs:1-10", "test/"] },
    { id: "tail", title: "Line fifty", summary: "The same further down.", hunks: ["lib/a.mjs"] },
  ],
  mechanical: [{ title: "A rename and a redrawn logo", hunks: ["lib/new-name.mjs", "*.png"] }],
};

test("the snapshot is the branch against its base, and is read back from the round's folder", { skip: !hasGit }, async (context) => {
  const repo = await reviewRepo(context);
  const snap = await takeSnapshot({ top: repo.dir, now: () => Date.parse("2026-11-17T10:00:00Z") });
  assert.deepEqual([snap.meta.base, snap.meta.head, snap.meta.baseRef, snap.meta.headRef, snap.meta.branch, snap.meta.dirty, snap.meta.at], [repo.base, repo.head, "main", "HEAD", "feature", false, "2026-11-17T10:00:00.000Z"]);
  assert.deepEqual(snap.meta.stats, { files: 6, added: 6, removed: 3, binary: 1 });
  assert.deepEqual(snap.issues, []);

  const files = parsePatch(snap.patch);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.hunks.length, f.binary]), [
    ["lib/a.mjs", "modified", 2, false],
    ["lib/new-name.mjs", "renamed", 0, false],
    ["logo.png", "modified", 0, true],
    ["notes.txt", "modified", 1, false],
    ["run.sh", "modified", 0, false],
    ["test/a.test.mjs", "added", 1, false],
  ]);
  assert.deepEqual(files[3].hunks[0].lines.filter((l) => l.noeol).map((l) => [l.t, l.text]), [["del", "two"], ["add", "three"]]);
  assert.deepEqual([files[4].oldMode, files[4].newMode], ["100644", "100755"]);

  // The base moves on and the tree gets dirty: the review is still the branch against where it forked.
  repo.git("checkout", "-q", "main");
  repo.write("lib/later.mjs", "later\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "main moves on");
  repo.git("checkout", "-q", "feature");
  repo.write("notes.txt", "uncommitted\n");
  const later = await takeSnapshot({ top: repo.dir });
  assert.deepEqual([later.meta.base, later.meta.head, later.meta.dirty], [repo.base, repo.head, true]);
  assert.notEqual(later.meta.baseTip, repo.base);
  assert.equal(later.patch, snap.patch, "what landed on the base since and what is not committed are not in the review");
  assert.match(warnsOf(later.issues)[0], /^snapshot: the working tree has uncommitted changes: they are not in this review/);
  const named = await takeSnapshot({ top: repo.dir, base: repo.base, head: "feature" });
  assert.deepEqual([named.meta.baseRef, named.meta.headRef, named.meta.branch, named.meta.dirty, named.patch === snap.patch], [repo.base, "feature", "", false, true]);

  const roundDir = path.join(repo.dir, ".home", "round");
  mkdirSync(roundDir, { recursive: true });
  saveSnapshot(roundDir, snap);
  const back = loadSnapshot(roundDir);
  assert.deepEqual(back.meta, snap.meta);
  assert.equal(back.patch, snap.patch);
  assert.throws(() => loadSnapshot(path.join(repo.dir, ".home")), /ENOENT/);

  const { spec } = normalizeReview(REPO_SPEC);
  const built = buildReview(spec, back.patch);
  const index = reviewIndex(spec, back.meta, built);
  assert.deepEqual([index.total, index.sorted], [7, 5]);
  assert.deepEqual(index.chapters, [
    { id: "top", pieces: 2, files: 2, added: 3, removed: 1, names: ["lib/a.mjs", "test/a.test.mjs"] },
    { id: "tail", pieces: 1, files: 1, added: 1, removed: 1, names: ["lib/a.mjs"] },
  ]);
  assert.deepEqual(index.mechanical, [{ pieces: 2, files: 2, added: 0, removed: 0 }]);
  assert.deepEqual(index.rest, { pieces: 2, files: 2, added: 2, removed: 1 });
  assert.deepEqual(warnsOf(built.issues), ['chapters: 2 hunks in no chapter: the page shows them under "The rest" (notes.txt, run.sh)']);
  const top = groupPieces(spec, built, "ch:top");
  assert.deepEqual(top.map((p) => [p.id, p.file, p.test, p.lines.length]), [["h1", "lib/a.mjs", false, 7], ["h7", "test/a.test.mjs", true, 2]]);
  assert.equal("fileIndex" in top[0], false);
  assert.deepEqual(groupPieces(spec, built, "mech:0").map((p) => [p.kind, p.oldFile ?? null]), [["rename", "lib/old-name.mjs"], ["binary", null]]);
  assert.deepEqual(groupPieces(spec, built, "rest").map((p) => p.id), ["h5", "h6"]);
  assert.equal(groupPieces(spec, built, "ch:nope"), null);
  assert.equal(lineOf(built, "h1", "new", 3).text, "line three");
  assert.equal(lineOf(built, "h1", "old", 3).text, "line 3");
  assert.equal(lineOf(built, "h1", "new", 30), null);
  assert.ok(built.paths.includes("lib/old-name.mjs"), "a renamed file is served under its old name too");
});

test("the snapshot refuses what it cannot review; git never sees an option", { skip: !hasGit }, async (context) => {
  const repo = await reviewRepo(context);
  await assert.rejects(takeSnapshot({ top: repo.dir, head: "main" }), /no base to review against: none of origin\/HEAD, origin\/main, origin\/master, main, master names a commit other than the head/);
  await assert.rejects(takeSnapshot({ top: repo.dir, base: "feature" }), /nothing to review: HEAD \([0-9a-f]{7}\) is already in feature/);
  await assert.rejects(takeSnapshot({ top: repo.dir, base: "nope" }), (e) => e.refused && /base "nope" names no commit/.test(e.message));
  await assert.rejects(takeSnapshot({ top: repo.dir, head: "nope" }), /head "nope" names no commit/);

  const out = path.join(repo.dir, "written-by-git.txt");
  await assert.rejects(takeSnapshot({ top: repo.dir, base: `--output=${out}` }), (e) => e.refused && /starts with "-"/.test(e.message));
  await assert.rejects(takeSnapshot({ top: repo.dir, head: `--output=${out}` }), (e) => e.refused);
  await assert.rejects(resolveCommit(repo.dir, "-h"), (e) => e.refused);
  assert.equal(existsSync(out), false);

  const plain = await scratchDir(context);
  await assert.rejects(takeSnapshot({ top: plain }), /is not a git working tree/);

  const files = ["lib/a.mjs", "lib/new-name.mjs", "lib/old-name.mjs"];
  assert.match(await fileAt(repo.dir, repo.head, "lib/a.mjs", files), /^line 1\nline 2\nline three\n/);
  assert.match(await fileAt(repo.dir, repo.base, "lib/a.mjs", files), /^line 1\nline 2\nline 3\n/);
  assert.equal(await fileAt(repo.dir, repo.head, "lib/old-name.mjs", files), null, "the head has no file under the old name");
  await assert.rejects(fileAt(repo.dir, repo.head, "secret.env", files), /"secret\.env" is not a file of this review's snapshot/);
  await assert.rejects(fileAt(repo.dir, repo.head, "../outside.txt", files), /outside the project/);
  await assert.rejects(fileAt(repo.dir, repo.head, "--help", files), /starts with "-"/);
  await assert.rejects(fileAt(repo.dir, "HEAD", "lib/a.mjs", files), /is not a commit id/);
});

// ---------- the round: MCP review → the page → wait ----------

function rpcClient(child) {
  let buffer = "";
  let next = 1;
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  return (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
}

test("MCP: review → comments, a question, read marks → the verdict with every comment", { skip: !hasGit }, async (context) => {
  const repo = await reviewRepo(context);
  const dir = repo.dir;
  const child = spawn(process.execPath, [path.join(pluginDir, "mcp.mjs")], { cwd: pluginDir, env: envOf(dir, { CLAUDE_PROJECT_DIR: "" }), stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => child.kill());
  const rpc = rpcClient(child);
  const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
  const text = (result) => result.content.map((c) => c.text).join("\n");

  const tools = (await rpc("tools/list", {})).result.tools;
  const tool = tools.find((t) => t.name === "review");
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ["project", "spec", "specPath", "base", "head", "open"]);
  assert.match(tool.description, /Open a code review for the user/);

  const bad = await call("review", { project: dir, spec: { title: "t", chapters: [{ id: "a", summary: "s" }] }, open: false });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /The review spec has errors, nothing was shown:[\s\S]+needs a title/);
  const refused = await call("review", { project: dir, spec: REPO_SPEC, base: "--output=x", open: false });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /base "--output=x" starts with "-": refused[\s\S]+Nothing was shown\./);
  assert.equal(existsSync(path.join(dir, "x")), false);

  const linted = text(await call("lint", { project: dir, spec: REPO_SPEC }));
  assert.match(linted, /decide lint: warn +chapters: 2 hunks in no chapter[\s\S]+decide lint: ok$/);

  const opened = await call("review", { project: dir, spec: REPO_SPEC, open: false });
  assert.equal(opened.isError, undefined, text(opened));
  const [, round, url] = text(opened).match(/Review (\S+) «The fixture change» is open for the user: (http:\/\/127\.0\.0\.1:\d+\/)/);
  assert.match(text(opened), new RegExp(`Snapshot: main \\(${repo.base.slice(0, 7)}\\) → HEAD \\(${repo.head.slice(0, 7)}\\); 6 files, \\+6 −3; 5 of 7 hunks sorted`));
  assert.match(text(opened), /Lint warnings:\n.*2 hunks in no chapter/);

  const port = Number(new URL(url).port);
  const post = async (route, body) => {
    const res = await fetch(`${url}api/rounds/${round}/${route}`, { method: "POST", headers: asPage(port), body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const get = async (route = "") => {
    const res = await fetch(`${url}api/rounds/${round}${route}`);
    return { status: res.status, body: await res.json() };
  };

  const first = (await get()).body;
  assert.deepEqual([first.mode, first.status, first.live, first.spec.chapters.length, first.review.total, first.review.sorted], ["review", "pending", true, 2, 7, 5]);
  assert.deepEqual([first.review.snapshot.base, first.review.snapshot.head, first.review.snapshot.branch], [repo.base, repo.head, "feature"]);
  assert.deepEqual([first.review.comments, first.review.read], [[], {}]);

  // The diff comes a group at a time; a whole file only when the snapshot names it.
  const { group, pieces } = (await get("/pieces?group=ch:top")).body;
  assert.equal(group, "ch:top");
  assert.deepEqual(pieces.map((p) => [p.id, p.file, p.lines.length]), [["h1", "lib/a.mjs", 7], ["h7", "test/a.test.mjs", 2]]);
  assert.equal((await get("/pieces?group=ch:nope")).status, 404);
  const whole = await get(`/file?path=${encodeURIComponent("lib/a.mjs")}&side=new`);
  assert.equal(whole.status, 200);
  assert.match(whole.body.text, /^line 1\nline 2\nline three\n/);
  assert.match((await get("/file?path=lib/a.mjs&side=old")).body.text, /\nline 3\n/);
  for (const [p, why] of [["secret.env", /not a file of this review's snapshot/], ["../x", /outside the project/], ["--help", /starts with "-"/]]) {
    const res = await get(`/file?path=${encodeURIComponent(p)}&side=new`);
    assert.equal(res.status, 400, p);
    assert.match(res.body.error, why);
  }

  // Comments: on a line, on a hunk; rewritten; taken back. A line the hunk does not have is refused.
  const fix = await post("comment", { hunk: "h1", line: 3, side: "new", kind: "fix", text: "Keep the digit: the parser reads it." });
  assert.equal(fix.status, 200, JSON.stringify(fix.body));
  const nit = await post("comment", { hunk: "h2", line: 50, side: "old", kind: "nit", text: "typo" });
  await post("comment", { id: nit.body.id, kind: "nit", text: "Say why in the commit message." });
  const gone = await post("comment", { hunk: "h4", kind: "nit", text: "to be taken back" });
  assert.equal((await post("uncomment", { id: gone.body.id })).status, 200);
  assert.equal((await post("comment", { hunk: "h1", line: 30, side: "new", kind: "fix", text: "x" })).status, 400);
  assert.equal((await post("comment", { hunk: "h99", kind: "fix", text: "x" })).status, 400);
  assert.equal((await post("comment", { hunk: "h1", kind: "question", text: "x" })).status, 400, "a question is asked, not left as a comment");
  assert.equal((await post("comment", { hunk: "h1", kind: "fix", text: "  " })).status, 400);

  // A question on a line reaches the agent at once, with the line; the answer shows under it.
  const asked = await post("ask", { question: "h1", text: "Why the word?", line: 3, side: "new" });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const question = text(await call("wait", { project: dir, round, timeoutSec: 5 }));
  assert.match(question, new RegExp(`The reviewer asks about lib/a\\.mjs:3 \\[h1\\] in review ${round}:\\n    \\+ line three\\n> Why the word\\?`));
  await call("explain", { project: dir, round, question: "h1", text: "The parser was taught words." });
  const midway = (await get()).body;
  assert.deepEqual(midway.dialog.map((d) => [d.qid, d.ask, d.file, d.line, d.side, d.reply?.text]), [["h1", "Why the word?", "lib/a.mjs", 3, "new", "The parser was taught words."]]);
  assert.deepEqual(midway.review.comments.map((c) => [c.kind, c.hunk, c.file, c.line ?? null, c.side ?? null, c.code ?? null, c.text]), [
    ["fix", "h1", "lib/a.mjs", 3, "new", "line three", "Keep the digit: the parser reads it."],
    ["nit", "h2", "lib/a.mjs", 50, "old", "line 50", "Say why in the commit message."],
  ]);

  // Read marks; a verdict is one of three.
  assert.equal((await post("read", { chapter: "top", read: true })).status, 200);
  assert.equal((await post("read", { chapter: "tail", read: true })).status, 200);
  assert.equal((await post("read", { chapter: "tail", read: false })).status, 200);
  assert.equal((await post("read", { chapter: "nope", read: true })).status, 400);
  assert.deepEqual(Object.keys((await get()).body.review.read), ["top"], "a mark holds when it was set");
  assert.equal((await post("submit", { answers: {} })).status, 400, "a review ends with a verdict");
  assert.equal((await post("submit", { verdict: "lgtm" })).status, 400);
  assert.match(text(await call("wait", { project: dir, round, timeoutSec: 1 })), /Still waiting/);

  const sent = await post("submit", { verdict: "return", note: "Line three first." });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const verdict = text(await call("wait", { project: dir, round, timeoutSec: 5 }));
  assert.match(verdict, /^Review «The fixture change» is finished\./);
  assert.match(verdict, /Verdict: RETURNED\. Comments: 1 to fix, 1 nit, 1 question\. Chapters read: 1 of 2 \(not read: «Line fifty»\)\. 2 of 7 hunks were in no chapter\./);
  assert.match(verdict, /The reviewer's note:\n> Line three first\./);
  assert.match(verdict, /To fix \(1\):\n1\. lib\/a\.mjs:3 · chapter «Line three»\n   \+ line three\n   Keep the digit: the parser reads it\./);
  assert.match(verdict, /Nits \(1\):\n1\. lib\/a\.mjs:50 \(old side\) · chapter «Line fifty»\n   - line 50\n   Say why in the commit message\./);
  assert.match(verdict, /Questions \(1\):\n1\. lib\/a\.mjs:3 · chapter «Line three»\n   \+ line three\n   Why the word\?\n   \(you answered on the page\)/);
  assert.match(verdict, /The change was returned\./);

  const [, answersPath] = verdict.match(/Full JSON: (.+)/);
  const saved = JSON.parse(readFileSync(answersPath, "utf8"));
  assert.deepEqual([saved.mode, saved.verdict, saved.note, saved.comments.length, saved.read, saved.unread], ["review", "return", "Line three first.", 3, ["top"], ["tail"]]);
  assert.deepEqual(saved.range, { base: repo.base, head: repo.head, baseRef: "main", headRef: "HEAD" });
  assert.deepEqual(saved.checks, { failed: 0, missing: 1, total: 2 });

  // The round is over: it still reads, it takes nothing more, and its verdict is not a journal decision.
  const done = (await get()).body;
  assert.deepEqual([done.status, done.result.verdict, done.review.comments.length], ["answered", "return", 2]);
  assert.equal((await get("/pieces?group=rest")).body.pieces.length, 2);
  assert.notEqual((await post("comment", { hunk: "h1", kind: "fix", text: "late" })).status, 200);
  assert.doesNotMatch(text(await call("history", { project: dir })), /The fixture change/);

  // The snapshot is on disk with the round.
  const roundDir = path.join(done.dataDir, "rounds", round);
  const snap = loadSnapshot(roundDir);
  assert.deepEqual([snap.meta.base, snap.meta.head], [repo.base, repo.head]);
  assert.ok(homeOf(dir) && roundDir.startsWith(homeOf(dir)));
});
