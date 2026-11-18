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
import { formatReviewResult, reviewDigest, reviewResult } from "../lib/review/digest.mjs";
import { parsePatch, patchStats, unquote } from "../lib/review/patch.mjs";
import { reviewerIssues } from "../lib/review/reviewers.mjs";
import { buildReview, groupPieces, lineOf, loadSnapshot, reviewIndex, saveSnapshot, takeSnapshot } from "../lib/review/snapshot.mjs";
import { checkState, normalizeReview } from "../lib/review/spec.mjs";
import { uncollected } from "../lib/store/scan.mjs";
import { asAgent, asPage, envOf, exitOf, hasGit, homeOf, pluginDir, scratchDir, spawnServer } from "./helpers.mjs";

const missingTextWarning = 'key places have no `text`: after another commit they can point at other lines unnoticed; `outline` prints the text';
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

test("hunk references: ** reaches a file at the top, ? is a plain character, a deleted file answers to its old lines", () => {
  const pieces = piecesOf(parsePatch(PATCH));
  const ids = (ref) => pieces.filter((p) => refMatcher(ref).match(p)).map((p) => p.id);
  assert.deepEqual(ids("**/*.txt"), ["h5", "h8"], "**/ matches no directory too");
  assert.deepEqual(ids("**/a.mjs"), ["h1", "h2"]);
  assert.deepEqual(ids("lib/**/*.mjs"), ["h1", "h2", "h3"]);
  assert.deepEqual(ids("lib/ab?.mjs"), [], "? is not a wildcard and not a regex mark");
  assert.deepEqual(ids("gone.txt:1-2"), ["h8"], "a deleted file has only old lines");
  assert.deepEqual(ids("gone.txt:40"), []);
});

test("a mode change on a file that also has hunks is carried by its pieces", () => {
  const patch = "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\nindex 1111111..2222222\n--- a/run.sh\n+++ b/run.sh\n@@ -1,2 +1,2 @@\n #!/bin/sh\n-echo hi\n+echo ho\n";
  const [piece] = piecesOf(parsePatch(patch));
  assert.deepEqual([piece.kind, piece.modes], ["hunk", ["100644", "100755"]]);
  assert.equal(piecesOf(parsePatch(PATCH)).find((p) => p.id === "h1").modes, undefined);
});

// ---------- the spec ----------

const SPEC = {
  acceptance: { changed: "Nothing changes from outside." },
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
  assert.deepEqual(warnsOf(issues), ["risks[0]: say which check covers it, or write that nothing does"]);
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

test("the spec lint: a chapter id that every object already has is refused", () => {
  for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const { issues } = normalizeReview({ chapters: [{ id, title: "T", summary: "S", hunks: ["a"] }], checks: [{ command: "x", exit: 0 }], summary: "s" });
    assert.match(errorsOf(issues).join("\n"), /chapters\[0\]: chapter id ".+" is a name every object has/, id);
  }
});

test("the verdict digest: a chapter nobody marked is not read, whatever its id", () => {
  const spec = { checks: [], chapters: [{ id: "valueOf", title: "V" }] };
  const result = reviewResult({ base: {}, spec, meta: {}, placed: { where: {}, sorted: 0, total: 0 }, review: { comments: [], read: {} }, dialog: [], payload: { verdict: "approve" } });
  assert.deepEqual([result.read, result.unread], [[], ["valueOf"]]);
});

test("the spec lint: key places and skim", () => {
  const chapter = (extra) => ({ id: "a", title: "T", summary: "S", hunks: ["a"], ...extra });
  const lint = (extra) => normalizeReview({ acceptance: { changed: "Nothing changes from outside." }, summary: "s", checks: [{ command: "x", exit: 0 }], chapters: [chapter(extra)] });
  const ok = lint({ focus: [{ at: "lib/a.mjs:10-30", note: "the guard" }, { at: " lib/b.mjs:7 ", note: "one line" }], skim: " generated " });
  assert.deepEqual(ok.issues, [{ level: "warn", where: "focus", message: missingTextWarning }]);
  assert.deepEqual([ok.spec.chapters[0].focus, ok.spec.chapters[0].skim], [[{ at: "lib/a.mjs:10-30", note: "the guard" }, { at: "lib/b.mjs:7", note: "one line" }], "generated"]);
  assert.deepEqual(normalizeReview(ok.spec, { fields: "lenient" }).spec.chapters, ok.spec.chapters, "a spec read back from disk keeps its key places");
  assert.deepEqual(lint({ focus: { at: "lib/a.mjs:1-3", note: "one place, not in a list" } }).spec.chapters[0].focus.length, 1);
  assert.deepEqual(lint({}).spec.chapters[0].focus, []);
  // What the place is: one of three words, any case; another word is dropped with a warning.
  const kinds = lint({ focus: [{ at: "lib/a.mjs:1-3", note: "n", kind: "Risk" }, { at: "lib/a.mjs:5", note: "n", kind: "decision" }, { at: "lib/a.mjs:7", note: "n", kind: "scary" }] });
  assert.deepEqual(kinds.spec.chapters[0].focus.map((f) => f.kind), ["risk", "decision", undefined]);
  assert.deepEqual(warnsOf(kinds.issues), ['chapters[0].focus[0]: say which check covers it, or write that nothing does', 'chapters[0].focus[1]: a decision place asks the owner a yes/no question: add `question`', 'chapters[0].focus[2]: kind is one of risk, decision, check, or left out; got "scary"', "focus: " + missingTextWarning]);

  const bad = lint({ focus: ["lib/a.mjs:1-3", { at: "lib/a.mjs" }, { at: "lib/a.mjs:9-3" }, { at: "lib/a.mjs:0" }, { at: "lib/a.mjs:1-2", note: "n", why: "x" }] });
  assert.deepEqual(errorsOf(bad.issues).slice(0, 4), [
    'chapters[0].focus[0]: a key place is an object: {at: "path:from-to", note, kind}',
    'chapters[0].focus[1]: at is "path:from-to" or "path:line", lines of the new file; got "lib/a.mjs"',
    'chapters[0].focus[2]: "lib/a.mjs:9-3": the end is before the start',
    'chapters[0].focus[3]: at is "path:from-to" or "path:line", lines of the new file; got "lib/a.mjs:0"',
  ]);
  assert.match(errorsOf(bad.issues)[4], /^chapters\[0\]\.focus\[4\]: .*why/);
  assert.equal(errorsOf(bad.issues).length, 5);

  const six = Array.from({ length: 6 }, (_, i) => ({ at: `lib/a.mjs:${i * 10 + 1}-${i * 10 + 5}`, note: "n" }));
  assert.deepEqual(warnsOf(lint({ risk: "high", skim: "generated", focus: [...six.slice(0, 5), { at: "lib/a.mjs:100-200" }] }).issues), [
    "chapters[0].focus[5]: no note: say in one phrase what the reviewer should check here",
    "chapters[0].focus[5]: 101 lines is a file, not a key place: name the 10 to 30 lines that matter",
    'chapters[0]: "a" names 6 key places: more than 5 and the reviewer is back to reading everything',
    'chapters[0]: "a" is high risk and marked skim: a risky chapter is read, name its key places in focus',
    "focus: " + missingTextWarning,
    'risks: chapter "a" marked high risk but no risk in the overview points there',
  ]);
  const three = normalizeReview({ acceptance: { changed: "Nothing changes from outside." }, summary: "s", checks: [{ command: "x", exit: 0 }], chapters: ["a", "b", "c"].map((id) => chapter({ id })) });
  assert.deepEqual(warnsOf(three.issues), ["chapters: no chapter names key places (focus) or is marked skim: the reviewer gets every line of every hunk"]);
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
    'risks[0]: say which check covers it, or write that nothing does',
    'risks[0]: no chapter "nope": the risk will not jump anywhere',
    'checks[0]: exit is the command\'s exit code, a whole number; got "0": shown as not run',
    "summary: no summary: the overview opens with what changed and why",
    'risks: chapter "auth" marked high risk but no risk in the overview points there',
    'acceptance: say what changed for the user and how to check it; for a refactoring: nothing changes from outside',
  ]);
  assert.deepEqual(spec.chapters[0].hunks, ["lib/"], "one reference may come without the list");
  assert.deepEqual([spec.chapters[0].risk, spec.risks[0].level, spec.risks[0].chapter, spec.checks[0].exit], ["low", "medium", "", null]);
  assert.ok(warnsOf(normalizeReview({ chapters: [{ id: "a", title: "A", summary: "s" }], summary: "s" }).issues).some((m) => m.startsWith("checks: no checks")));
});

test("the spec the skill shows passes its own lint", () => {
  const skill = readFileSync(path.join(pluginDir, "skills/review/SKILL.md"), "utf8");
  const [, block] = skill.match(/```json\n([\s\S]*?)```/);
  const { spec, issues } = normalizeReview(JSON.parse(block));
  assert.deepEqual(issues, [{ level: "warn", where: "focus", message: missingTextWarning }]);
  assert.deepEqual(spec.chapters.map((c) => c.id), ["token", "mail"]);
  assert.deepEqual(spec.checks.map(checkState), ["ok", "failed", "missing"]);
});

// ---------- the digest ----------

for (const { name, requirement, reviewers, expected } of [
  { name: "the snapshot did not require a team", requirement: { required: false, reason: "9 changed lines; no risk named" }, expected: "Reviewers: not required (9 changed lines; no risk named)" },
  { name: "the round predates the reviewer team" },
  { name: "the team was required but unavailable", requirement: { required: true, reason: "risks[] names a risk" }, reviewers: { none: "Sub-agents are unavailable." }, expected: "Reviewers: none (Sub-agents are unavailable.)" },
]) test(`the digest reports the reviewer team when ${name}`, () => {
  const { spec } = normalizeReview({ ...SPEC, ...(reviewers && { reviewers }) });
  const result = reviewResult({ base: {}, spec, meta: requirement ? { reviewers: requirement } : {}, placed: { where: {}, sorted: 0, total: 0 }, review: { read: {}, comments: [] }, dialog: [] });
  const teamLine = (digest) => digest.split("\n").find(line => line.startsWith("Reviewers:"));
  assert.equal(teamLine(result.digest), expected);
  // Delivery may rebuild the digest from the stored result when the branch head moves.
  assert.equal(teamLine(reviewDigest(spec, JSON.parse(JSON.stringify(result)))), expected);
});

test("the digest marks a commented line by what it is in the diff, not by its side", () => {
  const { spec } = normalizeReview(SPEC);
  const built = buildReview(spec, PATCH);
  const review = { comments: [{ id: "c1", kind: "fix", hunk: "h1", file: "lib/a.mjs", line: 1, side: "new", code: "line 1", text: "Untouched, but wrong." }], read: {} };
  const kinds = [];
  const lineKind = (hunk, side, line) => (kinds.push([hunk, side, line]), "ctx");
  const result = reviewResult({ base: { title: "t" }, spec, meta: {}, placed: built.placed, pieces: built.pieces, review, dialog: [], payload: { verdict: "return" }, lineKind });
  assert.deepEqual(kinds, [["h1", "new", 1]]);
  assert.equal(result.comments[0].change, "ctx");
  assert.match(result.digest, /lib\/a\.mjs:1 · chapter «The top of a\.mjs»\n {5}line 1\n {3}Untouched, but wrong\./);
});

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
  const result = reviewResult({ base: { title: spec.title, mode: "review" }, spec, meta, placed: built.placed, pieces: built.pieces, review, dialog, payload: { verdict: "return", note: " Close, but not yet. " } });
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
      "Verdict: RETURNED at aaaaaaa (HEAD). Comments: 1 to fix, 2 nits, 2 questions (1 not answered). Chapters viewed: 1 of 2 (not viewed: «The tail and the rename»). Opened 0 of 8 pieces; in part 0; not opened 8 (lib/a.mjs, lib/new-name.mjs, logo.png, notes.txt, run.sh and 2 more). 3 of 8 hunks were in no chapter.",
      "The reviewer's note:\n> Close, but not yet.",
      "To fix (1):\n1. [c1] lib/a.mjs:3 · chapter «The top of a.mjs»\n   + line two and a half\n   Drop this line.\n   It repeats the one above.",
      "Nits (2):\n1. [c2] lib/a.mjs:41 (old side) · chapter «The tail and the rename»\n   - line 41\n   Say why in the commit.\n2. [c3] logo.png\n   The old one was sharper.",
      "Questions (2):\n1. [a1] lib/a.mjs:2 · chapter «The top of a.mjs»\n   + line two\n   Why two lines?\n   (you answered on the page)\n2. [a2] notes.txt\n   Is the newline lost on purpose?\n   NOT answered yet: answer it in chat",
    ].join("\n\n"),
  );
  const text = formatReviewResult(result, "/tmp/x.answers.json");
  assert.match(text, /^Verdict: RETURNED at aaaaaaa \(HEAD\)/);
  assert.match(text, /Full JSON: \/tmp\/x\.answers\.json\n\nThe change was returned\. Fix what is under "To fix"/);

  const approved = reviewResult({ base: { title: spec.title }, spec, meta, placed: built.placed, pieces: built.pieces, review: { comments: [], read: { top: true, tail: true } }, dialog: [], payload: { verdict: "approve" } });
  assert.equal(approved.digest, "Verdict: APPROVED at aaaaaaa (HEAD). No comments. Chapters viewed: 2 of 2. Approved with checks not green: 1 failed, 1 not run. Opened 0 of 8 pieces; in part 0; not opened 8 (lib/a.mjs, lib/new-name.mjs, logo.png, notes.txt, run.sh and 2 more). 3 of 8 hunks were in no chapter.");
  assert.match(formatReviewResult(approved, "x"), /the page merged nothing\.$/);
  assert.equal(reviewResult({ base: { title: "t" }, spec, meta, placed: built.placed, pieces: built.pieces, review, dialog, payload: { verdict: "nits" } }).verdict, "nits");
  assert.deepEqual(reviewResult({ base: { title: "t" }, spec, meta, placed: built.placed, pieces: built.pieces, review, dialog, payload: { cancelled: true } }), { title: "t", cancelled: true });
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
  reviewers: { none: "This fixture opens without agents." },
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
    { id: "top", ids: ["h1", "h7"], pieces: 2, files: 2, added: 3, removed: 1, names: ["lib/a.mjs", "test/a.test.mjs"], focus: [] },
    { id: "tail", ids: ["h2"], pieces: 1, files: 1, added: 1, removed: 1, names: ["lib/a.mjs"], focus: [] },
  ]);
  assert.deepEqual(index.mechanical, [{ ids: ["h3", "h4"], pieces: 2, files: 2, added: 0, removed: 0 }]);
  assert.deepEqual(index.rest, { ids: ["h5", "h6"], pieces: 2, files: 2, added: 2, removed: 1 });

  // Key places: the lines a person reads, resolved to the chapter's own hunks.
  const focused = normalizeReview({
    ...REPO_SPEC,
    chapters: [
      { ...REPO_SPEC.chapters[0], focus: [{ at: "lib/a.mjs:3", note: "the parser reads this", kind: "risk" }, { at: "lib/a.mjs:50", note: "in the other chapter" }, { at: "lib/a.mjs:20-22", note: "not changed" }] },
      { ...REPO_SPEC.chapters[1], skim: "the same edit again" },
    ],
  });
  assert.deepEqual(errorsOf(focused.issues), []);
  const laid = buildReview(focused.spec, back.patch);
  assert.deepEqual(reviewIndex(focused.spec, back.meta, laid).chapters.map((c) => c.focus), [[{ file: "lib/a.mjs", from: 3, to: 3, note: "the parser reads this", kind: "risk", pieces: ["h1"] }], []]);
  assert.deepEqual(errorsOf(laid.issues).filter((w) => w.includes("focus")), [
    'chapters[0] (top).focus[1]: "lib/a.mjs:50" is not in this chapter: those lines are in chapter "tail"; move the place or the hunk',
    'chapters[0] (top).focus[2]: "lib/a.mjs:20-22" names no changed lines of this diff (lines of the new file, inside a hunk); this chapter has new-file lines 1-6; move the place or the hunk',
  ]);
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
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ["project", "spec", "specPath", "base", "head", "previous", "open"]);
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
  const [, round, url] = text(opened).match(/Review (\S+) «The fixture change» is ready: (http:\/\/127\.0\.0\.1:\d+\/)/);
  assert.match(text(opened), new RegExp(`Snapshot: main \\(${repo.base.slice(0, 7)}\\) → HEAD \\(${repo.head.slice(0, 7)}\\); 6 files, \\+6 −3; 5 of 7 hunks sorted`));
  assert.match(text(opened), /Lint warnings:[\s\S]*2 hunks in no chapter/);

  const port = Number(new URL(url).port);
  const post = async (route, body) => {
    const res = await fetch(`${url}api/rounds/${round}/${route}`, { method: "POST", headers: asPage(port), body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const get = async (route = "", headers = {}) => {
    const res = await fetch(`${url}api/rounds/${round}${route}`, { headers });
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
  const ownerUrl = new URL(text(opened).match(/is ready: (\S+)/)[1]);
  const key = new URLSearchParams(ownerUrl.hash.slice(1)).get("files");
  assert.ok(key);
  assert.ok(!JSON.stringify(first).includes(key));
  for (const route of ["", "api/state", "api/inbox"]) {
    const publicPage = await fetch(url + route);
    assert.equal(publicPage.status, 200);
    assert.ok(!(await publicPage.text()).includes(key), `the public ${route || "page"} does not grant file access`);
  }
  const getFile = (route) => get(route, { "x-decide-review-key": key });
  assert.equal((await get("/file?path=lib/a.mjs&side=new")).status, 403);
  const whole = await getFile(`/file?path=${encodeURIComponent("lib/a.mjs")}&side=new`);
  assert.equal(whole.status, 200);
  assert.match(whole.body.text, /^line 1\nline 2\nline three\n/);
  assert.match((await getFile("/file?path=lib/a.mjs&side=old")).body.text, /\nline 3\n/);
  for (const [p, why] of [["secret.env", /not a file of this review's snapshot/], ["../x", /outside the project/], ["--help", /starts with "-"/]]) {
    const res = await getFile(`/file?path=${encodeURIComponent(p)}&side=new`);
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
  assert.match(verdict, /^Verdict: RETURNED at /);
  assert.match(verdict, /Verdict: RETURNED at [0-9a-f]{7} \(HEAD\)\. Comments: 1 to fix, 1 nit, 1 question\. Chapters viewed: 1 of 2 \(not viewed: «Line fifty»\)\. Opened 0 of 7 pieces; in part 0; not opened 7 \(lib\/a\.mjs, lib\/new-name\.mjs, logo\.png, notes\.txt, run\.sh and 1 more\)\. 2 of 7 hunks were in no chapter\./);
  assert.match(verdict, /The reviewer's note:\n> Line three first\./);
  assert.match(verdict, /To fix \(1\):\n1\. \[[^\]]+\] lib\/a\.mjs:3 · chapter «Line three»\n   \+ line three\n   Keep the digit: the parser reads it\./);
  assert.match(verdict, /Nits \(1\):\n1\. \[[^\]]+\] lib\/a\.mjs:50 \(old side\) · chapter «Line fifty»\n   - line 50\n   Say why in the commit message\./);
  assert.match(verdict, /Questions \(1\):\n1\. \[[^\]]+\] lib\/a\.mjs:3 · chapter «Line three»\n   \+ line three\n   Why the word\?\n   \(you answered on the page\)/);
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

test("a review survives a server restart: the snapshot, the comments, the read marks, the question", { skip: !hasGit }, async (context) => {
  const repo = await reviewRepo(context);
  const home = homeOf(repo.dir);
  const first = await spawnServer(context, home);
  const at = (port) => `http://127.0.0.1:${port}`;
  const opened = await fetch(`${at(first.port)}/api/rounds`, { method: "POST", headers: asAgent(first.port), body: JSON.stringify({ project: repo.dir, spec: REPO_SPEC, mode: "review", open: false }) });
  assert.equal(opened.status, 200);
  const { id, review } = await opened.json();
  assert.deepEqual([review.total, review.sorted, review.baseRef], [7, 5, "main"]);
  const post = (port, route, body) => fetch(`${at(port)}/api/rounds/${id}/${route}`, { method: "POST", headers: asPage(port), body: JSON.stringify(body) });
  assert.equal((await post(first.port, "comment", { hunk: "h1", line: 3, side: "new", kind: "fix", text: "Keep the digit." })).status, 200);
  assert.equal((await post(first.port, "read", { chapter: "top", read: true })).status, 200);
  assert.equal((await post(first.port, "ask", { question: "h2", text: "Why fifty?", line: 50, side: "new" })).status, 200);
  assert.equal((await post(first.port, "coverage", { pieces: { h1: "part", h2: "opened" } })).status, 200);
  assert.equal((await post(first.port, "coverage", { pieces: { h2: "part" } })).status, 200);
  assert.equal((await post(first.port, "coverage", { pieces: { nope: "opened" } })).status, 400);
  assert.equal((await post(first.port, "coverage", { pieces: { h1: "read" } })).status, 400);
  // A page cannot open a review, and an agent's spec with errors opens nothing.
  assert.equal((await fetch(`${at(first.port)}/api/rounds`, { method: "POST", headers: asPage(first.port), body: JSON.stringify({ project: repo.dir, spec: REPO_SPEC, mode: "review", open: false }) })).status, 403);
  const refused = await fetch(`${at(first.port)}/api/rounds`, { method: "POST", headers: asAgent(first.port), body: JSON.stringify({ project: repo.dir, spec: { chapters: [{ id: "a" }] }, mode: "review", open: false }) });
  assert.equal(refused.status, 422);
  assert.match(JSON.stringify((await refused.json()).issues), /needs a title/);

  const stored = await (await fetch(`${at(first.port)}/api/rounds/${id}`)).json();
  const specFile = path.join(stored.dataDir, "rounds", id, "spec.json");
  const previous = JSON.parse(readFileSync(specFile, "utf8"));
  delete previous.reviewers;
  const metaFile = path.join(path.dirname(specFile), "review", "snapshot.json");
  const previousMeta = JSON.parse(readFileSync(metaFile, "utf8"));
  delete previousMeta.reviewers;
  writeFileSync(metaFile, JSON.stringify(previousMeta));
  previous.chapters[0].focus = [{ at: "lib/a.mjs:9999", note: "A place dropped by the previous version." }];
  writeFileSync(specFile, JSON.stringify(previous));
  first.child.kill();
  await exitOf(first.child);
  // The branch moves on after the review was opened: the review still shows what was reviewed.
  repo.write("lib/a.mjs", "rewritten\n");
  repo.git("commit", "-q", "-am", "after the review opened");

  const second = await spawnServer(context, home);
  const back = await (await fetch(`${at(second.port)}/api/rounds/${id}`)).json();
  assert.deepEqual([back.mode, back.status, back.review.total, back.review.snapshot.head], ["review", "pending", 7, repo.head]);
  assert.deepEqual(back.review.reviewers.findings, []);
  assert.equal(back.review.reviewers.requirement, null);
  // "Newer exists": the branch has a commit the snapshot does not.
  assert.deepEqual(back.review.newer, { head: repo.git("rev-parse", "HEAD") });
  // Every group names its pieces, so a comment is counted for its chapter before the chapter's lines are loaded.
  assert.deepEqual([back.review.chapters.map((c) => c.ids), back.review.mechanical.map((m) => m.ids), back.review.rest.ids], [[["h1", "h7"], ["h2"]], [["h3", "h4"]], ["h5", "h6"]]);
  // The routes of a questions round answer 409 on a review, not 500.
  for (const [route, body] of [["fit", { minutes: 5 }], ["answer", { qid: "top", answer: "x" }], ["note", { qid: "top", text: "x" }], ["flag", { qid: "top", flag: "explain" }], ["import", { files: [{ answers: {} }] }], ["restore", { id: "top" }], ["keep", { qid: "top" }], ["words", { qid: "top", text: "x" }], ["seen", { ids: ["top"] }], ["patch", { ops: [] }]]) {
    const r = await fetch(`${at(second.port)}/api/rounds/${id}/${route}`, { method: "POST", headers: route === "patch" || route === "import" ? asAgent(second.port) : asPage(second.port), body: JSON.stringify(body) });
    assert.ok(r.status >= 400 && r.status < 500, `${route} on a review round: ${r.status}`);
  }
  assert.equal((await fetch(`${at(second.port)}/api/rounds/${id}/draft`, { method: "PUT", headers: asPage(second.port), body: JSON.stringify({ answers: {} }) })).status < 500, true);
  assert.deepEqual(back.review.comments.map((c) => [c.hunk, c.line, c.kind, c.code, c.text]), [["h1", 3, "fix", "line three", "Keep the digit."]]);
  assert.deepEqual(Object.keys(back.review.read), ["top"]);
  assert.deepEqual(back.review.coverage, { h1: "part", h2: "opened" });
  assert.deepEqual(back.review.chapters[0].focus, [], "a stored round with an old dropped place still opens");
  assert.deepEqual(back.dialog.map((d) => [d.qid, d.ask, d.file, d.line, d.code]), [["h2", "Why fifty?", "lib/a.mjs", 50, "line fifty"]]);
  const group = await (await fetch(`${at(second.port)}/api/rounds/${id}/pieces?group=ch:tail`)).json();
  assert.deepEqual(group.pieces.map((p) => [p.id, p.newStart]), [["h2", 47]]);
  const whole = await (await fetch(`${at(second.port)}/api/rounds/${id}/file?path=lib/a.mjs&side=new`, { headers: asAgent(second.port) })).json();
  assert.match(whole.text, /^line 1\nline 2\nline three\n/, "the file as it was at the reviewed commit, not as it is now");
  const sent = await post(second.port, "submit", { verdict: "nits" });
  assert.equal(sent.status, 200);
  assert.match((await sent.json()).result.digest, /^Verdict: APPROVED WITH NITS at [0-9a-f]{7} \(HEAD\)\. Comments: 1 to fix, 1 question \(1 not answered\)\. Chapters viewed: 1 of 2/);
  assert.equal((await post(second.port, "coverage", { pieces: { h1: "opened" } })).status, 409);
  // A verdict nobody collected announces itself like any answered round.
  assert.deepEqual(uncollected(back.dataDir, { graceMs: 0 }).map((r) => [r.id, r.title]), [[id, "The fixture change"]]);
});

test("overview collects risk places without duplicating a listed place", async () => {
  const { collectRisks } = await import("../ui/js/review/risks.js");
  const spec = { risks: [{ level: "high", what: "listed", chapter: "a", at: "a.mjs:3" }], chapters: [] };
  const chapters = [{ id: "a", focus: [{ file: "a.mjs", from: 3, to: 3, kind: "risk", note: "duplicate" }, { file: "a.mjs", from: 9, to: 10, kind: "risk", note: "collected" }, { kind: "why", note: "not a risk" }] }];
  assert.deepEqual(collectRisks(spec, chapters), [...spec.risks, { level: "high", what: "collected", chapter: "a", place: 1 }]);
  assert.equal(spec.risks.length, 1);
});

test("verdict digest names the snapshot and a newer head", () => {
  const spec = { chapters: [], checks: [] };
  const result = reviewResult({ base: {}, spec, meta: { head: "1234567890", headRef: "feature", newer: { head: "abcdef0123" } }, placed: { where: {}, sorted: 0, total: 0 }, review: { read: {}, comments: [] }, dialog: [], payload: { verdict: "approve" } });
  assert.match(result.digest, /^Verdict: APPROVED at 1234567 \(feature\)/);
  assert.match(result.digest, /\n.*abcdef0.*1234567.*approval covers only/i);
  assert.deepEqual(result.range.newer, { head: "abcdef0123" });
});

test("review result addresses retain both verdicts; wait checks branch movement after submission", { skip: !hasGit }, async (t) => {
  const { formatResult } = await import("../lib/prepare.mjs");
  const repo = await reviewRepo(t);
  const server = await spawnServer(t, homeOf(repo.dir));
  const origin = `http://127.0.0.1:${server.port}`;
  const copy = path.join(repo.dir, "same.answers.json");
  const post = async (route, body, agent = false) => {
    const response = await fetch(`${origin}/api/${route}`, { method: "POST", headers: agent ? asAgent(server.port) : asPage(server.port), body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const finish = async (verdict) => {
    const { id } = await post("rounds", { project: repo.dir, spec: { ...REPO_SPEC, previous: false }, mode: "review", open: false, outPath: copy, specFile: path.join(repo.dir, "same.json") }, true);
    await post(`rounds/${id}/submit`, { verdict, note: `note for ${verdict}` });
    const response = await fetch(`${origin}/api/rounds/${id}/next?timeout=1000`, { headers: asAgent(server.port) });
    const item = await response.json();
    const text = formatResult(item.payload, item.payload.file);
    return { id, address: text.match(/Full JSON: (.+)/)[1], text };
  };
  const first = await finish("return");
  const second = await finish("approve");
  for (const [result, verdict] of [[first, "return"], [second, "approve"]]) {
    const saved = JSON.parse(readFileSync(result.address));
    assert.equal(saved.round, result.id);
    assert.equal(saved.verdict, verdict);
    assert.equal(saved.note, `note for ${verdict}`);
    assert.match(result.text, /Full JSON: .*\nConvenience copy: .*next round.*overwrites/);
  }
  repo.git("commit", "--allow-empty", "-qm", "after verdict");
  const head = repo.git("rev-parse", "HEAD");
  const item = await (await fetch(`${origin}/api/rounds/${second.id}/next?timeout=1000`, { headers: asAgent(server.port) })).json();
  assert.match(item.payload.digest, new RegExp(`Branch head ${head.slice(0, 7)} differs from snapshot ${repo.head.slice(0, 7)}`));
  assert.deepEqual(JSON.parse(readFileSync(second.address)).range.newer, { head });
});

test("lint refuses lost focus and unexplained mechanical shares; owner pins remain lint: ok", { skip: !hasGit }, async (context) => {
  const repo = await reviewRepo(context);
  const specPath = path.join(repo.dir, "lint.json");
  const run = (spec) => {
    writeFileSync(specPath, JSON.stringify(spec));
    const { status, stdout } = spawnSync(process.execPath, [path.join(pluginDir, "decide.mjs"), "lint", specPath], {
      cwd: repo.dir, env: envOf(repo.dir), encoding: "utf8",
    });
    return { exit: status, text: stdout.trim() };
  };
  const one = { acceptance: { changed: 'Nothing changes from outside.' }, title: 'All changes', summary: 'The fixture change.', checks: [{ command: 'node --test', exit: 0 }], chapters: [{ id: 'all', title: 'Everything', summary: 'The fixture change.', hunks: ['**'] }] };
  // Owner decision of 2026-11-17: one chapter and all-risk key places are both valid choices.
  for (const focus of [[], [{ at: 'lib/a.mjs:3', note: 'The parser.', kind: 'risk', checkedBy: 'Nothing covers this yet.' }, { at: 'lib/a.mjs:50', note: 'The tail.', kind: 'risk', checkedBy: 'Nothing covers this yet.' }]]) {
    const result = run({ ...one, chapters: [{ ...one.chapters[0], focus }], ...(focus.length ? { reviewers: REPO_SPEC.reviewers } : {}) });
    assert.equal(result.exit, 0);
    assert.match(result.text, /decide lint: ok$/);
    assert.match(result.text, focus.length ? /Reviewers: required.*risk key place/ : /Reviewers: not required/);
    assert.equal(result.text.includes(missingTextWarning), Boolean(focus.length));
  }
  for (const [at, message] of [['lib/a.mjs:50', /chapter "tail"; move the place or the hunk/], ['lib/a.mjs:9999', /this chapter has new-file lines 1-6/]]) {
    const spec = { ...REPO_SPEC, chapters: [{ ...REPO_SPEC.chapters[0], focus: [{ at, note: 'Check.' }] }, REPO_SPEC.chapters[1]] };
    const result = await run(spec);
    assert.equal(result.exit, 1);
    assert.match(result.text, /1 errors/);
    assert.match(result.text, message);
    const server = await spawnServer(context, homeOf(await scratchDir(context)));
    const response = await fetch(`http://127.0.0.1:${server.port}/api/rounds`, { method: 'POST', headers: asAgent(server.port), body: JSON.stringify({ project: repo.dir, mode: 'review', spec, open: false }) });
    assert.equal(response.status, 422);
    assert.match(JSON.stringify((await response.json()).issues), /move the place or the hunk/);
  }
  const mechanical = { ...one, chapters: [{ ...one.chapters[0], hunks: ['test/'] }], mechanical: [{ title: 'Generated output', hunks: ['**'] }] };
  const refused = await run(mechanical);
  assert.equal(refused.exit, 1);
  assert.match(refused.text, /mechanical groups hold \d+ of \d+ changed lines \(\d+%\).*mechanicalWhy/);
  const reason = await run({ ...mechanical, mechanicalWhy: 'The generator changed its output.' });
  assert.equal(reason.exit, 0);
  assert.match(reason.text, /warn +mechanical: mechanical groups hold/);
  assert.match(reason.text, /decide lint: ok$/);
});

test('decision action persists across server restart, overwrites and clears, and exports the owner answer', { skip: !hasGit }, async (context) => {
  const repo = await reviewRepo(context);
  const home = homeOf(repo.dir);
  const first = await spawnServer(context, home);
  const spec = structuredClone(REPO_SPEC);
  spec.chapters[0].focus = [{ at: 'lib/a.mjs:3', note: 'The parser sees a word.', kind: 'decision', question: 'Is a word acceptable?', options: ['Keep word', 'Use digit'] }];
  const opened = await fetch(`http://127.0.0.1:${first.port}/api/rounds`, { method: 'POST', headers: asAgent(first.port), body: JSON.stringify({ project: repo.dir, spec, mode: 'review', open: false }) });
  assert.equal(opened.status, 200);
  const { id } = await opened.json();
  const post = (port, body) => fetch(`http://127.0.0.1:${port}/api/rounds/${id}/decision`, { method: 'POST', headers: asPage(port), body: JSON.stringify(body) });
  const answer = { chapter: 'top', at: 'lib/a.mjs:3', answer: 'yes' };
  for (const bad of [{ ...answer, chapter: 'tail' }, { ...answer, at: 'lib/a.mjs:99' }, { ...answer, answer: 'other' }, { ...answer, chapter: '__proto__' }]) assert.equal((await post(first.port, bad)).status, 400);
  for (const value of ['yes', 'no', null, 'yes']) {
    assert.equal((await post(first.port, { ...answer, answer: value })).status, 200);
    const round = await (await fetch(`http://127.0.0.1:${first.port}/api/rounds/${id}`)).json();
    assert.equal(round.review.decisions.top?.['lib/a.mjs:3'] ?? null, value);
    assert.equal(round.review.comments.length, 0, 'a decision is not a comment');
  }
  first.child.kill(); await exitOf(first.child);
  const second = await spawnServer(context, home);
  const back = await (await fetch(`http://127.0.0.1:${second.port}/api/rounds/${id}`)).json();
  assert.equal(back.review.decisions.top['lib/a.mjs:3'], 'yes');
  assert.equal(back.review.chapters[0].focus[0].question, 'Is a word acceptable?');
  await post(second.port, { ...answer, answer: 'no' });
  const sent = await fetch(`http://127.0.0.1:${second.port}/api/rounds/${id}/submit`, { method: 'POST', headers: asPage(second.port), body: JSON.stringify({ verdict: 'approve' }) });
  assert.equal(sent.status, 200);
  const { result } = await sent.json();
  assert.deepEqual(result.decisions, [{ id: 'd1', chapter: 'top', at: 'lib/a.mjs:3', question: 'Is a word acceptable?', answer: 'no', label: 'Use digit' }]);
  assert.match(result.digest, /Decisions \(1\):\n1\. \[d1\] lib\/a.mjs:3\n   Is a word acceptable\? — Use digit/);
  const saved = JSON.parse(readFileSync(path.join(back.dataDir, 'rounds', id, 'answers.json'), 'utf8'));
  assert.deepEqual(saved.decisions, result.decisions);
  assert.equal((await post(second.port, answer)).status, 409);
});

const TEAM = {
  ran: [{ role: "correctness", model: "sonnet", summary: "Three places to check.", verdict: "concerns" }],
  skipped: [{ role: "safety", model: "gpt-9", why: "model not available" }],
  findings: [
    { id: "f1", role: "correctness", severity: "blocking", at: "lib/a.mjs:3", line: "line three", text: "Keep the digit." },
    { role: "correctness", severity: "major", at: "lib/a.mjs:50", line: "line three", text: "Check the other line." },
    { id: "f2", role: "correctness", severity: "minor", at: "lib/a.mjs:29", text: "Check the untouched code." },
  ],
};

for (const { name, reviewers, errors, warnings } of [
  { name: "the gate refused the round", reviewers: { ran: [] }, errors: 1, warnings: [] },
  { name: "the spec says none ran", reviewers: { none: "Sub-agents are unavailable." }, errors: 0, warnings: [] },
  { name: "part of the team ran", reviewers: TEAM, errors: 1, warnings: [] },
]) test(`lint handles missing reviewer roles when ${name}`, () => {
  const requirement = {
    required: true, reason: "risks[] names a risk",
    roles: ["correctness", "safety", "tests"].map(id => ({ id, brief: `Review ${id}.` })),
  };
  const issues = reviewerIssues({ reviewers }, requirement);
  assert.equal(errorsOf(issues).length, errors);
  assert.deepEqual(warnsOf(issues), warnings);
});

test("reviewer requirement uses changed lines, named risks, both paths of renames and project settings", async () => {
  const { changedPaths, reviewerRequirement } = await import("../lib/review/reviewers.mjs");
  const { effective } = await import("../lib/settings.mjs");
  const defaults = effective().reviewers.value;
  const stats = { added: 100, removed: 99 };
  const check = (over = {}) => reviewerRequirement({ stats, paths: [], settings: defaults, ...over });
  assert.equal(check().required, false);
  assert.match(check({ stats: { ...stats, removed: 100 } }).reason, /200 changed lines, the threshold is 200/);
  for (const [spec, rule] of [
    [{ risks: [{}] }, /risks\[\]/],
    [{ chapters: [{ id: "a", risk: "high" }] }, /high risk/],
    [{ chapters: [{ id: "a", focus: [{ kind: "risk" }] }] }, /key place/],
  ]) {
    assert.equal(check({ spec }).required, true);
    assert.match(check({ spec }).reason, rule);
  }
  for (const [file, rule] of [["server/payments.js", "money"], ["lib/oauth/token.js", "auth"], ["db/migrations/1.sql", "migrations"], ["src/security.ts", "security"]]) {
    const result = check({ paths: ["lib/utils.js", file] });
    assert.equal(result.required, true, file);
    assert.ok(result.reason.includes(file) && result.reason.includes(rule), result.reason);
  }
  assert.match(check({ paths: changedPaths([{ path: "lib/util.mjs", oldPath: "lib/Auth.mjs" }]) }).reason, /auth path rule matched "lib\/Auth.mjs"/);
  assert.equal(check({ paths: ["docs/author.md", "lib/paymentory.js", "lib/not-securityish.js"] }).required, false);
  assert.equal(check({ settings: { ...defaults, mode: "always" } }).required, true);
  assert.equal(check({ settings: { ...defaults, mode: "request" }, paths: ["auth.js"], spec: { risks: [{}] } }).required, false);
  const selected = effective({ reviewers: { ...defaults, mode: "request" } }, { reviewers: { ...defaults, lines: 199 } }).reviewers;
  assert.equal(selected.from, "project");
  assert.match(check({ settings: selected.value }).reason, /199 changed lines, the threshold is 199/);
});

test("reviewer spec lint keeps off-diff findings and points out a moved anchor", () => {
  const { spec, issues } = normalizeReview({ ...REPO_SPEC, reviewers: TEAM });
  assert.deepEqual(errorsOf(issues), []);
  assert.deepEqual(spec.reviewers?.findings.map(f => f.id), ["f1", "f3", "f2"]);
  const built = buildReview(spec, PATCH);
  assert.deepEqual(built.findings[0].anchor, { hunk: "h1", line: 3 });
  assert.ok(built.findings[2].outside);
  assert.match(warnsOf(built.issues).join("\n"), /about lib\/a.mjs:29, not in this diff/);
  const anchored = normalizeReview({ ...REPO_SPEC, reviewers: { ...TEAM, findings: [{ ...TEAM.findings[0], at: "lib/a.mjs:3", line: "line two" }] } }).spec;
  const moved = buildReview(anchored, PATCH);
  assert.match(warnsOf(moved.issues).join("\n"), /line 2/);
  assert.deepEqual(moved.findings[0].anchorMismatch, { movedTo: 2 });
  assert.equal(moved.findings[0].anchor.line, 3);
  const fileOnly = normalizeReview({ ...REPO_SPEC, reviewers: { findings: [{ ...TEAM.findings[0], at: "lib/untouched.mjs", line: undefined }] } }).spec;
  assert.equal(buildReview(fileOnly, PATCH).findings[0].outside, true);

  for (const reviewers of [
    [], { ran: {} }, { skipped: [null] }, { none: 42 }, { findings: [{ ...TEAM.findings[0], extra: true }] },
    { ...TEAM, none: "Agents unavailable." }, { ran: [{ ...TEAM.ran[0], verdict: "maybe" }] },
    { findings: [{ ...TEAM.findings[0], severity: "low" }] },
    { findings: [{ ...TEAM.findings[0], at: "lib/a.mjs:7-3" }] },
    { findings: [TEAM.findings[0], TEAM.findings[0]] },
  ]) assert.ok(errorsOf(normalizeReview({ ...REPO_SPEC, reviewers }).issues).some(s => s.includes("reviewers")), JSON.stringify(reviewers));
  const clean = normalizeReview({ ...REPO_SPEC, reviewers: { ...TEAM, ran: [{ ...TEAM.ran[0], verdict: "clean" }] } });
  assert.match(warnsOf(clean.issues).join("\n"), /clean.*blocking/);
});

test("the reviewer gate agrees in lint and review; decisions survive a restart and reach the digest", { skip: !hasGit }, async (context) => {
  const repo = await reviewRepo(context);
  const home = homeOf(repo.dir);
  const first = await spawnServer(context, home);
  const call = async (port, route, body, agent = false) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
      ...(body !== undefined ? { method: "POST", body: JSON.stringify(body) } : {}),
      headers: agent ? asAgent(port) : asPage(port),
    });
    return { status: res.status, data: await res.json() };
  };
  const open = (spec) => call(first.port, "rounds", { project: repo.dir, mode: "review", spec, open: false }, true);
  const { reviewers, ...risky } = REPO_SPEC;
  const small = { ...risky, risks: [], chapters: risky.chapters.map(c => ({ ...c, risk: "low" })) };
  const specPath = path.join(repo.dir, "review.json");
  const lint = (spec) => {
    writeFileSync(specPath, JSON.stringify(spec));
    return spawnSync(process.execPath, [path.join(pluginDir, "decide.mjs"), "lint", specPath], { cwd: repo.dir, env: envOf(repo.dir), encoding: "utf8" });
  };
  const refused = await open({ ...risky, reviewers: { ran: [], skipped: TEAM.skipped } });
  assert.equal(refused.status, 422);
  const refusal = refused.data.issues.map(i => i.message).join("\n");
  for (const pattern of [/risks\[\]/, /9 changed lines/, /correctness/, /agent default/, /Logic errors/, /skills\/review\/SKILL.md/, /reviewers.none/]) assert.match(refusal, pattern);
  const badLint = lint(risky);
  assert.equal(badLint.status, 1);
  assert.match(badLint.stdout, /Reviewers: required.*risks\[\]/);
  const none = { ...risky, reviewers: { none: "This agent cannot start sub-agents." } };
  assert.equal((await open(none)).status, 200);
  assert.equal(lint(none).status, 0);
  const noTeam = await open(small);
  assert.equal(noTeam.status, 200);
  assert.match(lint(small).stdout, /Reviewers: not required.*9 changed lines/);

  const { effective, writeSettings } = await import("../lib/settings.mjs");
  const { openProject } = await import("../lib/project.mjs");
  const { dataDir } = openProject(repo.dir, home);
  const defaults = effective().reviewers.value;
  writeSettings(home, { set: { reviewers: { ...defaults, mode: "request" } } });
  assert.equal((await open(risky)).status, 200);
  writeSettings(dataDir, { set: { reviewers: { ...defaults, lines: 9 } } });
  assert.equal((await open(small)).status, 422);
  assert.match(lint(small).stdout, /Reviewers: required.*9 changed lines, the threshold is 9/);
  const outline = spawnSync(process.execPath, [path.join(pluginDir, "decide.mjs"), "outline", "--json"], {
    cwd: repo.dir, env: envOf(repo.dir), encoding: "utf8",
  });
  assert.equal(outline.status, 0, outline.stderr);
  assert.match(JSON.parse(outline.stdout).reviewers.reason, /9 changed lines, the threshold is 9/);

  assert.equal((await open({ ...risky, reviewers: TEAM })).status, 422);
  const withTeam = { ...risky, reviewers: { ...TEAM, skipped: [...TEAM.skipped, { role: "tests", model: "", why: "No test reviewer is available in this fixture." }] } };
  const started = await open(withTeam);
  assert.equal(started.status, 200);
  assert.equal(lint(withTeam).status, 0);
  const route = `rounds/${started.data.id}`;
  const decide = (id, decision, reason) => call(first.port, `${route}/finding`, { id, decision, reason });
  assert.equal((await decide("unknown", "fix")).status, 404);
  assert.equal((await decide("f1", "ignored")).status, 400);
  assert.equal((await decide("f2", "fix")).status, 200);
  assert.equal((await decide("f2", null)).status, 200);
  assert.equal((await decide("f1", "fix")).status, 200);
  assert.equal((await decide("f3", "dismissed", "Covered elsewhere.")).status, 200);

  first.child.kill();
  await exitOf(first.child);
  const second = await spawnServer(context, home);
  const round = await call(second.port, route);
  assert.deepEqual(round.data.review.findingDecisions, { f1: { decision: "fix" }, f3: { decision: "dismissed", reason: "Covered elsewhere." } });
  const sent = await call(second.port, `${route}/submit`, { verdict: "approve" });
  assert.equal(sent.status, 200);
  const final = await call(second.port, `${route}/next?timeout=500`, undefined, true);
  assert.equal(final.status, 200, JSON.stringify(final.data));
  const data = final.data.payload;
  const saved = JSON.parse(readFileSync(path.join(round.data.dataDir, "rounds", started.data.id, "answers.json"), "utf8"));
  assert.deepEqual(saved.reviewers, data.reviewers);
  assert.match(formatReviewResult(data, "answers.json"), /Use your judgment on open findings.*Leave dismissed findings alone/);
  assert.deepEqual(data.reviewers.findings.map(f => [f.id, f.decision, f.reason]), [
    ["f1", "fix", undefined], ["f3", "dismissed", "Covered elsewhere."], ["f2", null, undefined],
  ]);
  assert.match(data.digest, /Verdict:.*\nReviewers: correctness \(concerns\); skipped: safety \(model not available\)/);
  assert.match(data.digest, /To fix \(1\):[\s\S]*\[f1\][\s\S]*Reviewer findings left open[\s\S]*\[f2\][\s\S]*Dismissed by the owner[\s\S]*\[f3\][\s\S]*Covered elsewhere/);
});

test("CLI review prints a live wait and writes the verdict to --out", { skip: !hasGit }, async (t) => {
  const { dir } = await reviewRepo(t);
  const specFile = path.join(dir, "change.review.json");
  writeFileSync(specFile, JSON.stringify(REPO_SPEC));
  const outputFile = path.join(dir, "chosen.json");
  const cli = (...args) => spawnSync(process.execPath, [path.join(pluginDir, "decide.mjs"), ...args], {
    cwd: dir, env: envOf(dir), encoding: "utf8", timeout: 20_000,
  });
  const opened = cli("review", specFile, "--out", outputFile, "--no-open", "--project", dir);
  assert.equal(opened.status, 0, opened.stderr);
  const [, id, origin] = opened.stdout.match(/Review (\S+).*?(http:\/\/127\.0\.0\.1:\d+)/);
  assert.match(opened.stdout, new RegExp(`wait ${id} --live`));
  const timeout = cli("wait", id, "--live", "--timeout-sec", "0", "--project", dir);
  assert.equal(timeout.status, 4, timeout.stderr);
  assert.match(timeout.stdout, new RegExp(`wait ${id} --live`));
  const submitted = await fetch(`${origin}/api/rounds/${id}/submit`, {
    method: "POST", headers: asPage(Number(new URL(origin).port)), body: JSON.stringify({ verdict: "approve" }),
  });
  assert.equal(submitted.status, 200);
  assert.equal(JSON.parse(readFileSync(outputFile)).round, id);
  assert.equal(existsSync(path.join(dir, "change.review.answers.json")), false);
});
