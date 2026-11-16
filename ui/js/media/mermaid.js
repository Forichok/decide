// mermaid — a diagram drawn by Mermaid, loaded from a CDN; without it (offline, or the page's
// policy blocking the import) the source is shown as code.

import { h, icon } from "../dom.js";
import { codeBlock } from "./code.js";

const MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
let mermaidLoad = null;
let mermaidSeq = 0;

export function render(node, ctx, env) {
  return node.mermaid ? diagram(node.mermaid, ctx, env) : null;
}

function diagram(src, ctx, { t, qid }) {
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
    .catch(() => box.replaceChildren(codeBlock({ text: src, lang: "mermaid", diff: false }, ctx, t)));
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
