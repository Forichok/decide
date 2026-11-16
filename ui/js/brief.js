// brief.js — what the swipe brief and the task panel of a questions round share: the kinds of a brief
// point, and the grouped list that draws them. The panel of a round is `taskPanel`; the swipe deck's own
// column (swipe/brief.js) builds on `briefGroups`.

import { h, icon } from "./dom.js";
import { t } from "./i18n.js";
import { md } from "./md.js";

export const KINDS = ["decision", "risk", "problem", "open", "note"];
export const KIND_ICON = { decision: "check", risk: "alert", problem: "x", open: "help", note: "note" };

// The brief's points as one section per kind. `seen` is a Set of keys already shown: a point not in it
// is marked new (once `markNew` is true).
export function briefGroups(items, glossary, { seen = new Set(), markNew = false } = {}) {
  return KINDS.map((kind) => {
    const list = items.filter((b) => b.kind === kind);
    if (!list.length) return null;
    return h(
      `section.sw-group.k-${kind}`,
      {},
      h("h3.sw-group-h", { html: `${icon(KIND_ICON[kind])}${t(`sw.kind.${kind}`)}<span class="n">${list.length}</span>` }),
      h(
        "ul",
        {},
        list.map((b) => {
          const key = `${kind}:${b.text}`;
          const isNew = markNew && !seen.has(key);
          seen.add(key);
          return h(`li.sw-item${isNew ? ".new" : ""}`, { html: md(b.text, glossary) });
        }),
      ),
    );
  }).filter(Boolean);
}

// The side panel of a questions round: what the task is, what is decided, checked and open.
// paint(openTitles): the spec's own points, plus the titles of the questions still unanswered.
export function taskPanel(spec) {
  const body = h("div.q-brief-body");
  const toggle = h("button.q-brief-toggle", {
    type: "button",
    "aria-expanded": "true",
    onclick: () => {
      const folded = el.classList.toggle("folded");
      toggle.setAttribute("aria-expanded", String(!folded));
    },
  });
  const el = h("aside.q-brief", { "aria-label": t("brief.task") }, toggle, body);
  const seen = new Set();
  function paint(openTitles = []) {
    const own = spec.brief || [];
    const rest = openTitles.filter((x) => !own.some((b) => b.kind === "open" && b.text === x));
    const all = [...own, ...rest.map((text) => ({ kind: "open", text }))];
    body.replaceChildren(...briefGroups(all, spec.glossary, { seen }));
    toggle.innerHTML = `${icon("note")}<span>${t("brief.task")}</span><span class="n">${all.length}</span>${icon("chevron", "chev")}`;
  }
  paint();
  return { el, paint };
}
