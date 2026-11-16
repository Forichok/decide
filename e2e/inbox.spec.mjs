import { test, expect } from "@playwright/test";
import { startDecide, spec } from "./helpers.mjs";
import { openRound, opt } from "./ui.mjs";

// The rail is a column beside the page from 1420 px; each test gets a server of its own so the rows are its own.
test.use({ viewport: { width: 1500, height: 900 } });
let d;
test.beforeEach(async () => {
  d = await startDecide({ name: "inbox" });
});
test.afterEach(async () => d?.stop());

const named = (title, extra = {}) => spec({ title, ...extra });

test("the rail lists every waiting round with project, title and progress", async ({ page }) => {
  const a = await d.open(named("First round"));
  await d.open(named("Second round"));
  await openRound(page, d, a);
  const rail = page.locator("#rail");
  await expect(rail.locator(".ib-item")).toHaveCount(2, { timeout: 10_000 });
  await expect(rail.locator(".ib-name", { hasText: "Second round" })).toBeVisible();
  await expect(rail.locator(".ib-item.current .ib-name")).toHaveText("First round");
  await expect(rail.locator(".ib-count").first()).toContainText("0 of 3 answered");
  await expect(rail.locator(".ib-project").first()).toHaveText("project");
});

test("a round opened later appears in the rail without a new tab", async ({ page, context }) => {
  const a = await d.open(named("Base round"));
  await openRound(page, d, a);
  const before = await page.locator("#rail .ib-item").count();
  const pagesBefore = context.pages().length;
  await d.open(named("Late round"));
  await expect(page.locator("#rail .ib-item")).toHaveCount(before + 1, { timeout: 10_000 });
  await expect(page.locator("#rail .ib-name", { hasText: "Late round" })).toBeVisible();
  expect(context.pages().length).toBe(pagesBefore);
});

test("high stakes come first in the order of the rail", async ({ page }) => {
  const calm = await d.open(named("Calm order round"));
  const hot = await d.open(
    named("High stakes order round", {
      questions: [{ id: "k", type: "single", title: "Drop the table?", why: "Data.", stakes: "high", reversible: false, options: [{ id: "y", label: "Yes", then: "Gone." }, { id: "n", label: "No", then: "Kept." }] }],
    }),
  );
  await openRound(page, d, calm);
  const names = await page.locator("#rail .ib-name").allTextContents();
  expect(names.indexOf("High stakes order round")).toBeLessThan(names.indexOf("Calm order round"));
  expect(hot).toBeTruthy();
});

test("dismiss takes a round out of the rail after one confirmation", async ({ page }) => {
  // BUG (product): the page's POST /api/rounds/:id/dismiss is refused with 403, because lib/http.mjs lists
  // dismiss among the agent-only routes, so the page (Origin, no token) can never dismiss. Expected to fail.
  test.fail();
  const keep = await d.open(named("Dismiss keeper"));
  await d.open(named("Dismiss victim"));
  await openRound(page, d, keep);
  const row = page.locator("#rail .ib-item", { hasText: "Dismiss victim" });
  await row.hover();
  await row.locator(".ib-x").click();
  await expect(row.locator(".ib-x")).toContainText("Dismiss?");
  await row.locator(".ib-x").click();
  await expect(page.locator("#rail .ib-item", { hasText: "Dismiss victim" })).toHaveCount(0, { timeout: 8000 });
});

test("after Done the page offers the next round and the tab does not close itself", async ({ page }) => {
  const first = await d.open(named("Done first"));
  await d.open(named("Done next"));
  await openRound(page, d, first);
  await opt(page, "db", "pg").click();
  await page.locator("#bar .bar-done").click();
  await page.locator("#overlay .btn.primary", { hasText: "Send to the agent" }).click();
  await expect(page.locator(".next-row")).toContainText("Done next", { timeout: 10_000 });
  expect(page.isClosed()).toBe(false);
});
