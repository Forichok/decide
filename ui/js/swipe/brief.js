// brief.js — the brief the agent keeps rewriting: decisions, risks, problems, open questions, notes,
// and the answers it has not folded in yet. On the left of the deck; on a phone it folds into a bar.

import { h, icon } from "../dom.js";
import { t } from "../i18n.js";
import { briefGroups } from "../brief.js";
import { answerText } from "./card.js";

export function createBrief(s) {
  const body = h("div.sw-brief-body");
  const toggle = h("button.sw-brief-toggle", { type: "button", onclick: () => el.classList.toggle("open") });
  const el = h("aside.sw-brief", { "aria-label": t("sw.brief") }, toggle, body);
  const shown = new Set();
  let first = true;

  function paint(a) {
    const deck = s.deck;
    const cards = s.byId();
    const groups = briefGroups(deck.brief, deck.glossary, { seen: shown, markNew: !first });
    const freshIds = [...new Set([...s.server.fresh, ...[...s.inflight.keys()].filter((id) => !s.inflight.get(id).undo)])].filter((id) => a[id]);
    const fresh = freshIds.length
      ? h(
          "section.sw-group.k-fresh",
          {},
          h("h3.sw-group-h", { html: `${icon("spark")}${t("sw.fresh")}<span class="n">${freshIds.length}</span>` }),
          h(
            "ul",
            {},
            freshIds.map((id) => {
              const c = cards.get(id);
              return h("li.sw-item.raw", {}, h("span.t", {}, c?.title || id), h("span.ans", {}, answerText(c, a[id])));
            }),
          ),
        )
      : null;
    const empty = !deck.brief.length && !fresh;
    body.replaceChildren(
      ...[
        h("div.sw-brief-head", {}, h("div.sw-brief-label", {}, t("sw.brief")), deck.goal && h("h2.sw-goal", {}, deck.goal)),
        ...groups,
        fresh,
        empty && h("p.sw-brief-empty", {}, t("sw.briefEmpty")),
      ].filter(Boolean),
    );
    toggle.innerHTML = `${icon("note")}<span>${t("sw.brief")}</span><span class="n">${deck.brief.length}</span>${icon("chevron", "chev")}`;
    first = false;
  }

  return { el, paint };
}
