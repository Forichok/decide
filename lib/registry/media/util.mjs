// util.mjs — what the media kinds share on the engine side: reading a value the way 2.1 did,
// and turning a path or URL into an asset.

import { statSync } from "node:fs";

export const REMOTE = /^(https?:|data:)/i;
export const HTML = /\.html?$/i;
export const LIMITS = { chartBars: 12, chartPoints: 60, chartSeries: 4, diffLines: 400, tableRows: 50, tableCols: 8, videoMB: 20, htmlKB: 200 };

export const str = (v) => (typeof v === "string" ? v.trim() : "");
export const text = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
export const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);

// A path or URL as {src, ...extra, local}; a missing local file is a warning and no asset.
export function asset(src, where, ctx, extra) {
  if (!src) return null;
  if (REMOTE.test(src)) return { src, ...extra, local: false };
  const abs = ctx.abs(src);
  if (!ctx.exists(abs)) {
    ctx.add("warn", where, `missing file ${abs} — skipped`);
    return null;
  }
  return { src: abs, ...extra, local: true };
}

// A shape problem: said once, and the attachment is dropped.
export function bad(ctx, where, message) {
  ctx.add("warn", where, message);
  return null;
}

export function sizeMB(file, ctx) {
  try {
    return (ctx.size ? ctx.size(file) : statSync(file).size) / 1048576;
  } catch {
    return 0;
  }
}
