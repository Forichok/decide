// Shared capture helpers: a scratch decide project (fixture data only), the real daemon through the MCP tool
// handlers, and a muted headless Chrome at 3x. Nothing here touches ~/.decide or a real project.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROMO = resolve(HERE, "..");
export const SCRATCH = process.env.DECIDE_PROMO_SCRATCH || resolve(PROMO, "out/capture-home");
export const PROJECT = resolve(SCRATCH, "task-app");

export function freshScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(resolve(PROJECT, ".git"), { recursive: true });
  writeFileSync(resolve(PROJECT, "README.md"), "# task-app (fixture)\n");
  process.env.DECIDE_HOME = resolve(SCRATCH, "decide-home");
}

export async function tools() {
  if (!process.env.DECIDE_HOME) throw new Error("call freshScratch() first");
  const { HANDLERS } = await import("../../lib/tools.mjs");
  return HANDLERS;
}

export const urlOf = (text) => text.match(/https?:\/\/\S+/)[0].replace(/[.,]$/, "");

export async function browser({ width = 1440, height = 900, scale = 3 } = {}) {
  const b = await chromium.launch({
    executablePath: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--mute-audio", "--hide-scrollbars", "--font-render-hinting=none", "--disable-site-isolation-trials", "--disable-features=site-per-process,IsolateOrigins"],
  });
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: "dark", locale: "en-US", reducedMotion: "reduce" });
  return { b, page: await ctx.newPage() };
}

export const settle = (page, ms = 400) => page.waitForTimeout(ms);
