// Captures every UI state the film uses from the real decide page, at 3x, into public/ui/<state>.png, plus
// public/ui/boxes.json: the CSS-pixel boxes of the elements the camera aims at in each state.
// Fixture data only (fixtures/), a scratch DECIDE_HOME, muted headless Chrome. Run: node capture/run.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { freshScratch, tools, urlOf, browser, settle, PROMO, PROJECT } from "./lib.mjs";

const OUT = resolve(PROMO, "public/ui");
mkdirSync(OUT, { recursive: true });
freshScratch();
const T = await tools();
const boxes = {};
const W = 1440, H = 900;
const { b, page } = await browser({ width: W, height: H, scale: 3 });

// Every state: one viewport PNG + boxes of named selectors (CSS px, viewport coordinates).
async function shot(name, aim = {}) {
  await settle(page, 350);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const got = {};
  for (const [k, sel] of Object.entries(aim)) {
    got[k] = await page.evaluate((s) => {
      const [q, n] = s.split("@");
      const el = document.querySelectorAll(q)[Number(n || 0)];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, sel);
    if (!got[k]) console.warn(`  ${name}: no element for ${k} (${sel})`);
  }
  boxes[name] = got;
  console.log("shot", name);
}
const center = (sel, block = "center") => page.evaluate(([s, bl]) => document.querySelector(s).scrollIntoView({ block: bl, behavior: "instant" }), [sel, block]);
const L = (sel) => { const [q, n] = sel.split("@"); return page.locator(q).nth(Number(n || 0)); };
const scrollTo = (y) => page.evaluate((v) => window.scrollTo(0, v), y);
const typeSlow = async (text, states, prefix, aim) => {
  // type the text, saving a state at each listed length
  let typed = 0;
  for (const n of states) {
    await page.keyboard.type(text.slice(typed, n));
    typed = n;
    await shot(`${prefix}-${n}`, aim);
  }
};

/* ---------------- act 1: the page round ---------------- */
const askText = await T.ask({ project: PROJECT, specPath: resolve(PROMO, "fixtures/home.questions.json"), open: false });
const round = askText.match(/Round (\S+)/)[1];
await page.goto(urlOf(askText));
await page.waitForSelector("#q-goal");
await settle(page, 800);

await shot("p-top", { title: "h1.title", goal: "#q-goal", bar: ".bar-count" });

// q1: the agent's pick and its reason; the digit 1 picks it
await center("#q-goal .opt-reason", "center");
await shot("p-goal", { card: "#q-goal", rec: "#q-goal .badge.rec", reason: "#q-goal .opt-reason", opt1: "#q-goal .opt" });
{
  // clicking the title to focus the card scrolls it; put the page back where p-goal was, so the pick shows in place
  const y0 = await page.evaluate(() => window.scrollY);
  await page.click("#q-goal h3.q-title");
  await page.keyboard.press("1");
  await scrollTo(y0);
}
await shot("p-goal-picked", { card: "#q-goal", rec: "#q-goal .badge.rec", reason: "#q-goal .opt-reason", opt1: "#q-goal .opt", bar: ".bar-count" });

// q2: three mockups side by side, the Today view picked
await center("#q-layout", "center");
await shot("p-layout", { card: "#q-layout", today: "#q-layout .opt@1" });
await L("#q-layout .opt@1").click();
await shot("p-layout-picked", { card: "#q-layout", today: "#q-layout .opt@1", bar: ".bar-count" });

// q3: the live task-card mockup; tick its checkbox inside the sandboxed frame
await center("#q-card iframe", "center");
await settle(page, 600);
await shot("p-card", { card: "#q-card", frame: "#q-card iframe" });
{
  const fr = page.frameLocator("#q-card iframe");
  const tick = fr.locator("input[type=checkbox], .check, button, [role=checkbox]").first();
  try {
    await tick.click({ timeout: 2000 });
  } catch (e) {
    console.warn("  card: no clickable checkbox in the mockup:", e.message.split("\n")[0]);
  }
}
await shot("p-card-ticked", { card: "#q-card", frame: "#q-card iframe" });
await L("#q-card .opt@0").click().catch(() => console.warn("  card: no first option"));

// rollout: ask the agent under the question, the real reply comes back through explain
await center("#q-rollout", "center");
await shot("p-rollout", { card: "#q-rollout", flag: "#q-rollout .opt@2" });
await page.locator("#q-rollout").getByRole("button", { name: /ask the agent/i }).click();
await page.waitForSelector("#q-rollout .ask-input");
await center("#q-rollout .ask-box", "center");
const AIM_ASK = { card: "#q-rollout", box: "#q-rollout .ask-box", input: "#q-rollout .ask-input" };
await typeSlow("what's a feature flag?", [0, 4, 9, 14, 18, 22], "p-ask", AIM_ASK);
await page.keyboard.press("Meta+Enter");
await shot("p-ask-sent", { ...AIM_ASK, thread: "#q-rollout .thread" });
const asked = await T.wait({ project: PROJECT, round, timeoutSec: 10 });
const askId = (asked.match(/askId[^\w]*(\w+)/) || [])[1];
await T.explain({
  project: PROJECT,
  round,
  question: "rollout",
  askId,
  text: "A switch inside the app. The new screen is on only for the accounts you pick, and you can turn it off in a second, without a release.\n\nFor this screen I'd still go **gradually**: real users find the bugs, and only 10% of them see one.",
});
await page.waitForSelector("#q-rollout .msg.agent", { timeout: 10000 });
await center("#q-rollout .msg.agent", "center");
await shot("p-reply-toast", { card: "#q-rollout", reply: "#q-rollout .msg.agent", thread: "#q-rollout .thread" });
await settle(page, 6000);
await shot("p-reply", { card: "#q-rollout", reply: "#q-rollout .msg.agent", thread: "#q-rollout .thread" });
await L("#q-rollout .opt@1").click();
await shot("p-rollout-picked", { card: "#q-rollout", reply: "#q-rollout .msg.agent", gradual: "#q-rollout .opt@1", bar: ".bar-count" });

// the rest: features (multi), order (rank), confidence (scale), migration
for (const id of ["features", "order", "confidence", "migration"]) {
  await center(`#q-${id}`, "center");
  await page.locator(`#q-${id}`).getByRole("button", { name: /as recommended/i }).click().catch(() => {});
  if (id === "confidence") await page.locator("#q-confidence .scale button, #q-confidence .scale [role=radio]").nth(3).click().catch(() => {});
  await shot(`p-${id}`, { card: `#q-${id}`, bar: ".bar-count" });
}
await page.click(".bar-done");
await settle(page, 600);
await shot("p-review", { modal: ".modal, dialog", send: ".modal .btn.primary, dialog .btn.primary" });
await page.locator(".modal .btn.primary, dialog .btn.primary").first().click();
await page.waitForSelector(".done-digest", { timeout: 10000 });
await shot("p-handing", { title: "h2, .done-title", digest: ".done-digest" });
console.log(await T.wait({ project: PROJECT, round, timeoutSec: 10 }));
await settle(page, 1500);
await shot("p-done", { title: "h2, .done-title", digest: ".done-digest" });

writeFileSync(`${OUT}/boxes.json`, JSON.stringify(boxes, null, 1));
await b.close();
process.exit(0);
