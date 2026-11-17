import { test, expect } from "@playwright/test";
import { startDecide, spec } from "./helpers.mjs";
import { openRound, opt } from "./ui.mjs";

let d;
test.beforeAll(async () => {
  d = await startDecide({ name: "states" });
});
test.afterAll(async () => d?.stop());

test("an open round says the agent is waiting", async ({ page }) => {
  const id = await d.open(spec());
  await openRound(page, d, id);
  await expect(page.locator(".presence-note.live")).toContainText("The agent is waiting");
});

test("with no agent listening the page says answers are saved and gives a line to paste", async ({ page }) => {
  const id = await d.open(spec());
  await openRound(page, d, id);
  // The server counts a round as listened to for 90 s after the last wait. Instead of waiting that long, the
  // page is handed the same news the server's state event carries (the page's own module, same instance).
  await page.evaluate(async () => (await import("/ui/js/header.js")).updatePresence(false));
  const note = page.locator(".presence-note");
  await expect(note).toContainText("No agent is listening", { timeout: 8000 });
  await expect(note.locator(".paste-line code")).toContainText(id);
});

test("Done shows a readable summary of what was answered", async ({ page }) => {
  const id = await d.open(spec());
  await openRound(page, d, id);
  await opt(page, "db", "sqlite").click();
  await page.locator("#bar .bar-done").click();
  await page.locator("#overlay .btn.primary", { hasText: "Send to the agent" }).click();
  const view = page.locator(".done-view");
  await expect(view).toBeVisible({ timeout: 10_000 });
  await expect(view).toContainText("What you answered");
  await expect(view).toContainText("SQLite");
  expect((await d.round(id)).status).not.toBe("pending");
});

test("a stopped server is said in words with the command to start it", async ({ page }) => {
  const own = await startDecide({ name: "states-stop" });
  try {
    const id = await own.open(spec());
    await openRound(page, own, id);
    await expect(page.locator("#stopped")).toBeHidden();
    process.kill(own.pid, "SIGTERM");
    const box = page.locator("#stopped");
    await expect(box).toBeVisible({ timeout: 15_000 });
    await expect(box).toContainText("The decide server has stopped");
    await expect(box).toContainText("Nothing you typed is lost");
    await expect(box.locator("code")).toContainText("decide.mjs open");
  } finally {
    await own.stop();
  }
});
