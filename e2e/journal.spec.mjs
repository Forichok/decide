import { test, expect } from "@playwright/test";
import { startDecide, spec } from "./helpers.mjs";

let d;
test.beforeAll(async () => {
  d = await startDecide({ name: "journal" });
  // Two answered rounds in the project: the journal has something to show.
  for (const [title, pick] of [["Pick the storage", "pg"], ["Pick the cache", "sqlite"]]) {
    const id = await d.open(spec({ title }));
    await d.must("POST", `/api/rounds/${id}/submit`, { answers: { db: { selected: [pick] } } });
  }
});
test.afterAll(async () => d?.stop());

const journal = async (page) => {
  await page.goto(`${d.origin}/#journal`);
  await page.locator(".jp-list").waitFor();
};

test("the journal page lists answered rounds under their day", async ({ page }) => {
  await journal(page);
  await expect(page.locator(".jp-count")).toContainText("2 decisions");
  await expect(page.locator(".jp-title", { hasText: "Pick the storage" })).toBeVisible();
  await expect(page.locator(".jp-title", { hasText: "Pick the cache" })).toBeVisible();
  // A date heading above the entries.
  await expect(page.locator(".jp-day").first()).toBeVisible();
  await expect(page.locator(".jp-day").first()).toContainText(String(new Date().getFullYear()));
});

test("search narrows the list and an empty search says nothing found", async ({ page }) => {
  await journal(page);
  await page.locator(".jp-search").fill("storage");
  await expect(page.locator(".jp-title")).toHaveCount(1);
  await page.locator(".jp-search").fill("zzzz-no-such-thing");
  await expect(page.locator(".jr-empty")).toContainText("Nothing found");
});

test("an entry opens its answers", async ({ page }) => {
  await journal(page);
  const first = page.locator(".jp-digest").first();
  await first.locator("summary").click();
  await expect(first.locator("pre")).toContainText(/Which database/);
});

test("the map view draws the decisions or says why there are no links", async ({ page }) => {
  await journal(page);
  await page.getByRole("button", { name: "Map", exact: true }).click();
  const box = page.locator(".jp-map");
  await expect(box).toBeVisible();
  await expect(box.locator(".map-note").first()).toContainText(/\d+ decisions, 0 links/, { timeout: 15_000 });
  await expect(box).toContainText("No links between decisions yet");
});

test("a bad round id is an error with a way back, not a blank page", async ({ page }) => {
  await page.goto(`${d.origin}/#r=9-nonexistent`);
  await expect(page.locator("body")).toContainText("There is no round 9-nonexistent", { timeout: 10_000 });
});

test.fixme("the journal switches between projects and the map offers a neighbourhood picker", async () => {
  // Waits for chunk J (journal project switch and neighbourhood picker). Contract: the journal page has a
  // project select that reloads the list for that project; above 40 nodes the map has a picker for a round
  // whose neighbourhood to draw.
});
