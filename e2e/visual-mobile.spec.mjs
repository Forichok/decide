import { test, expect } from "@playwright/test";
import { startDecide, MOBILE } from "./helpers.mjs";

test("a visual round on a narrow screen keeps a manual check beside its evidence gap", async ({ page }) => {
  const d = await startDecide({ name: "visual-mobile" });
  try {
    const id = await d.open({ title: "Fixture", questions: [{ id: "x", title: "Why?", type: "text" }] });
    // Exercise the renderer with a pending visual round, independent of the capture pipeline.
    await page.route("**/api/rounds/" + id, async route => {
      const raw = await d.round(id);
      await route.fulfill({ json: { ...raw, mode: "visual", spec: {
        title: "Email preferences", summary: ["A subscriber can reopen saved preferences."],
        range: { base: "b".repeat(40), head: "a".repeat(40), baseRef: "main", headRef: "feature" },
        tasks: [{ id: "email", title: "Open history", beforeText: "The history was empty.", afterText: "The saved change is visible.",
          steps: ["Open history."], expected: "One change.", gap: "The historical environment is offline.", evidence: [] }]
      }, visual: { checks: {}, marks: [], gaps: {}, resolutions: {} } } });
    });
    await page.setViewportSize(MOBILE);
    await page.goto(d.origin + "/?lang=en#r=" + id);
    await expect(page.getByRole("heading", { name: "Open history" })).toBeVisible();
    await expect(page.getByText("The historical environment is offline.")).toBeVisible();
    await expect(page.getByRole("button", { name: "I checked this myself" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await d.stop(); }
});
