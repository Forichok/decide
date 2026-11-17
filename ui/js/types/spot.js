// spot — mark points or areas on a picture. Engine side: lib/registry/types/spot.mjs.
// The answer is { points: [{ x, y, w, h, text }] } in percent of the picture; a point has w and h of 0.

import { h, icon } from "../dom.js";
import { joinParts, ownPart } from "./shared.js";

const pct = (v) => Math.round(Math.max(0, Math.min(100, v)) * 10) / 10;

// A mark that fits the picture: x, y inside it, w and h not past its edge.
export function tidy(raw, max = 20) {
  const out = [];
  for (const p of Array.isArray(raw) ? raw : []) {
    if (!p || typeof p !== "object" || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const x = pct(p.x);
    const y = pct(p.y);
    const w = Number.isFinite(p.w) ? Math.min(pct(p.w), pct(100 - x)) : 0;
    const hh = Number.isFinite(p.h) ? Math.min(pct(p.h), pct(100 - y)) : 0;
    out.push({ x, y, w, h: hh, text: typeof p.text === "string" ? p.text.trim().slice(0, 2000) : "" });
    if (out.length >= max) break;
  }
  return out;
}

export const emptyAnswer = () => ({ points: [] });
export const isAnswered = (q, a) => Array.isArray(a.points) && a.points.length > 0;
export const compact = (q, a) => (a.points?.length ? { points: tidy(a.points, q.maxSpots) } : {});
export const check = (q, raw) => (Array.isArray(raw.points) ? { points: tidy(raw.points, q.maxSpots) } : {});
export const badge = (q, t) => t("badge.spot");

const where = (p) => (p.w || p.h ? `area ${p.x},${p.y} ${p.w}x${p.h}%` : `point ${p.x},${p.y}%`);
export function describe(q, r, w) {
  const own = ownPart(r, w);
  if (!r.points?.length) return own;
  return joinParts(own, `${r.points.length} marked: ${r.points.map((p) => `${where(p)}${p.text ? ` "${p.text}"` : ""}`).join("; ")}`);
}

export function sync(card, q, a) {
  const root = card.querySelector(".spot");
  if (root) root._paint?.(a);
}

export function render(q, ctx) {
  const { t } = ctx;
  const img = q.images[0];
  const pic = h("img.sp-img", { src: img?.src || "", alt: img?.caption || q.title, draggable: "false" });
  const layer = h("div.sp-layer", { "aria-label": t("spot.layer") });
  const frame = h("div.sp-frame", {}, pic, layer);
  const list = h("ol.sp-list", {});
  const draw = h("div.sp-draw");
  let start = null;
  const at = (e) => {
    const r = frame.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
  };
  const mutate = (fn) => ctx.set(q.id, { points: fn([...(ctx.answers[q.id].points || [])]), flag: null });
  layer.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    layer.setPointerCapture(e.pointerId);
    start = at(e);
    frame.append(draw);
    Object.assign(draw.style, { left: `${start.x}%`, top: `${start.y}%`, width: "0", height: "0" });
  });
  layer.addEventListener("pointermove", (e) => {
    if (!start) return;
    const p = at(e);
    Object.assign(draw.style, { left: `${Math.min(start.x, p.x)}%`, top: `${Math.min(start.y, p.y)}%`, width: `${Math.abs(p.x - start.x)}%`, height: `${Math.abs(p.y - start.y)}%` });
  });
  layer.addEventListener("pointerup", (e) => {
    if (!start) return;
    const p = at(e);
    const s = start;
    start = null;
    draw.remove();
    const dx = Math.abs(p.x - s.x);
    const dy = Math.abs(p.y - s.y);
    const area = dx > 1.5 || dy > 1.5;
    const mark = area ? { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: dx, h: dy, text: "" } : { x: s.x, y: s.y, w: 0, h: 0, text: "" };
    if ((ctx.answers[q.id].points || []).length >= q.maxSpots) return;
    mutate((pts) => [...pts, ...tidy([mark])]);
    // The note of the new mark takes focus.
    requestAnimationFrame(() => list.lastElementChild?.querySelector("input")?.focus());
  });
  const root = h("div.spot", {}, frame, h("p.sp-hint", {}, t("spot.hint")), list);
  root._paint = (a) => {
    const pts = a.points || [];
    // Marks are repainted each time; the list only when its length changed, so typing keeps its focus.
    layer.replaceChildren(
      ...pts.map((p, i) =>
        h("span.sp-mark", { class: p.w || p.h ? "area" : "", style: `left:${p.x}%;top:${p.y}%;${p.w || p.h ? `width:${p.w}%;height:${p.h}%` : ""}` }, h("b", {}, String(i + 1))),
      ),
    );
    if (Number(list.dataset.n) === pts.length && list.childElementCount === pts.length) return;
    list.dataset.n = String(pts.length);
    list.replaceChildren(
      ...pts.map((p, i) =>
        h(
          "li.sp-item",
          {},
          h("span.sp-n", {}, String(i + 1)),
          h("input.sp-text", {
            type: "text",
            value: p.text,
            placeholder: t("spot.text"),
            "aria-label": t("spot.textFor", i + 1),
            oninput: (e) => {
              const text = e.currentTarget.value;
              mutate((all) => all.map((x, j) => (j === i ? { ...x, text } : x)));
            },
          }),
          h("button.icon-btn", { type: "button", title: t("spot.remove"), "aria-label": t("spot.remove"), html: icon("x"), onclick: () => mutate((all) => all.filter((_, j) => j !== i)) }),
        ),
      ),
    );
  };
  return root;
}
