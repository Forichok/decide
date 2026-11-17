import { test, expect } from "@playwright/test";
import { startDecide, spec } from "./helpers.mjs";
import { openRound } from "./ui.mjs";

let d;
test.beforeAll(async () => {
  d = await startDecide({ name: "pwa" });
});
test.afterAll(async () => d?.stop());

test("the manifest makes the page installable", async ({ page, request }) => {
  const id = await d.open(spec());
  await openRound(page, d, id);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  const res = await request.get(`${d.origin}/manifest.webmanifest`);
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m.display).toBe("standalone");
  expect(m.start_url).toBe("/");
  expect(m.name).toBe("decide");
  expect(m.icons.length).toBeGreaterThan(0);
  const icon = await request.get(d.origin + m.icons[0].src);
  expect(icon.ok()).toBe(true);
});

test("the service worker registers and takes control of the page", async ({ page }) => {
  const id = await d.open(spec());
  await openRound(page, d, id);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe(`${d.origin}/`);
});

test("the app badge shows how many rounds wait", async ({ page }) => {
  await page.addInitScript(() => {
    window.__badge = [];
    navigator.setAppBadge = (n) => (window.__badge.push(n), Promise.resolve());
    navigator.clearAppBadge = () => (window.__badge.push(0), Promise.resolve());
  });
  const a = await d.open(spec({ title: "Badge one" }));
  await d.open(spec({ title: "Badge two" }));
  await openRound(page, d, a);
  await expect.poll(() => page.evaluate(() => window.__badge.at(-1))).toBeGreaterThanOrEqual(2);
});

test("with the server down the page says how to start it and, on a fallback port, that the app will not find it", async ({ page }) => {
  const own = await startDecide({ name: "pwa-down" });
  try {
    const id = await own.open(spec());
    await openRound(page, own, id);
    process.kill(own.pid, "SIGTERM");
    const box = page.locator("#stopped");
    await expect(box).toBeVisible({ timeout: 15_000 });
    await expect(box.locator("code")).toContainText("decide.mjs open");
    await expect(box).toContainText("fallback port");
    await expect(box).toContainText("47474");
  } finally {
    await own.stop();
  }
});

test("a page loaded while the server is down still shows the shell with the start command", async ({ page }) => {
  const own = await startDecide({ name: "pwa-shell" });
  try {
    const id = await own.open(spec());
    await openRound(page, own, id);
    await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state);
    // Reload once so the worker controls the page and has the shell cached.
    await page.reload();
    await page.locator(".card").first().waitFor();
    process.kill(own.pid, "SIGTERM");
    await expect.poll(() => fetch(`${own.origin}/api/ping`).then(() => true, () => false), { timeout: 10_000 }).toBe(false);
    await page.reload();
    await expect(page.locator("#stopped")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#stopped code")).toContainText("decide.mjs open");
  } finally {
    await own.stop();
  }
});
