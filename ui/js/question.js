// question.js — one question card: header, badges, explanation facets, media,
// answer control, extras (own option, note, attachments) and quick actions.

import { h, icon, $ } from "./dom.js";
import { t } from "./i18n.js";
import { md, mdInline } from "./md.js";
import { renderMedia } from "./media.js";
import { renderInput, syncInput } from "./inputs.js";
import { renderExtras, syncExtras } from "./extras.js";
import { renderThread, syncThread } from "./dialog.js";
import { isAnswered, recommendedIds } from "./logic.js";

const FACETS = [
  ["what", t("facet.what")],
  ["how", t("facet.how")],
  ["why", t("facet.why")],
  ["goal", t("facet.goal")],
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
  const facets = FACETS.filter(([k]) => q[k]);
  if (facets.length) {
    const grid = h(
      "div.facets",
      { hidden: Boolean(q.tldr) },
      facets.map(([k, label]) => h(`div.facet.${k}`, {}, h("div.f-label", {}, label), h("div.f-text.rich", { html: md(q[k], g) }))),
    );
    const toggle = h("button.explain-toggle", {
      type: "button",
      "aria-expanded": String(!grid.hidden),
      html: `${icon("chevron", "chev")}${t("facet.more", facets.map(([, l]) => l.toLowerCase()).join(" · "))}`,
      onclick: () => {
        grid.hidden = !grid.hidden;
        toggle.setAttribute("aria-expanded", String(!grid.hidden));
      },
    });
    card.append(toggle, grid);
  }
  const body = h("div.q-body", {}, renderMedia(q, ctx, q.id), renderInput(q, ctx), renderThread(q, ctx), renderExtras(q, ctx));
  card.append(body, renderActions(q, ctx));
  syncQuestion(card, q, ctx);
  return card;
}

function badges(q) {
  const list = [
    q.stakes === "high" && h("span.badge.stakes-high", { html: `${icon("alert")}${t("badge.high")}` }),
    q.reversible === false && h("span.badge.irreversible", { html: `${icon("lock")}${t("badge.irreversible")}` }),
    q.type === "multi" && h("span.badge.soft", {}, t("badge.multi", q.max)),
    q.type === "rank" && h("span.badge.soft", {}, t("badge.rank")),
    q.optional && h("span.badge.soft", {}, t("badge.optional")),
  ].filter(Boolean);
  return list.length ? h("div.badges", {}, list) : null;
}

function renderActions(q, ctx) {
  const row = h("div.actions");
  const tools = h("div.tools");
  const toolList = [
    h("button.chip.ghost", { type: "button", dataset: { act: "note" }, html: `${icon("note")}${t("chip.note")}`, title: t("chip.noteTitle"), onclick: () => ctx.openNote(q.id) }),
    q.allowOther &&
      h("button.chip.ghost", { type: "button", dataset: { act: "other" }, html: `${icon("plus")}${t("chip.other")}`, onclick: () => ctx.openOther(q.id) }),
    h("button.chip.ghost", { type: "button", dataset: { act: "file" }, html: `${icon("clip")}${t("chip.file")}`, title: t("chip.fileTitle"), onclick: () => ctx.pickFile(q.id) }),
  ];
  tools.append(...toolList.filter(Boolean));
  const flags = h("div.flags");
  if (recommendedIds(q).length) {
    flags.append(
      h("button.chip.ghost.rec-act", { type: "button", dataset: { act: "rec" }, html: `${icon("star")}${t("chip.rec")}`, title: t("chip.recTitle"), onclick: () => ctx.applyRecommended(q.id) }),
    );
  }
  for (const a of ACTIONS) {
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
  for (const f of ["explain", "delegate", "skip"]) card.classList.toggle(`flag-${f}`, a.flag === f);
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
  syncThread(card, q, ctx);
}
