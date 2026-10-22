// journal.mjs — the project's decision log: one JSON line per answered round,
// so later rounds (and later sessions) can see what was already decided. A
// decision that no longer holds gets a "supersede" line instead of an edit:
// the file only grows, and reading it folds those lines into the entries.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const journalPath = (dataDir) => join(dataDir, "journal.jsonl");

export function appendJournal(dataDir, round, result) {
  if (!dataDir || result.cancelled) return;
  const entry = {
    at: result.submittedAt,
    round: result.round,
    title: result.title,
    mode: round.mode === "swipe" ? "swipe" : "questions",
    source: result.source || undefined,
    spec: round.specFile || undefined,
    answers: round.outPath,
    questions: (round.mode === "swipe" ? round.spec.cards.filter((c) => result.answers?.[c.id]) : round.spec.questions).map((q) => q.title),
    digest: result.digest || "",
  };
  appendFileSync(journalPath(dataDir), `${JSON.stringify(entry)}\n`);
}

// Marks an earlier round's decision as no longer holding; by: the round that replaced it, if any.
export function supersedeJournal(dataDir, { round, by = "", reason = "" }) {
  const all = readAll(dataDir);
  const target = all.find((e) => e.round === round);
  if (!target) throw Object.assign(new Error(`no decision with round id "${round}" in this project's journal`), { user: true });
  if (by && by === round) throw Object.assign(new Error("a round can't supersede itself"), { user: true });
  if (by && !all.some((e) => e.round === by)) throw Object.assign(new Error(`no decision with round id "${by}" in this project's journal`), { user: true });
  const line = { type: "supersede", round, by: by || undefined, reason: String(reason || "").trim().slice(0, 1000) || undefined, at: new Date().toISOString() };
  appendFileSync(journalPath(dataDir), `${JSON.stringify(line)}\n`);
  return { ...target, superseded: { by: line.by, reason: line.reason, at: line.at } };
}

// Every decision, oldest first, with supersede lines folded in.
function readAll(dataDir) {
  const file = journalPath(dataDir);
  if (!existsSync(file)) return [];
  const entries = [];
  const byRound = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (item?.type === "supersede") {
      const e = byRound.get(item.round);
      if (e) e.superseded = { by: item.by, reason: item.reason, at: item.at };
      continue;
    }
    if (!item || typeof item !== "object") continue;
    entries.push(item);
    byRound.set(item.round, item);
  }
  return entries;
}

// Newest first. query matches title, questions and digest, case-insensitive.
// status: "all" (default), "live" or "superseded"; mode: "questions" or "swipe".
export function readJournal(dataDir, { limit = 20, query = "", status = "all", mode = "" } = {}) {
  const needle = String(query).trim().toLowerCase();
  const out = [];
  for (const entry of readAll(dataDir).reverse()) {
    if (status === "live" && entry.superseded) continue;
    if (status === "superseded" && !entry.superseded) continue;
    if (mode && (entry.mode || "questions") !== mode) continue;
    const text = [entry.title, ...(entry.questions || []), entry.digest].join("\n").toLowerCase();
    if (needle && !text.includes(needle)) continue;
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

export function formatJournal(entries) {
  if (!entries.length) return "No decisions recorded for this project yet.";
  return entries.map((e) => `## ${e.title} — ${e.at} · round ${e.round}${supersededLine(e)}\n${e.digest || "(no answers)"}`).join("\n\n");
}

const supersededLine = (e) =>
  e.superseded ? `\n_Superseded${e.superseded.by ? ` by round ${e.superseded.by}` : ""}${e.superseded.reason ? `: ${e.superseded.reason}` : ""}. It no longer holds._` : "";

// ---- overlap: is a new question about something a live decision already settled?

const STOP = new Set(
  "about above after again also another any are because been before being both but can could does doing down each every from have having here into its just like make many more most much must need only other over same should some such than that their them then there these they this those through under very want were what when where which while will with would your this that should дать для его если есть или как какой когда кто мы над нас нет нужно она они оно при про раз так также там тем то только чем что чтобы эта эти это этот".split(
    " ",
  ),
);

// Words of four letters or more, cut to six: rough stemming that also catches Russian endings.
export function topicWords(text) {
  const words = String(text || "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]{4,}/gu);
  return new Set((words || []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 6)));
}

// Live decisions whose questions share most of their words with one of these texts.
export function overlaps(dataDir, texts, { limit = 5 } = {}) {
  const live = readJournal(dataDir, { limit: 500, status: "live" });
  const hits = [];
  for (const text of texts) {
    const a = topicWords(text);
    if (a.size < 2) continue;
    for (const entry of live) {
      for (const q of entry.questions || []) {
        const b = topicWords(q);
        const shared = [...a].filter((w) => b.has(w)).length;
        if (shared >= 2 && shared / Math.min(a.size, b.size) >= 0.5) {
          if (!hits.some((h) => h.entry.round === entry.round && h.question === q)) hits.push({ text, entry, question: q });
          break;
        }
      }
    }
  }
  return hits.slice(0, limit);
}

export function formatOverlaps(hits) {
  if (!hits.length) return "";
  const lines = hits.map(({ text, entry, question }) => {
    const line = (entry.digest || "").split("\n").find((l) => l.includes(question)) || "";
    return `- «${text}» looks like «${question}», decided in round ${entry.round} «${entry.title}» (${entry.at.slice(0, 10)})${line ? `:\n  ${line.trim()}` : ""}`;
  });
  return [
    "Careful: this may contradict decisions that still hold:",
    ...lines,
    "If the user now decides otherwise, mark the old round superseded with the supersede tool (round = the old id, by = this round) once this round is answered. If it is the same question, use the earlier answer instead of asking again.",
  ].join("\n");
}
