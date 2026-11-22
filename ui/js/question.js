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
    // A spot question draws its first picture itself, to mark it; a tune question frames its own mockup.
    renderMedia(q.type === "spot" ? { ...q, images: q.images.slice(1) } : q.type === "tune" ? { ...q, preview: null } : q, ctx, q.id),
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
  // What a reader reaches for on any question stays in the row: ask, a note, an option of their own.
  // The rare ones (a file, the ready answers, the ways to leave it unanswered) wait behind "More".
  const note = h("button.chip.ghost", { type: "button", dataset: { act: "note" }, html: `${icon("note")}${t("chip.note")}`, title: t("chip.noteTitle"), onclick: () => ctx.openNote(q.id) });
  const other = q.allowOther && h("button.chip.ghost", { type: "button", dataset: { act: "other" }, html: `${icon("plus")}${t("chip.other")}`, onclick: () => ctx.openOther(q.id) });
  const tools = !ctx.offline && h(
    "div.action-group",
    { role: "group", "aria-label": t("act.capAdd") },
    h("span.action-cap", { "aria-hidden": "true" }, t("act.capAdd")),
    h("button.chip.ghost", { type: "button", dataset: { act: "file" }, html: `${icon("clip")}${t("chip.file")}`, title: t("chip.fileTitle"), onclick: () => ctx.pickFile(q.id) }),
  );
  const showRec = (!quick || q.type === "multi") && recommendedIds(q).length > 0;
  const flags = h(
    "div.action-group",
    { role: "group", "aria-label": t("act.capPass") },
    h("span.action-cap", { "aria-hidden": "true" }, t("act.capPass")),
    showRec && h("button.chip.ghost.rec-act", { type: "button", dataset: { act: "rec" }, html: `${icon("star")}${t("chip.rec")}`, title: t("chip.recTitle"), onclick: () => ctx.applyRecommended(q.id) }),
    !q.mine && renderFlag(q, ctx, "delegate", "hand", "D"),
    renderFlag(q, ctx, "skip", "skip", "S"),
  );
  const panel = h("div.action-panel", { id: `qa-${q.id}`, hidden: true }, quick, tools, flags);
  const more = h("button.chip.ghost.action-more", {
    type: "button",
    "aria-expanded": "false",
    "aria-controls": panel.id,
    html: `${t("act.more")}${icon("chevron")}`,
    onclick: () => expand(panel.hidden),
  });
  const footer = h(
    "div.actions",
    {},
    h(
      "div.action-row",
      {},
      renderFlag(q, ctx, "explain", "help", "E"),
      note,
      other,
      more,
      h("span.action-status"),
    ),
    panel,
  );
  footer.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || panel.hidden) return;
    e.stopPropagation();
    expand(false);
    more.focus();
  });
  return footer;

  function expand(open) {
    panel.hidden = !open;
    more.setAttribute("aria-expanded", String(open));
  }
}

function renderFlag(q, ctx, flag, iconName, key) {
  const label = t(flag === "explain" && ctx.live ? "act.ask" : `act.${flag}`);
  return h("button.chip.flag", {
    type: "button",
    dataset: { flag },
    "aria-pressed": "false",
    title: `${label} (${key})`,
    html: `${icon(iconName)}${label}`,
    onclick: () => ctx.toggleFlag(q.id, flag),
  });
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
  const status = $(".action-status", card);
  status.textContent = a.flag === "delegate" ? t("act.delegated") : a.flag === "skip" ? t("act.skipped") : "";
  const recButton = $(".rec-act", card);
  if (recButton) {
    const rec = recommendedIds(q);
    const isRec = !a.other.trim() && a.selected.length === rec.length && a.selected.every((id) => rec.includes(id));
    recButton.classList.toggle("on", isRec);
  }
  syncInput(card, q, a);
  syncExtras(card, q, ctx);
  syncQuick(card);
  syncThread(card, q, ctx);
}
