// answers.mjs — answer files coming back from an exported page (export.mjs):
// check one against its round, and line several up to show where the people
// who answered disagree.

import { describe, digest } from "../ui/js/logic.js";

const FLAGS = new Set(["skip", "delegate", "explain"]);
const CHOICE = new Set(["single", "multi", "confirm"]);
const TEXT_MAX = 20_000;

const str = (v, max = TEXT_MAX) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

// Keeps what fits the round's questions; anything else is dropped with a warning.
export function checkAnswers(spec, file) {
  const errors = [];
  const warnings = [];
  if (!file || typeof file !== "object" || Array.isArray(file)) return { errors: ["not an answers file: expected a JSON object"], warnings, answers: {} };
  if (!file.answers || typeof file.answers !== "object" || Array.isArray(file.answers)) return { errors: ["not an answers file: no answers object"], warnings, answers: {} };
  const byId = new Map(spec.questions.map((q) => [q.id, q]));
  const answers = {};
  for (const [qid, raw] of Object.entries(file.answers)) {
    const q = byId.get(qid);
    if (!q) {
      warnings.push(`question "${qid}" is not in this round; dropped`);
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const ids = new Set(q.options.map((o) => o.id));
    const r = {};
    if (CHOICE.has(q.type) && Array.isArray(raw.selected)) {
      const bad = raw.selected.filter((id) => !ids.has(id));
      if (bad.length) warnings.push(`${qid}: unknown option ${bad.map((b) => `"${b}"`).join(", ")} dropped`);
      r.selected = raw.selected.filter((id) => ids.has(id));
      if (q.type !== "multi") r.selected = r.selected.slice(0, 1);
    }
    if (q.type === "rank" && Array.isArray(raw.order)) r.order = raw.order.filter((id) => ids.has(id));
    if (q.type === "scale" && Number.isFinite(raw.value)) r.value = Math.max(q.scale?.min ?? -Infinity, Math.min(q.scale?.max ?? Infinity, raw.value));
    if (q.type === "text" && str(raw.text)) r.text = str(raw.text);
    if (str(raw.other)) r.other = str(raw.other);
    if (str(raw.note)) r.note = str(raw.note);
    if (Array.isArray(raw.pins)) {
      r.pins = raw.pins
        .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && str(p.text, 2000))
        .slice(0, 50)
        .map((p) => ({ file: str(p.file, 200) || "", x: p.x, y: p.y, ...(Number.isFinite(p.width) ? { width: p.width } : {}), text: str(p.text, 2000) }));
      if (!r.pins.length) delete r.pins;
    }
    if (FLAGS.has(raw.flag)) r.flag = raw.flag;
    if (raw.auto === true) r.auto = true;
    // A question only the user may answer is never settled by someone else's auto-fill.
    if (q.mine && r.flag === "delegate") r.flag = "skip";
    answers[qid] = r;
  }
  if (!Object.keys(answers).length) errors.push("the file answers none of this round's questions");
  return { errors, warnings, answers };
}

// The comparable core of one answer: what was picked, ordered, rated or written.
function core(q, r) {
  // An auto-filled recommendation counts: by leaving the question, that person accepted it.
  if (!r || r.flag === "skip") return null;
  if (r.selected?.length) return `sel:${[...r.selected].sort().join(",")}${r.other ? `+${r.other.toLowerCase()}` : ""}`;
  if (r.order?.length) return `ord:${r.order.join(">")}`;
  if (r.value != null) return `val:${r.value}`;
  if (r.other) return `own:${r.other.toLowerCase()}`;
  return null;
}

// files: [{ name, answers, comment }] already checked. Returns per-question rows and the disagreements.
export function compareAnswers(spec, files) {
  const people = files.map((f, i) => f.name || `answer ${i + 1}`);
  const rows = [];
  for (const q of spec.questions) {
    const each = files.map((f) => f.answers[q.id]);
    if (each.every((r) => !r)) continue;
    const cores = each.map((r) => core(q, r)).filter(Boolean);
    const disagree = new Set(cores).size > 1;
    rows.push({ q, each, disagree });
  }
  return { people, rows, disagreements: rows.filter((r) => r.disagree) };
}

export function formatComparison(spec, files) {
  const { people, rows, disagreements } = compareAnswers(spec, files);
  const line = (q, each) => people.map((p, i) => `  - ${p}: ${describe(q, each[i])}${each[i]?.note ? ` — ${each[i].note.replace(/\n/g, " ")}` : ""}`).join("\n");
  const out = [`${people.length} people answered «${spec.title}»: ${people.join(", ")}.`];
  out.push(
    disagreements.length
      ? `They disagree on ${disagreements.length} question${disagreements.length === 1 ? "" : "s"}:\n${disagreements.map(({ q, each }) => `- ${q.title}\n${line(q, each)}`).join("\n")}`
      : "They agree on every question that more than one of them answered.",
  );
  const same = rows.filter((r) => !r.disagree);
  if (same.length) out.push(`Agreed or answered by one person:\n${same.map(({ q, each }) => `- ${q.title}\n${line(q, each)}`).join("\n")}`);
  for (const f of files.filter((f) => f.comment)) out.push(`${f.name || "Someone"} also wrote: ${f.comment}`);
  out.push("Nothing was settled: the round stays open. Ask the user how to resolve the disagreements, then import the agreed file (or ask again).");
  return out.join("\n\n");
}

// The digest of one checked file against a spec, for a round that is no longer open.
export const fileDigest = (spec, file) => digest(spec, { answers: file.answers, comment: file.comment });
