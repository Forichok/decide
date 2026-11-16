// html — a snippet in a sandboxed frame, as tall as its content. The block is a document of its own
// at x.src, which reports its height; an exported file has no server, so it keeps srcdoc.

import { h } from "../dom.js";

// The frames on the page, kept to resize them; the observer and the listeners are made with the first block.
const sizedFrames = new Set();
let listening = false;
let frameSizes = null;
let darkNow = () => false;

// The theme toggle and the system setting both reach frames that are already open.
const retheme = () => {
  const scheme = darkNow() ? "dark" : "light";
  for (const f of sizedFrames) f.contentWindow?.postMessage({ decideScheme: scheme }, "*");
};

export function render(node, ctx, env) {
  const x = node.html;
  if (!x) return null;
  return env.compact ? env.zoom("html", htmlBlock(x, env, 200)) : htmlBlock(x, env);
}

function htmlBlock(x, { t, offline, dark }, cap) {
  darkNow = dark;
  const frame = h("iframe.html-frame", { sandbox: "allow-scripts allow-popups", title: t("html.title"), referrerpolicy: "no-referrer" });
  // The block is a document of its own at x.src (served under the sandbox policy: the page's CSP would block a
  // srcdoc's inline script, and a same-origin frame would be the page). An exported file has no server: it keeps
  // srcdoc, and there is no CSP to meet.
  if (offline || !x.src) frame.srcdoc = htmlDoc(x.source, dark);
  else {
    frame.src = x.src;
    frame.addEventListener("load", () => frame.contentWindow?.postMessage({ decideScheme: dark() ? "dark" : "light" }, "*"));
  }
  frame.style.height = "60px";
  frame.dataset.max = String(cap || x.maxHeight);
  sizedFrames.add(frame);
  frameSizes ??= new ResizeObserver((entries) => {
    for (const { target } of entries) if (target.offsetWidth) target.contentWindow?.postMessage({ decideMeasure: true }, "*");
  });
  // A frame laid out while hidden reports 0 and may never report again: ask it to measure once it has a size.
  frameSizes.observe(frame);
  if (!listening) {
    listening = true;
    new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", retheme);
    window.addEventListener("message", (e) => {
      if (!Number.isFinite(e.data?.decideHeight)) return;
      for (const f of sizedFrames) {
        if (!f.isConnected && f.dataset.seen) sizedFrames.delete(f), frameSizes.unobserve(f);
        else if (f.contentWindow === e.source) {
          f.dataset.seen = "1";
          f.style.height = `${Math.max(24, Math.min(Math.ceil(e.data.decideHeight), Number(f.dataset.max)))}px`;
        }
      }
    });
  }
  return h("div.html-block.media-stop", {}, frame);
}

function htmlDoc(source, dark) {
  const scheme = dark() ? "dark" : "light";
  // The body's own box, not scrollHeight: scrollHeight never drops below the frame, so a frame could only grow.
  const report = `(()=>{const b=document.body,s=()=>parent.postMessage({decideHeight:Math.ceil(b.getBoundingClientRect().height)+2},"*");new ResizeObserver(s).observe(b);addEventListener("load",s);addEventListener("message",e=>{if(e.source!==parent||!e.data)return;if(e.data.decideScheme)document.documentElement.style.colorScheme=e.data.decideScheme;if(e.data.decideMeasure)s()});s()})()`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><base target="_blank"><style>:root{color-scheme:${scheme}}html,body{margin:0;background:transparent}body{font:14.5px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:1px}</style></head><body>${source}<script>${report}</script></body></html>`;
}
