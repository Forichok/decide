// media.js — visuals attached to a question, an option, a swipe card or side:
// image gallery, before/after slider, video, sandboxed HTML mockup, chart,
// data table, side-by-side diff, code block, mermaid diagram, links. In a
// swipe side tile (compact) each kind shrinks to a thumbnail and opens large
// on click.

import { h, icon } from "./dom.js";
import { t } from "./i18n.js";
import { mdInline } from "./md.js";
import { inlineSpan, diffStats, lineDiff } from "./diff.js";
import { chartSvg } from "./chart.js";

const MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
let mermaidLoad = null;
let mermaidSeq = 0;

// qid: the question these visuals belong to — marks drawn on a picture attach there.
// compact: a swipe side tile; big: the zoomed copy in a modal.
export function renderMedia(node, ctx, qid, { compact = false, big = false } = {}) {
  const zoom = (kind, el) => (ctx.zoom && !big ? zoomable(el, () => ctx.zoom(renderMedia({ [kind]: node[kind], previewHeight: 640 }, ctx, qid, { big: true }))) : el);
  const parts = [
    node.images?.length && gallery(node.images, ctx, qid),
    node.compare && zoom("compare", compareView(node.compare)),
    node.video?.length && videos(node.video, ctx, qid),
    node.preview && (compact ? zoom("preview", preview(node.preview, 200, true)) : preview(node.preview, node.previewHeight)),
    node.chart && zoom("chart", chartView(node.chart, compact)),
    node.table && zoom("table", tableView(node.table)),
    node.diff && zoom("diff", diffView(node.diff, ctx, { unified: compact || narrow() })),
    node.mermaid && diagram(node.mermaid, ctx, qid),
    node.code && codeBlock(node.code, ctx),
    node.links?.length && links(node.links),
  ].filter(Boolean);
  return parts.length ? h(`div.media${compact ? ".compact" : ""}`, {}, parts) : null;
}

const narrow = () => matchMedia("(max-width: 640px)").matches;

// An expand button in the corner opens the same visual large.
function zoomable(el, open) {
  el.classList.add("has-zoom");
  el.append(
    h("button.media-zoom", {
      type: "button",
      title: t("media.zoom"),
      "aria-label": t("media.zoom"),
      html: icon("expand"),
      onclick: (e) => {
        e.stopPropagation();
        open();
      },
    }),
  );
  return el;
}

// Before/after: drag the divider (or focus it and use ← →); the left part shows before.
function compareView(c) {
  const pos = (v) => {
    const p = Math.max(0, Math.min(100, v));
    box.style.setProperty("--pos", `${p}%`);
    handle.setAttribute("aria-valuenow", String(Math.round(p)));
  };
  const img = (a, cls) => h(`img.cmp-img.${cls}`, { src: a.src, alt: a.label || "", draggable: "false", loading: "lazy", decoding: "async" });
  const handle = h("div.cmp-handle", { role: "slider", tabindex: "0", "aria-label": t("cmp.slider"), "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "50" }, h("span.cmp-knob", { html: `${icon("left")}${icon("right")}` }));
  const box = h(
    "div.compare.media-stop",
    {},
    img(c.before, "before"),
    img(c.after, "after"),
    h("span.cmp-tag.l", {}, c.before.label || t("cmp.before")),
    h("span.cmp-tag.r", {}, c.after.label || t("cmp.after")),
    handle,
  );
  pos(50);
  let dragging = null;
  const at = (e) => {
    const r = box.getBoundingClientRect();
    pos(((e.clientX - r.left) / r.width) * 100);
  };
  box.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".media-zoom")) return;
    e.preventDefault(); // no focus: the arrow keys keep answering the swipe card
    dragging = e.pointerId;
    box.setPointerCapture(e.pointerId);
    at(e);
  });
  box.addEventListener("pointermove", (e) => e.pointerId === dragging && at(e));
  const stop = (e) => e.pointerId === dragging && (dragging = null);
  box.addEventListener("pointerup", stop);
  box.addEventListener("pointercancel", stop);
  handle.addEventListener("keydown", (e) => {
    const d = { ArrowLeft: -5, ArrowRight: 5, Home: -100, End: 100 }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    pos(Number(handle.getAttribute("aria-valuenow")) + d);
  });
  return box;
}

// Short clips play muted on a loop while on screen; longer ones wait for the play button.
const SHORT_SEC = 20;
const watcher =
  typeof IntersectionObserver === "function" &&
  new IntersectionObserver((entries) => {
    for (const e of entries) {
      const v = e.target;
      if (!v.loop) continue;
      if (e.isIntersecting) v.play().catch(() => {});
      else v.pause();
    }
  });

function videos(list, ctx, qid) {
  return h(
    `div.videos.media-stop.n${Math.min(list.length, 2)}`,
    {},
    list.map((v) => {
      if (v.gif) {
        return h(
          "figure.shot",
          {},
          h("button.shot-btn", { type: "button", title: t("media.zoom"), onclick: (e) => (e.stopPropagation(), ctx.lightbox([{ src: v.src, caption: v.caption }], 0, qid)), html: `<img src="${attr(v.src)}" alt="${attr(v.caption)}" loading="lazy"><span class="zoom">${icon("expand")}</span>` }),
          v.caption && h("figcaption", {}, v.caption),
        );
      }
      const el = h("video", { src: v.src, controls: true, playsinline: true, preload: "metadata" });
      el.muted = true;
      el.addEventListener("loadedmetadata", () => {
        if (!(v.loop ?? el.duration <= SHORT_SEC)) return void (el.muted = false);
        el.loop = true;
        watcher ? watcher.observe(el) : el.play().catch(() => {});
      });
      return h("figure.video", {}, el, v.caption && h("figcaption", {}, v.caption));
    }),
  );
}

function chartView(c, small = false) {
  const legend = c.series.length > 1 && h("div.ch-legend", {}, c.series.map((s, k) => h("span.ch-key", {}, h(`i.s${k + 1}`), s.name)));
  return h("figure.chart.media-stop", {}, c.title && h("figcaption.ch-title", {}, c.title), legend, h("div.ch-plot", { html: chartSvg(c, small ? "small" : "full") }));
}

const NUM = /^[-+−]?[\d\s.,]*\d[\d\s.,]*\s*(%|[kKMB]|[$€₽£]|ms|s|x|×)?$/;

function tableView(tb) {
  const numeric = tb.columns.map((_, j) => tb.rows.every((r) => !r[j] || NUM.test(r[j])) && tb.rows.some((r) => r[j]));
  const cell = (tag, text, j) => h(`${tag}${numeric[j] ? ".num" : ""}`, { html: mdInline(text) });
  return h(
    "div.table-wrap.media-stop",
    {},
    h(
      "table.data",
      {},
      tb.caption && h("caption", {}, tb.caption),
      h("thead", {}, h("tr", {}, tb.columns.map((c, j) => cell("th", c, j)))),
      h("tbody", {}, tb.rows.map((r) => h("tr", {}, r.map((c, j) => cell("td", c, j))))),
    ),
  );
}

// Unchanged runs longer than this fold into a "N unchanged lines" row.
const FOLD = 8;
const KEEP = 3;

function diffView(d, ctx, { unified }) {
  const rows = lineDiff(d.before, d.after);
  const { added, removed } = diffStats(rows);
  const grid = h(`table.diff-grid${unified ? ".unified" : ""}`);
  const body = h("tbody");
  // Element.append writes a null as the text "null", so the parts are filtered.
  grid.append(
    ...[
      unified ? h("colgroup", {}, h("col.n"), h("col.sign"), h("col.t")) : h("colgroup", {}, h("col.n"), h("col.t"), h("col.n"), h("col.t")),
      !unified && (d.labels[0] || d.labels[1]) ? h("thead", {}, h("tr", {}, h("th", { colspan: "2" }, d.labels[0] || t("cmp.before")), h("th", { colspan: "2" }, d.labels[1] || t("cmp.after")))) : null,
      body,
    ].filter(Boolean),
  );
  const line = (r) => (unified ? unifiedRows(r) : [splitRow(r)]);
  for (let i = 0; i < rows.length; ) {
    let j = i;
    while (j < rows.length && rows[j].type === "same") j++;
    const run = j - i;
    if (run > FOLD) {
      const lead = i === 0 ? 0 : KEEP;
      const trail = j === rows.length ? 0 : KEEP;
      body.append(...rows.slice(i, i + lead).flatMap(line));
      const hidden = rows.slice(i + lead, j - trail);
      const fold = h("tr.fold", {}, h("td", { colspan: unified ? "3" : "4" }, h("button", { type: "button", onclick: () => fold.replaceWith(...hidden.flatMap(line)) }, t("diff.fold", hidden.length))));
      body.append(fold, ...rows.slice(j - trail, j).flatMap(line));
      i = j;
    } else if (run) {
      body.append(...rows.slice(i, j).flatMap(line));
      i = j;
    } else {
      body.append(...line(rows[i]));
      i += 1;
    }
  }
  const copy = h("button.copy", {
    type: "button",
    html: t("code.copy"),
    onclick: (e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(d.after).then(() => ctx?.toast(t("code.copied")));
    },
  });
  return h(
    "div.code.diffbox.media-stop",
    {},
    h("div.code-bar", {}, h("span", {}, d.lang || t("code.diff"), h("b.d-add", {}, ` +${added}`), h("b.d-del", {}, ` −${removed}`)), copy),
    h("div.diff-scroll", {}, grid),
  );
}

function splitRow(r) {
  const span = r.type === "mod" ? inlineSpan(r.left.text, r.right.text) : null;
  const side = (s, cls, parts) => [h(`td.n.${cls}`, {}, s ? String(s.n) : ""), h(`td.t.${cls}`, {}, s ? textCell(s.text, parts) : "")];
  const lc = r.type === "same" ? "same" : r.left ? "del" : "none";
  const rc = r.type === "same" ? "same" : r.right ? "add" : "none";
  return h("tr", {}, side(r.left, lc, span?.left), side(r.right, rc, span?.right));
}

function unifiedRows(r) {
  const span = r.type === "mod" ? inlineSpan(r.left.text, r.right.text) : null;
  const row = (cls, sign, n, text, parts) => h(`tr.${cls}`, {}, h("td.n", {}, String(n)), h("td.sign", {}, sign), h("td.t", {}, textCell(text, parts)));
  if (r.type === "same") return [row("same", " ", r.right.n, r.right.text)];
  return [r.left && row("del", "−", r.left.n, r.left.text, span?.left), r.right && row("add", "+", r.right.n, r.right.text, span?.right)].filter(Boolean);
}

const textCell = (text, parts) => (parts && parts[1] ? [parts[0], h("mark", {}, parts[1]), parts[2]] : text || " ");

function gallery(images, ctx, qid) {
  const box = h(`div.gallery.media-stop.n${Math.min(images.length, 3)}`);
  images.forEach((img, i) => {
    const open = (annotate) => (e) => {
      e.stopPropagation();
      ctx.lightbox(images, i, qid, { annotate });
    };
    box.append(
      h(
        "figure.shot",
        {},
        h("button.shot-btn", {
          type: "button",
          title: t("media.zoom"),
          "aria-label": img.caption || t("media.image"),
          onclick: open(false),
          html: `<img src="${attr(img.src)}" alt="${attr(img.caption)}" loading="lazy" decoding="async"><span class="zoom">${icon("expand")}</span>`,
        }),
        sameOrigin(img.src) &&
          h("button.shot-mark", { type: "button", title: t("media.markTitle"), html: `${icon("pen")}${t("lb.mark")}`, onclick: open(true) }),
        img.caption && h("figcaption", {}, img.caption),
      ),
    );
  });
  return box;
}

export const sameOrigin = (src) => /^(\/(?!\/)|blob:|data:)/.test(src) || String(src).startsWith(location.origin);

// fit: a side tile is narrower than any phone, so the page is laid out at phone
// width and scaled down to the tile instead of reflowing into a column of words.
const FIT_WIDTH = 390;

function preview(p, height, fit = false) {
  const frame = h("iframe", {
    src: p.src,
    sandbox: "allow-scripts allow-popups",
    loading: "lazy",
    title: t("preview.title"),
    referrerpolicy: "no-referrer",
  });
  const px = Math.max(160, Math.min(height, 900));
  frame.style.height = `${px}px`;
  const box = h(
    "div.preview.media-stop",
    {},
    h(
      "div.preview-bar",
      {},
      h("span.dots3", {}, h("i"), h("i"), h("i")),
      h("span", {}, t("preview.live")),
      h("a.preview-open", { href: p.src, target: "_blank", rel: "noopener", html: `${t("preview.open")}${icon("expand")}` }),
    ),
    frame,
  );
  if (fit) {
    new ResizeObserver(([e]) => {
      const w = e.contentRect.width;
      if (!w) return;
      const z = Math.min(1, w / FIT_WIDTH);
      frame.style.zoom = z;
      frame.style.width = `${w / z}px`;
      frame.style.height = `${px / z}px`;
    }).observe(box);
  }
  return box;
}

function diagram(src, ctx, qid) {
  const box = h("div.diagram.media-stop", {}, h("div.diagram-wait", {}, t("diagram.wait")));
  const id = `mmd-${++mermaidSeq}`;
  loadMermaid()
    .then((m) => m.render(id, src))
    .then(({ svg }) => {
      box.innerHTML = svg;
      fitDiagram(box.querySelector("svg"));
      const zoom = () => ctx.lightbox([{ src: svgUrl(box.querySelector("svg")), caption: t("diagram.caption") }], 0, qid);
      box.classList.add("zoomable");
      box.title = t("media.zoom");
      box.addEventListener("click", zoom);
      box.append(h("span.zoom", { html: icon("expand") }));
    })
    .catch(() => box.replaceChildren(codeBlock({ text: src, lang: "mermaid", diff: false })));
  return box;
}

// Mermaid sometimes sizes the viewBox before its nodes are placed (seen on a busy
// machine), which cuts the drawing off. Once the SVG is on the page, fit the viewBox
// to what was actually drawn.
function fitDiagram(svg, tries = 60) {
  if (!svg.isConnected) return void (tries && requestAnimationFrame(() => fitDiagram(svg, tries - 1)));
  const b = svg.getBBox();
  if (!b.width) return;
  const pad = 8;
  svg.setAttribute("viewBox", `${b.x - pad} ${b.y - pad} ${b.width + 2 * pad} ${b.height + 2 * pad}`);
  svg.style.maxWidth = `${Math.ceil(b.width + 2 * pad)}px`;
}

// A standalone copy of the rendered diagram, sized large enough to fill the lightbox.
function svgUrl(svg) {
  const copy = svg.cloneNode(true);
  const vb = svg.viewBox.baseVal;
  const scale = vb?.width ? Math.max(1, 1600 / vb.width) : 1;
  copy.removeAttribute("style");
  if (vb?.width) {
    copy.setAttribute("width", String(Math.round(vb.width * scale)));
    copy.setAttribute("height", String(Math.round(vb.height * scale)));
  }
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const bg = getComputedStyle(document.body).backgroundColor;
  copy.insertAdjacentHTML("afterbegin", `<rect x="${vb?.x || 0}" y="${vb?.y || 0}" width="100%" height="100%" fill="${bg}"/>`);
  return URL.createObjectURL(new Blob([copy.outerHTML], { type: "image/svg+xml" }));
}

function loadMermaid() {
  const theme = document.documentElement.dataset.theme;
  const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  mermaidLoad ||= Promise.race([
    import(MERMAID).then((m) => {
      // SVG-only labels: the diagram then also works as an <img> (lightbox) and on a canvas (marks).
      m.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: dark ? "dark" : "neutral",
        fontFamily: "system-ui, sans-serif",
        htmlLabels: false,
        flowchart: { htmlLabels: false },
      });
      return m.default;
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("mermaid timeout")), 7000)),
  ]);
  return mermaidLoad;
}

export function codeBlock(code, ctx) {
  const lines = code.text.split("\n").map((line) => {
    let cls = "";
    if (code.diff && /^\+(?!\+\+)/.test(line)) cls = "add";
    else if (code.diff && /^-(?!--)/.test(line)) cls = "del";
    else if (code.diff && line.startsWith("@@")) cls = "hunk";
    return h(`span.ln${cls ? `.${cls}` : ""}`, {}, line || " ");
  });
  const copy = h("button.copy", {
    type: "button",
    html: t("code.copy"),
    onclick: (e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(code.text).then(() => ctx?.toast(t("code.copied")));
    },
  });
  return h(
    "div.code.media-stop",
    {},
    h("div.code-bar", {}, h("span", {}, code.diff ? t("code.diff") : code.lang || t("code.code")), copy),
    h("pre", {}, h("code", {}, lines)),
  );
}

function links(list) {
  return h(
    "div.links",
    {},
    list.map((l) => h("a.link-chip", { href: l.url, target: "_blank", rel: "noopener noreferrer", html: `${icon("link")}${esc(l.label)}` })),
  );
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const attr = esc;
