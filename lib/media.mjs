// media.mjs — normalize visual attachments of a question, option, swipe card,
// swipe side or explanation: images, HTML mockup preview, code/diff, mermaid
// diagram, links, and the 2.0 kinds: a before/after compare slider, video, a
// side-by-side text diff, a data table and a simple bar/line chart. Every
// shape problem becomes a lint issue; a broken attachment is dropped, never
// shown half-made.

import { statSync } from "node:fs";

const REMOTE = /^(https?:|data:)/i;
const VIDEO = /\.(mp4|webm|gif)$/i;
export const LIMITS = { chartBars: 12, chartPoints: 60, chartSeries: 4, diffLines: 400, tableRows: 50, tableCols: 8, videoMB: 20 };
const str = (v) => (typeof v === "string" ? v.trim() : "");
const text = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);

export function collectMedia(node, where, ctx) {
  const images = [...list(node.image), ...list(node.images)]
    .map((img) => (typeof img === "string" ? { src: img } : img || {}))
    .map((img) => asset(str(img.src || img.path), where, ctx, { caption: str(img.caption || img.alt) }))
    .filter(Boolean);

  const preview = str(node.preview) ? asset(str(node.preview), where, ctx, {}) : null;
  const code = normalizeCode(node.code);
  const links = [...list(node.link), ...list(node.links)]
    .map((l) => (typeof l === "string" ? { url: l, label: l } : l || {}))
    .filter((l) => /^https?:\/\//i.test(str(l.url)))
    .map((l) => ({ url: str(l.url), label: str(l.label) || str(l.url) }));

  return {
    images,
    preview,
    previewHeight: Number.isInteger(node.previewHeight) ? node.previewHeight : 360,
    code,
    mermaid: str(node.mermaid),
    links,
    compare: node.compare == null ? null : normalizeCompare(node.compare, `${where}.compare`, ctx),
    video: list(node.video ?? node.videos).map((v, i) => normalizeVideo(v, `${where}.video${i ? `[${i}]` : ""}`, ctx)).filter(Boolean),
    diff: node.diff == null ? null : normalizeDiff(node.diff, `${where}.diff`, ctx),
    table: node.table == null ? null : normalizeTable(node.table, `${where}.table`, ctx),
    chart: node.chart == null ? null : normalizeChart(node.chart, `${where}.chart`, ctx),
  };
}

// The kinds a node carries, for lint rules that look at a card and its sides together.
export const mediaKinds = (m) =>
  ["images", "preview", "code", "mermaid", "compare", "video", "diff", "table", "chart"].filter((k) => (Array.isArray(m[k]) ? m[k].length : m[k]));

function asset(src, where, ctx, extra) {
  if (!src) return null;
  if (REMOTE.test(src)) return { src, ...extra, local: false };
  const abs = ctx.abs(src);
  if (!ctx.exists(abs)) {
    ctx.add("warn", where, `missing file ${abs} — skipped`);
    return null;
  }
  return { src: abs, ...extra, local: true };
}

function normalizeCode(code) {
  if (!code) return null;
  if (typeof code === "string") return { text: code, lang: "", diff: looksLikeDiff(code) };
  const text = str(code.text) || str(code.source);
  if (!text) return null;
  const lang = str(code.lang);
  return { text, lang, diff: code.diff === true || lang === "diff" || looksLikeDiff(text) };
}

function looksLikeDiff(text) {
  const lines = text.split("\n");
  return lines.length > 1 && lines.filter((l) => /^[+-](?![+-])/.test(l)).length >= 2;
}

// compare: {before, after, labels?: [before, after]}; before/after are image paths or {src, label}.
function normalizeCompare(raw, where, ctx) {
  if (!raw || typeof raw !== "object") return bad(ctx, where, 'expected {"before": image, "after": image}');
  const side = (v, fallback) => {
    const o = typeof v === "string" ? { src: v } : v || {};
    return asset(str(o.src || o.path), where, ctx, { label: str(o.label) || fallback });
  };
  const labels = list(raw.labels).map(str);
  const before = side(raw.before, labels[0] || "");
  const after = side(raw.after, labels[1] || "");
  if (!before || !after) return bad(ctx, where, "a compare needs both before and after images — skipped");
  if (before.src === after.src) ctx.add("warn", where, "before and after are the same picture");
  return { before, after };
}

// video: a path or {src, caption, loop?}; mp4, webm or gif. Short clips loop muted, long ones get controls.
function normalizeVideo(raw, where, ctx) {
  const o = typeof raw === "string" ? { src: raw } : raw || {};
  const src = str(o.src || o.path);
  if (!src) return bad(ctx, where, "a video needs src");
  if (!VIDEO.test(src.split("?")[0]) && !REMOTE.test(src)) ctx.add("warn", where, `${src}: use mp4, webm or gif`);
  const v = asset(src, where, ctx, { caption: str(o.caption), loop: o.loop === true ? true : o.loop === false ? false : null, gif: /\.gif$/i.test(src.split("?")[0]) });
  if (v?.local) {
    const mb = sizeMB(v.src, ctx);
    if (mb > LIMITS.videoMB) ctx.add("warn", where, `${mb.toFixed(1)} MB video — over ${LIMITS.videoMB} MB loads slowly; cut it to the few seconds that matter`);
  }
  return v;
}

function sizeMB(file, ctx) {
  try {
    return (ctx.size ? ctx.size(file) : statSync(file).size) / 1048576;
  } catch {
    return 0;
  }
}

// diff: {before, after, lang?, labels?}: two texts, compared line by line in the browser.
function normalizeDiff(raw, where, ctx) {
  if (!raw || typeof raw !== "object" || (typeof raw.before !== "string" && typeof raw.after !== "string")) {
    return bad(ctx, where, 'expected {"before": "text", "after": "text"}');
  }
  const before = text(raw.before).replace(/\r\n/g, "\n");
  const after = text(raw.after).replace(/\r\n/g, "\n");
  if (before === after) ctx.add("warn", where, "before and after are identical — nothing to compare");
  const lines = Math.max(before.split("\n").length, after.split("\n").length);
  if (lines > LIMITS.diffLines) ctx.add("warn", where, `${lines} lines — over ${LIMITS.diffLines}, cut the diff to the part that matters`);
  const labels = list(raw.labels).map(str);
  return { before, after, lang: str(raw.lang), labels: [labels[0] || "", labels[1] || ""] };
}

// table: {columns: [...], rows: [[...]] or [{column: value}], caption?}.
function normalizeTable(raw, where, ctx) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.rows)) return bad(ctx, where, 'expected {"columns": [...], "rows": [[...], ...]}');
  let columns = list(raw.columns).map((c) => text(typeof c === "object" && c ? c.label ?? c.id : c).trim());
  if (!columns.length && raw.rows[0] && typeof raw.rows[0] === "object" && !Array.isArray(raw.rows[0])) columns = Object.keys(raw.rows[0]);
  if (!columns.length) return bad(ctx, where, "a table needs columns");
  const keys = list(raw.columns).map((c, i) => (c && typeof c === "object" ? text(c.id ?? c.label) : columns[i]));
  const rows = raw.rows.map((r, i) => {
    const cells = Array.isArray(r) ? r : r && typeof r === "object" ? (keys.length ? keys : columns).map((k) => r[k]) : [r];
    if (Array.isArray(r) && r.length !== columns.length) ctx.add("warn", `${where}.rows[${i}]`, `${r.length} cells for ${columns.length} columns`);
    return columns.map((_, j) => text(cells[j]).trim());
  });
  if (!rows.length) return bad(ctx, where, "a table needs at least one row");
  if (rows.length > LIMITS.tableRows) ctx.add("warn", where, `${rows.length} rows — over ${LIMITS.tableRows}, show the rows that matter`);
  if (columns.length > LIMITS.tableCols) ctx.add("warn", where, `${columns.length} columns — over ${LIMITS.tableCols} won't fit on a phone`);
  return { columns, rows, caption: str(raw.caption) };
}

// chart: {type: "bar"|"line", labels, series: [{name, values}] or [numbers], unit?, title?}.
function normalizeChart(raw, where, ctx) {
  if (!raw || typeof raw !== "object") return bad(ctx, where, 'expected {"type": "bar", "labels": [...], "series": [...]}');
  let type = str(raw.type) || "bar";
  if (!["bar", "line"].includes(type)) {
    ctx.add("warn", where, `unknown chart type "${type}" (use bar or line), drawing bars`);
    type = "bar";
  }
  const labels = list(raw.labels).map((l) => text(l).trim());
  let series = list(raw.series);
  if (series.length && series.every((v) => typeof v === "number" || typeof v === "string")) series = [{ name: "", values: series }];
  series = series
    .map((s) => (Array.isArray(s) ? { values: s } : s || {}))
    .map((s, i) => {
      const values = list(s.values ?? s.data).map((v) => (v === null || v === "" ? null : Number(v)));
      if (values.some((v) => v !== null && !Number.isFinite(v))) ctx.add("warn", `${where}.series[${i}]`, "non-numeric values are drawn as gaps");
      if (labels.length && values.length !== labels.length) ctx.add("warn", `${where}.series[${i}]`, `${values.length} values for ${labels.length} labels`);
      return { name: str(s.name) || str(s.label), values: values.map((v) => (Number.isFinite(v) ? v : null)) };
    })
    .filter((s) => s.values.some((v) => v !== null));
  if (!series.length) return bad(ctx, where, "a chart needs at least one series of numbers");
  const n = Math.max(labels.length, ...series.map((s) => s.values.length));
  const fullLabels = Array.from({ length: n }, (_, i) => labels[i] ?? String(i + 1));
  if (type === "bar" && n > LIMITS.chartBars) ctx.add("warn", where, `${n} bars — over ${LIMITS.chartBars} can't be read on a card; group them or use a line`);
  if (type === "line" && n > LIMITS.chartPoints) ctx.add("warn", where, `${n} points — over ${LIMITS.chartPoints}, sample the series`);
  if (series.length > LIMITS.chartSeries) ctx.add("warn", where, `${series.length} series — over ${LIMITS.chartSeries} colors blur together`);
  if (series.length > 1 && series.some((s) => !s.name)) ctx.add("warn", where, "name every series: the legend needs it");
  return { type, labels: fullLabels, series, unit: str(raw.unit), title: str(raw.title) };
}

// Charts shown next to each other (two swipe sides, the options of a question)
// get one y range, so equal bars mean equal values across them.
export function shareScale(charts) {
  const all = charts.filter(Boolean);
  if (all.length < 2) return;
  const values = all.flatMap((c) => c.series.flatMap((s) => s.values)).filter((v) => v !== null);
  const domain = [Math.min(0, ...values), Math.max(0, ...values)];
  for (const c of all) c.domain = domain;
}

function bad(ctx, where, message) {
  ctx.add("warn", where, message);
  return null;
}
