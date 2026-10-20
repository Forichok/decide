// Probe: open the page round and the deck, save one full-page shot of each (for picking selectors and framing).
import { resolve } from "node:path";
import { freshScratch, tools, urlOf, browser, settle, PROMO, PROJECT } from "./lib.mjs";

freshScratch();
const T = await tools();
const page1 = urlOf(await T.ask({ project: PROJECT, specPath: resolve(PROMO, "fixtures/home.questions.json"), open: false }));
const deck = urlOf(await T.swipe({ project: PROJECT, specPath: resolve(PROMO, "fixtures/home.deck.json"), open: false }));
const out = resolve(PROMO, "out/probe");
const { b, page } = await browser({ scale: 1 });
for (const [name, url] of [["page", page1], ["deck", deck]]) {
  await page.goto(url);
  await settle(page, 1500);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  console.log(name, url);
}
await b.close();
process.exit(0);
