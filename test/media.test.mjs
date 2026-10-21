/**
 * Feature:    media kinds shared by /decide and swipe (2.0)
 * Layer:      lib/media.mjs normalize + lint (pure), ui/js/md.js, ui/js/diff.js, ui/js/chart.js (pure, run in node)
 * Contract:   skills/decide/spec.md "Visuals", skills/swipe/SKILL.md "What a card can show"
 * Covers:
 *   - compare, video, diff, table and chart normalize from their short and long shapes
 *   - a broken attachment is dropped with a warning, never shown half-made
 *   - lint warns on misuse: over 12 bars, a diff over 400 lines, a video over 20 MB, a long swipe title,
 *     a side preview on a card that has one
 *   - md renders tables, quotes and headings and stays escape-first
 *   - the line diff pairs changed lines and keeps every line exactly once
 *   - the chart SVG escapes labels and draws one mark per value
 * Why exists: the agent writes these shapes by hand; a silent drop or a broken render costs the user a decision.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectMedia, LIMITS } from "../lib/media.mjs";
import { normalizeSpec } from "../lib/spec.mjs";
import { normalizeDeck } from "../lib/swipe.mjs";
import { createRoots } from "../lib/assets.mjs";
import { md } from "../ui/js/md.js";
import { diffStats, inlineSpan, lineDiff } from "../ui/js/diff.js";
import { chartSvg, niceTicks } from "../ui/js/chart.js";

async function fixture(context) {
  const dir = await mkdtemp(path.join(tmpdir(), "decide-media-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  for (const f of ["a.png", "b.png", "clip.mp4", "loop.gif"]) await writeFile(path.join(dir, f), "x");
  const issues = [];
  const ctx = { add: (level, where, message) => issues.push({ level, where, message }), exists: () => true, abs: (p) => path.resolve(dir, p) };
  ctx.exists = (p) => ["a.png", "b.png", "clip.mp4", "loop.gif", "big.mp4"].includes(path.basename(p));
  return { dir, ctx, issues, warned: () => issues.map((i) => `${i.where}: ${i.message}`).join("\n") };
}

test("compare, video, diff, table and chart normalize", async (context) => {
  const { dir, ctx, issues } = await fixture(context);
  const m = collectMedia(
    {
      compare: { before: "a.png", after: { src: "b.png", label: "New" }, labels: ["Old"] },
      video: ["clip.mp4", { src: "loop.gif", caption: "Spin", loop: true }],
      diff: { before: "a\nb\n", after: "a\nc\n", lang: "js" },
      table: { columns: ["Plan", { id: "price", label: "Price" }], rows: [["Free", 0], { Plan: "Pro", price: "$9" }] },
      chart: { type: "line", labels: ["Q1", "Q2", "Q3"], series: [{ name: "Users", values: [1, "2", null] }], unit: "k" },
    },
    "q",
    ctx,
  );
  assert.deepEqual(issues, []);
  assert.deepEqual([m.compare.before.src, m.compare.before.label, m.compare.after.label], [path.join(dir, "a.png"), "Old", "New"]);
  assert.deepEqual(m.video.map((v) => [path.basename(v.src), v.gif, v.loop]), [["clip.mp4", false, null], ["loop.gif", true, true]]);
  assert.deepEqual([m.diff.before, m.diff.lang, m.diff.labels], ["a\nb\n", "js", ["", ""]]);
  assert.deepEqual(m.table.rows, [["Free", "0"], ["Pro", "$9"]]);
  assert.deepEqual(m.chart.series[0].values, [1, 2, null]);
  assert.equal(collectMedia({ chart: { series: [3, 4] } }, "q", ctx).chart.labels.join(), "1,2", "bare numbers make one series with index labels");
  assert.equal(collectMedia({ table: { rows: [{ a: 1, b: 2 }] } }, "q", ctx).table.columns.join(), "a,b", "columns from object rows");

  // Published like images: local paths become served URLs, remote ones stay.
  const roots = createRoots();
  const pub = roots.publishNode({ ...m, images: [] });
  assert.match(pub.compare.after.src, /^\/r\/\d+\/b\.png$/);
  assert.match(pub.video[0].src, /^\/r\/\d+\/clip\.mp4$/);
});

test("a broken attachment is dropped with a warning", async (context) => {
  const { ctx, warned } = await fixture(context);
  const m = collectMedia(
    {
      compare: { before: "a.png", after: "gone.png" },
      video: [{ caption: "no src" }, "gone.mp4"],
      diff: { text: "nope" },
      table: { columns: ["a"] },
      chart: { type: "pie", series: [["x", "y"]] },
    },
    "q",
    ctx,
  );
  assert.deepEqual([m.compare, m.video, m.diff, m.table, m.chart], [null, [], null, null, null]);
  const w = warned();
  // A non-media file never becomes a served root.
  const odd = collectMedia({ compare: { before: "a.png", after: "notes.txt" }, video: "id_rsa" }, "q", ctx);
  assert.deepEqual([odd.compare, odd.video], [null, []]);
  assert.match(warned(), /notes\.txt: not a picture/);
  assert.match(warned(), /id_rsa: use mp4, webm or gif — skipped/);
  for (const re of [/missing file .+gone\.png/, /compare needs both/, /video needs src/, /gone\.mp4 — skipped/, /expected \{"before"/, /expected \{"columns"/, /unknown chart type "pie"/, /at least one series/]) assert.match(w, re);
});

test("lint warns on misuse", async (context) => {
  const { dir, ctx, warned } = await fixture(context);
  await writeFile(path.join(dir, "big.mp4"), "");
  await truncate(path.join(dir, "big.mp4"), (LIMITS.videoMB + 1) * 1048576);
  const labels = Array.from({ length: 13 }, (_, i) => `m${i}`);
  collectMedia(
    {
      chart: { labels, series: [{ values: labels.map((_, i) => i) }, { values: labels.map(() => 1) }] },
      diff: { before: "x\n".repeat(401), after: "y" },
      video: "big.mp4",
      table: { columns: ["a", "b"], rows: [["only one"]] },
    },
    "q",
    ctx,
  );
  const w = warned();
  assert.match(w, /13 bars — over 12/);
  assert.match(w, /name every series/);
  assert.match(w, /402 lines — over 400/);
  assert.match(w, /21\.0 MB video — over 20 MB/);
  assert.match(w, /rows\[0\]: 1 cells for 2 columns/);

  const deck = normalizeDeck(
    {
      cards: [
        {
          id: "long",
          title: "x".repeat(130),
          preview: "a.png",
          body: "| a | b |\n|---|---|\n| 1 | 2 |",
          left: { label: "L", preview: "b.png" },
          right: { label: "R", chart: { series: [1, 2] } },
        },
      ],
    },
    { specDir: dir },
  );
  const dw = deck.issues.map((i) => `${i.where}: ${i.message}`).join("\n");
  assert.match(dw, /title is 130 chars — over 120/);
  assert.match(dw, /left: the card already has a preview/);
  assert.equal(deck.deck.cards[0].body.startsWith("| a |"), true, "a swipe card keeps its body");
  assert.equal(deck.deck.cards[0].right.chart.series[0].values.length, 2, "a side keeps its own media");

  // Charts side by side share one y range, so equal bars mean equal values.
  const pair = normalizeDeck({ cards: [{ id: "p", title: "?", left: { label: "A", chart: { series: [10, 40] } }, right: { label: "B", chart: { series: [-5, 20] } } }] }, { specDir: dir }).deck.cards[0];
  assert.deepEqual([pair.left.chart.domain, pair.right.chart.domain], [[-5, 40], [-5, 40]]);
  assert.match(chartSvg(pair.right.chart), />40</, "the smaller chart still draws the shared top tick");

  const spec = normalizeSpec({ questions: [{ id: "q", title: "?", body: "### Why\n- one", options: [{ id: "a", label: "A", recommended: true, table: { columns: ["k"], rows: [["v"]] } }] }] }, { specDir: dir });
  assert.equal(spec.spec.questions[0].body, "### Why\n- one");
  assert.deepEqual(spec.spec.questions[0].options[0].table.rows, [["v"]], "an option carries a table too");
});

test("md: tables, quotes and headings stay escape-first", () => {
  const html = md("### Plan <b>\n| Tier | Price |\n|:--|--:|\n| **Pro** <img src=x onerror=alert(1)> | `a|b` |\n\n> quoted _text_\n> - item");
  assert.match(html, /^<h3>Plan &lt;b&gt;<\/h3>/);
  assert.match(html, /<th>Tier<\/th><th style="text-align:right">Price<\/th>/);
  assert.match(html, /<td><strong>Pro<\/strong> &lt;img src=x onerror=alert\(1\)&gt;<\/td><td style="text-align:right"><code>a\|b<\/code><\/td>/);
  assert.match(html, /<blockquote><p>quoted <em>text<\/em><\/p><ul><li>item<\/li><\/ul><\/blockquote>/);
  assert.doesNotMatch(html, /<img|<b>/);
  assert.equal(md("a | b\nno separator"), "<p>a | b<br>no separator</p>", "a pipe alone is not a table");
  assert.equal(md('| x |\n|---|\n| <script>"</script> |').includes("<script>"), false);
});

test("line diff pairs changed lines and keeps every line once", () => {
  const before = "import a\nconst x = 1\nkeep\nold only\ntail";
  const after = "import a\nconst x = 2\nkeep\ntail\nnew end";
  const rows = lineDiff(before, after);
  assert.deepEqual(
    rows.map((r) => r.type),
    ["same", "mod", "same", "del", "same", "add"],
  );
  assert.deepEqual(rows.filter((r) => r.left).map((r) => r.left.text), before.split("\n"), "every left line once, in order");
  assert.deepEqual(rows.filter((r) => r.right).map((r) => r.right.text), after.split("\n"), "every right line once, in order");
  assert.deepEqual(diffStats(rows), { added: 2, removed: 2 });
  assert.deepEqual(inlineSpan("const x = 1", "const x = 2"), { left: ["const x = ", "1", ""], right: ["const x = ", "2", ""] });
  // An inserted line before a changed one: the changed line still pairs with its new version.
  const ins = lineDiff("function f(a) {\n}", "import x\n\nfunction f(a, b) {\n}");
  assert.deepEqual(ins.map((r) => r.type), ["add", "add", "mod", "same"]);
  assert.equal(ins[2].left.text, "function f(a) {");
  assert.deepEqual(lineDiff("aaa", "zzz").map((r) => r.type), ["mod"], "nothing alike still pairs by position");
  assert.deepEqual(lineDiff("", "a").map((r) => r.type), ["add"]);
  assert.deepEqual(lineDiff("same\n", "same"), [{ type: "same", left: { n: 1, text: "same" }, right: { n: 1, text: "same" } }]);
  // Too big for the LCS table: still correct, as one changed block.
  const big = Array.from({ length: 2500 }, (_, i) => `l${i}`);
  const huge = lineDiff(big.join("\n"), big.map((l) => `${l}!`).join("\n"));
  assert.equal(huge.length, 2500);
  assert.ok(huge.every((r) => r.type === "mod"));
});

test("chart SVG: one mark per value, labels escaped", () => {
  const svg = chartSvg({ type: "bar", labels: ["<a>", "b"], series: [{ name: "S1", values: [3, -1] }, { name: "S2", values: [2, null] }], unit: "%" });
  assert.equal((svg.match(/class="ch-bar"/g) || []).length, 3, "a gap draws no bar");
  assert.match(svg, /&#60;a&#62;/);
  assert.doesNotMatch(svg, /<a>/);
  assert.match(svg, /<title>S1 · b: -1%<\/title>/);
  const line = chartSvg({ type: "line", labels: ["1", "2", "3"], series: [{ name: "", values: [1, null, 3] }] });
  assert.equal((line.match(/class="ch-pt"/g) || []).length, 2);
  assert.match(line, /d="M[\d.]+,[\d.]+M[\d.]+,[\d.]+"/, "a gap breaks the line");
  assert.deepEqual(niceTicks(0, 87), [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(-3, 9), [-5, 0, 5, 10]);
});
