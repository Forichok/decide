// logic.js — pure answer logic shared by the page and the Node client.
// An "answer" is the page state of one question; finalizeAnswers() strips it
// down to what the agent reads. The digest is always in English: it is for
// the agent, whatever language the page and the questions are in.

import { recommendedIds } from "./types/shared.js";
import { typeOf } from "./types/index.js";

export { recommendedIds };

export const FLAGS = {
  explain: "explain in more detail",
  delegate: "up to the agent",
  skip: "skipped",
};

// The common fields of a blank answer; the type adds what it owns (selected, order…).
export function emptyAnswer(q) {
  return { selected: [], other: "", note: "", attachments: [], pins: [], order: [], value: null, text: "", flag: null, touched: false, ...typeOf(q).emptyAnswer(q) };
}

export function isVisible(q, answers) {
  return q.showIf.every((c) => {
    const sel = answers[c.q]?.selected || [];
    if (c.in.length && !c.in.some((id) => sel.includes(id))) return false;
    return !c.notIn.some((id) => sel.includes(id));
  });
}

export const isAnswered = (q, a) => Boolean(a) && typeOf(q).isAnswered(q, a);

// A question marked mine waits for the user's own answer: handing it to the agent doesn't resolve it.
export function isResolved(q, a) {
  if (q.mine && a?.flag === "delegate") return isAnswered(q, a);
  return q.optional || Boolean(a?.flag) || isAnswered(q, a);
}

// Visible required questions marked mine that still have no answer: Done waits for them.
export const missingMine = (spec, answers) => visibleQuestions(spec, answers).filter((q) => q.mine && !q.optional && !isResolved(q, answers[q.id]));

export function visibleQuestions(spec, answers) {
  return spec.questions.filter((q) => isVisible(q, answers));
}

export function progress(spec, answers) {
  const visible = visibleQuestions(spec, answers).filter((q) => !q.optional);
  return { resolved: visible.filter((q) => isResolved(q, answers[q.id])).length, total: visible.length };
}

export function withRecommendation(q, a) {
  return typeOf(q).recommend?.(q, a, recommendedIds(q)) ?? a;
}

// Build the agent-facing answers map. fill decides what happens to unresolved
// required questions: "recommend" (or true) takes the recommendation and marks
// them { flag: "delegate", auto: true }; "skip" leaves them open as
// { flag: "skip", auto: true }.
export function finalizeAnswers(spec, answers, { fill = false } = {}) {
  const out = {};
  for (const q of visibleQuestions(spec, answers)) {
    let a = answers[q.id] || emptyAnswer(q);
    let auto = false;
    if (fill && !isResolved(q, a)) {
      // The recommendation is never filled in for a question the user must answer themselves.
      a = fill === "skip" || q.mine ? { ...a, flag: "skip" } : { ...withRecommendation(q, a), flag: "delegate" };
      auto = true;
    }
    const r = compact(q, a);
    if (auto) r.auto = true;
    if (Object.keys(r).length || q.type !== "text") out[q.id] = r;
  }
  return out;
}

function compact(q, a) {
  // The type keeps what is its own; the picked options come first, as they always did.
  const { selected, ...own } = typeOf(q).compact?.(q, a) ?? {};
  const r = {};
  if (selected) r.selected = selected;
  if (a.other.trim()) r.other = a.other.trim();
  Object.assign(r, own);
  if (a.note.trim()) r.note = a.note.trim();
  if (a.attachments.length) r.attachments = [...a.attachments];
  // Notes pinned on a mockup: where (in % of the frame, and at which layout width) and what.
  if (a.pins?.length) r.pins = a.pins.map(({ src, x, y, width, text }) => ({ file: fileName(src), x, y, ...(width ? { width } : {}), text }));
  if (a.flag) r.flag = a.flag;
  return r;
}

const fileName = (src) => {
  // An exported file carries its pictures as data: URIs with the original name kept in a parameter.
  const named = String(src || "").match(/^data:[^,]*;name=([^;,]+)/);
  if (named) return decodeURIComponent(named[1]);
  const last = String(src || "").split(/[?#]/)[0].split("/").pop();
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

// The digest's wording. The page passes its own translation of the same keys.
const WORDS = {
  explain: `❓ ${FLAGS.explain}`,
  skip: `⏭ ${FLAGS.skip}`,
  delegate: `🤝 ${FLAGS.delegate}`,
  autoSkip: "⏭ no answer, left open",
  autoDelegate: "🤝 no answer → the recommendation",
  against: (recs) => `(against the recommendation: ${recs})`,
  own: (text) => `own option: "${text}"`,
};

export function describe(q, r, w = WORDS) {
  if (!r) return "—";
  const parts = [];
  if (r.flag === "explain") parts.push(w.explain);
  if (r.flag === "skip") parts.push(r.auto ? w.autoSkip : w.skip);
  if (r.flag === "delegate") parts.push(r.auto ? w.autoDelegate : w.delegate);
  const own = typeOf(q).describe(q, r, w);
  if (own) parts.push(own);
  return parts.join(" · ") || "—";
}

export function digest(spec, result) {
  const lines = [];
  const answers = result.answers || {};
  let n = 0;
  for (const q of spec.questions) {
    const r = answers[q.id];
    if (!r) continue;
    n += 1;
    lines.push(`${n}. [${q.id}] ${q.title} → ${describe(q, r)}${q.mine && r.flag === "skip" ? " (theirs to decide: don't pick for them)" : ""}`);
    if (r.note) lines.push(`   ✎ ${r.note.replace(/\n/g, "\n     ")}`);
    for (const f of r.attachments || []) lines.push(`   📎 ${f}`);
    for (const p of r.pins || []) lines.push(`   📍 ${p.file}${p.width ? ` at ${p.width}px` : ""} (x ${p.x}%, y ${p.y}%): ${p.text}`);
  }
  if (spec.leftOut?.length) lines.push(`Not asked, to fit the user's ${spec.budget}-minute budget: ${spec.leftOut.map((q) => `[${q.id}] ${q.title}`).join("; ")}`);
  if (result.comment) lines.push(`Comment: ${result.comment}`);
  for (const f of result.attachments || []) lines.push(`📎 ${f}`);
  return lines.join("\n");
}
