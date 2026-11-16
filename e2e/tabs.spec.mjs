import { test, expect } from "@playwright/test";
import { startDecide, spec } from "./helpers.mjs";
import { openRound, opt, saved, serverAnswer } from "./ui.mjs";

let d;
test.beforeAll(async () => {
  d = await startDecide({ name: "tabs" });
});
test.afterAll(async () => d?.stop());

test("two tabs on one round converge and neither wipes the other", async ({ browser }) => {
  const id = await d.open(spec());
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await openRound(a, d, id);
  await openRound(b, d, id);

  await opt(a, "db", "sqlite").click();
  await expect(opt(b, "db", "sqlite")).toHaveAttribute("aria-checked", "true");

  await opt(b, "tabs", "search").click();
  await expect(opt(a, "tabs", "search")).toHaveAttribute("aria-checked", "true");
  // A's earlier answer is still there on both: B's save did not wipe it.
  await expect(opt(a, "db", "sqlite")).toHaveAttribute("aria-checked", "true");
  await expect(opt(b, "db", "sqlite")).toHaveAttribute("aria-checked", "true");

  const answers = await d.answers(id);
  expect(JSON.stringify(answers.db)).toContain("sqlite");
  expect(JSON.stringify(answers.tabs)).toContain("search");
  await ctx.close();
});

test("a reload restores answers and the save indicator says saved", async ({ page }) => {
  const id = await d.open(spec());
  await openRound(page, d, id);
  await opt(page, "db", "pg").click();
  await expect(saved(page)).toHaveAttribute("data-status", "saved");
  expect(await serverAnswer(d, id, "db")).toBeTruthy();
  await page.reload();
  await page.locator(".card").first().waitFor();
  await expect(opt(page, "db", "pg")).toHaveAttribute("aria-checked", "true");
});

test("reload restores the scroll position of the round", async ({ page }) => {
  const long = spec();
  for (let i = 0; i < 10; i++) long.questions.push({ id: `x${i}`, type: "text", title: `Filler ${i}?`, why: "Filler to make the page long." });
  const id = await d.open(long);
  await openRound(page, d, id);
  await page.locator("#q-x6").scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => Math.round(scrollY));
  expect(before).toBeGreaterThan(300);
  await page.reload();
  await page.locator(".card").first().waitFor();
  await expect.poll(() => page.evaluate(() => Math.round(scrollY))).toBeGreaterThan(before - 250);
});
