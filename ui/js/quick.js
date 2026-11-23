// quick.js — the ready answers of a choice question: "Yes, but…" (the picked option plus a condition),
// "None, suggest others" (flag "none" and an optional note) and "Later" (flag "later" and a revisit text).
// renderQuick(q, ctx) gives the buttons for the actions row and one panel for the text each of them asks.
// The answer state is logic.js's (condition, revisit, flag, note); saving goes through ctx.set, the page's
// draft path, and through ctx.store when the page has one (ui/js/store.js: saveAnswer, saveFlag).

import { h, icon, $ } from "./dom.js";
import { t } from "./i18n.js";
import { isReadyFlag } from "./logic.js";

const MODES = ["yes", "none", "later"];
const CHOICE = new Set(["single", "multi", "confirm"]);

export const hasQuick = (q) => CHOICE.has(q.type);

// What each button asks for. `needs` is what the text must hold before it saves.
const SPEC = {
  yes: { icon: "check", label: "quick.yes", title: "quick.yesTitle", hint: "quick.yesHint", field: "condition", needsText: true },
  none: { icon: "swap", label: "quick.none", title: "quick.noneTitle", hint: "quick.noneHint", field: "note", needsText: false },
  later: { icon: "clock", label: "quick.later", title: "quick.laterTitle", hint: "quick.laterHint", field: "revisit", needsText: true },
};

// TODO(store): ctx.set keeps the draft through the old save path; once round.js routes it through
// ui/js/store.js, the two store calls below are the only save and this shim goes.
function commit(ctx, q, patch) {
  ctx.set(q.id, patch);
  const store = ctx.store;
  if (!store || !ctx.roundId) return;
  const a = ctx.answers[q.id];
  if (isReadyFlag(a.flag)) store.saveFlag(ctx.roundId, q.id, a.flag, a.flag === "later" ? { revisit: a.revisit } : { note: a.note });
  else {
    store.saveFlag(ctx.roundId, q.id, a.flag || null, {});
    store.saveAnswer(ctx.roundId, q.id, { selected: [...a.selected], ...(a.other.trim() ? { other: a.other.trim() } : {}), ...(a.condition?.trim() ? { condition: a.condition?.trim() } : {}) });
  }
}

const picked = (a) => a.selected.length > 0 || a.other.trim().length > 0;

export function renderQuick(q, ctx) {
  const panel = h("div.quick-panel", { hidden: true, dataset: { qid: q.id } });
  const state = h("p.quick-state", { hidden: true });
  const input = h("input.quick-input", { type: "text", "aria-label": "" });
  const hint = h("span.quick-hint");
  const save = h("button.btn.quick-save", { type: "button", onclick: () => submit() }, t("quick.save"));
  const undo = h("button.chip.ghost.quick-undo", { type: "button", onclick: () => clear() }, t("quick.undo"));
  const close = h("button.icon-btn.sm", { type: "button", "aria-label": t("quick.cancel"), html: icon("x"), onclick: () => show(null) });
  panel.append(hint, h("div.quick-row", {}, input, save, undo, close));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      show(null);
    }
  });

  const buttons = h("div.quick", { role: "group", "aria-label": t("quick.group") }, h("span.action-cap", { "aria-hidden": "true" }, t("quick.group")));
  for (const mode of MODES) {
    buttons.append(
      h("button.chip.ghost.quick-btn", {
        type: "button",
        dataset: { quick: mode },
        "aria-pressed": "false",
        title: t(SPEC[mode].title),
        html: `${icon(SPEC[mode].icon)}${t(SPEC[mode].label)}`,
        onclick: () => (panel.dataset.mode === mode ? show(null) : show(mode)),
      }),
    );
  }

  function show(mode) {
    const a = ctx.answers[q.id];
    if (mode === "yes" && !picked(a)) {
      ctx.toast(t("quick.pickFirst"));
      ctx.shake(q.id);
      return;
    }
    if (!mode) delete panel.dataset.mode;
    else panel.dataset.mode = mode;
    if (mode) {
      const s = SPEC[mode];
      // The note of a "none" answer is the answer's note; a note written for another reason is not offered back.
      input.value = mode === "none" ? (a.flag === "none" ? a.note : "") : a[s.field] || "";
      input.setAttribute("aria-label", t(s.hint));
      input.placeholder = t(s.hint);
      hint.textContent = "";
      requestAnimationFrame(() => input.focus());
    }
    paint();
  }

  function submit() {
    const mode = panel.dataset.mode;
    if (!mode) return;
    const text = input.value.trim();
    if (SPEC[mode].needsText && !text && !(mode === "yes" && ctx.answers[q.id].condition)) {
      input.focus();
      return;
    }
    const base = { flag: null };
    if (mode === "yes") commit(ctx, q, { condition: text, flag: ctx.answers[q.id].flag === "explain" ? "explain" : null });
    if (mode === "none") commit(ctx, q, { ...base, flag: "none", selected: [], other: "", condition: "", revisit: "", note: text });
    if (mode === "later") commit(ctx, q, { ...base, flag: "later", selected: [], other: "", condition: "", revisit: text });
    show(null);
  }

  // Takes the ready answer back: the question is open again.
  function clear() {
    const a = ctx.answers[q.id];
    if (a.flag === "none") commit(ctx, q, { flag: null, note: "" });
    else if (a.flag === "later") commit(ctx, q, { flag: null, revisit: "" });
    else commit(ctx, q, { condition: "" });
    show(null);
  }

  function paint() {
    const a = ctx.answers[q.id];
    const mode = panel.dataset.mode || "";
    panel.hidden = !mode;
    for (const b of buttons.querySelectorAll(".quick-btn")) {
      const m = b.dataset.quick;
      const on = m === "yes" ? Boolean(a.condition) && !isReadyFlag(a.flag) : a.flag === (m === "none" ? "none" : "later");
      b.classList.toggle("on", on);
      b.classList.toggle("open", m === mode);
      b.setAttribute("aria-pressed", String(on));
    }
    const has = mode === "yes" ? Boolean(a.condition) : a.flag === (mode === "none" ? "none" : "later");
    undo.hidden = !has;
    const text = summaryOf(a);
    state.hidden = !text;
    state.textContent = text;
  }

  panel._paint = paint;
  return { buttons, panel, state };
}

// The summary line under the options once a ready answer stands: what the agent will read.
export function summaryOf(a) {
  if (a.flag === "none") return t("quick.noneSet", a.note?.trim());
  if (a.flag === "later") return t("quick.laterSet", a.revisit?.trim());
  if (a.condition?.trim() && (a.selected.length || a.other?.trim())) return t("quick.yesSet", a.condition?.trim());
  return "";
}

export function syncQuick(card) {
  $(".quick-panel", card)?._paint?.();
}
