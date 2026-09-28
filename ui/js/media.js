// media.js — visuals attached to a question or an option: image gallery,
// sandboxed HTML mockup, code/diff block, mermaid diagram, links.

import { h, icon } from "./dom.js";
import { t } from "./i18n.js";

const MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
let mermaidLoad = null;
let mermaidSeq = 0;

// qid: the question these visuals belong to — marks drawn on a picture attach there.
export function renderMedia(node, ctx, qid) {
  const parts = [
    node.images?.length && gallery(node.images, ctx, qid),
    node.preview && preview(node.preview, node.previewHeight),
    node.mermaid && diagram(node.mermaid, ctx, qid),
    node.code && codeBlock(node.code, ctx),
    node.links?.length && links(node.links),
  ].filter(Boolean);
  return parts.length ? h("div.media", {}, parts) : null;
}

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

function preview(p, height) {
  const frame = h("iframe", {
    src: p.src,
    sandbox: "allow-scripts allow-popups",
    loading: "lazy",
    title: t("preview.title"),
    referrerpolicy: "no-referrer",
  });
  frame.style.height = `${Math.max(160, Math.min(height, 900))}px`;
  return h(
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
