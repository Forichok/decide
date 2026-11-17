// The review mode end to end, on a small repository made for the test: the overview, a chapter, one
// comment of each kind, a question the agent answers, and the verdict the agent gets back.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { startDecide } from "./helpers.mjs";

const hasGit = spawnSync("git", ["--version"]).status === 0;
const lines = (n, over = {}) => `${Array.from({ length: n }, (_, i) => over[i + 1] ?? `line ${i + 1}`).join("\n")}\n`;

const testFile = (names) =>
  `import test from "node:test";\n${names.map((n) => `test("${n}", () => {\n${Array.from({ length: 11 }, (_, i) => `  check(${i});`).join("\n")}\n});`).join("\n")}\n`;

// main: a.mjs, a module, a logo, notes, a script. feature: two lines of a.mjs rewritten (two hunks), the
// module renamed, the logo redrawn, a line added to notes, the script made executable, a test added.
// guide, also off main: a new file of 90 lines, one line of a.mjs, a test file of three tests (40 lines).
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
  git("checkout", "-q", "-b", "guide", "main");
  write("lib/big.mjs", lines(90, { 41: 'const total = count("x"); // why' }));
  write("lib/a.mjs", lines(60, { 30: "line thirty" }));
  write("test/big.test.mjs", testFile(["opens", "folds", "keeps a comment"]));
  git("add", "-A");
  git("commit", "-q", "-m", "the guided change");
  git("checkout", "-q", "-b", "tall", "main");
  for (let c = 0; c < 9; c++) for (let f = 0; f < 6; f++) write(`chapter-${c}/file-${f}.mjs`, lines(60));
  git("add", "-A");
  git("commit", "-q", "-m", "tall fixture");
  git("checkout", "-q", "feature");
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

  // The hunk laid into its file: every line of a.mjs, the file's other hunk with its own marks, the
  // hunk's own lines still the only ones that take a comment.
  await a.getByRole("button", { name: "Whole file", exact: true }).click();
  await expect(a.locator("tr.far")).toHaveCount(55);
  await expect(a.locator("tr.far.del td.t")).toHaveText("line 50");
  await expect(a.locator("tr.far.add td.t")).toHaveText("line fifty");
  await a.getByRole("button", { name: "Only the change", exact: true }).click();
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

// A change too long to read by line: the agent names the place to read, the page folds the rest, and
// every folded line is one click away: by the gap, by the hunk, around it, the whole file, the whole diff.
const GUIDE = {
  title: "The guided change",
  summary: "A new module and one line of a.mjs.",
  chapters: [
    { id: "core", title: "The module", summary: "Ninety lines, six of them matter.", hunks: ["lib/"], focus: [{ at: "lib/big.mjs:40-45", note: "The loop.", kind: "risk" }] },
    { id: "checks", title: "The tests", summary: "Three tests.", hunks: ["test/"], skim: "Names only." },
  ],
};

test("a review with key places: the rest is folded and opens by the gap, the hunk, the file and the whole diff", async ({ page }) => {
  test.skip(!hasGit, "git is not installed");
  const opened = await d.must("POST", "/api/rounds", { project: d.project, spec: GUIDE, mode: "review", open: false, head: "guide" });
  expect(opened.review).toMatchObject({ total: 3, sorted: 3 });
  await page.goto(`${d.origin}/?lang=en#r=${opened.id}`);
  await expect(page.locator("#cr-overview .cr-how")).toContainText("1 place");

  await expect(page.locator("#cr-overview .cr-risk")).toContainText("The loop.");
  await page.locator("#cr-overview button.cr-risk").click();
  await expect(page.locator("#cr-ch-core tr.cr-place")).toBeInViewport();

  // ---- the chapter opens on the key place, three lines around it, the rest behind two gaps
  const core = page.locator("#cr-ch-core");
  await core.scrollIntoViewIfNeeded();
  const big = core.locator('.cr-hunk:has(.cr-path:text-is("lib/big.mjs"))');
  await expect(big.locator("tr.cr-line")).toHaveCount(12);
  await expect(big.locator("tr.cr-line.focus")).toHaveCount(6);
  await expect(big.locator("tr.cr-gap")).toHaveCount(2);
  await expect(big.locator("tr.cr-place")).toContainText("The loop.");
  // The place says what it is, on its row, on its lines and in the chapter's list.
  await expect(big.locator("tr.cr-place.kind-risk .cr-kind")).toHaveText("Risk");
  await expect(big.locator("tr.cr-line.focus.kind-risk")).toHaveCount(6);
  // the bar beside the lines takes the kind's colour, the same as the row above them
  const bar = (sel) => big.locator(sel).first().evaluate((el) => getComputedStyle(el).boxShadow.match(/rgba?\([^)]*\)/)?.[0]);
  expect(await bar("tr.cr-line.focus.kind-risk td.n")).toBe(await bar("tr.cr-place.kind-risk td"));
  await expect(core.locator(".cr-places button.kind-risk .cr-kind")).toHaveText("Risk");
  // Code is coloured by what it is; the text of the line stays the line.
  const coded = big.locator('tr.cr-line[data-key="new:41"] td.t');
  await expect(coded).toHaveText('const total = count("x"); // why');
  await expect(coded.locator(".tk-k")).toHaveText("const");
  await expect(coded.locator(".tk-f")).toHaveText("count");
  await expect(coded.locator(".tk-s")).toHaveText('"x"');
  await expect(coded.locator(".tk-c")).toHaveText("// why");
  await expect(core.locator(".cr-places button")).toHaveCount(1);
  await core.locator(".cr-places button").click();
  await expect(big.locator("tr.cr-place")).toBeInViewport();

  // The row over the place asks and comments: the box opens on the place's first line.
  const box = page.locator(".cr-compose");
  await big.locator("tr.cr-place").getByRole("button", { name: "Ask the agent" }).click();
  await expect(big.locator('tr.cr-note[data-key="new:40"] .cr-compose textarea')).toBeFocused();
  await expect(box.locator('.cr-seg [data-kind="question"]')).toHaveAttribute("aria-pressed", "true");
  await box.locator(".btn.ghost").click();
  await big.locator("tr.cr-place").getByRole("button", { name: "Comment", exact: true }).click();
  await expect(box.locator('.cr-seg [data-kind="fix"]')).toHaveAttribute("aria-pressed", "true");
  await box.locator("textarea").fill("Bound the loop.");
  await box.locator(".btn.primary").click();
  await expect(big.locator('tr.cr-note[data-key="new:40"] .cr-cm.fix .cr-cm-text')).toHaveText("Bound the loop.");

  // A gap opens by twenty lines; a new file is one hunk, so "Whole file" is the whole hunk.
  await big.locator("tr.cr-gap").first().getByRole("button", { name: "↑ 20 more" }).click();
  await expect(big.locator("tr.cr-line")).toHaveCount(32);
  await big.getByRole("button", { name: "Whole file", exact: true }).click();
  await expect(big.locator("tr.cr-line")).toHaveCount(90);
  await expect(big.locator("tr.cr-gap")).toHaveCount(0);
  await expect(big.getByRole("button", { name: "Lines around" })).toHaveCount(0);
  await big.getByRole("button", { name: "Fold", exact: true }).click();
  await expect(big.locator("tr.cr-line")).toHaveCount(12);

  // ---- the chapter's other hunk sits under one fold, itself folded
  const others = core.locator("details.cr-others");
  await expect(others.locator(".cr-count")).toHaveText("1");
  const a = others.locator('.cr-hunk:has(.cr-path:text-is("lib/a.mjs"))');
  await expect(a).toBeHidden();
  await others.locator("summary").click();
  await expect(a.locator("tr.cr-line")).toHaveCount(0);
  await a.locator("tr.cr-gap button").click();
  await expect(a.locator("tr.cr-line")).toHaveCount(8);
  await a.getByRole("button", { name: "Lines around", exact: true }).click();
  await expect(a.locator("tr.far")).toHaveCount(40);
  await a.getByRole("button", { name: "Whole file", exact: true }).click();
  await expect(a.locator("tr.far")).toHaveCount(53);
  await a.getByRole("button", { name: "Only the change", exact: true }).click();
  await expect(a.locator("tr.far")).toHaveCount(0);

  // ---- a second click on the line being commented keeps what was typed
  const line = a.locator('tr.cr-line[data-key="new:30"] td.t');
  await line.click();
  await box.locator("textarea").fill("Why thirty?");
  await line.click();
  await expect(box.locator("textarea")).toHaveValue("Why thirty?");
  await expect(box.locator("textarea")).toBeFocused();
  await box.locator(".btn.primary").click();
  await expect(a.locator('tr.cr-note[data-key="new:30"] .cr-cm.fix .cr-cm-text')).toHaveText("Why thirty?");

  // ---- a chapter to skim: a long test file is the list of its tests
  const checks = page.locator("#cr-ch-checks");
  await checks.scrollIntoViewIfNeeded();
  await expect(checks.locator(".cr-skim")).toContainText("Names only.");
  await checks.locator("details.cr-others summary").click();
  const tests = checks.locator(".cr-hunk");
  await expect(tests.locator(".cr-tests li")).toHaveText(["opens", "folds", "keeps a comment"]);
  await expect(tests.locator("tr.cr-line")).toHaveCount(0);
  await tests.locator(".cr-tests button").nth(1).click();
  await expect(tests.locator('tr.cr-line[data-key="new:15"]')).toBeVisible();

  // ---- the whole diff at once, and back
  const full = page.locator("button.cr-full");
  await expect(full).toHaveAttribute("aria-pressed", "false");
  await full.click();
  await expect(full).toHaveAttribute("aria-pressed", "true");
  await expect(big.locator("tr.cr-line")).toHaveCount(90);
  await expect(page.locator("tr.cr-gap")).toHaveCount(0);
  await expect(tests.locator("tr.cr-line")).toHaveCount(40);
  await full.click();
  await expect(big.locator("tr.cr-line")).toHaveCount(12);
  await expect(a.locator('tr.cr-note[data-key="new:30"]'), "a line with a comment stays open").toBeVisible();
});


const TALL = {
  title: "Tall review", summary: "Many chapters.",
  chapters: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, title: `Chapter ${i}`, hunks: [`chapter-${i}/`], focus: [{ at: `chapter-${i}/file-0.mjs:30`, kind: "risk", note: `Risk ${i}` }] })),
};

test("whole diff loads every chapter, mechanical group and the rest before Fold back", async ({ page }) => {
  const opened = await d.must("POST", "/api/rounds", { project: d.project, spec: SPEC, mode: "review", open: false });
  let releaseRest;
  const restGate = new Promise((resolve) => { releaseRest = resolve; });
  await page.route("**/pieces?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("group") === "rest") await restGate;
    await route.continue();
  });
  await page.goto(`${d.origin}/?lang=en#r=${opened.id}`);
  await page.locator("button.cr-full").click();
  await expect(page.locator("button.cr-full")).toHaveText(`Loaded ${opened.review.total - 1} of ${opened.review.total} pieces`);
  await expect(page.locator("button.cr-full")).toBeDisabled();
  releaseRest();
  await expect(page.locator("button.cr-full")).toHaveText("Fold back");
  await expect(page.locator(".cr-hunk")).toHaveCount(opened.review.total);
  await expect(page.locator("details.cr-fold:not([open]), details.cr-others:not([open])")).toHaveCount(0);
  await expect(page.locator("tr.cr-gap")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("no tests in this chapter");
});

for (const [narrow, theme] of [[false, "light"], [true, "light"], [true, "dark"]]) test(`chapter navigation settles on the target (narrow=${narrow}, theme=${theme})`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width: narrow ? 1100 : 1280, height: 800 });
  const opened = await d.must("POST", "/api/rounds", { project: d.project, spec: TALL, mode: "review", open: false, head: "tall" });
  await page.route("**/pieces?**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.continue();
  });
  await page.goto(`${d.origin}/?lang=en#r=${opened.id}`);
  const menu = page.getByRole("button", { name: "Chapters", exact: true });
  if (narrow) {
    await expect(menu).toBeVisible();
    await menu.focus();
    await menu.press("Enter");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeFocused();
    await menu.press("Space");
    await page.locator("#cr-overview .cr-how").click();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".cr-chapters-menu")).toBeHidden();
    await menu.click();
    await page.keyboard.press("Shift+Tab");
    await expect(menu).toBeFocused();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Shift+Tab");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".cr-chapters-menu")).toBeHidden();
    await menu.click();
    await page.locator(".cr-chapters-menu button").last().focus();
    await page.keyboard.press("Tab");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".cr-chapters-menu")).toBeHidden();
    await menu.click();
  } else await expect(menu).toBeHidden();
  await page.locator(".cr-rail-item").filter({ hasText: "Chapter 6" }).click();
  if (narrow) await expect(menu).toHaveAttribute("aria-expanded", "false");
  const target = page.locator("#cr-ch-c6");
  await expect.poll(() => target.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
  await expect.poll(() => target.evaluate((el) => el.getBoundingClientRect().top)).toBeLessThan(100);
  await page.waitForTimeout(600);
  expect(await target.evaluate((el) => el.getBoundingClientRect().top)).toBeLessThan(100);
  await page.keyboard.press("j");
  await expect(page.locator("#cr-ch-c7")).toBeInViewport();
  await page.keyboard.press("k");
  await expect(target).toBeInViewport();
  await target.locator(".cr-places button").click();
  await expect(target.locator("tr.cr-place")).toBeInViewport();
  if (narrow) await menu.click();
  await page.locator("button.cr-full").click();
  await expect(page.locator("button.cr-full")).toHaveText("Fold back");
  await expect(page.locator(".cr-hunk")).toHaveCount(opened.review.total);
});

test("verdict identifies the snapshot, warns on both approvals and reports collection as a fact", async ({ page }) => {
  const opened = await d.must("POST", "/api/rounds", { project: d.project, spec: SPEC, mode: "review", open: false });
  const before = await d.round(opened.id);
  const sha = before.review.snapshot.head.slice(0, 7);
  const newer = spawnSync("git", ["-c", "user.name=decide-test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "after opening"], { cwd: d.project });
  expect(newer.status).toBe(0);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: d.project, encoding: "utf8" }).stdout.trim().slice(0, 7);
  await page.goto(`${d.origin}/?lang=en#r=${opened.id}`);
  await page.locator('.cr-bar [data-verdict="approve"]').click();
  const modal = page.locator(".cr-verdict");
  await expect(modal).toContainText(sha);
  await expect(modal).toContainText("HEAD");
  for (const verdict of ["approve", "nits"]) {
    await modal.locator(`[data-verdict="${verdict}"]`).click();
    await expect(modal.locator('[data-alert="newer"]')).toContainText(head);
    await expect(modal.locator('[data-alert="newer"]')).toContainText(sha);
  }
  await modal.locator(".btn.primary").click();
  await expect(page.locator(".done-sub")).toContainText("No agent has collected");
  await expect(page.locator(".done-sub")).toContainText("Your comments are kept with the round.");
  await expect(page.locator(".cr-done-recovery")).toHaveCount(0);
  await expect(page.locator(".paste-line code")).toContainText(opened.id);
  await expect(page.locator(".paste-line button")).toBeVisible();
  await expect(page.locator(".cr-sum-commit")).toContainText(sha);
  await takeKind(opened.id, "final");
  await expect(page.locator(".done-sub")).toContainText("were delivered to the agent");
  await expect(page.locator(".cr-done-recovery")).toHaveText(`If nothing follows, tell the agent in its chat to collect round ${opened.id}.`);
  await expect(page.locator(".paste-line")).toHaveCount(0);
  await page.goto(`${d.origin}/?lang=ru#r=${opened.id}`);
  await expect(page.locator(".cr-done-recovery")).toHaveText(`Если продолжения нет, попросите агента в его чате забрать раунд ${opened.id}.`);
});


test("a far key-place jump settles after earlier chapters load", async ({ page }) => {
  const opened = await d.must("POST", "/api/rounds", { project: d.project, spec: TALL, mode: "review", open: false, head: "tall" });
  await page.route("**/pieces?**", async (route) => {
    const group = new URL(route.request().url()).searchParams.get("group");
    await new Promise((resolve) => setTimeout(resolve, group === "ch:c6" ? 10 : 300));
    await route.continue();
  });
  await page.goto(`${d.origin}/?lang=en#r=${opened.id}`);
  await page.locator("#cr-overview button.cr-risk").filter({ hasText: "Risk 6" }).click();
  const row = page.locator("#cr-ch-c6 tr.cr-place");
  await expect(row).toBeInViewport();
  await page.waitForTimeout(600);
  await expect(row).toBeInViewport();
});


test("Russian full-diff progress uses the page's word for pieces", async () => {
  const { default: ru } = await import("../ui/js/lang/ru.js");
  for (const [total, word] of [[1, "куска"], [2, "кусков"], [5, "кусков"], [11, "кусков"], [21, "куска"], [22, "кусков"]]) {
    expect(ru["cr.fullLoading"](0, total)).toBe(`Загружено 0 из ${total} ${word}`);
  }
});


test("review recovery asks for collection without repeating comment storage", async () => {
  const { default: en } = await import("../ui/js/lang/en.js");
  const { default: ru } = await import("../ui/js/lang/ru.js");
  expect(en["cr.done.recovery"]("round-1")).toBe("If nothing follows, tell the agent in its chat to collect round round-1.");
  expect(ru["cr.done.recovery"]("round-1")).toBe("Если продолжения нет, попросите агента в его чате забрать раунд round-1.");
});
