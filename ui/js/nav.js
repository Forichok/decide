// nav.js — table of contents with live status, "current question" tracking
// and keyboard shortcuts.

import { h, $, $$ } from "./dom.js";
import { t } from "./i18n.js";
import { isAnswered, isVisible } from "./logic.js";
import { modalOpen } from "./overlays.js";

export function renderToc(spec, go) {
  const toc = $("#toc");
  const bySection = new Map(spec.sections.map((s) => [s.id, []]));
  const loose = [];
  for (const q of spec.questions) (bySection.get(q.section) || loose).push(q);
  const item = (q) =>
    h("li", { dataset: { qid: q.id } }, h("button.toc-q", { type: "button", onclick: () => go(q.id) }, h("span.toc-dot"), h("span.toc-t", {}, strip(q.title))));
  const groups = [];
  if (loose.length) groups.push(h("ol.toc-list", {}, loose.map(item)));
  for (const s of spec.sections) {
    const qs = bySection.get(s.id);
    if (qs.length) groups.push(h("div.toc-sec", { dataset: { sid: s.id } }, h("div.toc-h", {}, s.title), h("ol.toc-list", {}, qs.map(item))));
  }
  toc.replaceChildren(h("div.toc-inner", {}, h("div.toc-label", {}, t("toc.label")), groups));
}

export function syncToc(spec, answers, current) {
  for (const q of spec.questions) {
    const li = $(`#toc li[data-qid="${CSS.escape(q.id)}"]`);
    if (!li) continue;
    li.hidden = !isVisible(q, answers);
    li.classList.toggle("done", isAnswered(q, answers[q.id]) || Boolean(answers[q.id]?.flag));
    li.classList.toggle("flagged", Boolean(answers[q.id]?.flag));
    li.classList.toggle("current", q.id === current);
  }
}

const strip = (s) => s.replace(/[*_`]/g, "");

// Tracks which card is "current": the last one interacted with, or the one
// crossing the upper third of the viewport while scrolling.
export function trackCurrent(onChange) {
  let current = null;
  const set = (id) => {
    if (id && id !== current) {
      current = id;
      onChange(id);
    }
  };
  const io = new IntersectionObserver(
    (entries) => {
      const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (hit) set(hit.target.dataset.qid);
    },
    { rootMargin: "-30% 0px -60% 0px" },
  );
  $$(".card").forEach((c) => io.observe(c));
  const onEvent = (e) => set(e.target.closest?.(".card")?.dataset.qid);
  document.addEventListener("focusin", onEvent);
  document.addEventListener("pointerdown", onEvent);
  const stop = () => {
    io.disconnect();
    document.removeEventListener("focusin", onEvent);
    document.removeEventListener("pointerdown", onEvent);
  };
  return { get: () => current, set, stop };
}

export function bindKeys(api) {
  const handler = (e) => {
    const typing = e.target.closest?.("input, textarea, [contenteditable]");
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      api.submit();
      return;
    }
    if (typing || modalOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key.toLowerCase();
    const map = {
      j: () => api.step(1),
      о: () => api.step(1),
      k: () => api.step(-1),
      л: () => api.step(-1),
      n: () => api.nextOpen(),
      т: () => api.nextOpen(),
      r: () => api.act("rec"),
      к: () => api.act("rec"),
      e: () => api.act("explain"),
      у: () => api.act("explain"),
      d: () => api.act("delegate"),
      в: () => api.act("delegate"),
      s: () => api.act("skip"),
      ы: () => api.act("skip"),
      m: () => api.act("note"),
      ь: () => api.act("note"),
      "?": () => api.help(),
      ",": () => api.help(),
    };
    if (/^[1-9]$/.test(e.key)) {
      e.preventDefault();
      api.pick(Number(e.key));
    } else if (map[key]) {
      e.preventDefault();
      map[key]();
    }
  };
  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler);
}
