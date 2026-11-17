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

test("the agent moves the controls with a knobs patch and the page saves the old state as a snapshot", async ({ page }) => {
  const id = await openTune(page);
  const dens = slider(page, "Density");
  await expect(dens).toHaveAttribute("aria-valuenow", "4");
  const src = await card(page, "card").locator("iframe").first().getAttribute("src");
  writeFile(d.project, "tune.assets/card2.html", readFileSync(path.join(repo, "examples/v3/tune.assets/card.html"), "utf8").replace("<body", "<!-- second mockup --><body"));
  await d.patch(id, { knobs: { question: "card", values: { density: 8 }, preview: path.join(d.project, "tune.assets/card2.html") } }, { reason: "calmer card" });
  await expect(dens).toHaveAttribute("aria-valuenow", "8");
  await expect(frameOf(page).locator("html")).toHaveCSS("--knob-density", /8/);
  await expect(card(page, "card").locator("iframe").first()).not.toHaveAttribute("src", src);
  const slot = card(page, "card").locator(".tn-slot");
  await expect(slot).toHaveCount(1);
  await expect(slot).toContainText("calmer card");
  const view = (await d.round(id)).view;
  expect(view.knobs.card).toMatchObject({ values: { density: 8 }, reason: "calmer card" });
});

test("'in words' sends what the user wants as a words request to the listening agent", async ({ page }) => {
  const id = await openTune(page);
  await card(page, "card").locator("textarea.tn-words-in").fill("make it calmer");
  // A held `next` is what makes the agent listen.
  const heard = (async () => {
    for (let i = 0; i < 8; i++) {
      const item = await d.next(id, { timeout: 1000 });
      if (!item) continue;
      await d.ack(id, item.seq);
      if (item.kind === "words") return item;
    }
    return null;
  })();
  await new Promise((r) => setTimeout(r, 400));
  await card(page, "card").locator('[data-act="words"]').click();
  const item = await heard;
  expect(item, "the agent gets a words item").toBeTruthy();
  expect(item.payload.words).toMatchObject({ qid: "card", text: "make it calmer" });
  expect(item.payload.words.values.density).toBe(4);
  await expect(card(page, "card").locator(".tn-said")).toContainText("Sent");
});

test("'in words' with no agent that takes events is saved as the note and shown", async ({ page }) => {
  const id = await openTune(page);
  // A new round counts as listened to for 90 s; a plain `ask` waiter (held, no events) is the other way to
  // reach the same branch: the item would never be handed out, so the words become a note.
  const hold = fetch(`${d.origin}/api/rounds/${id}/next?waiter=plain&timeout=6000`, { headers: { "x-decide-token": d.token, origin: d.origin } }).catch(() => null);
  await new Promise((r) => setTimeout(r, 400));
  await card(page, "card").locator("textarea.tn-words-in").fill("more airy");
  await card(page, "card").locator('[data-act="words"]').click();
  // The words come back as the question's note and the note box shows them.
  await expect(card(page, "card").locator("textarea.note")).toHaveValue(/more airy/);
  await expect(card(page, "card").locator(".tn-said")).toContainText("saved as a note");
  const a = await until(async () => {
    const x = (await d.answers(id)).card;
    return x?.note ? x : null;
  });
  expect(a.note).toContain("more airy");
  await hold;
});
