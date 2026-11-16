import { test, expect } from "@playwright/test";
import { startDecide, spec } from "./helpers.mjs";
import { card, openRound, opt } from "./ui.mjs";

let d;
test.beforeAll(async () => {
  d = await startDecide({ name: "reactive" });
});
test.afterAll(async () => d?.stop());

const filler = (n) => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, type: "text", title: `Filler ${i}?`, why: "Makes the page long." }));

test("a ghost patch greys the question out with its reason and one click brings it back", async ({ page }) => {
  const id = await d.open(spec());
  await openRound(page, d, id);
  await d.patch(id, { ghost: "tabs" }, { reason: "No pages are needed for the demo" });
  const tabs = card(page, "tabs");
  await expect(tabs).toHaveClass(/st-ghost/);
  await expect(tabs.locator(".q-state")).toContainText("No pages are needed for the demo");
  await tabs.locator('[data-act="restore"]').click();
  await expect(tabs).not.toHaveClass(/st-ghost/);
  await expect(tabs.locator(".q-state")).toHaveCount(0);
});

test("a ghost question leaves the count in the header and the footer", async ({ page }) => {
  // BUG (product): ui/js/nav.js syncProgress counts the whole spec, ghosts included, so a greyed-out question
  // still shows in "0 of 3 decided" and in the segments. Expected to fail until the count skips ghosts.
  test.fail();
  const id = await d.open(spec());
  await openRound(page, d, id);
  await d.patch(id, { ghost: "tabs" }, { reason: "Not needed" });
  await expect(card(page, "tabs")).toHaveClass(/st-ghost/);
  await expect(page.locator("#bar .bar-count")).toHaveText("0 of 2 decided", { timeout: 2000 });
});

// BUG (product): the page paints the state strip (badge, reason, what it was) but never the new content of
// a patched item. After `set`, `addOptions` and `add` the card keeps its old title and options, even after a
// reload, although GET /api/rounds/:id carries the new item in view.items. Expected to fail until round.js
// renders view.items[].item.
test("a reworded question is marked changed with its reason and what it was", async ({ page }) => {
  const id = await d.open(spec());
  await openRound(page, d, id);
  await d.patch(id, { set: { id: "db", title: "Which database for production?" } }, { reason: "Scope moved to production" });
  const db = card(page, "db");
  await expect(db).toHaveClass(/st-changed/);
  await expect(db.locator(".q-state")).toContainText("Scope moved to production");
  await db.locator('[data-act="was"]').click();
  await expect(db.locator(".state-was")).toContainText("Which database?");
});

test("a reworded question shows its new title", async ({ page }) => {
  test.fail(); // BUG (product): see the note above the previous test.
  const id = await d.open(spec());
  await openRound(page, d, id);
  await d.patch(id, { set: { id: "db", title: "Which database for production?" } }, { reason: "Scope moved to production" });
  await expect(card(page, "db").locator(".q-state")).toBeVisible();
  await expect(card(page, "db").locator(".q-title")).toHaveText("Which database for production?", { timeout: 2000 });
});

test("new options and a new question appear, marked new, without a reload", async ({ page }) => {
  test.fail(); // BUG (product): see the note above "a reworded question".
  const id = await d.open(spec());
  await openRound(page, d, id);
  await d.patch(
    id,
    [
      { addOptions: { question: "db", options: [{ id: "duck", label: "DuckDB", then: "Embedded analytics." }] } },
      { add: { item: { id: "region", type: "single", title: "Which region?", why: "Latency.", options: [{ id: "eu", label: "EU", then: "Closer to users." }, { id: "us", label: "US", then: "Cheaper." }] }, after: "db" }, reason: "Latency came up" },
    ],
    { reason: "The agent found a lighter option" },
  );
  await expect(opt(page, "db", "duck")).toBeVisible({ timeout: 2000 });
  await expect(card(page, "region")).toHaveClass(/st-new/);
  await expect(card(page, "region").locator(".q-state")).toContainText("Latency came up");
});

test("focus and scroll position are the same before and after a patch", async ({ page }) => {
  const long = spec();
  long.questions.push(...filler(8));
  const id = await d.open(long);
  await openRound(page, d, id);
  const field = card(page, "f3").locator("textarea.answer-text");
  await field.scrollIntoViewIfNeeded();
  await field.click();
  await field.fill("half a thought");
  const before = await page.evaluate(() => ({ y: Math.round(scrollY), focus: document.activeElement?.className, text: document.activeElement?.value }));
  await d.patch(id, [{ ghost: "tabs" }, { set: { id: "db", title: "Which database, really?" } }], { reason: "Rethinking" });
  await expect(card(page, "tabs")).toHaveClass(/st-ghost/);
  const after = await page.evaluate(() => ({ y: Math.round(scrollY), focus: document.activeElement?.className, text: document.activeElement?.value }));
  expect(after.focus).toBe(before.focus);
  expect(after.text).toBe("half a thought");
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(2);
});

test("the question being typed in is not repainted and says it was updated", async ({ page }) => {
  const id = await d.open(spec());
  await openRound(page, d, id);
  const field = card(page, "name").locator("textarea.answer-text");
  await field.click();
  await field.fill("Atlas");
  await d.patch(id, { set: { id: "name", title: "What should it be named?" } }, { reason: "Wording only" });
  await expect(card(page, "name").locator(".q-state")).toContainText("Changed");
  // A second change while the user is still typing there is said in one line, not repainted.
  await d.patch(id, { set: { id: "name", title: "What do we name it?" } }, { reason: "Wording again" });
  await expect(card(page, "name").locator(".q-state")).toContainText("This question was updated");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("Atlas");
});

test("a rule in the spec ghosts a question the moment an answer changes, and undoes it", async ({ page }) => {
  const s = spec({ rules: [{ when: { question: "db", in: ["sqlite"] }, reason: "SQLite needs no admin pages", do: [{ ghost: ["tabs"] }] }] });
  const id = await d.open(s);
  await openRound(page, d, id);
  await opt(page, "db", "sqlite").click();
  await expect(card(page, "tabs")).toHaveClass(/st-ghost/);
  await expect(card(page, "tabs").locator(".q-state")).toContainText("SQLite needs no admin pages");
  await opt(page, "db", "pg").click();
  await expect(card(page, "tabs")).not.toHaveClass(/st-ghost/);
});
