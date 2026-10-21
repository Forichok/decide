// swipe.mjs — the swipe interview: a deck of two-sided cards the user answers
// with the arrow keys, while the agent reads the answers in batches, rewrites
// the brief and adds, replaces or removes cards. Pure except for existsSync on
// local assets; the daemon keeps the live state, this file shapes it.

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { collectMedia, mediaKinds, shareScale } from "./media.mjs";
import { specLang, words } from "./words.mjs";

export const SIDES = ["left", "right"];
export const KINDS = ["decision", "risk", "problem", "open", "note"];
export const BATCH_DEFAULT = 5;
// Cards left at which a batch goes out early, so the agent refills the deck before it runs dry.
export const LOW_WATER = 3;
const BATCH_MAX = 30;
// A swipe card is read in a few seconds: past these it belongs in /decide.
export const TITLE_MAX = 120;
export const BODY_MAX = 700;

const str = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const clampPct = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : null);
const clampBatch = (v) => (Number.isInteger(v) && v > 0 ? Math.min(v, BATCH_MAX) : null);

function context(raw, specDir, issues) {
  const lang = specLang({ ...raw, questions: list(raw?.cards) });
  return {
    lang,
    w: words(lang),
    add: (level, where, message) => issues.push({ level, where, message }),
    exists: (p) => existsSync(p),
    abs: (p) => (isAbsolute(p) ? p : resolve(specDir, p)),
  };
}

// The opening deck: {title, goal, intro?, glossary?, cards, brief?, confidence?, batch?}.
export function normalizeDeck(raw, { specDir = process.cwd() } = {}) {
  const issues = [];
  const ctx = context(raw, specDir, issues);
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.cards) || raw.cards.length === 0) {
    ctx.add("error", "cards", 'expected { "cards": [ ... ] } with at least one card');
    return { deck: null, issues };
  }
  const cards = normalizeCards(raw.cards, "cards", ctx, new Set());
  if (!str(raw.goal)) ctx.add("warn", "goal", "no goal — one line on what the interview is about heads the brief");
  const deck = {
    mode: "swipe",
    lang: ctx.lang,
    title: str(raw.title) || ctx.w.round,
    goal: str(raw.goal),
    intro: str(raw.intro),
    glossary: raw.glossary && typeof raw.glossary === "object" ? raw.glossary : {},
    cards,
    brief: normalizeBrief(raw.brief, ctx),
    confidence: clampPct(raw.confidence) ?? 0,
    batch: clampBatch(raw.batch) ?? BATCH_DEFAULT,
    done: false,
  };
  return { deck, issues };
}

// Cards for push: same rules, ids checked against the ones the deck already has.
export function normalizePatch(raw, { specDir = process.cwd(), lang } = {}) {
  const issues = [];
  const ctx = context({ lang, ...raw }, specDir, issues);
  const patch = {
    add: normalizeCards(list(raw?.add), "add", ctx, new Set()),
    replace: normalizeCards(list(raw?.replace), "replace", ctx, new Set()),
    remove: list(raw?.remove).map(String),
    position: raw?.position === "next" ? "next" : "end",
  };
  for (const key of ["add", "replace"]) {
    list(raw?.[key]).forEach((c, i) => str(c?.id) || ctx.add("error", `${key}[${i}]`, "a pushed card needs an id"));
  }
  if (raw?.brief !== undefined) patch.brief = normalizeBrief(raw.brief, ctx);
  if (raw?.goal !== undefined) patch.goal = str(raw.goal);
  if (raw?.confidence !== undefined) patch.confidence = clampPct(raw.confidence);
  if (raw?.batch !== undefined) patch.batch = clampBatch(raw.batch);
  if (raw?.done !== undefined) patch.done = raw.done === true;
  return { patch, issues };
}

function normalizeCards(raw, path, ctx, seen) {
  return raw.map((c, i) => {
    const where = `${path}[${i}]${c?.id ? ` (${c.id})` : ""}`;
    const card = normalizeCard(c || {}, i, where, ctx);
    if (seen.has(card.id)) ctx.add("error", where, `duplicate card id "${card.id}"`);
    seen.add(card.id);
    return card;
  });
}

function normalizeCard(c, i, where, ctx) {
  const id = str(c.id) || `c${i + 1}`;
  if (c.options !== undefined) ctx.add("error", where, "a swipe card has exactly two sides: left and right, not options");
  for (const side of SIDES) {
    if (!c[side] || (typeof c[side] !== "string" && !str(c[side].label))) ctx.add("error", where, `"${id}" needs a ${side} side with a label`);
  }
  const rec = str(c.recommended);
  if (rec && !SIDES.includes(rec)) ctx.add("warn", where, `recommended must be "left" or "right", got "${rec}"`);
  if (!str(c.title)) ctx.add("error", where, `"${id}" needs a title: the question`);
  if (str(c.title).length > TITLE_MAX) ctx.add("warn", where, `title is ${str(c.title).length} chars — over ${TITLE_MAX}; ask the short question and move the rest to tldr or body`);
  if (str(c.body).length > BODY_MAX) ctx.add("warn", where, `body is ${str(c.body).length} chars — over ${BODY_MAX} slows the deck; split the card or ask it in /decide`);
  const card = {
    id,
    section: str(c.section),
    title: str(c.title) || ctx.w.question,
    tldr: str(c.tldr),
    body: str(c.body),
    recommended: SIDES.includes(rec) ? rec : null,
    reason: str(c.reason),
    from: str(c.from) || null,
    stakes: c.stakes === "high" ? "high" : null,
    ...collectMedia(c, where, ctx),
    left: normalizeSide(c.left, `${where}.left`, ctx),
    right: normalizeSide(c.right, `${where}.right`, ctx),
  };
  lintMedia(card, where, ctx);
  shareScale([card.left.chart, card.right.chart]);
  return card;
}

// A card shows its own media above both sides, and each side's media inside a half-width tile.
const HEAVY = ["preview", "diff", "table"];
function lintMedia(card, where, ctx) {
  const own = mediaKinds(card);
  for (const side of SIDES) {
    const kinds = mediaKinds(card[side]);
    if (card[side].preview && card.preview) ctx.add("warn", `${where}.${side}`, "the card already has a preview — two live mockups on one card don't fit; keep one, or give each side a picture");
    const heavy = kinds.filter((k) => HEAVY.includes(k));
    if (heavy.length > 1) ctx.add("warn", `${where}.${side}`, `${heavy.join(" + ")} in one side tile is too much to read in a swipe; keep one`);
    if (card[side].diff && card.diff) ctx.add("warn", `${where}.${side}`, "the card already has a diff; put each side's version in the card's diff (before/after) instead");
  }
  const sideKinds = SIDES.map((s) => mediaKinds(card[s]));
  if (own.length > 2) ctx.add("warn", where, `${own.join(", ")} on one card — a swipe card shows one or two things; move the rest to the sides or to /decide`);
  if (sideKinds[0].length && !sideKinds[1].length && sideKinds[0].some((k) => k !== "images")) ctx.add("warn", where, "only the left side has media — show the right side the same way so the two compare");
  if (sideKinds[1].length && !sideKinds[0].length && sideKinds[1].some((k) => k !== "images")) ctx.add("warn", where, "only the right side has media — show the left side the same way so the two compare");
}

function normalizeSide(s, where, ctx) {
  const side = typeof s === "string" ? { label: s } : s || {};
  return { label: str(side.label) || "—", detail: str(side.detail), ...collectMedia(side, where, ctx) };
}

function normalizeBrief(raw, ctx) {
  return list(raw)
    .map((item, i) => (typeof item === "string" ? { text: item } : item || {}))
    .filter((item) => str(item.text))
    .map((item, i) => {
      const kind = str(item.kind) || "decision";
      if (!KINDS.includes(kind)) ctx.add("warn", `brief[${i}]`, `unknown kind "${kind}" (use ${KINDS.join(", ")})`);
      return { id: str(item.id) || null, kind: KINDS.includes(kind) ? kind : "note", text: str(item.text), cards: list(item.cards).map(String) };
    });
}

// Applies a push to the deck. Answered cards are history: they can't be
// replaced or removed, only followed by new cards. The front card is the one
// on the user's screen: it stays as it is, and "next" cards go right behind it.
export function applyPatch(deck, answered, patch, { front = null } = {}) {
  const issues = [];
  const add = (message) => issues.push({ level: "warn", where: "push", message });
  let cards = deck.cards.slice();
  const ids = new Set(cards.map((c) => c.id));

  for (const card of patch.replace) {
    const i = cards.findIndex((c) => c.id === card.id);
    if (i < 0) add(`replace: no card "${card.id}" — use add`);
    else if (answered.has(card.id)) add(`replace: "${card.id}" is already answered — add a new card instead`);
    else if (card.id === front) add(`replace: "${card.id}" is on the user's screen right now — add a follow-up card instead`);
    else cards[i] = { ...card, rev: (cards[i].rev || 0) + 1 };
  }
  for (const id of patch.remove) {
    if (!ids.has(id)) add(`remove: no card "${id}"`);
    else if (answered.has(id)) add(`remove: "${id}" is already answered`);
    else if (id === front) add(`remove: "${id}" is on the user's screen right now`);
    else cards = cards.filter((c) => c.id !== id);
  }
  const fresh = [];
  for (const card of patch.add) {
    if (ids.has(card.id)) add(`add: card "${card.id}" exists — use replace, or pick a new id`);
    else {
      ids.add(card.id);
      fresh.push(card);
    }
  }
  if (patch.position === "next") {
    const f = front && !answered.has(front) ? cards.findIndex((c) => c.id === front) : -1;
    const at = f >= 0 ? f + 1 : cards.findIndex((c) => !answered.has(c.id));
    cards.splice(at < 0 ? cards.length : at, 0, ...fresh);
  } else cards.push(...fresh);

  const next = { ...deck, cards };
  for (const key of ["brief", "goal", "confidence", "batch", "done"]) {
    if (patch[key] !== undefined && patch[key] !== null) next[key] = patch[key];
  }
  if (fresh.length) next.done = patch.done === true;
  return { deck: next, issues, added: fresh.length };
}

// side "own" is the user's own answer, typed instead of either side.
export const OWN_MAX = 2000;
// The closing note, and the note sent with "Dig deeper".
export const NOTE_MAX = 4000;
// One line in the digest and the brief: an own answer may span several.
const oneLine = (text) => String(text || "").replace(/\s*\n\s*/g, " / ");
export const sideLabel = (card, side, text) => (side === "skip" ? null : side === "own" ? text || "" : card?.[side]?.label ?? side);

function answerLine(card, entry, n) {
  const title = card?.title || entry.card;
  if (entry.undo) return `${n}. [${entry.card}] ${title} → taken back (the card is open again)`;
  if (entry.side === "skip") return `${n}. [${entry.card}] ${title} → skipped`;
  if (entry.side === "own") return `${n}. [${entry.card}] ${title} → their own answer, neither side: «${oneLine(entry.text)}»`;
  const rec = card?.recommended ? (card.recommended === entry.side ? " ★" : " (against the recommendation)") : "";
  return `${n}. [${entry.card}] ${title} → ${sideLabel(card, entry.side)} (${entry.side})${rec}`;
}

// What the agent reads after each batch: only what changed since the last one.
export function batchDigest(deck, entries) {
  const byId = new Map(deck.cards.map((c) => [c.id, c]));
  return entries.map((e, i) => answerLine(byId.get(e.card), e, i + 1)).join("\n");
}

// Every card the user answered, in deck order.
export function finalDigest(deck, answers) {
  const lines = deck.cards.filter((c) => answers[c.id]).map((c, i) => answerLine(c, { card: c.id, ...answers[c.id] }, i + 1));
  return lines.join("\n");
}

export function deckStats(deck, answers) {
  const answered = deck.cards.filter((c) => answers[c.id]).length;
  return { total: deck.cards.length, answered, left: deck.cards.length - answered, skipped: deck.cards.filter((c) => answers[c.id]?.side === "skip").length };
}

// The brief the user takes away: the agent's points, then every answer.
export function briefMarkdown(deck, answers, { note = "" } = {}) {
  const w = words(deck.lang).brief;
  const out = [`# ${deck.title}`, ""];
  if (deck.goal) out.push(`**${w.goal}:** ${deck.goal}`, "");
  out.push(`_${w.confidence(deck.confidence)}_`, "");
  if (note) out.push(`## ${w.note}`, "", ...note.split("\n").map((l) => `> ${l}`.trimEnd()), "");
  for (const kind of KINDS) {
    const items = deck.brief.filter((b) => b.kind === kind);
    if (!items.length) continue;
    out.push(`## ${w.kinds[kind]}`, "", ...items.map((b) => `- ${b.text}`), "");
  }
  const answered = deck.cards.filter((c) => answers[c.id]);
  if (answered.length) {
    out.push(`## ${w.answers}`, "");
    for (const c of answered) {
      const { side, text } = answers[c.id];
      out.push(`- ${c.title} → ${side === "skip" ? `_${w.skipped}_` : side === "own" ? `«${oneLine(text)}»` : c[side].label}`);
    }
    out.push("");
  }
  return out.join("\n");
}
