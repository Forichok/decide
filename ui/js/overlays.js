// overlays.js — modal shell, image lightbox, review-before-send, keyboard help,
// cancel confirmation and the toast.

import { h, icon, $ } from "./dom.js";
import { shortcut, t } from "./i18n.js";
import { mdInline } from "./md.js";
import { describe, finalizeAnswers, isResolved, visibleQuestions } from "./logic.js";
import { sameOrigin } from "./media.js";
import { startAnnotate } from "./annotate.js";

let closeCurrent = null;

export function openModal(content, { wide = false, onClose } = {}) {
  closeCurrent?.();
  const root = $("#overlay");
  const prevFocus = document.activeElement;
  const box = h(`div.modal${wide ? ".wide" : ""}`, { role: "dialog", "aria-modal": "true" }, content);
  root.replaceChildren(box);
  root.hidden = false;
  document.body.classList.add("locked");
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const onClick = (e) => {
    if (e.target === root) close();
  };
  function close() {
    root.hidden = true;
    root.replaceChildren();
    document.body.classList.remove("locked");
    document.removeEventListener("keydown", onKey, true);
    root.removeEventListener("click", onClick);
    closeCurrent = null;
    prevFocus?.focus?.({ preventScroll: true });
    onClose?.();
  }
  document.addEventListener("keydown", onKey, true);
  root.addEventListener("click", onClick);
  closeCurrent = close;
  // the top of a long modal stays in view; focus alone would scroll it to the button
  requestAnimationFrame(() => (box.querySelector("[data-autofocus]") || box.querySelector("button"))?.focus({ preventScroll: true }));
  return close;
}

export const modalOpen = () => Boolean(closeCurrent) || !$("#lightbox").hidden;

// onAnnotate(file): enables the mark-up button; annotate: open straight in drawing mode.
export function openLightbox(images, start, { onAnnotate, annotate = false } = {}) {
  const root = $("#lightbox");
  let i = start;
  let annotating = false;
  const img = h("img.lb-img", { alt: "", onclick: () => img.classList.toggle("zoomed") });
  const cap = h("div.lb-cap");
  const count = h("div.lb-count");
  const open = h("a.lb-open", { target: "_blank", rel: "noopener", html: `${t("lb.original")}${icon("expand")}` });
  const mark = onAnnotate && h("button.btn.ghost.sm.lb-mark", { type: "button", html: `${icon("pen")}${t("lb.mark")}`, onclick: () => startMarks() });
  const nav = (d) => {
    i = (i + d + images.length) % images.length;
    show();
  };
  function show() {
    img.src = images[i].src;
    img.alt = images[i].caption || "";
    img.classList.remove("zoomed");
    cap.textContent = images[i].caption || "";
    count.textContent = images.length > 1 ? `${i + 1} / ${images.length}` : "";
    open.href = images[i].src;
    if (mark) mark.hidden = !sameOrigin(images[i].src);
  }
  function startMarks() {
    annotating = true;
    startAnnotate(root, images[i], {
      onDone: onAnnotate,
      toast,
      onExit: () => {
        annotating = false;
        view();
      },
    });
  }
  const multi = images.length > 1;
  const parts = [
    h("div.lb-top", {}, count, h("span.spacer"), mark, open, h("button.icon-btn.lb-x", { type: "button", "aria-label": t("lb.close"), html: icon("x"), onclick: close })),
    multi && h("button.lb-nav.prev", { type: "button", "aria-label": t("lb.prev"), html: icon("left"), onclick: () => nav(-1) }),
    h("figure.lb-stage", {}, img, cap),
    multi && h("button.lb-nav.next", { type: "button", "aria-label": t("lb.next"), html: icon("right"), onclick: () => nav(1) }),
  ];
  const view = () => {
    root.replaceChildren(...parts.filter(Boolean));
    show();
  };
  view();
  root.hidden = false;
  document.body.classList.add("locked");
  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft" && multi) nav(-1);
    else if (e.key === "ArrowRight" && multi) nav(1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onClick = (e) => {
    if (!annotating && (e.target === root || e.target.classList.contains("lb-stage"))) close();
  };
  function close() {
    root.hidden = true;
    root.replaceChildren();
    document.body.classList.remove("locked");
    document.removeEventListener("keydown", onKey, true);
    root.removeEventListener("click", onClick);
  }
  document.addEventListener("keydown", onKey, true);
  root.addEventListener("click", onClick);
  if (annotate && onAnnotate && sameOrigin(images[i].src)) startMarks();
}

// What to do with unanswered questions; kept while the page is open.
let fillMode = "recommend";

export function openReview({ spec, answers, comment, onSend, onJump }) {
  const visible = visibleQuestions(spec, answers);
  const open = visible.filter((q) => !isResolved(q, answers[q.id]));
  const words = reviewWords();
  const list = h("div.rv-list");
  const render = () => {
    const final = finalizeAnswers(spec, answers, { fill: fillMode });
    list.replaceChildren(
      ...visible.map((q, i) =>
        h(
          "button.rv-row",
          { type: "button", class: open.includes(q) ? "auto" : "", onclick: () => (close(), onJump(q.id)) },
          h("span.rv-n", {}, String(i + 1)),
          h("span.rv-q", { html: mdInline(q.title) }),
          h("span.rv-a", {}, describe(q, final[q.id], words), extrasNote(final[q.id])),
        ),
      ),
    );
  };
  render();
  const choice = (mode) =>
    h(
      "label.rv-choice",
      {},
      h("input", { type: "radio", name: "rv-fill", value: mode, checked: fillMode === mode, onchange: () => ((fillMode = mode), render()) }),
      h("span", {}, t(`review.fill.${mode}`)),
    );
  const status = open.length
    ? h(
        "div.rv-warn",
        { html: icon("alert") },
        h(
          "div.rv-body",
          {},
          h("p", { id: "rv-open" }, t("review.open", open.length)),
          h("div.rv-fill", { role: "radiogroup", "aria-labelledby": "rv-open" }, choice("recommend"), choice("skip")),
        ),
      )
    : h("p.rv-ok", { html: `${icon("check")}${t("review.ok")}` });
  const back = open.length
    ? h("button.btn.ghost", { type: "button", onclick: () => (close(), onJump(open[0].id)) }, t("review.fillIn"))
    : h("button.btn.ghost", { type: "button", onclick: () => close() }, t("common.back"));
  const send = h("button.btn.primary", { type: "button", "data-autofocus": "", html: `${t("review.send")}${icon("arrow")}`, onclick: () => (close(), onSend(fillMode)) });
  const close = openModal(
    h(
      "div.review",
      {},
      h("h2.modal-title", {}, t("review.title")),
      status,
      list,
      comment && h("p.rv-comment", {}, t("review.comment", comment)),
      h("div.modal-actions", {}, back, send),
      h("p.modal-hint", {}, t("review.hint")),
    ),
    { wide: true },
  );
  return { send: () => send.click() };
}

const reviewWords = () => ({
  explain: t("rv.explain"),
  skip: t("rv.skip"),
  delegate: t("rv.delegate"),
  autoSkip: t("rv.autoSkip"),
  autoDelegate: t("rv.autoDelegate"),
  against: (recs) => t("rv.against", recs),
  own: (text) => t("rv.own", text),
});

function extrasNote(r) {
  const bits = [r?.note && t("review.note"), r?.attachments?.length && `📎 ${r.attachments.length}`].filter(Boolean);
  return bits.length ? h("span.rv-extra", {}, bits.join(" · ")) : null;
}

const KEYS = [
  ["1–9", "keys.pick"],
  ["J / K", "keys.move"],
  ["N", "keys.next"],
  ["R", "keys.rec"],
  ["E", "keys.explain"],
  ["D", "keys.delegate"],
  ["S", "keys.skip"],
  ["M", "keys.note"],
  ["Alt + ↑↓", "keys.rank"],
  ["⌘V", "keys.paste"],
  ["⌘⏎", "keys.submit"],
  ["Esc", "keys.esc"],
];

export function openHelp() {
  openModal(
    h(
      "div.help",
      {},
      h("h2.modal-title", {}, t("keys.title")),
      h("dl.keys", {}, KEYS.map(([k, d]) => [h("dt", {}, h("kbd", {}, shortcut(k))), h("dd", {}, t(d))])),
      h("div.modal-actions", {}, h("button.btn.primary", { type: "button", onclick: () => closeCurrent?.() }, t("keys.ok"))),
    ),
  );
}

export function confirmCancel(onConfirm) {
  const close = openModal(
    h(
      "div.confirm-cancel",
      {},
      h("h2.modal-title", {}, t("cancel.title")),
      h("p", {}, t("cancel.text")),
      h(
        "div.modal-actions",
        {},
        h("button.btn.ghost", { type: "button", "data-autofocus": "", onclick: () => close() }, t("common.back")),
        h("button.btn.danger", { type: "button", onclick: () => (close(), onConfirm()) }, t("cancel.confirm")),
      ),
    ),
  );
}

let toastTimer = null;
export function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}
