import { test, expect } from "@playwright/test";
import { startDecide, spec, writeFile, MOBILE, DESKTOP } from "./helpers.mjs";
import { card, openRound, opt, until } from "./ui.mjs";

// One test per acceptance item of the design, named after it.

let d;
test.beforeAll(async () => {
  d = await startDecide({ name: "acceptance" });
  const pic = (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="${c}"/></svg>`;
  writeFile(d.project, "a.svg", pic("#cde"));
  writeFile(d.project, "b.svg", pic("#edc"));
});
test.afterAll(async () => d?.stop());

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const [name, size] of [["375", MOBILE], ["768", { width: 768, height: 1024 }], ["1440", DESKTOP]]) {
  test(`the page wraps without a sideways scroll at ${name} px`, async ({ page }) => {
    await page.setViewportSize(size);
    const id = await d.open(spec({ title: "A rather long round title that has to wrap on a narrow screen without pushing the page wider" }));
    await openRound(page, d, id);
    expect(await noSideScroll(page)).toBe(true);
    const box = await page.locator(".card").first().boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(size.width);
  });
}

test("the review dialog keeps its Send button on screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 560 });
  const s = spec();
  for (let i = 0; i < 12; i++) s.questions.push({ id: `x${i}`, type: "text", title: `Extra ${i}?`, why: "Filler.", priority: 3 });
  const id = await d.open(s);
  await openRound(page, d, id);
  await opt(page, "db", "pg").click();
  await page.locator("#bar .bar-done").click();
  const send = page.locator("#overlay .btn.primary", { hasText: "Send to the agent" });
  await expect(send).toBeVisible();
  await expect(send).toBeInViewport();
});

test("'ask the agent' has a Send button and shows one status", async ({ page }) => {
  const id = await d.open(spec(), { live: true });
  await openRound(page, d, id);
  const db = card(page, "db");
  await db.locator('[data-flag="explain"]').click();
  await db.locator("textarea.ask-input").fill("Why?");
  await db.locator(".ask-row .btn.primary").click();
  await expect(db.locator(".msg").first()).toBeVisible();
  // One status line for the pending question, not a stack of them.
  await expect(db.locator(".msg.me")).toHaveCount(1);
  await expect(db.locator(".msg.agent.typing")).toHaveCount(1);
});

test("an option of the user's own shows selected", async ({ page }) => {
  const id = await d.open(spec());
  await openRound(page, d, id);
  const db = card(page, "db");
  await db.locator('[data-act="other"]').click();
  await db.locator(".other-input").fill("Something custom");
  await expect(db.locator(".other-wrap")).toHaveClass(/sel/);
  // Typing one's own option clears the listed pick: nothing else stays selected next to it.
  await expect(db.locator('.opt[aria-checked="true"]')).toHaveCount(0);
  const a = await until(async () => (await d.answers(id)).db?.other === "Something custom");
  expect(a).toBe(true);
});

test("the picture viewer has previous and next and 'pick this one'", async ({ page }) => {
  const s = spec({
    questions: [
      {
        id: "look",
        type: "single",
        title: "Which look?",
        why: "One goes forward.",
        options: [
          { id: "one", label: "One", then: "First.", images: [{ src: "a.svg", caption: "Look one" }, { src: "b.svg", caption: "Look one, second view" }] },
          { id: "two", label: "Two", then: "Second.", images: [{ src: "b.svg", caption: "Look two" }] },
        ],
      },
    ],
  });
  const id = await d.open(s);
  await openRound(page, d, id);
  await card(page, "look").locator(".shot-btn").first().click();
  const box = page.locator("#lightbox");
  await expect(box).toBeVisible();
  await expect(box.locator(".lb-count")).toHaveText("1 / 2");
  await box.locator(".lb-nav.next").click();
  await expect(box.locator(".lb-count")).toHaveText("2 / 2");
  await box.locator(".lb-nav.prev").click();
  await expect(box.locator(".lb-count")).toHaveText("1 / 2");
  await box.locator(".lb-pick").click();
  await expect(box).toBeHidden();
  await expect(opt(page, "look", "one")).toHaveAttribute("aria-checked", "true");
});

test("a round with 12 or more questions stays usable: keys move, answers save, the bar counts", async ({ page }) => {
  const s = spec();
  for (let i = 0; i < 12; i++) s.questions.push({ id: `m${i}`, type: "text", title: `Many ${i}?`, why: "Filler.", priority: 3 });
  const id = await d.open(s);
  await openRound(page, d, id);
  await expect(page.locator(".card")).toHaveCount(15);
  await expect(page.locator("#bar .bar-count")).toContainText("of 15");
  await page.keyboard.press("1");
  await expect(page.locator("#bar .bar-count")).toContainText("1 of 15");
  await expect(page.locator("#bar .seg-dot")).toHaveCount(15);
});

test("the skip link is the first stop in the tab order and lands on the questions", async ({ page }) => {
  const id = await d.open(spec());
  await openRound(page, d, id);
  await page.keyboard.press("Tab");
  const skip = page.locator(".skip-link");
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
});

test("the journal shows a date for each entry", async ({ page }) => {
  const id = await d.open(spec({ title: "Dated" }));
  await d.must("POST", `/api/rounds/${id}/submit`, { answers: { db: { selected: ["pg"] } } });
  await page.goto(`${d.origin}/#journal`);
  await page.locator(".jp-list").waitFor();
  await expect(page.locator(".jp-day").first()).toContainText(String(new Date().getFullYear()));
});

test("a bad round id is an error with a way back", async ({ page }) => {
  await page.goto(`${d.origin}/#r=9-nonexistent`);
  await expect(page.locator("body")).toContainText("There is no round 9-nonexistent", { timeout: 10_000 });
  await expect(page.locator("body").getByRole("button").or(page.locator("body").getByRole("link")).first()).toBeVisible();
});

test.fixme("questions that scrolled into view are reported as seen, so a later removal becomes a ghost", async () => {
  // FINAL WAVE `seen`: the page posts POST /api/rounds/:id/seen {ids}; view.seen is the union; a patch `remove` of a seen item is a ghost.
});
