// logic.js — pure answer logic shared by the page and the Node client.
// An "answer" is the page state of one question; finalizeAnswers() strips it
// down to what the agent reads. The digest is always in English: it is for
// the agent, whatever language the page and the questions are in.

export const FLAGS = {
  explain: "explain in more detail",
  delegate: "up to the agent",
  skip: "skipped",
};

export function emptyAnswer(q) {
  const order = q.type === "rank" ? orderFrom(q) : [];
  const selected = q.type === "rank" ? [] : q.default.filter((id) => q.options.some((o) => o.id === id));
  return { selected, other: "", note: "", attachments: [], order, value: null, text: "", flag: null, touched: false };
}

function orderFrom(q) {
  const ids = q.options.map((o) => o.id);
  const head = q.default.filter((id) => ids.includes(id));
  return [...head, ...ids.filter((id) => !head.includes(id))];
}

export function isVisible(q, answers) {
  return q.showIf.every((c) => {
    const sel = answers[c.q]?.selected || [];
    if (c.in.length && !c.in.some((id) => sel.includes(id))) return false;
    return !c.notIn.some((id) => sel.includes(id));
  });
}

export function isAnswered(q, a) {
  if (!a) return false;
  switch (q.type) {
    case "rank":
      return a.touched;
    case "scale":
      return Number.isFinite(a.value);
    case "text":
      return a.text.trim().length > 0;
    case "multi":
      return a.selected.length + (a.other.trim() ? 1 : 0) >= Math.max(1, q.min);
    default:
      return a.selected.length > 0 || a.other.trim().length > 0;
  }
}

export function isResolved(q, a) {
  return q.optional || Boolean(a?.flag) || isAnswered(q, a);
}

export const recommendedIds = (q) => q.options.filter((o) => o.recommended).map((o) => o.id);

export function visibleQuestions(spec, answers) {
  return spec.questions.filter((q) => isVisible(q, answers));
}

export function progress(spec, answers) {
  const visible = visibleQuestions(spec, answers).filter((q) => !q.optional);
  return { resolved: visible.filter((q) => isResolved(q, answers[q.id])).length, total: visible.length };
}

export function withRecommendation(q, a) {
  const rec = recommendedIds(q);
  if (q.type === "rank") return { ...a, touched: true };
  if (!rec.length) return a;
  return { ...a, selected: q.type === "single" || q.type === "confirm" ? rec.slice(0, 1) : rec, other: "" };
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
      a = fill === "skip" ? { ...a, flag: "skip" } : { ...withRecommendation(q, a), flag: "delegate" };
      auto = true;
    }
    const r = compact(q, a);
    if (auto) r.auto = true;
    if (Object.keys(r).length || q.type !== "text") out[q.id] = r;
  }
  return out;
}

function compact(q, a) {
  const r = {};
  if (["single", "multi", "confirm"].includes(q.type)) r.selected = [...a.selected];
  if (a.other.trim()) r.other = a.other.trim();
  if (q.type === "rank" && (a.touched || (a.flag && a.flag !== "skip"))) r.order = [...a.order];
  if (q.type === "scale" && Number.isFinite(a.value)) r.value = a.value;
  if (q.type === "text" && a.text.trim()) r.text = a.text.trim();
  if (a.note.trim()) r.note = a.note.trim();
  if (a.attachments.length) r.attachments = [...a.attachments];
  if (a.flag) r.flag = a.flag;
  return r;
}

const label = (q, id) => q.options.find((o) => o.id === id)?.label ?? id;

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
  const rec = recommendedIds(q);
  if (r.selected?.length) {
    const picked = r.selected.map((id) => label(q, id)).join(", ");
    const same = rec.length && r.selected.every((id) => rec.includes(id));
    const against = rec.length && !r.selected.some((id) => rec.includes(id));
    parts.push(
      picked + (same ? " ★" : against ? ` ${w.against(rec.map((id) => label(q, id)).join(", "))}` : ""),
    );
  }
  if (r.other) parts.push(w.own(r.other));
  if (r.order) parts.push(r.order.map((id) => label(q, id)).join(" > "));
  if (r.value != null) {
    const hint = q.scale?.labels?.[r.value];
    parts.push(`${r.value}/${q.scale?.max ?? ""}${hint ? ` "${hint}"` : ""}`);
  }
  if (r.text) parts.push(`"${r.text}"`);
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
    lines.push(`${n}. [${q.id}] ${q.title} → ${describe(q, r)}`);
    if (r.note) lines.push(`   ✎ ${r.note.replace(/\n/g, "\n     ")}`);
    for (const f of r.attachments || []) lines.push(`   📎 ${f}`);
  }
  if (result.comment) lines.push(`Comment: ${result.comment}`);
  for (const f of result.attachments || []) lines.push(`📎 ${f}`);
  return lines.join("\n");
}
