import { test, expect } from "@playwright/test";
import { startDecide, spec } from "./helpers.mjs";
import { card, openRound, opt, until } from "./ui.mjs";

let d;
test.beforeAll(async () => {
  d = await startDecide({ name: "keys" });
});
test.afterAll(async () => d?.stop());

const twoSingles = () =>
  spec({
    questions: [
      { id: "one", type: "single", title: "First?", why: "A.", options: [{ id: "a", label: "A", then: "x" }, { id: "b", label: "B", then: "y" }] },
      { id: "two", type: "single", title: "Second?", why: "B.", options: [{ id: "c", label: "C", then: "x" }, { id: "d", label: "D", then: "y" }] },
      { id: "three", type: "scale", title: "How sure?", why: "C.", min: 1, max: 5 },
    ],
  });

test("1, J, 2 answers the second question", async ({ page }) => {
  const id = await d.open(twoSingles());
  await openRound(page, d, id);
  await page.keyboard.press("1");
  await expect(opt(page, "one", "a")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("j");
  await page.keyboard.press("2");
  await expect(opt(page, "two", "d")).toHaveAttribute("aria-checked", "true");
  const a = await until(async () => {
    const x = await d.answers(id);
    return x.one && x.two ? x : null;
  });
  expect(JSON.stringify(a.two)).toContain("d");
});

test("one count in the header, the footer and the segments follows the answers", async ({ page }) => {
  const id = await d.open(twoSingles());
  await openRound(page, d, id);
  await expect(page.locator(".meta-row .count")).toHaveText("0 of 3 decided");
  await expect(page.locator("#bar .bar-count")).toHaveText("0 of 3 decided");
  await page.keyboard.press("1");
  await page.keyboard.press("j");
  await expect(page.locator(".meta-row .count")).toHaveText("1 of 3 decided");
  await expect(page.locator("#bar .bar-count")).toHaveText("1 of 3 decided");
  await expect(page.locator('#bar .seg-dot[data-qid="one"]')).toHaveAttribute("data-state", "answered");
  await expect(page.locator('#bar .seg-dot[data-qid="two"]')).toHaveAttribute("data-state", "current");
});

test("a scale answer counts as answered", async ({ page }) => {
  const id = await d.open(twoSingles());
  await openRound(page, d, id);
  await card(page, "three").scrollIntoViewIfNeeded();
  await card(page, "three").locator(".opt, button, [role=radio]").first().click();
  await page.keyboard.press("k");
  await expect(page.locator('#bar .seg-dot[data-qid="three"]')).toHaveAttribute("data-state", "answered");
});

test("R takes the recommendation, S skips, N jumps to the next open question", async ({ page }) => {
  const s = twoSingles();
  s.questions[0].options[1].recommended = true;
  const id = await d.open(s);
  await openRound(page, d, id);
  await page.keyboard.press("r");
  await expect(opt(page, "one", "b")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("n");
  await page.keyboard.press("s");
  await page.keyboard.press("j");
  await expect(page.locator('#bar .seg-dot[data-qid="two"]')).toHaveAttribute("data-state", "skipped");
});

test("the footer shows key hints with a keyboard and touch hints on touch", async ({ page, browser }) => {
  const id = await d.open(twoSingles());
  await openRound(page, d, id);
  await expect(page.locator("#bar .hint-keys")).toBeVisible();
  await expect(page.locator("#bar .hint-touch")).toBeHidden();
  const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });
  const m = await ctx.newPage();
  await openRound(m, d, id);
  await expect(m.locator("#bar .hint-touch")).toBeVisible();
  await expect(m.locator("#bar .hint-keys")).toBeHidden();
  await ctx.close();
});

test("Ctrl+Enter opens the review dialog and Escape closes it", async ({ page }) => {
  const id = await d.open(twoSingles());
  await openRound(page, d, id);
  await page.keyboard.press("Control+Enter");
  await expect(page.locator("#overlay")).toBeVisible();
  await expect(page.locator("#overlay")).toContainText("Check before sending");
  await page.keyboard.press("Escape");
  await expect(page.locator("#overlay")).toBeHidden();
});
