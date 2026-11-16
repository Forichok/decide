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

test.fixme("cards the agent changed come back at the end with the old answer preselected", async () => {
  // Waits for the swipe stale-cards chunk: a stale card is re-asked after the deck with its old answer marked.
});
test.fixme("a removed card the user already saw becomes a ghost that can be restored", async () => {
  // Waits for `seen` + ghost restore on swipe: patch remove of a seen card -> ghost with a restore button.
});
test.fixme("push goes through the patch engine on a swipe round", async () => {
  // FINAL WAVE: swipe `push` is applied as a patch (items are cards).
});
test.fixme("a patch on a swipe round is accepted, not refused with 409", async () => {
  // FINAL WAVE: POST /api/rounds/:id/patch on a swipe round works.
});
test.fixme("cards shown on screen are reported as seen: POST /api/rounds/:id/seen {ids}", async () => {
  // FINAL WAVE: the page posts seen ids; view.seen is their union.
});
