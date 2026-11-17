// The review mode end to end, on a small repository made for the test: the overview, a chapter, one
// comment of each kind, a question the agent answers, and the verdict the agent gets back.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { startDecide } from "./helpers.mjs";

const hasGit = spawnSync("git", ["--version"]).status === 0;
const lines = (n, over = {}) => `${Array.from({ length: n }, (_, i) => over[i + 1] ?? `line ${i + 1}`).join("\n")}\n`;

// main: a.mjs, a module, a logo, notes, a script. feature: two lines of a.mjs rewritten (two hunks), the
// module renamed, the logo redrawn, a line added to notes, the script made executable, a test added.
function fixtureRepo(dir) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "user.name=decide-test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (name, content) => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  };
  git("init", "-q", "-b", "main");
  write("lib/a.mjs", lines(60));
  write("lib/old-name.mjs", lines(10));
  write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  write("notes.txt", "one\ntwo\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  write("lib/a.mjs", lines(60, { 3: "line three", 50: "line fifty" }));
  git("mv", "lib/old-name.mjs", "lib/new-name.mjs");
  write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]));
  write("notes.txt", "one\ntwo\nthree\n");
  write("test/a.test.mjs", 'import test from "node:test";\ntest("a", () => {});\n');
  git("add", "-A");
  git("commit", "-q", "-m", "the change");
}

const SPEC = {
  title: "The fixture change",
  summary: "Two lines of a.mjs are rewritten and a module is renamed.",
  risks: [{ level: "high", what: "line three is read by a parser", chapter: "top" }],
  checks: [{ command: "node --test", exit: 0, seconds: 1.5 }, { command: "npx playwright test" }],
  chapters: [
    { id: "top", title: "Line three", summary: "The word instead of the digit.", risk: "high", watch: "The parser reads this line.", hunks: ["lib/a.mjs:1-10", "test/"] },
    { id: "tail", title: "Line fifty", summary: "The same further down.", hunks: ["lib/a.mjs"] },
  ],
  mechanical: [{ title: "A rename and a redrawn logo", hunks: ["lib/new-name.mjs", "*.png"] }],
};

let d;
test.beforeAll(async () => {
  d = await startDecide({ name: "review" });
  if (hasGit) fixtureRepo(d.project);
});
test.afterAll(async () => d?.stop());

// What the agent's wait would get next, of one kind.
async function takeKind(id, kind, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const item = await d.next(id, { timeout: 800 });
    if (!item) continue;
    await d.ack(id, item.seq);
    if (item.kind === kind) return item;
  }
  return null;
}

test("a review: overview, a chapter, a comment of each kind, a question, the verdict", async ({ page }) => {
  test.skip(!hasGit, "git is not installed");
  const opened = await d.must("POST", "/api/rounds", { project: d.project, spec: SPEC, mode: "review", open: false });
  const id = opened.id;
  expect(opened.review).toMatchObject({ total: 6, sorted: 5 });
  await page.goto(`${d.origin}/?lang=en#r=${id}`);

  // ---- the overview
  const overview = page.locator("#cr-overview");
  await expect(page.locator("h1.cr-title")).toHaveText("The fixture change");
  await expect(overview).toContainText("Two lines of a.mjs are rewritten");
  await expect(page.locator(".cr-meta")).toContainText("5 files");
  await expect(overview.locator(".cr-checks tr.ok")).toContainText("node --test");
  await expect(overview.locator(".cr-checks tr.ok")).toContainText("exit 0");
  await expect(overview.locator(".cr-checks tr.missing")).toContainText("npx playwright test");
  await expect(page.locator(".cr-rail .cr-sorted.short")).toContainText("5 of 6");
  await expect(page.locator(".cr-rail-item")).toHaveCount(5); // overview, two chapters, mechanical, the rest

  // ---- a risk jumps to its chapter
  await overview.locator("button.cr-risk").click();
  const top = page.locator("#cr-ch-top");
  await expect(top).toBeInViewport();
  await expect(top.locator(".cr-watch")).toContainText("The parser reads this line.");
  await expect(top.locator(".cr-hunk")).toHaveCount(2);
  const a = top.locator('.cr-hunk:has(.cr-path:text-is("lib/a.mjs"))');
  const spec = top.locator('.cr-hunk:has(.cr-path:text-is("test/a.test.mjs"))');
  await expect(spec.locator(".badge.cr-test")).toBeVisible();
  await expect(a.locator("tr.cr-line.del td.t")).toHaveText("line 3");
  await expect(a.locator("tr.cr-line.add td.t")).toHaveText("line three");

  // The hunk laid into its file: every line of a.mjs, the hunk's own still the only ones that take a comment.
  await a.locator(".cr-tool").first().click();
  await expect(a.locator("tr.far")).toHaveCount(54);
  await a.locator(".cr-tool").first().click();
  await expect(a.locator("tr.far")).toHaveCount(0);

  // ---- one comment of each kind
  const box = page.locator(".cr-compose");
  await a.locator('tr.cr-line[data-key="new:3"] td.t').click();
  await expect(box.locator("textarea")).toBeFocused();
  await box.locator("textarea").fill("Keep the digit: the parser reads it.");
  await box.locator(".btn.primary").click();
  await expect(a.locator('tr.cr-note[data-key="new:3"] .cr-cm.fix .cr-cm-text')).toHaveText("Keep the digit: the parser reads it.");
  await expect(box).toHaveCount(0);

  await spec.locator('tr.cr-line[data-key="new:2"] td.t').click();
  await box.locator('.cr-seg [data-kind="nit"]').click();
  await box.locator("textarea").fill("Name the test after what it checks.");
  await box.locator("textarea").press("ControlOrMeta+Enter");
  await expect(spec.locator(".cr-cm.nit .cr-cm-text")).toHaveText("Name the test after what it checks.");
  await expect(page.locator(".cr-verdict"), "⌘↵ in the box sends the comment, it does not open the verdict").toHaveCount(0);

  // ---- a question: the agent gets it at once and answers under the line
  await a.locator('tr.cr-line[data-key="old:3"] td.t').click();
  await box.locator('.cr-seg [data-kind="question"]').click();
  await box.locator("textarea").fill("Who reads line 3?");
  await box.locator(".btn.primary").click();
  const ask = await takeKind(id, "ask");
  expect(ask, "the agent gets the question").toBeTruthy();
  expect(ask.payload.ask).toMatchObject({ text: "Who reads line 3?", file: "lib/a.mjs", line: 3, side: "old", code: "line 3" });
  await d.explain(id, ask.payload.ask.question, "Only the **parser** does.", { askId: ask.payload.ask.id });
  await expect(a.locator('tr.cr-note[data-key="old:3"] .cr-cm.question .cr-reply')).toContainText("Only the parser does.", { timeout: 10_000 });

  // ---- the chapter is read as a whole; the bar keeps count
  const bar = page.locator(".cr-bar");
  await top.locator(".cr-ch-foot .btn").click();
  await expect(top).toHaveClass(/\bread\b/);
  await expect(bar.locator(".state b")).toHaveText("1 of 2 chapters read");
  await expect(bar.locator(".state small")).toContainText("3 comments");
  await expect(page.locator(".cr-rail-item.read")).toHaveCount(1);

  // ---- mechanical edits are one folded line; what the agent did not sort is "The rest"
  const mech = page.locator('details.cr-fold[data-stop="mech:0"]');
  await expect(mech.locator(".cr-count")).toHaveText("2");
  await expect(mech.locator(".cr-hunk")).toHaveCount(0);
  await mech.locator("summary").click();
  await expect(mech.locator(".cr-hunk")).toHaveCount(2);
  await expect(page.locator('details.cr-fold[data-stop="rest"] .cr-count')).toHaveText("1");

  // ---- the verdict: approving warns about the check that never ran, the open "fix" and the unread chapter
  await bar.locator('[data-verdict="approve"]').click();
  const modal = page.locator(".cr-verdict");
  await expect(modal.locator('.cr-alert[data-alert="checks"]')).toContainText("not green");
  await expect(modal.locator('.cr-alert[data-alert="fix"]')).toBeVisible();
  await expect(modal.locator('.cr-alert[data-alert="unread"]')).toContainText("Line fifty");
  await modal.locator('.cr-seg [data-verdict="return"]').click();
  await expect(modal.locator(".cr-alert")).toHaveCount(0);
  await modal.locator("textarea").fill("Put the digit back.");
  await modal.locator(".btn.primary").click();

  await expect(page.locator(".cr-sum-verdict.return")).toHaveText("Returned to the agent");
  await expect(page.locator(".cr-sum-list .cr-cm")).toHaveCount(3);

  // ---- what the agent reads
  const final = await takeKind(id, "final");
  expect(final, "the agent's wait gets the verdict").toBeTruthy();
  expect(JSON.stringify(final.payload)).toContain("Verdict: RETURNED");
  const { status, result } = await d.round(id);
  expect(status).toBe("answered");
  expect(result).toMatchObject({ mode: "review", verdict: "return", note: "Put the digit back.", read: ["top"], unread: ["tail"], checks: { failed: 0, missing: 1, total: 2 } });
  expect(result.comments.map((c) => [c.kind, c.file, c.line, c.side, c.text])).toEqual([
    ["fix", "lib/a.mjs", 3, "new", "Keep the digit: the parser reads it."],
    ["nit", "test/a.test.mjs", 2, "new", "Name the test after what it checks."],
    ["question", "lib/a.mjs", 3, "old", "Who reads line 3?"],
  ]);
  expect(result.comments[2].reply).toContain("parser");
  expect(result.digest).toContain("Verdict: RETURNED");
  expect(result.digest).toContain("Keep the digit: the parser reads it.");
});
