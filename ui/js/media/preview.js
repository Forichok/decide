// preview — a live mockup in a sandboxed frame: widths to try, notes pinned on the page. A mockup
// that lives on the web (https://…) cannot be framed by this page, so it is a link to a new tab.

import { h, icon } from "../dom.js";
import { FIT_WIDTH, fitFrames, frameOf, isRemote, previewBar, remoteLinks, widthSwitch } from "./shared.js";

export function render(node, ctx, env) {
  const p = node.preview;
  if (!p) return null;
  const { compact, qid, t } = env;
  if (isRemote(p.src)) return remoteLinks([{ src: p.src, text: (host) => t("preview.remote", host) }]);
  // Pins with notes on a mockup belong to the question, like a note does (not in a swipe deck).
  const pinsOf = (src) => (ctx.pins && !compact ? ctx.pins(qid, src) : null);
  return compact ? env.zoom("preview", preview(p, 200, env, { fit: true })) : preview(p, node.previewHeight, env, { pins: pinsOf(p.src) });
}

// pins: {list, add, remove} for notes pinned on top of the mockup, or null.
function preview(p, height, { t }, { fit = false, pins = null } = {}) {
  const px = Math.max(160, Math.min(height, 900));
  const frame = frameOf(p.src, t);
  const wrap = h("div.pv-frame", {}, frame);
  let want = fit ? FIT_WIDTH : null;
  const box = h("div.preview.media-stop");
  const layout = () => fitFrames(box, [wrap], [frame], px, want);
  const extra = fit ? [] : [widthSwitch((w) => ((want = w), layout()), t)];
  if (pins) extra.push(pinLayer(wrap, pins, () => want, t));
  box.append(previewBar(p, extra, t), wrap);
  if (pins) box.append(pins.listEl);
  frame.style.height = `${px}px`;
  new ResizeObserver(layout).observe(box);
  return box;
}

// Notes pinned on a mockup: the toggle turns clicks on the frame into pins; each pin asks for its note.
function pinLayer(wrap, pins, widthNow, t) {
  const layer = h("div.pv-pins");
  wrap.append(layer);
  let on = false;
  const toggle = h("button.pv-mark", {
    type: "button",
    "aria-pressed": "false",
    title: t("pins.title"),
    html: `${icon("pen")}${t("pins.button")}`,
    onclick: (e) => {
      e.stopPropagation();
      on = !on;
      toggle.setAttribute("aria-pressed", String(on));
      layer.classList.toggle("on", on);
    },
  });
  const paint = () => {
    const list = pins.list();
    layer.replaceChildren(
      ...list.map((pin, i) => h("span.pv-pin", { style: `left:${pin.x}%;top:${pin.y}%`, title: pin.text }, String(i + 1))),
    );
    pins.listEl.replaceChildren(
      ...list.map((pin, i) =>
        h(
          "li",
          {},
          h("b", {}, `${i + 1}`),
          h("span", {}, pin.text),
          pin.width && h("span.pv-at", {}, `${pin.width}px`),
          h("button.pv-del", { type: "button", "aria-label": t("pins.remove"), html: icon("x"), onclick: () => (pins.remove(pin), paint()) }),
        ),
      ),
    );
    pins.listEl.hidden = !list.length;
  };
  layer.addEventListener("click", (e) => {
    if (!on || e.target !== layer) return;
    const r = layer.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * 1000) / 10;
    const y = Math.round(((e.clientY - r.top) / r.height) * 1000) / 10;
    const input = h("input.pv-note", { type: "text", maxlength: 400, placeholder: t("pins.placeholder"), "aria-label": t("pins.placeholder") });
    const bubble = h("span.pv-bubble", { style: `left:${x}%;top:${y}%` }, input);
    layer.append(bubble);
    input.focus();
    let done = false;
    const close = (save) => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      if (save && text) pins.add({ x, y, width: widthNow(), text });
      paint();
    };
    input.addEventListener("keydown", (k) => {
      k.stopPropagation();
      if (k.key === "Enter") close(true);
      else if (k.key === "Escape") close(false);
    });
    input.addEventListener("blur", () => close(true));
  });
  paint();
  return toggle;
}
