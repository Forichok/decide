// The review mode end to end, on a small repository made for the test: the overview, a chapter, one
// comment of each kind, a question the agent answers, and the verdict the agent gets back.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { startDecide } from "./helpers.mjs";

const hasGit = spawnSync("git", ["--version"]).status === 0;

// The dialog confirms the verdict the bar's button named; the other two wait behind "Another verdict".
const pickVerdict = async (page, verdict) => {
  const modal = page.locator(".cr-verdict");
  const change = modal.locator(".cr-verdict-change");
  if (await change.isVisible()) await change.click();
  await modal.locator(`.cr-seg [data-verdict="${verdict}"]`).click();
};
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
  return { git, write, feature: git("rev-parse", "HEAD") };
}

const SPEC = {
  previous: false,
  reviewers: { none: "This fixture opens without agents." },
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

let d, repo;
test.beforeAll(async () => {
  d = await startDecide({ name: "review" });
  if (hasGit) repo = fixtureRepo(d.project);
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
  await page.goto(opened.url.replace("/#", "/?lang=en#"));

  // ---- the overview
  const overview = page.locator("#cr-overview");
  await expect(page.locator("h1.cr-title")).toHaveText("The fixture change");
  await expect(overview).toContainText("Two lines of a.mjs are rewritten");
  await expect(page.locator(".cr-meta")).toContainText("5 files");
  await expect(overview.locator(".cr-mechanical-account")).toContainText("0% of the change.");
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
  await expect(bar.locator(".state b")).toHaveText("Chapters viewed: 1 of 2");
  await expect(bar.locator('[data-stat="said"]')).toHaveText("Comments: 3");
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
  await expect(modal.locator('.cr-alert[data-alert="checks"]')).toContainText("Checks not run: 1.");
  await expect(modal.locator('.cr-alert[data-alert="fix"]')).toBeVisible();
  await expect(modal.locator('.cr-alert[data-alert="unread"]')).toContainText("Line fifty");
  await pickVerdict(page, "return");
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
  previous: false,
  reviewers: { none: "This fixture opens without agents." },
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
  await page.goto(opened.url.replace("/#", "/?lang=en#"));
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
  previous: false,
  reviewers: { none: "This fixture opens without agents." },
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
    await expect(page.locator(".cr-chapters-menu").getByRole("button", { name: "Files", exact: true })).toBeVisible();
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
    await pickVerdict(page, verdict);
    await expect(modal.locator('[data-alert="newer"]')).toContainText(head);
    await expect(modal.locator('[data-alert="newer"]')).toContainText(sha);
  }
  await modal.locator(".btn.primary").click();
  await expect(page.locator(".done-sub")).toContainText("No agent has collected");
  await expect(page.locator(".done-sub")).toContainText("Your comments are kept with the round.");
  await expect(page.locator(".cr-done-recovery")).toHaveCount(0);
  await expect(page.locator(".sum-raw summary")).toHaveText("The text the agent will get");
  await expect(page.locator(".paste-line code")).toContainText(opened.id);
  await expect(page.locator(".paste-line button")).toBeVisible();
  await expect(page.locator(".cr-sum-commit")).toContainText(sha);
  await takeKind(opened.id, "final");
  await expect(page.locator(".done-sub")).toContainText("were delivered to the agent");
  await expect(page.locator(".sum-raw summary")).toHaveText("The text the agent received");
  await expect(page.locator(".cr-done-recovery")).toHaveCount(0);
  await expect(page.locator(".done-card .waiting")).toHaveCount(0);
  await expect(page.locator(".paste-line")).toHaveCount(0);
  await page.goto(`${d.origin}/?lang=ru#r=${opened.id}`);
  await expect(page.locator(".done-card .waiting")).toHaveCount(0);
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
  await page.locator(".cr-rail").getByRole("button", { name: "Files", exact: true }).click();
  await page.locator(".cr-file-list").getByRole("button", { name: /chapter-8\/file-5.mjs/ }).click();
  const piece = page.locator('.cr-hunk').filter({ has: page.locator('.cr-path:text-is("chapter-8/file-5.mjs")') });
  await expect(piece).toBeInViewport();
  await expect(piece.locator("tr.cr-gap")).toHaveCount(0);
  await page.waitForTimeout(600);
  await expect(piece).toBeInViewport();
});


test("Russian review strings use the page's word for pieces", async () => {
  const { default: ru } = await import("../ui/js/lang/ru.js");
  for (const [key, value] of Object.entries(ru).filter(([key]) => key.startsWith('cr.'))) {
    expect(String(value), key).not.toMatch(/фрагмент/i);
  }
  for (const [total, word] of [[1, "куска"], [2, "кусков"], [5, "кусков"], [11, "кусков"], [21, "куска"], [22, "кусков"]]) {
    expect(ru["cr.fullLoading"](0, total)).toBe(`Загружено 0 из ${total} ${word}`);
  }
});


async function exposeChangedRows(page, host) {
  const rows = host.locator('tr.cr-line.add, tr.cr-line.del');
  for (let i = 0; i < await rows.count(); i += 8) {
    await rows.nth(i).scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  await rows.last().scrollIntoViewIfNeeded();
}

test('coverage distinguishes hidden, partial and opened pieces, survives reload and warns on approval', async ({ page }) => {
  const opened = await d.must('POST', '/api/rounds', { project: d.project, spec: GUIDE, mode: 'review', open: false, head: 'guide' });
  await page.goto(opened.url.replace("/#", "/?lang=en#"));
  await page.locator('#cr-overview button.cr-risk').click();
  const big = page.locator('.cr-hunk').filter({ has: page.locator('.cr-path:text-is("lib/big.mjs")') });
  await expect(big).toBeInViewport();
  await expect.poll(async () => (await d.round(opened.id)).review.coverage).toEqual({ h2: 'part' });
  await page.reload();
  await expect.poll(async () => (await d.round(opened.id)).review.coverage).toEqual({ h2: 'part' });
  await page.locator('.cr-rail').getByRole('button', { name: 'Files', exact: true }).click();
  const files = page.locator('.cr-file-list');
  await expect(files.locator('li')).toHaveCount(3);
  await expect(files.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
  const firstFile = files.locator('li button').first();
  await expect(firstFile.locator(':scope > code')).toHaveCount(1);
  await expect(firstFile.locator('code wbr')).toHaveCount(1);
  await expect(firstFile.locator(':scope > span')).toHaveCount(1);
  await expect(firstFile).toContainText('○ Not shown · +1 −1 · 1 hunk');
  await expect(firstFile).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  expect(await firstFile.evaluate((el) => parseFloat(getComputedStyle(el).outlineOffset))).toBeLessThan(0);
  await expect(files.locator('.cr-coverage-summary')).toHaveText('Shown 0 of 3 pieces · 1 in part · 2 not shown');
  await files.getByRole('button', { name: /lib\/a.mjs/ }).click();
  const a = page.locator('.cr-hunk').filter({ has: page.locator('.cr-path:text-is("lib/a.mjs")') });
  await expect(a).toBeInViewport();
  await expect(a.locator('tr.cr-gap')).toHaveCount(0);
  await expect.poll(async () => (await d.round(opened.id)).review.coverage).toMatchObject({ h1: 'opened', h2: 'part' });
  await page.locator('.cr-bar [data-verdict="approve"]').click();
  await expect(page.locator('[data-alert="coverage"]')).toContainText('Shown 1 of 3 pieces · 1 in part · 1 not shown');
  await expect(page.locator('[data-alert="coverage"] li')).toHaveText([
    'The module: in part 1 (lib/big.mjs)',
    'The tests: not shown 1 (test/big.test.mjs)',
  ]);
  await expect(page.locator('.cr-progress > span')).toHaveText(['Pieces shown: 1 of 3, in part 1']);
  await pickVerdict(page, "nits");
  await expect(page.locator('[data-alert="coverage"]')).toBeVisible();
  await pickVerdict(page, "return");
  await expect(page.locator('[data-alert="coverage"]')).toHaveCount(0);
  await pickVerdict(page, "approve");
  await page.locator('[data-alert="coverage"]').getByRole('button', { name: 'Files', exact: true }).click();
  await expect(files).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(files).toHaveCount(0);
  await page.locator('#cr-overview button.cr-risk').click();
  await big.getByRole('button', { name: 'Whole file', exact: true }).click();
  await exposeChangedRows(page, big);
  await expect.poll(async () => (await d.round(opened.id)).review.coverage.h2).toBe('opened');
  await big.getByRole('button', { name: 'Fold', exact: true }).click();
  await page.reload();
  await expect.poll(async () => (await d.round(opened.id)).review.coverage.h2).toBe('opened');
  await page.locator('.cr-bar [data-verdict="approve"]').click();
  await page.locator('.cr-verdict .btn.primary').click();
  await expect(page.locator('.done-view')).toBeVisible();
  const result = (await d.round(opened.id)).result;
  expect(result.coverage).toMatchObject({ total: 3, opened: 2, part: 0, unopened: 1 });
  expect(result.digest).toContain('Opened 2 of 3 pieces; in part 0; not opened 1 (test/big.test.mjs).');
});

test('mechanical share and its reason are the agent account in the overview and folded header', async ({ page }) => {
  const spec = { ...GUIDE, chapters: [GUIDE.chapters[1]], mechanical: [{ title: 'Generated modules', hunks: ['lib/'] }], mechanicalWhy: 'The generator changed its output.' };
  const opened = await d.must('POST', '/api/rounds', { project: d.project, spec, mode: 'review', open: false, head: 'guide' });
  const round = await d.round(opened.id);
  const share = round.review.mechanicalShare;
  await page.goto(`${d.origin}/?lang=en#r=${opened.id}`);
  const expected = `Mechanical, by the agent's account: ${share.files} files, +${share.added} −${share.removed}, ${share.percent}% of the change. Reason: The generator changed its output.`;
  await expect(page.locator('#cr-overview .cr-mechanical-account')).toHaveText(expected);
  await expect(page.locator('.cr-fold summary .cr-mechanical-account')).toHaveText(expected);
  await expect(page.locator('.cr-fold')).not.toHaveAttribute('open');
  await page.locator('.cr-rail').getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.locator('.cr-file-list li').filter({ hasText: 'lib/big.mjs' })).toContainText('in mechanical: Generated modules');
  await expect(page.locator('.cr-file-list li').filter({ hasText: 'lib/big.mjs' })).toContainText('Not shown');
});

test('requesting the whole diff does not count rows that have not unfolded yet', async ({ page }) => {
  const opened = await d.must('POST', '/api/rounds', { project: d.project, spec: GUIDE, mode: 'review', open: false, head: 'guide' });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route('**/pieces?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('group') === 'ch:checks') await held;
    await route.continue();
  });
  try {
    await page.goto(`${d.origin}/?lang=en#r=${opened.id}`);
    await page.locator('#cr-overview button.cr-risk').click();
    await expect.poll(async () => (await d.round(opened.id)).review.coverage.h2).toBe('part');
    await page.locator('.cr-full').click();
    const big = page.locator('.cr-hunk').filter({ has: page.locator('.cr-path:text-is("lib/big.mjs")') });
    await expect(big.locator('tr.cr-gap')).toHaveCount(2);
    // Two debounce intervals pass while the request is held and its rows remain folded.
    await page.waitForTimeout(500);
    expect((await d.round(opened.id)).review.coverage.h2).toBe('part');
    release();
    await expect(big.locator('tr.cr-gap')).toHaveCount(0);
    await exposeChangedRows(page, big);
    await expect.poll(async () => (await d.round(opened.id)).review.coverage.h2).toBe('opened');
  } finally { release(); }
});


test('approval coverage warnings bound groups and file names in both languages', async ({ page }) => {
  const spec = { ...TALL, chapters: TALL.chapters.slice(0, 7), mechanical: [{ title: 'Generated', hunks: ['chapter-7/'] }], mechanicalWhy: 'Generated files.' };
  const opened = await d.must('POST', '/api/rounds', { project: d.project, spec, mode: 'review', open: false, head: 'tall' });
  for (const lang of ['en', 'ru']) {
    await page.goto(`${d.origin}/?lang=${lang}#r=${opened.id}`);
    await page.locator('.cr-bar [data-verdict="approve"]').click();
    const warning = page.locator('[data-alert="coverage"]');
    const rows = warning.locator('li');
    await expect(rows).toHaveCount(7);
    await expect(rows.first()).toContainText(lang === 'en' ? ': not shown 6 (' : ': не показано 6 (');
    await expect(rows.first()).toContainText(lang === 'en' ? 'and 3 more' : 'и ещё 3');
    await expect(rows.first()).not.toContainText(lang === 'en' ? 'in part' : 'частично');
    await expect(rows.last()).toHaveText(lang === 'en' ? 'and 3 more: see Files' : 'и ещё 3: см. Файлы');
    await rows.last().getByRole('button', { name: lang === 'en' ? 'Files' : 'Файлы', exact: true }).click();
    const files = page.locator('.cr-file-list');
    await expect(files).toBeVisible();
    await expect.poll(() => files.locator('..').evaluate((el) => el.getBoundingClientRect().width)).toBe(720); // the dialog scales in
    await page.setViewportSize({ width: 375, height: 900 });
    expect(await files.locator('..').evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(375 * 0.92);
    const path = files.locator('li code').first();
    expect(await path.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await files.getByRole('button', { name: lang === 'en' ? 'Close' : 'Закрыть', exact: true }).click();
    await expect(files).toHaveCount(0);
  }
});

test('owner overview: decisions, risk checks, acceptance and persisted answers', async ({ page }) => {
  const spec = structuredClone(SPEC);
  spec.chapters[0].focus = [{ at: 'lib/a.mjs:3', note: 'A word replaces the digit.', kind: 'decision', question: 'Is a word acceptable?', options: ['Keep word', 'Use digit'] }, { at: 'lib/a.mjs:4', note: 'Parser may refuse it.', kind: 'risk' }];
  spec.risks[0].checkedBy = 'Parser test covers the word.';
  spec.acceptance = { changed: 'The `parser` receives a word. <img>', where: '`Parser` screen <img>', steps: ['Open `parser` <img>', 'Read `line three` <img>'], expect: 'A `word` appears. <img>' };
  const opened = await d.must('POST', '/api/rounds', { project: d.project, spec, mode: 'review', open: false });
  await page.goto(`${d.origin}/?lang=en#r=${opened.id}`);
  const overview = page.locator('#cr-overview');
  await expect(overview.locator('h3')).toHaveText(['What changed', 'Decisions for you', 'Risks', 'Independent reviewers', 'How to check it yourself', 'Checks']);
  await expect(overview).toContainText('Checked, the agent says, by: Parser test covers the word.');
  await expect(overview.locator('.cr-overview-section > .cr-said')).toHaveCount(0);
  await expect(overview.locator('.cr-ch-head > .cr-said')).toHaveCount(1);
  await expect(overview.locator('.cr-risk-check .cr-said')).toHaveCount(0);
  await expect(overview.locator('.cr-risk-check.warn')).toHaveText("Not checked");
  const acceptance = overview.locator('[data-section="acceptance"]');
  await expect(acceptance.locator('code')).toHaveText(['parser', 'Parser', 'parser', 'line three', 'word']);
  await expect(acceptance.locator('ol li')).toHaveText(['Open parser <img>', 'Read line three <img>']);
  await expect(acceptance).not.toContainText('`');
  await expect(acceptance.locator('img')).toHaveCount(0);
  await expect(acceptance).toContainText('The parser receives a word. <img>');
  await expect(acceptance).toContainText('Where to look: Parser screen <img>');
  await expect(acceptance).toContainText('What to expect: A word appears. <img>');
  await expect(overview).toContainText('The page does not run or verify these steps.');
  await page.locator('.cr-bar [data-verdict="approve"]').click();
  await expect(page.locator('[data-alert="decisions"]')).toContainText('1 decision not answered');
  await pickVerdict(page, "nits");
  await expect(page.locator('[data-alert="decisions"]')).toContainText('1 decision not answered');
  await expect(page.locator('.cr-verdict .modal-actions .primary')).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await overview.getByRole('button', { name: 'Use digit', exact: true }).click();
  await expect(overview.getByRole('button', { name: 'Use digit', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await overview.getByRole('button', { name: 'Go to place', exact: true }).click();
  await expect(page.locator('tr.cr-place').getByRole('button', { name: 'Use digit', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(overview.getByRole('button', { name: 'Use digit', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.cr-bar [data-verdict="approve"]').click();
  await expect(page.locator('[data-alert="decisionNo"]')).toContainText('1 decision answered no');
  await expect(page.locator('.cr-verdict .modal-actions .primary')).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await overview.getByRole('button', { name: 'Use digit', exact: true }).click();
  await expect(overview.getByRole('button', { name: 'Use digit', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await overview.getByRole('button', { name: 'Verdict', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'A note to the agent' })).toBeFocused();
});

for (const [colorScheme, lang, label] of [
  ["light", "en", "Open findings: 1"],
  ["dark", "ru", "Открытые находки: 1"],
]) test(`the chapter rail fits a finding count badge in the ${colorScheme} theme`, async ({ page }) => {
  test.skip(!hasGit, "git is not installed");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme });
  const title = "Страница ревью";
  const spec = {
    ...SPEC,
    chapters: SPEC.chapters.map(c => ({ ...c, title })),
    reviewers: {
      ran: [{ role: "correctness", model: "", summary: "The parser may reject the word.", verdict: "concerns" }],
      skipped: ["safety", "tests"].map(role => ({ role, model: "", why: "Outside this badge fixture." })),
      findings: [{ id: "f1", role: "correctness", severity: "blocking", at: "lib/a.mjs:3", text: "Keep the digit." }],
    },
  };
  const { id } = await d.must("POST", "/api/rounds", { project: d.project, spec, mode: "review", open: false });
  await page.goto(`${d.origin}/?lang=${lang}#r=${id}`);
  const rows = page.locator(".toc .cr-rail-item").filter({ hasText: title });
  await expect(rows).toHaveCount(2);
  const badge = rows.first().locator(".cr-open-findings");
  await expect(rows.last().locator(".cr-open-findings")).toBeHidden();
  await expect.soft(badge).toHaveText("1");
  await expect.soft(badge).toHaveAccessibleName(label);
  await expect.soft(badge).toHaveAttribute("title", label);
  for (const row of [rows.last(), rows.first()]) {
    const text = row.getByText(title, { exact: true });
    await expect.poll(() => text.evaluate(el => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)))).toBe(1);
  }
});

test("independent reviewer findings at their lines, decisions, and approval warnings", async ({ page }) => {
  test.skip(!hasGit, "git is not installed");
  const reviewers = {
    ran: [{ role: "correctness", model: "sonnet", summary: "The parser may reject the word.", verdict: "concerns" }],
    skipped: [{ role: "safety", model: "missing", why: "Model unavailable." }, { role: "tests", model: "", why: "Outside this fixture." }],
    findings: [
      { id: "f1", role: "correctness", severity: "blocking", at: "lib/a.mjs:3", line: "line three", text: "Keep the digit." },
      { id: "f2", role: "correctness", severity: "blocking", at: "lib/a.mjs:50", text: "Keep the other digit." },
      { id: "f3", role: "correctness", severity: "blocking", at: "notes.txt:3", text: "Check the new note." },
      { id: "f4", role: "correctness", severity: "minor", at: "lib/a.mjs:30", line: "line three", text: "Check this outside line." },
    ],
  };
  const { id } = await d.must("POST", "/api/rounds", { project: d.project, spec: { ...SPEC, reviewers }, mode: "review", open: false });
  await page.goto(`${d.origin}/?lang=en#r=${id}`);
  const overview = page.locator(".cr-reviewers");
  await expect(page.locator('.cr-bar [data-stat="blockers"]')).toHaveText("Blocking findings: 3");
  await expect(overview).toContainText("Independent reviewers");
  await expect(overview).toContainText("Bugs and regressions");
  await expect(overview).toContainText("sonnet");
  await expect(overview).toContainText("Model unavailable.");
  await expect(overview).toContainText("lib/a.mjs:30, not in this diff");
  await expect(overview).toContainText("3 blocking · 0 major · 1 minor");
  await expect(overview).toContainText("The line text now appears at line 3");
  await overview.getByRole("button", { name: "lib/a.mjs:3", exact: true }).click();
  const f1 = page.locator('tr[data-key="new:3"] .cr-finding[data-finding="f1"]');
  const f2 = page.locator('tr[data-key="new:50"] .cr-finding[data-finding="f2"]');
  const rest = page.locator('details[data-stop="rest"]');
  await expect(rest).toHaveAttribute("open", "");
  await expect(page.locator("#cr-ch-top .cr-open-findings")).toHaveText("1 open finding");
  await expect(f1).toBeFocused();
  await expect(f1.locator(".cr-finding-state")).toHaveText("Waiting for you");
  await page.getByRole("button", { name: "Hide reviewer findings" }).click();
  await expect(f1).toBeHidden();
  await page.reload();
  await expect(f1).toBeHidden();
  await page.getByRole("button", { name: "Show reviewer findings" }).click();
  let releaseSave;
  const saving = new Promise(resolve => { releaseSave = resolve; });
  await page.route(`**/api/rounds/${id}/finding`, async route => {
    await saving;
    await route.continue();
  }, { times: 1 });
  try {
    await f1.getByRole("button", { name: "To fix", exact: true }).click();
    await expect(f1.getByRole("button", { name: "Dismiss", exact: true })).toBeDisabled();
    await expect(overview.locator('[data-finding="f1"]').getByRole("button", { name: "Dismiss", exact: true })).toBeDisabled();
  } finally { releaseSave(); }
  await expect(f1.locator(".cr-finding-state")).toHaveText("To fix");
  await f2.getByRole("button", { name: "Dismiss", exact: true }).click();
  await f2.getByPlaceholder("Reason (optional)").fill("Out of scope");
  await f2.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(f2).toContainText("Out of scope");
  await page.reload();
  await overview.getByRole("button", { name: "lib/a.mjs:3", exact: true }).click();
  await expect(f1.locator(".cr-finding-state")).toHaveText("To fix");
  await overview.getByRole("button", { name: "lib/a.mjs:50", exact: true }).click();
  await expect(f2.locator(".cr-finding-state")).toHaveText("Dismissed");
  await expect(page.locator('.cr-bar [data-stat="blockers"]')).toHaveText("Blocking findings: 2");
  await expect(page.locator("#cr-ch-top .cr-open-findings")).toBeHidden();
  await expect(page.locator('.cr-bar [data-stat="said"]')).toHaveAttribute("title", /1 to fix/);
  await page.locator('.cr-bar [data-verdict="approve"]').click();
  const modal = page.locator(".cr-verdict");
  await expect(modal.locator('[data-alert="reviewer-blocking"]')).toContainText("2 blocking");
  await expect(modal.locator('[data-alert="reviewer-blocking"]')).toContainText("Line three");
  await expect(modal.locator('[data-alert="reviewer-skipped"]')).toContainText("Security and data");
  await pickVerdict(page, "nits");
  await expect(modal.locator('[data-alert="reviewer-blocking"]')).toBeVisible();
  await modal.locator(".btn.primary").click();
  await expect.poll(async () => (await d.round(id)).result?.verdict).toBe("nits");
});

test("the overview explains why a team did not run", async ({ page }) => {
  test.skip(!hasGit, "git is not installed");
  const none = await d.must("POST", "/api/rounds", { project: d.project, spec: { ...SPEC, reviewers: { none: "Sub-agents are unavailable." } }, mode: "review", open: false });
  await page.goto(`${d.origin}/?lang=en#r=${none.id}`);
  await expect(page.locator(".cr-reviewers")).toContainText("Sub-agents are unavailable.");
  await page.locator('.cr-bar [data-verdict="approve"]').click();
  await expect(page.locator('.cr-verdict [data-alert="reviewer-none"]')).toContainText("Sub-agents are unavailable.");
  await pickVerdict(page, "nits");
  await expect(page.locator('.cr-verdict [data-alert="reviewer-none"]')).toBeVisible();

  const { reviewers, ...spec } = SPEC;
  const small = await d.must("POST", "/api/rounds", { project: d.project, spec: { ...spec, risks: [], chapters: spec.chapters.map(c => ({ ...c, risk: "low" })) }, mode: "review", open: false });
  await page.goto(`${d.origin}/?lang=en#r=${small.id}`);
  await expect(page.locator(".cr-reviewers")).toContainText("No independent reviewers ran: not required for this change");
});

test("a returned Fix comes back at its change, with the same owner mark in both places", async ({ page }, info) => {
  test.skip(!hasGit, "git is not installed");
  const first = structuredClone(SPEC);
  first.chapters[1].focus = [{ at: "lib/a.mjs:50", note: "A word replaces the number.", kind: "decision", question: "Keep the word on line fifty?", options: ["Keep word", "Use number"] }];
  const { id } = await d.must("POST", "/api/rounds", {
    project: d.project, mode: "review", open: false, spec: first,
  });
  await page.goto(`${d.origin}/?lang=en#r=${id}`);
  const a = page.locator('#cr-ch-top .cr-hunk:has(.cr-path:text-is("lib/a.mjs"))');
  await a.locator('tr.cr-line[data-key="new:3"] td.t').click();
  const box = a.locator(".cr-compose");
  await box.locator("textarea").fill("Keep the digit for the parser.");
  await box.locator(".btn.primary").click();
  await expect(a.locator(".cr-cm")).toContainText("Keep the digit for the parser.");
  const answer = page.locator("#cr-overview").getByRole("button", { name: "Use number", exact: true });
  await answer.click();
  await expect(answer).toHaveAttribute("aria-pressed", "true");
  await page.locator('.cr-bar [data-verdict="return"]').click();
  await page.locator(".cr-verdict .btn.primary").click();
  await expect.poll(async () => (await d.round(id)).result?.verdict).toBe("return");

  const { comments: [{ id: ref }], decisions: [{ id: decision }] } = (await d.round(id)).result;
  repo.write("lib/a.mjs", lines(60));
  repo.git("commit", "-qam", "keep the digit");
  const follow = await d.must("POST", "/api/rounds", {
    project: d.project, mode: "review", open: false,
    spec: {
      ...SPEC, previous: id, title: "Keep the digit", summary: "The parser gets the original input.",
      chapters: [{ id: "parser", title: "Parser", summary: "Put the digit back.", hunks: ["lib/a.mjs"] }],
      mechanical: [], resolved: [
        { ref, how: "fixed", at: "lib/a.mjs:3", note: "Restored the digit." },
        { ref: decision, how: "fixed", at: "lib/a.mjs:50", note: "Restored the number." },
      ],
    },
  });
  await page.goto(`${d.origin}/?lang=en#r=${follow.id}`);
  await expect(page.locator(".cr-meta")).toContainText("Round 2");
  await expect(page.locator(".cr-meta")).toContainText(`since round ${id}`);
  await expect(page.locator(".cr-meta")).toContainText("the whole branch");
  const overview = page.getByRole("region", { name: "What happened to your comments" });
  const row = overview.locator(`[data-resolution="${ref}"]`);
  await expect(row).toContainText("Keep the digit for the parser.");
  await expect(row).toContainText("Restored the digit.");
  await expect(row).toContainText("lib/a.mjs");
  const decisionRow = overview.locator(`[data-resolution="${decision}"]`);
  await expect.soft(decisionRow.getByText("You answered: Use number", { exact: true })).toBeVisible();
  await decisionRow.getByRole("button", { name: "Go to change" }).click();
  const decisionMark = page.locator(`tr.cr-place [data-resolution="${decision}"]`);
  await expect.soft(decisionMark.locator(".cr-place-note")).toHaveText("Acts on your answer «Use number»: «Keep the word on line fifty?»");
  await decisionRow.getByRole("button", { name: "Accepted" }).click();
  await expect(decisionRow.getByRole("button", { name: "Accepted" })).toHaveAttribute("aria-pressed", "true");

  await page.locator('.cr-bar [data-verdict="approve"]').click();
  await expect(page.locator('[data-alert="resolution"]')).toContainText("1 reply not marked");
  await page.keyboard.press("Escape");
  await page.screenshot({ path: info.outputPath("follow-up-overview.png") });

  await row.getByRole("button", { name: "Go to change" }).click();
  const mark = page.locator(`tr.cr-place [data-resolution="${ref}"]`);
  await expect(mark).toBeInViewport();
  await expect(mark).toContainText("Fixes your comment");
  await expect(mark.locator("xpath=ancestor::tr/following-sibling::tr[1]")).toHaveAttribute("data-key", "new:3");
  await mark.getByRole("button", { name: "Not fixed" }).click();
  await expect(row.getByRole("button", { name: "Not fixed" })).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(row.getByRole("button", { name: "Not fixed" })).toHaveAttribute("aria-pressed", "true");
  await page.locator('.cr-bar [data-verdict="approve"]').click();
  await expect(page.locator('[data-alert="fix"]')).toContainText("1");
  await expect(page.locator('[data-alert="resolution"]')).toHaveCount(0);
  await page.keyboard.press("Escape");

  await row.getByRole("button", { name: "Accepted" }).click();
  await row.getByRole("button", { name: "Go to change" }).click();
  await expect(mark.getByRole("button", { name: "Accepted" })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: info.outputPath("follow-up-line.png") });
  await page.reload();
  await expect(row.getByRole("button", { name: "Accepted" })).toHaveAttribute("aria-pressed", "true");
  await page.locator('.cr-bar [data-verdict="approve"]').click();
  await expect(page.locator('[data-alert="resolution"]')).toHaveCount(0);
  await page.locator(".cr-verdict .btn.primary").click();
  await expect.poll(async () => (await d.round(follow.id)).result?.verdict).toBe("approve");
  await expect(page.getByText(`Follow-up to round ${id}.`, { exact: true })).toBeVisible();
});

test("independent decision saves finish before a verdict and both reach the result", async ({ page }) => {
  test.skip(!hasGit, "git is not installed");
  const spec = structuredClone(SPEC);
  spec.chapters[0].focus = [3, 4].map(line => ({
    at: `lib/a.mjs:${line}`, kind: "decision", note: "Check the change.", question: `Keep line ${line}?`,
  }));
  const { id } = await d.must("POST", "/api/rounds", { project: d.project, base: "main", head: repo.feature, spec, mode: "review", open: false });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/rounds/${id}/decision`, async route => {
    if (route.request().postDataJSON().at.endsWith(":3")) await gate;
    await route.continue();
  });
  await page.goto(`${d.origin}/?lang=en#r=${id}`);
  const questions = page.locator("#cr-overview .cr-decision");
  try {
    await questions.nth(0).getByRole("button", { name: "Yes" }).click();
    await questions.nth(1).getByRole("button", { name: "No" }).click();
    await expect(questions.nth(1).getByRole("button", { name: "No" })).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Control+Enter");
  } finally { release(); }
  const modal = page.getByRole("dialog");
  await expect(modal.locator('[data-verdict="return"]')).toHaveAttribute("aria-pressed", "true");
  await expect(modal.locator('[data-alert="empty"]')).toHaveCount(0);
  await pickVerdict(page, "nits");
  await expect(modal.locator('[data-alert="decisionNo"]')).toBeVisible();
  await modal.locator(".modal-actions .primary").focus();
  await page.keyboard.press("Tab");
  await expect.poll(() => modal.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await modal.locator(".modal-actions .primary").click();
  await expect(page.locator(".done-view")).toBeVisible();
  expect((await d.round(id)).result.decisions.map(d => d.answer)).toEqual(["yes", "no"]);
});

test("a line takes a comment from the keyboard, and the bar leads with the verdict the state points to", async ({ page }) => {
  test.skip(!hasGit, "git is not installed");
  const opened = await d.must("POST", "/api/rounds", { project: d.project, spec: SPEC, mode: "review", open: false });
  await page.goto(opened.url.replace("/#", "/?lang=en#"));
  const bar = page.locator(".cr-bar");
  // nothing said, no failed check: the bar leads with the approval
  await expect(bar.locator('[data-verdict="approve"]')).toHaveClass(/\bprimary\b/);
  await expect(bar.locator('[data-verdict="return"]')).not.toHaveClass(/\bprimary\b/);

  // Tab stops on one line of a piece, the arrows walk its lines, Enter opens the box on the line in focus
  const a = page.locator('#cr-ch-top .cr-hunk:has(.cr-path:text-is("lib/a.mjs"))');
  await expect(a.locator('tr.cr-line[tabindex="0"]')).toHaveCount(1);
  const first = a.locator("tr.cr-line").first();
  await first.focus();
  await page.keyboard.press("ArrowDown");
  const second = a.locator("tr.cr-line").nth(1);
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute("tabindex", "0");
  await expect(first).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("Enter");
  const box = page.locator(".cr-compose");
  await expect(box.locator("textarea")).toBeFocused();
  await box.locator("textarea").fill("Said without a mouse.");
  await box.locator("textarea").press("ControlOrMeta+Enter");
  await expect(a.locator(".cr-cm.fix .cr-cm-text")).toHaveText("Said without a mouse.");

  // something to fix: the bar leads with the return, and its dialog confirms that verdict alone
  await expect(bar.locator('[data-verdict="return"]')).toHaveClass(/\bprimary\b/);
  await expect(bar.locator('[data-verdict="approve"]')).not.toHaveClass(/\bprimary\b/);
  await bar.locator('[data-verdict="return"]').click();
  const modal = page.locator(".cr-verdict");
  await expect(modal.locator(".modal-title")).toHaveText("Return to the agent?");
  await expect(modal.locator(".cr-seg")).toBeHidden();
  await expect(modal.locator('[data-alert="empty"]')).toHaveCount(0);
  await modal.locator(".cr-verdict-change").click();
  await expect(modal.locator('.cr-seg [data-verdict="return"]')).toBeFocused();
  await expect(modal.locator('.cr-seg [data-verdict="return"]')).toHaveAttribute("aria-pressed", "true");
});
