import { test, expect } from "@playwright/test";
import { startDecide, spec } from "./helpers.mjs";
import { openRound } from "./ui.mjs";

let d;
test.beforeAll(async () => {
  d = await startDecide({ name: "brief" });
});
test.afterAll(async () => d?.stop());

const withBrief = () =>
  spec({
    brief: [
      { kind: "decision", text: "We ship a small first release." },
      { kind: "risk", text: "The load is a guess." },
      "A plain string is a note.",
    ],
  });

test("a round with a brief shows the task panel grouped by kind, plus the open questions", async ({ page }) => {
  const id = await d.open(withBrief());
  await openRound(page, d, id);
  const panel = page.locator(".q-brief");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".k-decision")).toContainText("We ship a small first release.");
  await expect(panel.locator(".k-risk")).toContainText("The load is a guess.");
  // Every unanswered question is listed as open.
  await expect(panel.locator(".k-open li")).toHaveCount(3);
});

test("the panel folds and unfolds", async ({ page }) => {
  const id = await d.open(withBrief());
  await openRound(page, d, id);
  const panel = page.locator(".q-brief");
  const toggle = panel.locator(".q-brief-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(panel).toHaveClass(/folded/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("answering a question takes it out of the open list", async ({ page }) => {
  const id = await d.open(withBrief());
  await openRound(page, d, id);
  await page.keyboard.press("1");
  await expect(page.locator(".q-brief .k-open li")).toHaveCount(2);
});

test("the agent rewrites the brief with a patch and the panel follows", async ({ page }) => {
  // BUG (product): the brief patch op is stored (view.brief) but ui/js/brief.js taskPanel only reads spec.brief,
  // so the panel never changes, live or after a reload. Expected to fail until the page reads view.brief.
  test.fail();
  const id = await d.open(withBrief());
  await openRound(page, d, id);
  await d.patch(id, { brief: [{ kind: "decision", text: "Scope is now the pilot only." }] }, { reason: "Pilot first" });
  await expect(page.locator(".q-brief .k-decision")).toContainText("Scope is now the pilot only.", { timeout: 2000 });
});
