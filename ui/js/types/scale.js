// scale — a number on a short scale. Engine side: lib/registry/types/scale.mjs.

import { h } from "../dom.js";
import { defaultSelected, joinParts, ownPart, recommendChoice } from "./shared.js";

// A default naming options still preselects them, as it always did (a showIf may read it).
export const emptyAnswer = (q) => ({ selected: defaultSelected(q) });
export const isAnswered = (q, a) => Number.isFinite(a.value);
export const compact = (q, a) => (Number.isFinite(a.value) ? { value: a.value } : {});
export const check = (q, raw) => (Number.isFinite(raw.value) ? { value: Math.max(q.scale?.min ?? -Infinity, Math.min(q.scale?.max ?? Infinity, raw.value)) } : {});
export const recommend = recommendChoice(true);
export function describe(q, r, w) {
  let value = "";
  if (r.value != null) {
    const hint = q.scale?.labels?.[r.value];
    value = `${r.value}/${q.scale?.max ?? ""}${hint ? ` "${hint}"` : ""}`;
  }
  return joinParts(ownPart(r, w), value);
}

// Picking the same step again takes it back.
function pickStep(q, v, ctx) {
  const a = ctx.answers[q.id];
  ctx.set(q.id, { value: a.value === v ? null : v, flag: a.flag === "explain" ? "explain" : null });
}

// The number keys pick the n-th step from the left.
export const keys = {
  pick(q, n, ctx) {
    const v = q.scale.min + n - 1;
    if (v <= q.scale.max) pickStep(q, v, ctx);
  },
};

export function sync(card, q, a) {
  for (const el of card.querySelectorAll(".seg")) {
    const on = Number(el.dataset.v) === a.value;
    el.classList.toggle("sel", on);
    el.setAttribute("aria-checked", String(on));
  }
}

export function render(q, ctx) {
  const { min, max, labels } = q.scale;
  const segs = [];
  for (let v = min; v <= max; v += 1) {
    segs.push(
      h(
        "button.seg",
        { type: "button", role: "radio", "aria-checked": "false", dataset: { v: String(v) }, onclick: () => pickStep(q, v, ctx) },
        h("span.seg-n", {}, String(v)),
        labels[v] && h("span.seg-l", {}, labels[v]),
      ),
    );
  }
  return h("div.scale", { role: "radiogroup", "aria-label": q.title, style: `--n:${segs.length}` }, segs);
}
