// end.js — what the deck shows when no card is left (the agent is thinking, digging, has no more
// questions, or the deck is empty), the closing note, and the "finish?" dialog. One set of
// controls per state: the buttons live in the end card, never again under it.

import { h, icon } from "../dom.js";
import { t } from "../i18n.js";
import { openModal } from "../overlays.js";

export function endCard(s) {
  const { deck } = s;
  const enough = () => h("button.btn.ghost.sw-stop", { type: "button", onclick: () => confirmFinish(s), html: `${t("sw.enough")}<kbd>Esc</kbd>` });
  if (deck.done) {
    return h(
      "div.sw-end.done",
      {},
      h("div.ring", { html: icon("check") }),
      h("h2", {}, t("sw.doneTitle")),
      h("p", {}, t("sw.doneSub", deck.confidence)),
      noteBox(s),
      h(
        "div.sw-end-actions",
        {},
        deeperBtn(s),
        h("button.btn.primary", { type: "button", "data-autofocus": "", onclick: () => s.finish(), html: `${t("sw.finish")}<kbd>↵</kbd>` }),
      ),
    );
  }
  if (s.server.digging || s.digging) {
    return h("div.sw-end", {}, h("div.sw-spinner"), h("h2", {}, t(s.listening ? "sw.digTitle" : "sw.digQueued")), h("p", {}, t(s.listening ? "sw.digSub" : "sw.digQueuedSub")), enough());
  }
  if (s.server.thinking) {
    return h("div.sw-end", {}, h("div.sw-spinner"), h("h2", {}, t("sw.waitTitle")), h("p", {}, t("sw.waitSub")), enough());
  }
  return h(
    "div.sw-end",
    {},
    h("div.ring.away", { html: icon("history") }),
    h("h2", {}, t("sw.emptyTitle")),
    h("p", {}, t(s.listening ? "sw.emptySub" : "sw.emptyAway")),
    enough(),
  );
}

// The closing note: free text that goes into the result and the brief, or with "Dig deeper" tells the agent where to dig.
export function noteBox(s) {
  const input = h("textarea.sw-ask-input.sw-note-input", {
    rows: 2,
    maxlength: 4000,
    placeholder: t("sw.notePlaceholder"),
    "aria-label": t("sw.note"),
    oninput: () => ((s.note = input.value), s.persist()),
  });
  input.value = s.note;
  return h("label.sw-note", {}, h("span.sw-note-label", { html: `${icon("note")}${t("sw.note")}` }), input, h("span.sw-ask-hint", {}, t("sw.noteHint")));
}

export const deeperBtn = (s, after) =>
  h("button.btn.ghost.sw-deeper", { type: "button", title: t("sw.deeperTitle"), onclick: () => (after?.(), s.dig()), html: `${icon("spark")}${t("sw.deeper")}` });

export function confirmFinish(s) {
  if (s.finishing) return;
  const a = s.answers();
  const n = s.deck.cards.filter((c) => a[c.id]).length;
  const close = openModal(
    h(
      "div.sw-finish",
      {},
      h("h2.modal-title", {}, t("sw.finishTitle")),
      h("p", {}, t("sw.finishSub", n, s.queue().length)),
      noteBox(s),
      h(
        "div.modal-actions",
        {},
        h("button.btn.ghost", { type: "button", onclick: () => close() }, t("sw.keepGoing")),
        !s.server.digging && deeperBtn(s, () => close()),
        h("button.btn.primary", { type: "button", "data-autofocus": "", onclick: () => (close(), s.finish()) }, t("sw.finish")),
      ),
    ),
    { wide: true },
  );
}
