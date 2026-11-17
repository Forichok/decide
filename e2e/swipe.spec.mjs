import { test, expect } from "@playwright/test";
import { startDecide, MOBILE } from "./helpers.mjs";
import { until } from "./ui.mjs";

let d;
test.beforeAll(async () => {
  d = await startDecide({ name: "swipe" });
});
test.afterAll(async () => d?.stop());

const deck = (over = {}) => ({
  title: "E2E deck",
  goal: "Pick a few things",
  brief: [{ kind: "decision", text: "Phones first" }],
  cards: [
    { id: "c1", title: "Dark mode first?", left: { label: "Light only" }, right: { label: "Ship dark" }, recommended: "right", reason: "most users ask" },
    { id: "c2", title: "Weekly digest?", left: { label: "No digest" }, right: { label: "Weekly" } },
    { id: "c3", title: "Offline support?", left: { label: "Online only" }, right: { label: "Offline too" } },
  ],
  ...over,
});

const front = (page) => page.locator(".sw-card.front");
const open = async (page, over) => {
  const id = await d.open(deck(over), { mode: "swipe" });
  await page.goto(d.url(id));
  await front(page).waitFor();
  return id;
};

test("the deck shows the front card with two sides and the recommended one marked", async ({ page }) => {
  await open(page);
  await expect(front(page)).toContainText("Dark mode first?");
  await expect(front(page).locator(".sw-side")).toHaveCount(2);
  await expect(front(page).locator(".sw-side.rec")).toContainText("Ship dark");
});

test("arrow keys answer: right, left and up (skip) move through the deck and reach the end screen", async ({ page }) => {
  const id = await open(page);
  await page.keyboard.press("ArrowRight");
  await expect(front(page)).toContainText("Weekly digest?");
  await page.keyboard.press("ArrowLeft");
  await expect(front(page)).toContainText("Offline support?");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".sw-end")).toBeVisible();
  const a = await until(async () => {
    const x = (await d.round(id)).swipe?.answers ?? {};
    return x.c1 && x.c2 ? x : null;
  });
  expect(JSON.stringify(a.c1)).toContain("right");
  expect(JSON.stringify(a.c2)).toContain("left");
});

test("backspace takes the last answer back", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ArrowRight");
  await expect(front(page)).toContainText("Weekly digest?");
  await page.keyboard.press("Backspace");
  await expect(front(page)).toContainText("Dark mode first?");
});

test("on a phone the card fits the screen and the thumb buttons answer", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await open(page);
  const box = await front(page).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(MOBILE.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(MOBILE.width);
  await page.locator(".sw-key.right").click();
  await expect(front(page)).toContainText("Weekly digest?");
  await page.locator(".sw-key.left").click();
  await expect(front(page)).toContainText("Offline support?");
});

test("the brief is on the page and the end screen is reached after the last card", async ({ page }) => {
  await open(page);
  await expect(page.locator("body")).toContainText("Phones first");
  await page.keyboard.press("ArrowRight");
  await expect(front(page)).toContainText("Weekly digest?");
  await page.keyboard.press("ArrowRight");
  await expect(front(page)).toContainText("Offline support?");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".sw-end")).toBeVisible();
});

test("cards the agent changed come back at the end with the old answer preselected", async ({ page }) => {
  const id = await open(page);
  await page.keyboard.press("ArrowRight");
  await expect(front(page)).toContainText("Weekly digest?");
  await d.patch(id, { set: { id: "c1", title: "Dark mode first, really?" } }, { reason: "the plan moved" });
  await page.keyboard.press("ArrowLeft");
  await expect(front(page)).toContainText("Offline support?");
  await page.keyboard.press("ArrowLeft");
  await expect(front(page)).toContainText("Dark mode first, really?");
  await expect(front(page)).toHaveClass(/recheck/);
  await expect(front(page).locator(".sw-recheck")).toContainText("the plan moved");
  await expect(front(page)).toHaveAttribute("data-pre", "right");
  await front(page).locator("button[data-act=keep]").click();
  await expect(page.locator(".sw-end")).toBeVisible();
  const a = await until(async () => {
    const r = await d.round(id);
    return r.swipe?.answers?.c1 && !(r.view?.stale ?? []).includes("c1") ? r.swipe.answers : null;
  });
  expect(JSON.stringify(a.c1)).toContain("right");
});

test("a removed card the user already saw becomes a ghost that can be restored", async ({ page }) => {
  const id = await open(page);
  await page.keyboard.press("ArrowRight");
  await expect(front(page)).toContainText("Weekly digest?");
  await d.patch(id, { remove: "c1" }, { reason: "no longer relevant" });
  const ghosts = page.locator(".sw-ghosts");
  await expect(ghosts).toContainText("Dark mode first?");
  await ghosts.getByRole("button").click();
  await expect(page.locator(".sw-ghosts")).toHaveCount(0);
  const view = await until(async () => {
    const r = await d.round(id);
    return (r.view?.ghosts ?? []).length === 0 && r.swipe?.answers?.c1 ? r : null;
  });
  expect(view).toBeTruthy();
});

test("push goes through the patch engine on a swipe round", async ({ page }) => {
  const id = await open(page);
  const out = await d.push(id, { add: [{ id: "n1", title: "Pushed card?", left: { label: "No" }, right: { label: "Yes" } }], position: "next", reason: "pushed" });
  expect(out.added).toBe(1);
  await page.keyboard.press("ArrowRight");
  await expect(front(page)).toContainText("Pushed card?");
  // The patch engine marks the card new with the push's reason; the old push path had no such view.
  const item = (await d.round(id)).swipe.view.items.find((e) => e.id === "n1");
  expect(item).toMatchObject({ state: "new", reason: "pushed" });
});

test("a patch on a swipe round is accepted, not refused with 409", async ({ page }) => {
  const id = await open(page);
  const r = await d.call("POST", `/api/rounds/${id}/patch`, { ops: [{ add: { item: { id: "n2", title: "Patched in?", left: { label: "No" }, right: { label: "Yes" } } } }] });
  expect(r.status).toBe(200);
  for (const next of ["Weekly digest?", "Offline support?", "Patched in?"]) {
    await page.keyboard.press("ArrowRight");
    await expect(front(page)).toContainText(next);
  }
});

test("cards shown on screen are reported as seen: POST /api/rounds/:id/seen {ids}", async ({ page }) => {
  const id = await d.open(deck(), { mode: "swipe" });
  const reqs = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes(`/api/rounds/${id}/seen`)) reqs.push(r.postDataJSON());
  });
  await page.goto(d.url(id));
  await front(page).waitFor();
  await expect.poll(() => reqs.flatMap((b) => b.ids)).toContain("c1");
  await page.keyboard.press("ArrowRight");
  await expect(front(page)).toContainText("Weekly digest?");
  await expect.poll(() => reqs.flatMap((b) => b.ids)).toContain("c2");
  const seen = await until(async () => {
    const r = await d.round(id);
    return r.view?.seen?.includes("c2") ? r.view.seen : null;
  });
  expect(seen).toEqual(expect.arrayContaining(["c1", "c2"]));
});
