#!/usr/bin/env node
// screens.mjs: regenerates docs/screens/*.webp. Starts its own muted decide server in a scratch home, opens the
// example rounds in Playwright's Chromium and writes one webp per shot.
//
//   node scripts/screens.mjs                 every shot
//   node scripts/screens.mjs readme swipe    only the named groups (readme, question, swipe, tune, forms,
//                                            evidence, journal, settings, inbox)
//
// File names: the README's own (`options-light.webp`, `swipe-diff-dark.webp`, ...) at 1440 wide, and for the
// 3.0 views `<view>-<width>-<theme>.webp` at 375, 768 and 1440. Playwright writes png; cwebp (or, without it,
// the browser's own encoder) turns it into webp at quality 80.
//
// Needs `npm ci` (Playwright and its cached Chromium). Never touches the real ~/.decide: the server runs in a
// scratch HOME and DECIDE_HOME (see scripts/harness.mjs; SCREENS_SCRATCH and SCREENS_PORT pick where).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { pluginDir, sleep, startServer } from "./harness.mjs";

const OUT = path.join(pluginDir, "docs", "screens");
const WIDTHS = { 375: { width: 375, height: 812, scale: 2 }, 768: { width: 768, height: 1024, scale: 1 }, 1440: { width: 1440, height: 900, scale: 1 } };
const THEMES = ["light", "dark"];
const QUALITY = 80;

const only = new Set(process.argv.slice(2));
const wanted = (group) => !only.size || only.has(group);

const scratch = process.env.SCREENS_SCRATCH || tmpdir();
mkdirSync(scratch, { recursive: true });
const tmp = mkdtempSync(path.join(scratch, "screens-png-"));
let hasCwebp = true;
try {
  execFileSync("cwebp", ["-version"], { stdio: "ignore" });
} catch {
  hasCwebp = false;
}

mkdirSync(OUT, { recursive: true });
const written = [];

// png buffer -> docs/screens/<name>.webp
async function save(name, png, browser) {
  const file = path.join(OUT, `${name}.webp`);
  if (hasCwebp) {
    const src = path.join(tmp, `${name}.png`);
    writeFileSync(src, png);
    execFileSync("cwebp", ["-quiet", "-q", String(QUALITY), src, "-o", file]);
  } else {
    const page = await browser.newPage();
    const b64 = await page.evaluate(
      async ({ data, q }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        c.getContext("2d").drawImage(img, 0, 0);
        return c.toDataURL("image/webp", q).split(",")[1];
      },
      { data: png.toString("base64"), q: QUALITY / 100 },
    );
    await page.close();
    writeFileSync(file, Buffer.from(b64, "base64"));
  }
  written.push(name);
  console.log(`  ${name}.webp`);
}

// ---- helpers for the page

const card = (page, qid) => page.locator(`#q-${qid}`);
const ready = async (page, sel = ".card") => {
  await page.locator(sel).first().waitFor();
  await page.evaluate(() => document.fonts?.ready);
  await sleep(700);
};
// The page's inline style is blocked by its policy, so the script sets styles through the DOM. The toast ("the
// agent replied...") is noise in a still; the floating bar is shown unless a shot of one card hides it.
const bar = (page, shown) =>
  page.evaluate((on) => {
    const b = document.getElementById("bar");
    if (b) b.style.visibility = on ? "" : "hidden";
    const t = document.getElementById("toast");
    if (t) t.style.display = "none";
  }, shown);
const snap = async (page) => (await bar(page, true), page.screenshot());

// A shot of one element with some page around it: the whole element even when it is taller than the window.
// The floating bar is hidden meanwhile so it does not cover the card.
async function elementShot(page, locator, { pad = 24 } = {}) {
  await locator.scrollIntoViewIfNeeded();
  await sleep(300);
  await bar(page, false);
  const box = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
  });
  const vw = page.viewportSize().width;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const png = await page.screenshot({ fullPage: true, clip: { x, y, width: Math.min(vw - x, box.width + pad * 2), height: box.height + pad * 2 } });
  await bar(page, true);
  return png;
}
async function scrollTop(page, locator, gap = 16) {
  await locator.evaluate((el, g) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - g), gap);
  await sleep(400);
}

// ---- the example rounds

let d;
const showcase = () => d.readSpec("examples/showcase.questions.json");
const swipeDeck = (front) => {
  const deck = d.readSpec("examples/swipe.deck.json");
  if (front) {
    const i = deck.cards.findIndex((c) => c.id === front);
    if (i < 0) throw new Error(`no card ${front}`);
    deck.cards.unshift(...deck.cards.splice(i, 1));
  }
  return deck;
};
const SCREEN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560" viewBox="0 0 900 560"><rect width="900" height="560" fill="#eef0f6"/><rect x="0" y="0" width="900" height="64" fill="#fff"/><rect x="32" y="22" width="120" height="20" rx="6" fill="#c9ced9"/><rect x="48" y="104" width="804" height="120" rx="14" fill="#fff"/><rect x="48" y="248" width="390" height="260" rx="14" fill="#fff"/><rect x="462" y="248" width="390" height="260" rx="14" fill="#fff"/><circle cx="110" cy="164" r="30" fill="#d6245f"/><rect x="164" y="146" width="320" height="16" rx="6" fill="#c9ced9"/><rect x="164" y="176" width="220" height="12" rx="6" fill="#dfe3ec"/></svg>';

async function openRound(c, spec, opts) {
  await d.clear();
  const id = await d.open(spec, opts);
  await c.page.goto(d.url(id));
  await ready(c.page);
  return id;
}

// ---- README shots, 1440 wide

async function readmeShots(c) {
  const { page, theme } = c;
  const out = (n, png) => save(`${n}-${theme}`, png, c.browser);

  // Question rounds from the showcase.
  const id = await openRound(c, showcase(), { live: true });
  await out("options", await elementShot(page, card(page, "goal")));
  await out("compare", await elementShot(page, card(page, "layout")));
  await out("preview", await elementShot(page, card(page, "card")));
  await out("diagram", await elementShot(page, card(page, "rollout")));
  await page.waitForFunction(() => document.querySelector("#q-rollout svg, #q-rollout iframe")).catch(() => {});

  // Ask under the question and the agent's reply.
  const goal = card(page, "goal");
  await goal.locator('[data-flag="explain"]').click();
  await goal.locator("textarea.ask-input").fill("Does the reminder need a server, or can the phone do it alone?");
  await goal.locator(".ask-row .btn.primary").click();
  await d.explain(id, "goal", "Local reminders work without a server: the phone schedules them itself. A server is only needed to sync them between two devices, and that is a later question.");
  await goal.locator(".msg.agent .msg-text").waitFor({ timeout: 10_000 });
  await sleep(500);
  await out("ask", await elementShot(page, goal));

  // Review dialog, then the done screen.
  await card(page, "layout").locator(".opt").first().click();
  await sleep(300);
  await page.locator("#bar .bar-done").click();
  await page.locator("#overlay .btn.primary").waitFor();
  await sleep(500);
  await out("review", await snap(page));
  await page.locator("#overlay .btn.primary").first().click();
  await page.locator(".done, #done, .dn").first().waitFor({ timeout: 10_000 }).catch(() => {});
  await sleep(800);
  await out("done", await snap(page));
}

async function swipeShots(c) {
  const { page, theme } = c;
  const out = (n, png) => save(`${n}-${theme}`, png, c.browser);
  const front = page.locator(".sw-card.front");
  const open = async (card) => {
    await d.clear();
    const id = await d.open(swipeDeck(card), { mode: "swipe" });
    await page.goto(d.url(id));
    await front.waitFor();
    await sleep(900);
    return id;
  };
  await open("home");
  await out("swipe", await snap(page));
  for (const [name, cardId] of [
    ["swipe-compare", "pricing"],
    ["swipe-video", "onboarding"],
    ["swipe-previews", "density"],
    ["swipe-diff", "parser"],
    ["swipe-chart-body", "pro-price"],
    ["swipe-line", "digest"],
    ["swipe-table", "limits"],
  ]) {
    await open(cardId);
    await out(name, await snap(page));
  }

  // The user's own answer.
  await open("home");
  await page.keyboard.press("Enter");
  await page.locator(".sw-own-input").fill("Both: one person now, sharing later without a rewrite");
  await sleep(400);
  await out("swipe-own", await snap(page));

  // A follow-up card after an answer.
  await d.clear();
  const deck = swipeDeck("home");
  deck.cards.unshift({ id: "offline", title: "Should tasks work offline?", left: { label: "No, online only" }, right: { label: "Yes, sync later" }, recommended: "right", why: "People add tasks on the subway." });
  const id = await d.open(deck, { mode: "swipe" });
  await page.goto(d.url(id));
  await front.waitFor();
  await page.keyboard.press("ArrowRight");
  await sleep(500);
  await d.must("POST", `/api/rounds/${id}/push`, {
    add: [{ id: "conflict", from: "offline", title: "Which edit wins when a task changes on two phones offline?", left: { label: "The later edit" }, right: { label: "Ask the user" }, why: "It decides whether sync can run without the user.", recommended: "left" }],
    position: "next",
  });
  await sleep(600);
  await page.keyboard.press("ArrowRight");
  await page.locator(".sw-card.front", { hasText: "two phones offline" }).waitFor({ timeout: 10_000 });
  await sleep(700);
  await out("swipe-followup", await snap(page));

  // The end of the deck: a note and Dig deeper.
  await d.clear();
  const end = await d.open({ ...swipeDeck(), cards: swipeDeck().cards.slice(0, 2) }, { mode: "swipe" });
  await page.goto(d.url(end));
  await front.waitFor();
  await page.keyboard.press("ArrowLeft");
  await sleep(400);
  await page.keyboard.press("ArrowRight");
  await page.locator(".sw-end").waitFor();
  await d.must("POST", `/api/rounds/${end}/push`, { done: true });
  await page.locator(".sw-note-input").fill("Dig into offline sync: who wins when two phones edit the same task?");
  await sleep(500);
  await out("swipe-deeper", await snap(page));
}

// ---- 3.0 views, at three widths

async function newViews(c) {
  const { page, theme, width, browser } = c;
  const out = (view, png) => save(`${view}-${width}-${theme}`, png, browser);

  if (wanted("question")) {
    await openRound(c, showcase());
    const q = card(page, "layout");
    await q.locator(".opt").nth(1).click();
    await sleep(400);
    await scrollTop(page, q, width < 500 ? 8 : 32);
    await out("question", await snap(page));
  }

  if (wanted("swipe")) {
    await d.clear();
    const id = await d.open(swipeDeck("home"), { mode: "swipe" });
    await page.goto(d.url(id));
    await page.locator(".sw-card.front").waitFor();
    await sleep(900);
    await out("swipe", await snap(page));
  }

  if (wanted("tune")) {
    await openRound(c, d.readSpec("examples/v3/tune.questions.json"));
    const q = card(page, "card");
    await q.locator("iframe").first().waitFor();
    await q.locator('.tn-chip[data-preset="Packed"]').click();
    await q.locator('[data-act="remember"]').click();
    await q.locator('.tn-chip[data-preset="Airy"]').click();
    await sleep(1200);
    await scrollTop(page, q, width < 500 ? 8 : 24);
    await out("tune", await snap(page));
  }

  if (wanted("forms")) {
    const spec = d.readSpec("examples/v3/forms.questions.json");
    spec.questions.find((x) => x.id === "where").images[0].src = "screen.svg";
    d.write("screen.svg", SCREEN_SVG);
    await openRound(c, spec);
    await card(page, "plan").locator(".opt, [draggable], .bk-item, button").first().waitFor().catch(() => {});
    await scrollTop(page, card(page, "plan"), width < 500 ? 8 : 24);
    await out("forms", await snap(page));
  }

  if (wanted("evidence")) {
    await openRound(c, d.readSpec("examples/v3/evidence.questions.json"));
    await out("evidence", await snap(page));
  }

  if (wanted("inbox")) {
    // Several waiting rounds: the rail lists them, and the page shows the one that is open.
    await openRound(c, showcase(), { live: true });
    for (const title of ["Pricing page copy", "Which database for the sync service?"]) await d.open({ title, questions: [{ id: "a", type: "single", title: "Pick one", why: "Needed.", options: [{ id: "x", label: "Yes", then: "Goes on." }, { id: "y", label: "No", then: "Stops." }] }] });
    await sleep(1500);
    await out("inbox", await snap(page));
  }
}

// ---- journal, settings

async function journalShots(c) {
  const { page, theme, width, browser } = c;
  const out = (view, png) => save(`${view}-${width}-${theme}`, png, browser);
  await page.goto(`${d.origin}/#journal`);
  await page.locator(".jp-list").waitFor();
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await page.locator(".jp-map .map-note").first().waitFor({ timeout: 20_000 });
  await sleep(2500);
  await out("journal-map", await snap(page));
}

async function settingsShots(c) {
  const { page, theme, width, browser } = c;
  await page.goto(`${d.origin}/#settings`);
  await sleep(1200);
  await save(`settings-${width}-${theme}`, await snap(page), browser);
}

// A few answered rounds that lean on each other, so the journal and its map have something to show.
async function seedJournal() {
  const make = async (title, qid, dependsOn) => {
    const id = await d.open({ title, questions: [{ id: qid, type: "single", title: `${title}?`, why: "It comes first.", ...(dependsOn ? { dependsOn } : {}), options: [{ id: "a", label: "Yes", then: "Goes on." }, { id: "b", label: "No", then: "Stops." }] }] });
    await d.must("POST", `/api/rounds/${id}/submit`, { answers: { [qid]: { selected: ["a"] } } });
    return id;
  };
  const first = await make("Who is the first version for", "who");
  await make("Where does sync run", "sync", ["who"]);
  const price = await make("What does Pro cost", "price", [first]);
  await make("Which payment provider", "pay", ["price"]);
  await make("Keep the free plan", "free", ["price"]);
}

// ---- main

d = await startServer({ name: "screens" });
let browser;
let status = 0;
try {
  for (const rel of ["examples/showcase.assets", "examples/swipe.assets", "examples/v3/tune.assets"]) d.copy(rel);
  await seedJournal();

  browser = await chromium.launch({ args: ["--mute-audio"] });
  const run = async (widthKey, theme, fn) => {
    const v = WIDTHS[widthKey];
    const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: v.scale, colorScheme: theme, reducedMotion: "reduce", locale: "en-US" });
    const page = await ctx.newPage();
    try {
      await fn({ page, browser, theme, width: v.width });
    } finally {
      await ctx.close();
    }
  };

  if (wanted("readme")) {
    console.log("README shots (1440)");
    for (const theme of THEMES) {
      await run(1440, theme, readmeShots);
      await run(1440, theme, swipeShots);
    }
  }
  console.log("3.0 views");
  for (const width of Object.keys(WIDTHS))
    for (const theme of THEMES)
      await run(width, theme, async (c) => {
        await newViews(c);
        if (wanted("journal")) await journalShots(c);
        if (wanted("settings")) await settingsShots(c);
      });
  console.log(`done: ${written.length} files in docs/screens`);
} catch (e) {
  console.error(e);
  status = 1;
} finally {
  await browser?.close().catch(() => {});
  await d.stop();
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(status);
