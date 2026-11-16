import { test, expect } from "@playwright/test";
import { startDecide, spec } from "./helpers.mjs";
import { card, openRound, opt, until } from "./ui.mjs";

let d;
test.beforeAll(async () => {
  d = await startDecide({ name: "reply" });
});
test.afterAll(async () => d?.stop());

// Drains the outbox the way a waiting agent does: next, then ack, until the wanted kind shows up.
async function takeKind(id, kind, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const item = await d.next(id, { timeout: 800 });
    if (!item) continue;
    await d.ack(id, item.seq);
    if (item.kind === kind) return item;
  }
  return null;
}

test("a question to the agent reaches it and the reply shows in the thread", async ({ page }) => {
  const id = await d.open(spec(), { live: true });
  await openRound(page, d, id);
  await card(page, "db").locator('[data-flag="explain"]').click();
  await card(page, "db").locator("textarea.ask-input").fill("Why Postgres?");
  await card(page, "db").locator(".ask-row .btn.primary").click();

  const ask = await takeKind(id, "ask");
  expect(ask, "the agent gets the question").toBeTruthy();
  expect(JSON.stringify(ask.payload)).toContain("Why Postgres?");

  await d.explain(id, "db", "Because it handles the load you described.");
  const reply = card(page, "db").locator(".msg.agent .msg-text");
  await expect(reply).toContainText("Because it handles the load", { timeout: 10_000 });
});

test("a reply that carries a patch lists under it what it changed", async ({ page }) => {
  const id = await d.open(spec(), { live: true });
  await openRound(page, d, id);
  await card(page, "db").locator('[data-flag="explain"]').click();
  await card(page, "db").locator(".ask-row .btn.primary").click();
  await takeKind(id, "ask");
  await d.explain(id, "db", "I reworded the question and dropped the pages one.", {
    patch: { ops: [{ ghost: "tabs" }], reason: "Pages do not matter now" },
    changes: [{ op: "replace", title: "Which database?" }, { op: "remove", title: "Which pages come first?" }],
  });
  const list = card(page, "db").locator(".msg-changes");
  await expect(list).toContainText("This reply changed", { timeout: 10_000 });
  await expect(list.locator("li.op-replace")).toContainText("Which database?");
  await expect(list.locator("li.op-remove")).toContainText("Which pages come first?");
  // The patch itself took effect.
  await expect(card(page, "tabs")).toHaveClass(/st-ghost/);
});

test("'none, suggest others' reaches a listening agent as a request", async ({ page }) => {
  const id = await d.open(spec(), { live: true });
  await openRound(page, d, id);
  await card(page, "db").locator('[data-quick="none"]').click();
  await card(page, "db").locator(".quick-input").fill("something managed");
  await card(page, "db").locator(".quick-save").click();
  const req = await takeKind(id, "request");
  expect(req, "the agent gets a request").toBeTruthy();
  expect(JSON.stringify(req.payload)).toContain("something managed");
});

test("without a live agent 'none' stays a flag in the answers", async ({ page }) => {
  const id = await d.open(spec(), { live: false });
  await openRound(page, d, id);
  await card(page, "db").locator('[data-quick="none"]').click();
  await card(page, "db").locator(".quick-save").click();
  const a = await until(async () => {
    const x = (await d.answers(id)).db;
    return x?.flag === "none" ? x : null;
  });
  expect(a.flag).toBe("none");
  await expect(opt(page, "db", "pg")).toHaveAttribute("aria-checked", "false");
});
