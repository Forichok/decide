// question.js — one question card: header, badges, the why line and the "more" text, media,
// answer control, extras (own option, note, attachments), ready answers and quick actions.

import { h, icon, $ } from "./dom.js";
import { t } from "./i18n.js";
import { md, mdInline } from "./md.js";
import { renderMedia } from "./media.js";
import { renderInput, syncInput } from "./inputs.js";
import { renderExtras, syncExtras } from "./extras.js";
import { renderThread, syncThread } from "./dialog.js";
import { isAnswered, recommendedIds } from "./logic.js";
import { typeOf } from "./types/index.js";
import { hasQuick, renderQuick, syncQuick } from "./quick.js";

// The five folded points of 2.x. A question no longer has them (they became `more`); the swipe cards still do.
export const FACETS = [
  ["what", t("facet.what")],
  ["how", t("facet.how")],
  ["why", t("facet.why")],
  ["goal", t("facet.goal")],
  ["then", t("facet.then")],
];

const ACTIONS = [
  { flag: "explain", icon: "help", label: t("act.explain"), key: "E" },
  { flag: "delegate", icon: "hand", label: t("act.delegate"), key: "D" },
  { flag: "skip", icon: "skip", label: t("act.skip"), key: "S" },
];

export function renderQuestion(q, index, ctx) {
  const g = ctx.glossary;
  const card = h("article.card", { id: `q-${q.id}`, tabindex: "-1", dataset: { qid: q.id }, "aria-labelledby": `qt-${q.id}` });
  card.append(
    h(
      "header.q-head",
      {},
      h("div.q-idx", { html: `<span class="n">${index}</span>${icon("check", "ok")}` }),
      h(
        "div.q-titles",
        {},
        h("h3.q-title", { id: `qt-${q.id}`, html: mdInline(q.title, g) }),
        badges(q),
        q.tldr && h("p.q-tldr.rich", { html: mdInline(q.tldr, g) }),
      ),
    ),
  );
  const quick = hasQuick(q) ? renderQuick(q, ctx) : null;
  const body = h(
    "div.q-body",
    {},
    q.why && h("p.q-why.rich", { html: mdInline(q.why, g) }),
    q.more && renderMore(q, g),
    q.body && h("div.q-text.rich", { html: md(q.body, g) }),
    renderMedia(q, ctx, q.id),
    renderInput(q, ctx),
    quick?.state,
    quick?.panel,
    renderThread(q, ctx),
    renderExtras(q, ctx),
  );
  card.append(body, renderActions(q, ctx, quick?.buttons));
  syncQuestion(card, q, ctx);
  return card;
}

// One button that opens the connected text; closed until asked for.
function renderMore(q, g) {
  const text = h("div.q-more-text.rich", { id: `qm-${q.id}`, hidden: true, html: md(q.more, g) });
  const toggle = h("button.more-toggle", {
    type: "button",
    "aria-expanded": "false",
    "aria-controls": `qm-${q.id}`,
    html: `${icon("chevron", "chev")}<span>${t("q.more")}</span>`,
    onclick: () => {
      text.hidden = !text.hidden;
      toggle.setAttribute("aria-expanded", String(!text.hidden));
      toggle.lastElementChild.textContent = t(text.hidden ? "q.more" : "q.less");
    },
  });
  return h("div.q-more", {}, toggle, text);
}

function badges(q) {
  const list = [
    q.stakes === "high" && h("span.badge.stakes-high", { html: `${icon("alert")}${t("badge.high")}` }),
    q.reversible === false && h("span.badge.irreversible", { html: `${icon("lock")}${t("badge.irreversible")}` }),
    typeOf(q).badge && h("span.badge.soft", {}, typeOf(q).badge(q, t)),
    q.optional && h("span.badge.soft", {}, t("badge.optional")),
    q.mine && h("span.badge.mine", { title: t("badge.mineTitle"), html: `${icon("hand")}${t("badge.mine")}` }),
  ].filter(Boolean);
  return list.length ? h("div.badges", {}, list) : null;
}

function renderActions(q, ctx, quick) {
  const row = h("div.actions", {}, quick);
  const tools = h("div.tools");
  const toolList = [
    h("button.chip.ghost", { type: "button", dataset: { act: "note" }, html: `${icon("note")}${t("chip.note")}`, title: t("chip.noteTitle"), onclick: () => ctx.openNote(q.id) }),
    q.allowOther &&
      h("button.chip.ghost", { type: "button", dataset: { act: "other" }, html: `${icon("plus")}${t("chip.other")}`, onclick: () => ctx.openOther(q.id) }),
    !ctx.offline && h("button.chip.ghost", { type: "button", dataset: { act: "file" }, html: `${icon("clip")}${t("chip.file")}`, title: t("chip.fileTitle"), onclick: () => ctx.pickFile(q.id) }),
  ];
  tools.append(...toolList.filter(Boolean));
  const flags = h("div.flags");
  if (recommendedIds(q).length) {
    flags.append(
      h("button.chip.ghost.rec-act", { type: "button", dataset: { act: "rec" }, html: `${icon("star")}${t("chip.rec")}`, title: t("chip.recTitle"), onclick: () => ctx.applyRecommended(q.id) }),
    );
  }
  for (const a of ACTIONS.filter((x) => !(q.mine && x.flag === "delegate"))) {
    const label = a.flag === "explain" && ctx.live ? t("act.ask") : a.label;
    flags.append(
      h("button.chip.flag", {
        type: "button",
        dataset: { flag: a.flag },
        "aria-pressed": "false",
        title: `${label} (${a.key})`,
        html: `${icon(a.icon)}${label}`,
        onclick: () => ctx.toggleFlag(q.id, a.flag),
      }),
    );
  }
  row.append(tools, flags);
  return row;
}

export function syncQuestion(card, q, ctx) {
  const a = ctx.answers[q.id];
  // Optional questions count as resolved for progress, but the card only turns
  // green once the user actually did something with it.
  card.classList.toggle("resolved", Boolean(a.flag) || isAnswered(q, a));
  card.classList.toggle("answered", isAnswered(q, a));
  for (const f of ["explain", "delegate", "skip", "none", "later"]) card.classList.toggle(`flag-${f}`, a.flag === f);
  for (const b of card.querySelectorAll(".chip.flag")) {
    const on = a.flag === b.dataset.flag;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  }
  const rec = recommendedIds(q);
  const isRec = rec.length > 0 && a.selected.length > 0 && a.selected.every((id) => rec.includes(id));
  $(".rec-act", card)?.classList.toggle("on", isRec);
  syncInput(card, q, a);
  syncExtras(card, q, ctx);
  syncQuick(card);
  syncThread(card, q, ctx);
}
