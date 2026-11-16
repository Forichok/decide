// text — a free answer. Engine side: lib/registry/types/text.mjs.

import { h } from "../dom.js";
import { defaultSelected, joinParts, ownPart, recommendChoice } from "./shared.js";

// A default naming options still preselects them, as it always did (a showIf may read it).
export const emptyAnswer = (q) => ({ selected: defaultSelected(q) });
export const isAnswered = (q, a) => a.text.trim().length > 0;
export const compact = (q, a) => (a.text.trim() ? { text: a.text.trim() } : {});
export const check = (q, raw, { str }) => (str(raw.text) ? { text: str(raw.text) } : {});
export const recommend = recommendChoice(true);
export const describe = (q, r, w) => joinParts(ownPart(r, w), r.text ? `"${r.text}"` : "");
export function sync() {}

export function autosize(ta) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight + 2, 480)}px`;
}

export function render(q, ctx) {
  const ta = h("textarea.answer-text", {
    rows: "3",
    placeholder: q.placeholder || ctx.t("text.placeholder"),
    "aria-label": q.title,
    oninput: (e) => {
      autosize(e.target);
      ctx.set(q.id, { text: e.target.value, flag: null }, { quiet: true });
    },
  });
  ta.value = ctx.answers[q.id].text;
  requestAnimationFrame(() => autosize(ta));
  return ta;
}
