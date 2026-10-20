// Captures the swipe act: the 23-card deck answered with the arrow keys, the brief pushed after every batch through
// the real push tool, one own answer typed. Writes public/ui/s-*.png and merges boxes into public/ui/boxes.json.
// Run after capture/run.mjs (it reads and extends boxes.json). Run: node capture/swipe.mjs
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

const AIM = { card: ".sw-stack article.card, .sw-stack .sw-card, .sw-stack > *:last-child", brief: "aside.sw-brief", conf: ".sw-conf", left: ".sw-left-n, .sw-count", deck: "section.sw" };
async function shot(name) {
  await settle(page, 450);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const got = {};
  for (const [k, sel] of Object.entries(AIM)) {
    got[k] = await page.evaluate((s) => {
      for (const one of s.split(", ")) {
        const el = document.querySelector(one);
        if (el) { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, sel: one }; }
      }
      return null;
    }, sel);
  }
  boxes[name] = got;
  console.log("shot", name, got.card ? "" : "(no card box)");
}

const sw = await T.swipe({ project: PROJECT, specPath: deckPath, open: false });
const round = sw.match(/round (\S+)/i)[1];
await page.goto(urlOf(sw));
await page.waitForSelector("section.sw");
await settle(page, 1000);
await shot("s-00");

// Which side the person picks per card (mostly the agent's pick, a few against it), and one own answer.
const OWN = { nodate: "Pin them to the top of Later" };
const AGAINST = new Set(["count", "motion", "beta"]);
const side = (c) => (AGAINST.has(c.id) ? (c.recommended === "left" ? "right" : "left") : c.recommended || "left");
const label = (c, s) => (typeof c[s] === "string" ? c[s] : c[s].label);

const answered = [];
let conf = deck.confidence;
const brief = () => {
  const pts = [];
  const pick = (id) => answered.find((a) => a.id === id);
  for (const a of answered) pts.push({ kind: "decision", text: `${a.card.topic}: ${a.text}`, cards: [a.id] });
  if (pick("offline")) pts.push({ kind: "risk", text: "Offline Today view needs a local copy of today's tasks", cards: ["offline"] });
  if (pick("quiet")) pts.push({ kind: "risk", text: "Quiet hours depend on the phone's time zone", cards: ["quiet"] });
  if (!pick("sync")) pts.push({ kind: "open", text: "Which edit wins when two devices change the same task" });
  return pts;
};

for (let i = 0; i < deck.cards.length; i++) {
  const c = deck.cards[i];
  const n = String(i + 1).padStart(2, "0");
  if (OWN[c.id]) {
    await page.keyboard.press("Enter");
    await page.waitForSelector(".sw-own-input");
    const text = OWN[c.id];
    await page.keyboard.type(text.slice(0, 12));
    await shot(`s-${n}-own-a`);
    await page.keyboard.type(text.slice(12));
    await shot(`s-${n}-own-b`);
    await page.keyboard.press("Enter");
    answered.push({ id: c.id, card: c, text });
  } else {
    const s = side(c);
    await page.keyboard.press(s === "left" ? "ArrowLeft" : "ArrowRight");
    answered.push({ id: c.id, card: c, text: label(c, s) });
  }
  await shot(`s-${n}`);
  // a batch is out: read it like the agent does and push the rewritten brief
  const res = await T.wait({ project: PROJECT, round, timeoutSec: 2 }).catch((e) => e.message);
  if (/batch|answered/i.test(res) && !/still waiting/i.test(res)) {
    conf = Math.min(96, conf + 10);
    const last = i === deck.cards.length - 1;
    console.log(await T.push({ project: PROJECT, round, brief: brief(), confidence: last ? 96 : conf, ...(last ? { done: true } : {}) }));
    await shot(`s-${n}-pushed`);
  }
}
await settle(page, 800);
await shot("s-end");
writeFileSync(BOXES, JSON.stringify(boxes, null, 1));
await b.close();
process.exit(0);
