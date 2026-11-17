import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { startDecide, spec } from "./helpers.mjs";
import { prepareSpec } from "../lib/prepare.mjs";
import { openProject } from "../lib/project.mjs";

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

// A second server with two projects: three decisions in one, forty-five in the other (the map trims above 40).
async function twoProjects() {
  const d2 = await startDecide({ name: "journal-two" });
  const other = path.join(d2.dir, "other-project");
  mkdirSync(other, { recursive: true });
  const dh = path.join(d2.dir, "dh");
  const make = async (project, title, n) => {
    const dataDir = openProject(project, dh).dataDir;
    const prepared = await prepareSpec(spec({ title: `${title} ${n}` }), { specDir: project, dataDir, shots: false });
    const out = await d2.must("POST", "/api/rounds", { project, spec: prepared.spec, live: false, open: false });
    await d2.must("POST", `/api/rounds/${out.id}/submit`, { answers: { db: { selected: ["pg"] } } });
    return out.id;
  };
  for (let n = 1; n <= 45; n++) await make(d2.project, "Big", n);
  for (let n = 1; n <= 3; n++) await make(other, "Small", n);
  return { d2, other };
}

test("the journal switches between projects and the map offers a neighbourhood picker", async ({ page }) => {
  test.setTimeout(120_000);
  const { d2, other } = await twoProjects();
  try {
    const api = await d2.must("GET", "/api/map");
    expect(api.projects.map((p) => p.count).sort((a, b) => a - b)).toEqual([3, 45]);
    expect(api.rounds.length).toBeGreaterThan(40);

    await page.goto(`${d2.origin}/#journal`);
    await page.locator(".jp-list").waitFor();
    const buttons = page.locator(".jp-projects button[data-project]");
    await expect(buttons).toHaveCount(3);
    const small = page.locator(`.jp-projects button[data-project="${other}"]`);
    await small.click();
    await expect(small).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".jp-title", { hasText: "Small 1" })).toBeVisible();
    await expect(page.locator(".jp-title", { hasText: "Big 1" })).toHaveCount(0);
    await buttons.first().click();
    await expect(page.locator(".jp-title", { hasText: "Big 1" }).first()).toBeVisible();

    await page.getByRole("button", { name: "Map", exact: true }).click();
    const box = page.locator(".jp-map");
    await expect(box.locator(".map-find")).toBeVisible({ timeout: 15_000 });
    await box.locator(".map-find").fill("Big 7");
    const hit = box.locator("button.map-round", { hasText: /Big 7$/ });
    await expect(hit).toHaveCount(1);
    await expect(box.locator(".map-picker button.map-round")).toHaveCount(1);
    await hit.click();
    await expect(box.locator(".map-back")).toBeVisible();
    await expect(box.locator("details.map-centres")).toBeVisible();
    await box.locator(".map-back").click();
    await expect(box.locator(".map-back")).toHaveCount(0);
  } finally {
    await d2.stop();
  }
});
