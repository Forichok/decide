// compare — before/after: a slider over two pictures, or over two live mockups.

import { h, icon } from "../dom.js";
import { FIT_WIDTH, fitFrames, frameOf, isRemote, previewBar, remoteLinks, widthSwitch } from "./shared.js";

export function render(node, ctx, env) {
  const c = node.compare;
  if (!c) return null;
  const { compact, t } = env;
  // Two live mockups need frames; a page on the web cannot be framed, so that side is a link. With one
  // remote side the other keeps its frame (there is no divider to drag over a link).
  if (c.live && [c.before, c.after].some((a) => isRemote(a.src))) return env.zoom("compare", compareMixed(c, compact ? 200 : node.previewHeight, env, { fit: compact }));
  return env.zoom("compare", c.live ? compareLive(c, compact ? 200 : node.previewHeight, env, { fit: compact }) : compareView(c, t));
}

// One side framed, the other a link: each side is shown on its own.
function compareMixed(c, height, { t }, { fit = false } = {}) {
  const px = Math.max(160, Math.min(height, 900));
  const sides = [
    [c.before, t("cmp.before")],
    [c.after, t("cmp.after")],
  ];
  const frames = [];
  const wraps = [];
  const parts = sides.map(([a, word]) => {
    const label = a.label || word;
    if (isRemote(a.src)) return remoteLinks([{ src: a.src, text: (host) => t("cmp.remote", label, host) }]);
    const frame = frameOf(a.src, t);
    const wrap = h("div.pv-frame", {}, frame);
    frames.push(frame);
    wraps.push(wrap);
    return h("div.cmp-side", {}, h("span.cmp-tag", {}, label), wrap);
  });
  const box = h("div.preview.cmp-mixed.media-stop", {}, ...(frames.length ? [previewBar(null, [], t)] : []), ...parts);
  const layout = () => fitFrames(box, wraps, frames, px, fit ? FIT_WIDTH : null);
  new ResizeObserver(layout).observe(box);
  return box;
}

// Before/after: drag the divider (or focus it and use ← →); the left part shows before.
function compareView(c, t) {
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
  slider(box, handle, box);
  return box;
}

// Two live mockups behind one divider: the left part shows before. Only the divider drags, so
// both pages stay clickable.
function compareLive(c, height, { t }, { fit = false } = {}) {
  const px = Math.max(160, Math.min(height, 900));
  const before = frameOf(c.before.src, t);
  const after = frameOf(c.after.src, t);
  const handle = h("div.cmp-handle", { role: "slider", tabindex: "0", "aria-label": t("cmp.slider"), "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "50" }, h("span.cmp-knob", { html: `${icon("left")}${icon("right")}` }));
  const stage = h(
    "div.compare.live",
    {},
    h("div.cmp-frame.before", {}, before),
    h("div.cmp-frame.after", {}, after),
    h("span.cmp-tag.l", {}, c.before.label || t("cmp.before")),
    h("span.cmp-tag.r", {}, c.after.label || t("cmp.after")),
    handle,
  );
  let want = fit ? FIT_WIDTH : null;
  const box = h("div.preview.cmp-live.media-stop", {}, previewBar(null, fit ? [] : [widthSwitch((w) => ((want = w), layout()), t)], t), stage);
  const layout = () => fitFrames(box, [stage], [before, after], px, want);
  new ResizeObserver(layout).observe(box);
  slider(stage, handle, handle);
  return box;
}

// Drag (on grab) or the arrow keys (on the focused handle) move the divider.
function slider(box, handle, grab) {
  const pos = (v) => {
    const p = Math.max(0, Math.min(100, v));
    box.style.setProperty("--pos", `${p}%`);
    handle.setAttribute("aria-valuenow", String(Math.round(p)));
  };
  pos(50);
  let dragging = null;
  const at = (e) => {
    const r = box.getBoundingClientRect();
    pos(((e.clientX - r.left) / r.width) * 100);
  };
  grab.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".media-zoom")) return;
    e.preventDefault(); // no focus: the arrow keys keep answering the swipe card
    dragging = e.pointerId;
    grab.setPointerCapture(e.pointerId);
    box.classList.add("sliding");
    at(e);
  });
  grab.addEventListener("pointermove", (e) => e.pointerId === dragging && at(e));
  const stop = (e) => {
    if (e.pointerId !== dragging) return;
    dragging = null;
    box.classList.remove("sliding");
  };
  grab.addEventListener("pointerup", stop);
  grab.addEventListener("pointercancel", stop);
  handle.addEventListener("keydown", (e) => {
    const d = { ArrowLeft: -5, ArrowRight: 5, Home: -100, End: 100 }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    pos(Number(handle.getAttribute("aria-valuenow")) + d);
  });
}
