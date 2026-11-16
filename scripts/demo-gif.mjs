#!/usr/bin/env node
// demo-gif.mjs: re-records docs/demo.gif. Starts its own muted decide server in a scratch home, opens a short
// round in Playwright's Chromium with video recording, plays the story (the user picks options, asks the agent
// about one, the agent replies, Done) and turns the video into a gif with ffmpeg (palettegen / paletteuse).
//
//   node scripts/demo-gif.mjs [out.gif]      default docs/demo.gif
//
// Needs `npm ci` and ffmpeg on the PATH. Never touches the real ~/.decide (scripts/harness.mjs).

import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { pluginDir, sleep, startServer } from "./harness.mjs";

const out = path.resolve(process.argv[2] || path.join(pluginDir, "docs", "demo.gif"));
const SIZE = { width: 1200, height: 760 };
const WIDTH = 800;
const FPS = 8;

const d = await startServer({ name: "demo-gif" });
const videos = path.join(d.dir, "video");
mkdirSync(videos, { recursive: true });
let browser;
let status = 0;
try {
  d.copy("examples/showcase.assets");
  const spec = d.readSpec("examples/showcase.questions.json");
  const keep = ["layout", "features", "rollout", "name"];
  spec.questions = spec.questions.filter((q) => keep.includes(q.id));
  delete spec.context;
  delete spec.recap;
  const id = await d.open(spec, { live: true });

  browser = await chromium.launch({ args: ["--mute-audio"] });
  const ctx = await browser.newContext({ viewport: SIZE, colorScheme: "light", locale: "en-US", recordVideo: { dir: videos, size: SIZE } });
  const page = await ctx.newPage();
  const card = (q) => page.locator(`#q-${q}`);
  const scrollTo = async (q) => {
    await card(q).evaluate((el) => window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 90, behavior: "instant" }));
    await sleep(500);
  };
  const pick = async (q, n) => {
    await scrollTo(q);
    await card(q).locator(".opt").nth(n).click();
    await sleep(700);
  };

  await page.goto(d.url(id));
  await page.locator(".card").first().waitFor();
  await sleep(1000);

  await pick("layout", 1);
  await pick("features", 0);
  await card("features").locator(".opt").nth(1).click();
  await sleep(900);

  // Ask the agent about one question; the agent replies on the page.
  await scrollTo("rollout");
  await card("rollout").locator('[data-flag="explain"]').click();
  await sleep(500);
  await card("rollout").locator("textarea.ask-input").pressSequentially("Can we turn it off again after launch?", { delay: 45 });
  await sleep(500);
  await card("rollout").locator(".ask-row .btn.primary").click();
  await sleep(1800);
  await d.explain(id, "rollout", "Yes. Behind a feature flag it is one switch, and the old screen stays in the app for a week.");
  await card("rollout").locator(".msg.agent .msg-text").waitFor({ timeout: 10_000 });
  await sleep(1500);
  await pick("rollout", 2);

  await scrollTo("name");
  await card("name").locator("input, textarea").first().pressSequentially("Today", { delay: 90 });
  await sleep(1000);

  // Done: the review, then send.
  await page.locator("#bar .bar-done").click();
  await page.locator("#overlay .btn.primary").waitFor();
  await sleep(1500);
  await page.locator("#overlay .btn.primary").first().click();
  await sleep(2200);

  const video = page.video();
  await ctx.close();
  const src = await video.path();
  mkdirSync(path.dirname(out), { recursive: true });
  const filters = `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos`;
  const palette = path.join(videos, "palette.png");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-vf", `${filters},palettegen=max_colors=48:stats_mode=diff`, palette]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-i", palette, "-lavfi", `${filters} [x]; [x][1:v] paletteuse=dither=none:diff_mode=rectangle`, out]);
  const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src]).toString().trim();
  console.log(`${path.relative(pluginDir, out)}: ${(statSync(out).size / 1048576).toFixed(2)} MB, ${Number(dur).toFixed(1)} s`);
} catch (e) {
  console.error(e);
  status = 1;
} finally {
  await browser?.close().catch(() => {});
  await d.stop();
}
process.exit(status);
