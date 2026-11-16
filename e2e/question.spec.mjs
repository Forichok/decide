import { test, expect } from "@playwright/test";
import { startDecide, spec } from "./helpers.mjs";
import { card, openRound, opt, serverAnswer, until } from "./ui.mjs";

let d;
test.beforeAll(async () => {
  d = await startDecide({ name: "question" });
});
test.afterAll(async () => d?.stop());

const rich = () =>
  spec({
    questions: [
      {
        id: "db",
        type: "single",
        title: "Which database?",
        why: "It decides the storage layer.",
        more: "Longer text about the databases, shown only on request.",
        options: [
          { id: "pg", label: "Postgres", recommended: true, reason: { text: "Fits the load.", evidence: "measured", source: "bench.md" }, then: "Runs in a container.", pros: [{ text: "Fast reads", evidence: "estimate" }], cons: ["More to run"] },
          { id: "sqlite", label: "SQLite", then: "One file." },
        ],
      },
      {
        id: "mode",
        type: "single",
        title: "Which mode?",
        why: "Sets the default.",
        options: [{ id: "a", label: "Mode A", then: "Starts quiet." }, { id: "b", label: "Mode B", then: "Starts loud." }],
      },
    ],
  });

test("the why line, then, one badge and a folded more", async ({ page }) => {
  const id = await d.open(rich());
  await openRound(page, d, id);
  await expect(card(page, "db").locator(".q-why")).toHaveText("It decides the storage layer.");
  await expect(opt(page, "db", "pg").locator(".opt-then")).toHaveText("Runs in a container.");
  // One badge per option at rest.
  expect(await opt(page, "db", "pg").locator(".badge").count()).toBe(1);
  const more = card(page, "db").locator(".q-more-text");
  await expect(more).toBeHidden();
  await card(page, "db").locator(".more-toggle").click();
  await expect(more).toBeVisible();
  await expect(more).toContainText("Longer text");
});

test("evidence labels sit beside the reason, the pros and the cons", async ({ page }) => {
  const id = await d.open(rich());
  await openRound(page, d, id);
  await expect(opt(page, "db", "pg").locator(".ev.ev-measured")).toHaveText("measured");
  await expect(opt(page, "db", "pg").locator(".ev.ev-estimate")).toHaveText("estimate");
});

test("a picked option saves and the 'yes, but' condition rides with it", async ({ page }) => {
  const id = await d.open(rich());
  await openRound(page, d, id);
  await opt(page, "db", "sqlite").click();
  await card(page, "db").locator('[data-quick="yes"]').click();
  await card(page, "db").locator(".quick-input").fill("only for the demo");
  await card(page, "db").locator(".quick-save").click();
  const a = await until(async () => {
    const x = (await d.answers(id)).db;
    return x?.condition ? x : null;
  });
  expect(a.selected).toEqual(["sqlite"]);
  expect(a.condition).toBe("only for the demo");
});

test("'none, suggest others' saves a flag and 'later' keeps a revisit text", async ({ page }) => {
  const id = await d.open(rich());
  await openRound(page, d, id);
  await card(page, "mode").locator('[data-quick="none"]').click();
  await card(page, "mode").locator(".quick-input").fill("something quieter");
  await card(page, "mode").locator(".quick-save").click();
  const none = await until(async () => {
    const x = (await d.answers(id)).mode;
    return x?.flag === "none" ? x : null;
  });
  expect(none.note).toBe("something quieter");

  await card(page, "db").locator('[data-quick="later"]').click();
  await card(page, "db").locator(".quick-input").fill("after the audit");
  await card(page, "db").locator(".quick-save").click();
  const later = await until(async () => {
    const x = (await d.answers(id)).db;
    return x?.flag === "later" ? x : null;
  });
  expect(later.revisit).toBe("after the audit");
});

test("Own option and a note are saved with the answer", async ({ page }) => {
  const id = await d.open(rich());
  await openRound(page, d, id);
  await card(page, "mode").locator('[data-act="other"]').click();
  await card(page, "mode").locator(".other-input").fill("Mode C");
  await card(page, "mode").locator('[data-act="note"]').click();
  await card(page, "mode").locator("textarea.note").fill("Because of the pilot.");
  const a = await until(async () => {
    const x = (await d.answers(id)).mode;
    return x?.other && x?.note ? x : null;
  });
  expect(a.other).toBe("Mode C");
  expect(a.note).toBe("Because of the pilot.");
  expect(await serverAnswer(d, id, "mode")).toBeTruthy();
});
