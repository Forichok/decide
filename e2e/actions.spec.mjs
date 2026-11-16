import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { startDecide, spec } from "./helpers.mjs";
import { openRound, opt, serverAnswer } from "./ui.mjs";

let d;
test.beforeAll(async () => {
  d = await startDecide({ name: "actions" });
});
test.afterAll(async () => d?.stop());

const many = () => {
  const s = spec();
  for (let i = 0; i < 12; i++) s.questions.push({ id: `q${i}`, type: "text", title: `Extra question ${i}?`, why: "Filler.", priority: 3 });
  return s;
};

// BUG (product): the round's action buttons ("I have 5 minutes", "Export this round") never show. main.js
// builds the round with env() before app.round is set, so env.currentId is empty (or the previous round's)
// when header.js decides whether to draw roundActions. The server routes work; see the tests that call them.
test("'I have 5 minutes' on the page keeps the questions that fit and lists the rest as left out", async ({ page }) => {
  test.fail();
  const id = await d.open(many());
  await openRound(page, d, id);
  const before = await page.locator(".card").count();
  await page.getByRole("button", { name: "I have 5 minutes" }).click({ timeout: 2000 });
  await page.locator(".card").first().waitFor();
  await expect.poll(() => page.locator(".card").count()).toBeLessThan(before);
  await expect(page.locator("body")).toContainText("Left out to fit your 5 min");
});

test("the 5 minutes route keeps the questions that fit and says what was left out", async () => {
  const id = await d.open(many());
  const res = await d.call("POST", `/api/rounds/${id}/fit`, { minutes: 5 });
  expect(res.status).toBe(200);
  expect(res.data.leftOut).toBeGreaterThan(0);
  const round = await d.round(id);
  expect(round.spec.questions.length).toBe(res.data.kept);
});

test("the page's Export button is refused by the server", async ({ page }) => {
  // BUG (product): the page's own POST /api/rounds/:id/export gets a 403, because lib/http.mjs lists export
  // among the agent-only routes (the same cause as the rail's dismiss). Expected to fail.
  test.fail();
  const id = await d.open(spec());
  await openRound(page, d, id);
  const status = await page.evaluate(async (rid) => (await fetch(`/api/rounds/${rid}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, id);
  expect(status).toBe(200);
});

test("an exported file, answered offline, imports back into the round", async ({ page }) => {
  // BUG (product): the exported page does not start: ui/js/offline.js has no `getMap` export, which
  // ui/js/map.js imports from net.js, so the module graph fails ("does not provide an export named getMap").
  test.fail();
  const id = await d.open(spec());
  const out = path.join(d.project, "exported.decide.html");
  const exported = await d.must("POST", `/api/rounds/${id}/export`, { out });
  expect(existsSync(exported.file)).toBe(true);

  await page.goto("file://" + exported.file);
  await page.locator(".card").first().waitFor({ timeout: 3000 });
  await opt(page, "db", "sqlite").click();
  await page.locator("#bar .bar-done").click();
  const download = page.waitForEvent("download");
  await page.locator("#overlay").getByRole("button", { name: /Save answers to a file/ }).click();
  const file = path.join(d.dir, "offline.answers.json");
  await (await download).saveAs(file);

  const answers = JSON.parse(readFileSync(file, "utf8"));
  const res = await d.call("POST", `/api/rounds/${id}/import`, { files: [{ ...answers, file: "offline.answers.json" }] });
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  expect(res.data.settled).toBe(true);
  expect(JSON.stringify((await d.round(id)).result.answers.db)).toContain("sqlite");
});

test("Save as ADR on an answered round writes the decision into the project", async ({ page }) => {
  const id = await d.open(spec());
  await openRound(page, d, id);
  await opt(page, "db", "pg").click();
  await page.locator("#bar .bar-done").click();
  await page.locator("#overlay .btn.primary", { hasText: "Send to the agent" }).click();
  await expect(page.locator(".done-view")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Save as ADR" }).click();
  await expect(page.locator("#toast")).toContainText(/Wrote|Updated/, { timeout: 8000 });
  const dir = path.join(d.project, "docs", "decisions");
  expect(existsSync(dir)).toBe(true);
  const files = readdirSync(dir);
  expect(files.length).toBeGreaterThan(0);
  expect(readFileSync(path.join(dir, files[0]), "utf8")).toContain("Postgres");
  expect(await serverAnswer(d, id, "db")).toBeTruthy();
});
