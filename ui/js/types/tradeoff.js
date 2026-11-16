// tradeoff — a slider between two poles. Engine side: lib/registry/types/tradeoff.mjs.
// The answer is { value: 0..100 }.

import { h, icon } from "../dom.js";
import { joinParts, ownPart } from "./shared.js";

const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));

export const emptyAnswer = () => ({});
export const isAnswered = (q, a) => Number.isFinite(a.value);
export const compact = (q, a) => (Number.isFinite(a.value) ? { value: clamp(a.value) } : {});
export const check = (q, raw) => (Number.isFinite(raw.value) ? { value: clamp(raw.value) } : {});
export const recommend = (q, a) => (q.recommendedAt != null ? { ...a, value: q.recommendedAt } : a);
export const badge = (q, t) => t("badge.tradeoff");

// "70/100 toward more careful" — the nearer pole, or "in the middle".
export function describe(q, r, w) {
  let value = "";
  if (Number.isFinite(r.value)) {
    const v = clamp(r.value);
    const side = v === 50 ? "in the middle" : `toward ${q.poles[v > 50 ? 1 : 0]}`;
    value = `${v}/100 (${q.poles[0]} ↔ ${q.poles[1]}), ${side}`;
  }
  return joinParts(ownPart(r, w), value);
}

export function sync(card, q, a) {
  const root = card.querySelector(".tradeoff");
  if (!root) return;
  const set = Number.isFinite(a.value);
  const input = root.querySelector("input");
  input.value = String(set ? clamp(a.value) : (q.recommendedAt ?? 50));
  root.classList.toggle("untouched", !set);
  root.style.setProperty("--v", `${set ? clamp(a.value) : (q.recommendedAt ?? 50)}%`);
  root.querySelector(".to-value").textContent = set ? `${clamp(a.value)}` : "";
}

export function render(q, ctx) {
  const { t } = ctx;
  const take = (e) => ctx.set(q.id, { value: clamp(Number(e.currentTarget.value)), flag: null });
  const input = h("input.to-range", { type: "range", min: "0", max: "100", step: "1", "aria-label": q.title, "aria-valuetext": `${q.poles[0]} ↔ ${q.poles[1]}`, oninput: take, onchange: take, onclick: take });
  const rec = q.recommendedAt != null && h("span.to-rec", { style: `left:${q.recommendedAt}%`, title: t("tradeoff.rec"), html: icon("star") });
  return h(
    "div.tradeoff.untouched",
    {},
    h("div.to-poles", {}, h("span.to-pole", {}, q.poles[0]), h("span.to-value", {}), h("span.to-pole", {}, q.poles[1])),
    h("div.to-track", {}, rec, input),
    q.recommendedAt != null && h("p.to-note", {}, t("tradeoff.recAt", q.recommendedAt)),
  );
}
