// card.js — one card on screen: the front card with its question, the folded answers, media, the two
// side tiles, the ask / own-answer boxes, and the drag that picks a side. Cards behind it are plain
// shells (backCard) that peek out below to show the deck is a stack.

import { h, icon } from "../dom.js";
import { t } from "../i18n.js";
import { md } from "../md.js";
import { renderMedia } from "../media.js";
import { FACETS } from "../question.js";

const DRAG_PICK = 110;
const inline = (s, text) => md(text, s.deck.glossary).replace(/^<p>|<\/p>$/g, "");

// How an answer reads back: a side's label, the user's own words, or "skipped".
export function answerText(c, a) {
  if (a.side === "skip") return t("sw.skipped");
  if (a.side === "own") return `«${a.text}»`;
  return c?.[a.side]?.label;
}

// A card behind the front one: only its title shows, faintly, so the stack reads as real cards.
export function backCard(c, depth, arrived) {
  return h(`div.sw-card.back.b${depth}${arrived ? ".arrive" : ""}`, { "aria-hidden": "true" }, h("div.sw-q", {}, c.title));
}

export function frontCard(s, c) {
  const replies = s.dialog.filter((d) => d.qid === c.id);
  const waitingReply = replies.some((d) => !d.reply);
  const card = h(
    `article.sw-card.front${c.stakes === "high" ? ".high" : ""}`,
    { dataset: { card: c.id }, tabindex: "-1" },
    h("div.sw-stamp.l", {}, c.left.label),
    h("div.sw-stamp.r", {}, c.right.label),
    h("div.sw-stamp.u", {}, t("sw.skipped")),
    h(
      "div.sw-card-body",
      {},
      h(
        "div.sw-card-top",
        {},
        c.section && h("span.sw-sec", {}, c.section),
        c.stakes === "high" && h("span.badge.warn", { html: `${icon("alert")}${t("sw.high")}` }),
        h("span.sw-left-n", {}, t("sw.leftN", s.queue().length)),
      ),
      fromLine(s, c),
      h("h2.sw-q", { html: inline(s, c.title) }),
      c.tldr && h("div.sw-tldr.rich", { html: md(c.tldr, s.deck.glossary) }),
      c.body && h("div.sw-body.rich", { html: md(c.body, s.deck.glossary) }),
      facetsBox(s, c),
      // No `canMark` in this context: pictures on a card zoom, they have no mark-up mode here.
      renderMedia(c, s.media, c.id),
      replies.filter((d) => d.reply).map((d) => explainBox(s, d)),
      waitingReply && h("div.sw-explain.wait", {}, h("span.sw-dots", {}, h("i"), h("i"), h("i")), t("sw.explaining")),
      s.asking === c.id && askBox(s, c),
      h("div.sw-sides", {}, sideTile(s, c, "left"), sideTile(s, c, "right")),
      s.writing === c.id
        ? ownBox(s, c)
        : h("button.sw-own", { type: "button", onclick: () => s.openOwn() }, h("span", { html: icon("note") }), h("span", {}, t("sw.own")), h("kbd", {}, "↵")),
      c.recommended && c.reason && h("div.sw-reason", { html: `${icon("star")}${inline(s, c.reason)}` }),
    ),
  );
  bindDrag(s, card);
  return card;
}

// A follow-up says which answer brought it up.
function fromLine(s, c) {
  const src = c.from && s.byId().get(c.from);
  const a = src && s.answers()[src.id];
  if (!a || a.side === "skip") return null;
  return h("div.sw-from", {}, h("span.arr", {}, "↳"), h("span", {}, t("sw.from")), h("b", {}, answerText(src, a)));
}

// The answers to "what, how, why, what for, what happens" fold under the question. Open or
// folded stays the same from card to card: whoever opened it once wants it on the next one too.
function facetsBox(s, c) {
  const facets = FACETS.filter(([k]) => c[k]);
  if (!facets.length) return null;
  const grid = h(
    "div.facets.sw-facets",
    { hidden: !s.facetsOpen },
    facets.map(([k, label]) => h(`div.facet.${k}`, {}, h("div.f-label", {}, label), h("div.f-text.rich", { html: md(c[k], s.deck.glossary) }))),
  );
  const toggle = h(
    "button.explain-toggle.sw-facets-toggle",
    { type: "button", "aria-expanded": String(s.facetsOpen), onclick: () => s.toggleFacets() },
    h("span", { html: `${icon("chevron", "chev")}${t("facet.more", facets.map(([, l]) => l.toLowerCase()).join(" · "))}` }),
    h("kbd", {}, "␣"),
  );
  return [toggle, grid];
}

// A side tile: the pick button on top, the side's own media below it. A click on the tile picks
// the side; a click on its media zooms or plays it instead.
function sideTile(s, c, side) {
  const sd = c[side];
  const rec = c.recommended === side;
  const shown = renderMedia(sd, s.media, c.id, { compact: true });
  return h(
    `div.sw-side.${side}${rec ? ".rec" : ""}${shown ? ".with-media" : ""}`,
    { onclick: (e) => !e.target.closest(".media-stop, a, button, video") && s.answer(side) },
    h(
      "button.sw-side-pick",
      { type: "button", onclick: () => s.answer(side) },
      h("span.sw-side-key", {}, side === "left" ? "←" : "→"),
      h("span.sw-side-label", {}, sd.label),
      sd.detail && h("span.sw-side-detail.rich", { html: inline(s, sd.detail) }),
    ),
    shown,
    rec && h("span.sw-side-rec", { title: c.reason || t("sw.rec"), html: icon("star") }),
  );
}

function explainBox(s, d) {
  return h("div.sw-explain", {}, d.ask && h("div.sw-explain-q", {}, d.ask), h("div.rich", { html: md(d.reply.text, s.deck.glossary) }), renderMedia(d.reply, s.media, d.qid));
}

function askBox(s, c) {
  const input = h("textarea.sw-ask-input", {
    rows: 2,
    placeholder: t("sw.askPlaceholder"),
    oninput: () => ((s.askDraft = input.value), s.persist()),
  });
  input.value = s.askDraft;
  const send = () => s.sendAsk(c.id, input.value.trim());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      s.asking = null;
      s.paint();
    }
  });
  requestAnimationFrame(() => input.focus());
  return h(
    "div.sw-ask",
    {},
    input,
    h("div.sw-ask-row", {}, h("span.sw-ask-hint", {}, t("sw.askHint")), h("button.btn.primary.sm", { type: "button", onclick: send }, t("sw.askSend"))),
  );
}

// The user's own answer when neither side fits: Enter sends, Shift+Enter breaks the line, Esc closes.
function ownBox(s, c) {
  const input = h("textarea.sw-ask-input.sw-own-input", {
    rows: 2,
    maxlength: 2000,
    placeholder: t("sw.ownPlaceholder"),
    oninput: () => ((s.ownDraft = input.value), s.persist()),
  });
  input.value = s.ownDraft;
  const send = () => {
    const text = input.value.trim();
    if (!text) return input.focus();
    s.answer("own", text);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      s.writing = null;
      s.paint();
    }
  });
  requestAnimationFrame(() => input.focus());
  return h(
    "div.sw-ask.sw-own-box",
    {},
    input,
    h("div.sw-ask-row", {}, h("span.sw-ask-hint", {}, t("sw.ownHint")), h("button.btn.primary.sm", { type: "button", onclick: send }, t("sw.ownSend"))),
  );
}

// ---- drag: left / right picks a side, up skips
function bindDrag(s, card) {
  let start = null;
  card.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button, a, textarea, input, .media-stop, .sw-explain, .sw-facets")) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    card.setPointerCapture(e.pointerId);
    card.classList.add("dragging");
  });
  card.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    const dy = Math.min(0, e.clientY - start.y);
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    card.style.setProperty("--l", String(Math.min(1, Math.max(0, -dx / DRAG_PICK))));
    card.style.setProperty("--r", String(Math.min(1, Math.max(0, dx / DRAG_PICK))));
    card.style.setProperty("--u", String(Math.abs(dx) < DRAG_PICK / 2 ? Math.min(1, Math.max(0, -dy / DRAG_PICK)) : 0));
  });
  const end = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    card.classList.remove("dragging");
    card.style.transform = "";
    for (const v of ["--l", "--r", "--u"]) card.style.removeProperty(v);
    if (dx <= -DRAG_PICK) s.answer("left");
    else if (dx >= DRAG_PICK) s.answer("right");
    else if (dy <= -DRAG_PICK && Math.abs(dx) < DRAG_PICK / 2) s.answer("skip");
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", end);
}
