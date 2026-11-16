import { test, expect } from "@playwright/test";
import { startDecide, spec } from "./helpers.mjs";
import { card, openRound, opt, serverAnswer } from "./ui.mjs";

let d;
test.beforeAll(async () => {
  d = await startDecide({ name: "stale" });
});
test.afterAll(async () => d?.stop());

async function answeredAndStale(page) {
  const id = await d.open(spec());
  await openRound(page, d, id);
  await opt(page, "db", "pg").click();
  expect(await serverAnswer(d, id, "db")).toBeTruthy();
  await d.patch(id, { stale: "db" }, { reason: "The load numbers changed" });
  await expect(card(page, "db")).toHaveClass(/st-stale/);
  return id;
}

test("a stale answer says check, shows the reason and counts in the footer", async ({ page }) => {
  await answeredAndStale(page);
  await expect(card(page, "db").locator(".q-state")).toContainText("The load numbers changed");
  await expect(page.locator("#bar .bar-check")).toHaveText("1 answer to check");
  await expect(page.locator('#bar .seg-dot[data-qid="db"]')).toHaveAttribute("data-state", /stale|current/);
});

test("the footer count opens the list and 'keep my answer' clears it", async ({ page }) => {
  await answeredAndStale(page);
  await page.locator("#bar .bar-check").click();
  const list = page.locator(".check-list");
  await expect(list).toContainText("Which database?");
  await expect(list).toContainText("The load numbers changed");
  await list.getByRole("button", { name: "Keep my answer" }).click();
  await expect(card(page, "db")).not.toHaveClass(/st-stale/);
  await expect(page.locator("#bar .bar-check")).toBeHidden();
});

test("Done is refused while an answer is unconfirmed, on the page and on the server", async ({ page }) => {
  const id = await answeredAndStale(page);
  await page.locator("#bar .bar-done").click();
  // The page does not send: the list of answers to check opens instead of the review dialog.
  await expect(page.locator(".check-list")).toBeVisible();
  await expect(page.locator("#overlay .btn.primary", { hasText: "Send to the agent" })).toHaveCount(0);
  const refused = await d.call("POST", `/api/rounds/${id}/submit`, { answers: {} });
  expect(refused.status).toBe(409);
  expect(JSON.stringify(refused.data)).toContain("db");
  expect((await d.round(id)).status).toBe("pending");
});

test("after 'answer again' the round can be sent", async ({ page }) => {
  const id = await answeredAndStale(page);
  await card(page, "db").locator('[data-act="again"]').click();
  await opt(page, "db", "sqlite").click();
  await expect(card(page, "db")).not.toHaveClass(/st-stale/);
  await page.locator("#bar .bar-done").click();
  await page.locator("#overlay .btn.primary", { hasText: "Send to the agent" }).click();
  await expect(page.locator(".done-view")).toBeVisible({ timeout: 10_000 });
  expect((await d.round(id)).status).not.toBe("pending");
});
