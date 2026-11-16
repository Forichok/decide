import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { startDecide, writeFile } from "./helpers.mjs";
import { card, openRound, until } from "./ui.mjs";

let d;
let repo;
test.beforeAll(async () => {
  d = await startDecide({ name: "knobs" });
  repo = path.resolve(import.meta.dirname, "..");
  writeFile(d.project, "tune.assets/card.html", readFileSync(path.join(repo, "examples/v3/tune.assets/card.html"), "utf8"));
});
test.afterAll(async () => d?.stop());

const tune = () => JSON.parse(readFileSync(path.join(repo, "examples/v3/tune.questions.json"), "utf8"));

// The mockup has no script of its own: the page's bridge sets --knob-* variables and fills data-knob nodes.
const frameOf = (page) => card(page, "card").frameLocator("iframe").first();
const slider = (page, label) => card(page, "card").getByRole("slider", { name: label });

async function openTune(page) {
  const id = await d.open(tune());
  await openRound(page, d, id);
  await card(page, "card").locator("iframe").first().waitFor();
  return id;
}

test("moving a control moves the mockup: the density variable follows the slider", async ({ page }) => {
  await openTune(page);
  const dens = slider(page, "Density");
  await dens.focus();
  const root = frameOf(page).locator("html");
  await expect(root).toHaveCSS("--knob-density", /4/);
  await page.keyboard.press("End");
  await expect(root).toHaveCSS("--knob-density", /10/);
  await expect(dens).toHaveAttribute("aria-valuenow", "10");
});

test("a text knob fills the matching node of the mockup", async ({ page }) => {
  await openTune(page);
  await card(page, "card").locator("input.tn-text").fill("Olga and Ivan");
  await expect(frameOf(page).locator('[data-knob="names"]')).toHaveText("Olga and Ivan");
});

test("a preset sets the values and shows as pressed", async ({ page }) => {
  await openTune(page);
  const packed = card(page, "card").locator('.tn-chip[data-preset="Packed"]');
  await packed.click();
  await expect(packed).toHaveAttribute("aria-pressed", "true");
  await expect(slider(page, "Density")).toHaveAttribute("aria-valuenow", "9");
  await expect(frameOf(page).locator("html")).toHaveCSS("--knob-density", /9/);
});

test("remember saves a snapshot and the choice reaches the server", async ({ page }) => {
  const id = await openTune(page);
  await card(page, "card").locator('.tn-chip[data-preset="Airy"]').click();
  await card(page, "card").locator('[data-act="remember"]').click();
  const slot = card(page, "card").locator(".tn-slot");
  await expect(slot).toHaveCount(1);
  await slot.locator('[data-act="pick"]').click();
  const a = await until(async () => {
    const x = (await d.answers(id)).card;
    return x && JSON.stringify(x).includes("snapshots") ? x : null;
  });
  expect(a).toBeTruthy();
  expect(JSON.stringify(a)).toContain('"density":2');
});

test("frames and themes: the stage shows each frame in each theme", async ({ page }) => {
  await openTune(page);
  await expect(card(page, "card").locator(".tn-fig")).toHaveCount(4);
  await expect(card(page, "card").locator(".tn-fig[data-frame='phone']")).toHaveCount(2);
});

test("derived values are computed from the knobs and shown in a table", async ({ page }) => {
  await openTune(page);
  const price = card(page, "price");
  await price.scrollIntoViewIfNeeded();
  const table = price.locator(".tn-table");
  await expect(table).toContainText("Clients kept");
  // 100 clients, churn 0.1 -> 90 kept; 20 EUR each -> 1800.
  await expect(table.locator("td.now").first()).toContainText("90");
  await expect(table).toContainText("1800");
  await price.getByRole("slider", { name: "Price per month" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(table).toContainText("1890");
});

test.fixme("the agent moves the controls with a knobs patch and the page saves the old state as a snapshot", async () => {
  // FINAL WAVE: patch op {knobs: {question, values?, preview?}} -> view.knobs[qid] = {values?, preview?, seq, reason};
  // the page moves the controls (or swaps the mockup src) and stores the state before as a snapshot named after the reason.
});
test.fixme("'in words' sends what the user wants as a words request to the listening agent", async () => {
  // FINAL WAVE: POST /api/rounds/:id/words {qid, text} -> outbox item kind "words" {qid, title, text, values};
  // with no agent listening it is saved as the question's note.
});
