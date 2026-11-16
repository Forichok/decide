// mermaid — a diagram drawn by the Mermaid that ships in ui/vendor/. It runs in a frame of its own
// (mermaid-frame.html: an opaque origin and a policy of its own), because Mermaid writes <style> elements
// into its drawing and the page's policy does not allow that. The page sends the source and takes back a
// height and the drawing as SVG text; it believes nothing else a frame says. An exported file has no
// server: it builds the same frame as srcdoc from the copy inside the file. Without a drawing the source
// shows as code.

import { h, icon } from "../dom.js";
import { codeBlock } from "./code.js";

const FRAME = "/ui/vendor/mermaid-frame.html";
const TIMEOUT_MS = 10_000;
const MAX_SVG = 3_000_000;
const MAX_HEIGHT = 4000;

// The diagrams on the page by their frame; one listener serves them all.
const diagrams = new Set();
let listening = false;

export function render(node, ctx, env) {
  return node.mermaid ? diagram(node.mermaid, ctx, env) : null;
}

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (e) => {
    const m = e.data?.decideMermaid;
    if (!m || typeof m !== "object") return;
    for (const d of diagrams) {
      if (!d.frame.isConnected && d.settled) diagrams.delete(d);
      else if (d.frame.contentWindow === e.source) d.onMessage(m);
    }
  });
}

// The frame's document inside an exported file: the whole of it, with the bundle as a data: URI, so nothing is fetched.
function exportedFrame() {
  try {
    const frame = JSON.parse(document.getElementById("decide-mermaid")?.textContent || "null")?.frame;
    return typeof frame === "string" ? frame : null;
  } catch {
    return null;
  }
}

function diagram(src, ctx, { t, qid, dark, offline }) {
  listen();
  const box = h("div.diagram.media-stop", {}, h("div.diagram-wait", {}, t("diagram.wait")));
  const srcdoc = offline ? exportedFrame() : null;
  if (offline && !srcdoc) {
    box.replaceChildren(codeBlock({ text: src, lang: "mermaid", diff: false }, ctx, t));
    return box;
  }
  // allow-scripts only: no allow-same-origin, so the frame is never the page or the server.
  const frame = h("iframe.diagram-frame", { sandbox: "allow-scripts", title: t("diagram.caption"), referrerpolicy: "no-referrer" });
  // Not display:none, which would give the frame no layout to measure; it shows once the drawing has a size.
  frame.style.visibility = "hidden";
  frame.style.height = "24px";
  const entry = { frame, settled: false, onMessage: null };
  const fail = () => {
    entry.settled = true;
    entry.failed = true;
    diagrams.delete(entry);
    box.replaceChildren(codeBlock({ text: src, lang: "mermaid", diff: false }, ctx, t));
  };
  const timer = setTimeout(fail, TIMEOUT_MS);
  entry.onMessage = (m) => {
    // The height may change after the drawing (a narrower page), so it is taken for as long as the frame lives.
    if (Number.isFinite(m.height) && !entry.failed) {
      if (m.height > 0) frame.style.visibility = "";
      frame.style.height = `${Math.max(24, Math.min(Math.ceil(m.height), MAX_HEIGHT))}px`;
      return;
    }
    if (entry.settled) return;
    if (m.ready === true) {
      frame.contentWindow.postMessage({ decideMermaid: { source: src, dark: dark(), bg: getComputedStyle(document.body).backgroundColor } }, "*");
    } else if (typeof m.error === "string") {
      clearTimeout(timer);
      fail();
    } else if (m.done && typeof m.done.svg === "string" && m.done.svg.length <= MAX_SVG && /^<svg[\s>]/.test(m.done.svg)) {
      clearTimeout(timer);
      entry.settled = true;
      zoomable(box, m.done.svg, ctx, t, qid);
    }
  };
  diagrams.add(entry);
  if (srcdoc) frame.srcdoc = srcdoc;
  else frame.src = FRAME;
  box.replaceChildren(h("div.diagram-wait", {}, t("diagram.wait")), frame);
  return box;
}

// Clicking the drawing opens it large. The frame cannot pass a click out, so a button covers it. The SVG text
// goes into a Blob shown by <img>, where a script in it would not run.
function zoomable(box, svg, ctx, t, qid) {
  box.querySelector(".diagram-wait")?.remove();
  const open = () => ctx.lightbox([{ src: URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })), caption: t("diagram.caption"), noOriginal: true }], 0, qid);
  box.classList.add("zoomable");
  box.append(h("button.diagram-hit", { type: "button", title: t("media.zoom"), "aria-label": t("media.zoom"), onClick: open }), h("span.zoom", { html: icon("expand") }));
}
