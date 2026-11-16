// brief.js — the brief the agent keeps rewriting: decisions, risks, problems, open questions, notes,
// and the answers it has not folded in yet. On the left of the deck; on a phone it folds into a bar.

import { h, icon } from "../dom.js";
import { t } from "../i18n.js";
import { md } from "../md.js";
import { answerText } from "./card.js";

const KINDS = ["decision", "risk", "problem", "open", "note"];
const KIND_ICON = { decision: "check", risk: "alert", problem: "x", open: "help", note: "note" };

export function createBrief(s) {
  const body = h("div.sw-brief-body");
  const toggle = h("button.sw-brief-toggle", { type: "button", onclick: () => el.classList.toggle("open") });
  const el = h("aside.sw-brief", { "aria-label": t("sw.brief") }, toggle, body);
  const shown = new Set();
  let first = true;

  function item(b, kind) {
    const key = `${kind}:${b.text}`;
    const isNew = !first && !shown.has(key);
    shown.add(key);
    return h(`li.sw-item${isNew ? ".new" : ""}`, { html: md(b.text, s.deck.glossary) });
  }

  function paint(a) {
    const deck = s.deck;
    const cards = s.byId();
    const groups = KINDS.map((kind) => {
      const items = deck.brief.filter((b) => b.kind === kind);
      if (!items.length) return null;
      return h(
        `section.sw-group.k-${kind}`,
        {},
        h("h3.sw-group-h", { html: `${icon(KIND_ICON[kind])}${t(`sw.kind.${kind}`)}<span class="n">${items.length}</span>` }),
        h("ul", {}, items.map((b) => item(b, kind))),
      );
    });
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
    const ghosts = s.ghosts();
    const ghostBox = ghosts.length
      ? h(
          "section.sw-group.sw-ghosts",
          {},
          h("h3.sw-group-h", {}, t("sw.ghosts", ghosts.length)),
          h(
            "ul",
            {},
            ghosts.map(({ card, reason }) =>
              h("li", {}, h("span.t", {}, card.title), reason && h("span.state-reason", {}, t("state.notRelevant", reason)), h("button.chip.ghost", { type: "button", onclick: () => s.restore(card.id) }, t("state.restore"))),
            ),
          ),
        )
      : null;
    const empty = !deck.brief.length && !fresh;
    body.replaceChildren(
      ...[
        h("div.sw-brief-head", {}, h("div.sw-brief-label", {}, t("sw.brief")), deck.goal && h("h2.sw-goal", {}, deck.goal)),
        ...groups,
        fresh,
        ghostBox,
        empty && h("p.sw-brief-empty", {}, t("sw.briefEmpty")),
      ].filter(Boolean),
    );
    toggle.innerHTML = `${icon("note")}<span>${t("sw.brief")}</span><span class="n">${deck.brief.length}</span>${icon("chevron", "chev")}`;
    first = false;
  }

  return { el, paint };
}
