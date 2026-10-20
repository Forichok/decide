// Renders each logo variant in logos.html to research/gate3r.assets/logo-<id>.png (muted headless Chrome).
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
const out = resolve("research/gate3r.assets"); mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--mute-audio"] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto("file://" + resolve("research/logo/logos.html"));
await p.evaluate(() => document.fonts.ready);
for (const id of ["m1", "m2", "m3", "m4"]) await p.locator("section#" + id).screenshot({ path: `${out}/logo-${id}.png` });
await b.close();
console.log("ok");
