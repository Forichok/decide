// Captures the swipe act with the real daemon and the real push/explain tools: the deck answered with the arrow keys,
// one answer taken back with ⌫, ↓ on the sync card with the agent's reply on the card, three follow-up cards the agent
// adds because of the offline answer, one own answer typed, risks and a conflict in the brief, confidence 40 -> 96.
// Writes public/ui/<state>.png, merges boxes into public/ui/boxes.json and the step list into public/ui/swipe.json
// (the film times its beats from that list). Run after capture/run.mjs. Run: node capture/swipe.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { freshScratch, tools, urlOf, browser, settle, PROMO, PROJECT } from "./lib.mjs";

const OUT = resolve(PROMO, "public/ui");
const BOXES = `${OUT}/boxes.json`;
const boxes = existsSync(BOXES) ? JSON.parse(readFileSync(BOXES, "utf8")) : {};
freshScratch();
const T = await tools();
const deckPath = resolve(PROMO, "fixtures/home.deck.json");
const deck = JSON.parse(readFileSync(deckPath, "utf8"));
const { b, page } = await browser({ width: 1440, height: 900, scale: 3 });

const AIM = {
  card: ".sw-stack .sw-card.front", brief: "aside.sw-brief", conf: ".sw-conf", count: ".sw-count", delta: ".sw-delta:not([hidden])",
  ask: ".sw-ask-input", own: ".sw-own-input", explain: ".sw-explain", from: ".sw-from",
  risk: ".sw-group.k-risk", problem: ".sw-group.k-problem", deck: "section.sw",
};
const steps = [];
let n = 0;
async function shot(act, extra = {}, name) {
  name ||= `sw-${String(++n).padStart(2, "0")}`;
  await settle(page, 450);
  // the brief outgrows the window by the risk pushes; it is kept scrolled to its end, where the risks and the pending answers are
  await page.evaluate(() => { const a = document.querySelector("aside.sw-brief"); if (a) a.scrollTop = a.scrollHeight; });
  await settle(page, 150);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const got = {};
  for (const [k, sel] of Object.entries(AIM)) {
    got[k] = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, sel);
  }
  boxes[name] = got;
  const [done, total] = await page.evaluate(() => (document.querySelector(".sw-count")?.textContent.match(/\d+/g) || []).map(Number));
  const left = total - done;
  const front = await page.evaluate(() => document.querySelector(".sw-card.front")?.dataset.card || null);
  steps.push({ name, act, front, left: Number.isFinite(left) ? left : null, total, conf, ...extra });
  console.log("shot", name, act, front, left, got.card ? "" : "(no card box)");
}

const sw = await T.swipe({ project: PROJECT, specPath: deckPath, open: false });
const round = sw.match(/round (\S+)/i)[1];
await page.goto(urlOf(sw));
await page.waitForSelector("section.sw");
await settle(page, 1000);
let conf = deck.confidence;
await shot("start", {}, "s-00");

const label = (c, s) => (typeof c[s] === "string" ? c[s] : c[s].label);
const byId = (id) => deck.cards.find((c) => c.id === id) || FOLLOW.find((c) => c.id === id);

// The follow-ups the agent adds after the offline answer, right after the current card.
const FOLLOW = [
  { id: "off-keep", section: "Data", topic: "Offline copy", from: "offline", title: "How much does the offline copy keep?", left: { label: "Today and tomorrow" }, right: { label: "Every task" }, recommended: "left", reason: "small and fast to sync" },
  { id: "off-edit", section: "Data", topic: "Offline edits", from: "offline", title: "Can you edit tasks while offline?", left: { label: "Yes, synced on reconnect" }, right: { label: "Read-only offline" }, recommended: "left" },
  { id: "off-tag", section: "Data", topic: "Offline tag", from: "offline", title: "Show that the list is offline?", left: { label: "A quiet \"Offline\" tag" }, right: { label: "Nothing" }, recommended: "left" },
];
const ASK = "both phones offline?";
const REPLY =
  "Two phones change the same task while offline. With **The latest edit**, whichever syncs last wins and the other change is lost without a word. **Ask the user** shows both versions and you pick one.";
const OWN = { nodate: "Pin them to the top of Later" };

// The script: [card, key] in order; "undo" takes the last answer back, "ask" explains the front card.
const PLAN = [
  ["empty", "right"], ["overdue", "left"], ["count", "right"], ["undo"], ["count", "left"], ["later", "left"],
  ["swipe-done", "left"], ["undo", "left"], ["offline", "left"], ["ask", "sync"], ["sync", "right"],
  ["snooze", "left"], ["off-keep", "left"], ["off-edit", "left"], ["off-tag", "left"],
  ["subtasks", "left"], ["time", "left"], ["week", "left"], ["nodate", "own"],
  ["default", "left"], ["quiet", "left"], ["dark", "left"], ["density", "left"],
  ["motion", "right"], ["beta", "left"], ["feedback", "left"], ["old", "left"],
  ["search", "skip"], ["widget", "right"],
];

const answered = new Map();
const skipped = new Set();
const has = (id) => answered.has(id);
const brief = () => {
  const pts = [...answered].map(([id, text]) => ({ kind: "decision", text: `${byId(id).topic}: ${text}`, cards: [id] }));
  if (has("offline")) pts.push({ kind: "risk", text: "Offline edits from two phones can collide", cards: ["offline", "sync"] });
  if (has("nodate")) pts.push({ kind: "risk", text: "Pinned no-date tasks can push today's below the fold", cards: ["nodate"] });
  if (has("default") && has("quiet")) pts.push({ kind: "problem", text: "Conflict: a 7:30 task's 15-minute reminder falls in quiet hours", cards: ["default", "quiet"] });
  if (skipped.has("search")) pts.push({ kind: "note", text: "Search: skipped, so it stays out of the first version", cards: ["search"] });
  if (!has("sync")) pts.push({ kind: "open", text: "Which edit wins when two phones change the same task" });
  return pts;
};
const CONF = [50, 62, 70, 78, 86, 92, 96];
let batches = 0, followed = false;
async function maybePush() {
  const res = await T.wait({ project: PROJECT, round, timeoutSec: 5 }).catch((e) => e.message);
  if (!/^Batch/i.test(res)) return;
  const stats = res.match(/(\d+) left in the deck/);
  const last = stats && Number(stats[1]) === 0;
  conf = last ? 96 : CONF[batches] ?? 92;
  batches++;
  const add = has("offline") && !followed ? FOLLOW : null;
  if (add) followed = true;
  console.log(await T.push({ project: PROJECT, round, brief: brief(), confidence: conf, ...(add ? { add, position: "next" } : {}), ...(last ? { done: true } : {}) }));
  await shot("push", add ? { added: add.length } : {});
}

for (const [id, key] of PLAN) {
  if (id === "undo" && !key) {
    const last = [...answered.keys()].pop();
    await page.keyboard.press("Backspace");
    answered.delete(last);
    await shot("undo", { card: last });
    continue;
  }
  if (id === "ask") {
    await page.keyboard.press("ArrowDown");
    await page.waitForSelector(".sw-ask-input");
    await shot("ask-open", { card: key });
    await page.keyboard.type(ASK);
    await shot("ask-typed", { card: key, text: ASK });
    await page.keyboard.press("Enter");
    await page.waitForSelector(".sw-explain.wait");
    await shot("ask-wait", { card: key });
    const ev = await T.wait({ project: PROJECT, round, timeoutSec: 10 });
    if (!/asks about question \[sync\]/.test(ev)) throw new Error(`expected the ask, got: ${ev}`);
    console.log(await T.explain({ project: PROJECT, round, question: key, text: REPLY }));
    await page.waitForSelector(".sw-explain:not(.wait)");
    await shot("explained", { card: key });
    continue;
  }
  const c = byId(id);
  const front = await page.evaluate(() => document.querySelector(".sw-card.front")?.dataset.card);
  if (front !== id) throw new Error(`expected card ${id} in front, got ${front}`);
  if (key === "own") {
    await page.keyboard.press("Enter");
    await page.waitForSelector(".sw-own-input");
    await shot("own-open", { card: id });
    await page.keyboard.type(OWN[id]);
    await shot("own-typed", { card: id, text: OWN[id] });
    await page.keyboard.press("Enter");
    answered.set(id, OWN[id]);
    await shot("answer", { card: id, side: "own" });
  } else if (key === "skip") {
    await page.keyboard.press("ArrowUp");
    skipped.add(id);
    await shot("answer", { card: id, side: "skip" });
  } else {
    await page.keyboard.press(key === "left" ? "ArrowLeft" : "ArrowRight");
    answered.set(id, label(c, key));
    await shot("answer", { card: id, side: key });
  }
  await maybePush();
}
await settle(page, 800);
await shot("end", {}, "s-end");
if (conf !== 96 || steps.at(-1).left !== 0) throw new Error(`the deck did not finish: conf ${conf}, left ${steps.at(-1).left}`);
writeFileSync(BOXES, JSON.stringify(boxes, null, 1));
writeFileSync(`${OUT}/swipe.json`, JSON.stringify(steps, null, 1));
// the film reads the step list from src/swipe-steps.ts (no frames in it, so it is committed)
const row = (s) => `  {name: '${s.name}', act: '${s.act}'${s.side ? `, side: '${s.side}'` : ""}, left: ${s.left}, conf: ${s.conf}${s.added ? `, added: ${s.added}` : ""}},`;
writeFileSync(resolve(PROMO, "src/swipe-steps.ts"), `/* Written by capture/swipe.mjs: every captured swipe state in order (public/ui/<name>.png). Do not edit. */
export type SwipeAct = 'start' | 'answer' | 'undo' | 'push' | 'ask-open' | 'ask-typed' | 'ask-wait' | 'explained' | 'own-open' | 'own-typed' | 'end';
export type SwipeStep = {name: string; act: SwipeAct; side?: 'left' | 'right' | 'own' | 'skip'; left: number; conf: number; added?: number};
export const SWIPE_STEPS: SwipeStep[] = [
${steps.map(row).join("\n")}
];
`);
await b.close();
process.exit(0);
