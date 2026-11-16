// journal.mjs — the project's decision log: one JSON line per answered round,
// so later rounds (and later sessions) can see what was already decided. A
// decision that no longer holds gets a "supersede" line instead of an edit:
// the file only grows, and reading it folds those lines into the entries. Reading also takes in the
// journals of a project's legacy dirs (2.x data dirs of the same repository); writing never goes there.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { answerText } from "../ui/js/logic.js";
import { JOURNAL_FORMAT, migrateEntry } from "./migrate.mjs";
import { answerText as cardAnswer } from "./swipe.mjs";

export const journalPath = (dataDir) => join(dataDir, "journal.jsonl");

// What reads take: a project ({ dataDir, legacyDirs }, as openProject returns it), or just a data dir.
const projectOf = (p) => (typeof p === "string" ? { dataDir: p, legacyDirs: [] } : p);

const oneLine = (text) => String(text).replace(/\s*\n\s*/g, " / ");

// One record per question (per answered card of a deck): a stable id, the title, and the answer as
// the agent read it in the tool result.
function recordsOf(round, result) {
  if (round.mode === "swipe") {
    return round.spec.cards
      .filter((c) => result.answers?.[c.id])
      .map((c) => {
        const a = result.answers[c.id];
        return { id: `${result.round}/${c.id}`, title: c.title, answer: oneLine(cardAnswer(c, { card: c.id, ...a, text: a.text ?? a.label })), ...(a.side === "skip" ? { flag: "skip" } : {}) };
      });
  }
  // A question put off ("later") is a deferred decision: it keeps its revisit condition.
  return round.spec.questions.map((q) => {
    const r = result.answers?.[q.id];
    const deferred = r?.flag === "later" ? { deferred: true, ...(r.revisit ? { revisit: oneLine(r.revisit) } : {}) } : {};
    return { id: `${result.round}/${q.id}`, title: q.title, answer: r ? oneLine(answerText(q, r)) : "—", ...(r?.flag ? { flag: r.flag } : {}), ...deferred, ...(r?.condition ? { condition: oneLine(r.condition) } : {}) };
  });
}

// The links a round declares, as the spec wrote them (resolved later, when the journal is read): a question's
// `dependsOn`, and the `showIf` rules, where the question asked about is what the later one hangs on.
// ref is a record id ("round/q"), a question id of this round, or a round id.
export function edgesOf(round) {
  if (round.mode === "swipe") {
    return round.spec.cards.filter((c) => c.from).map((c) => ({ from: c.from, to: c.id, kind: "dependsOn" }));
  }
  const out = [];
  for (const q of round.spec.questions) {
    for (const ref of q.dependsOn || []) out.push({ from: ref, to: q.id, kind: "dependsOn" });
    for (const c of q.showIf || []) if (c.q) out.push({ from: c.q, to: q.id, kind: "rule" });
  }
  return out;
}

// Only ever to the project's own data dir, never to a legacy one.
export function appendJournal(dataDir, round, result) {
  if (!dataDir || result.cancelled) return;
  const entry = {
    at: result.submittedAt,
    round: result.round,
    title: result.title,
    mode: round.mode === "swipe" ? "swipe" : "questions",
    project: round.project || undefined,
    source: result.source || undefined,
    spec: round.specFile || undefined,
    answers: round.outPath,
    questions: (round.mode === "swipe" ? round.spec.cards.filter((c) => result.answers?.[c.id]) : round.spec.questions).map((q) => q.title),
    digest: result.digest || "",
    format: JOURNAL_FORMAT,
    records: recordsOf(round, result),
    ...(edgesOf(round).length ? { edges: edgesOf(round) } : {}),
  };
  appendFileSync(journalPath(dataDir), `${JSON.stringify(entry)}\n`);
}

// Marks an earlier round's decision as no longer holding; by: the round that replaced it, if any.
// The decision may live in a legacy dir; the line is written to the project's own.
export function supersedeJournal(project, { round, by = "", reason = "" }) {
  project = projectOf(project);
  const all = readAll(project);
  const target = all.find((e) => e.round === round);
  if (!target) throw Object.assign(new Error(`no decision with round id "${round}" in this project's journal`), { user: true });
  if (by && by === round) throw Object.assign(new Error("a round can't supersede itself"), { user: true });
  if (by && !all.some((e) => e.round === by)) throw Object.assign(new Error(`no decision with round id "${by}" in this project's journal`), { user: true });
  const line = { type: "supersede", round, by: by || undefined, reason: String(reason || "").trim().slice(0, 1000) || undefined, at: new Date().toISOString() };
  appendFileSync(journalPath(project.dataDir), `${JSON.stringify(line)}\n`);
  return { ...target, superseded: { by: line.by, reason: line.reason, at: line.at } };
}

// The entries and supersede lines of one directory, in file order. A line that does not parse is skipped.
function readDir(dir) {
  const file = journalPath(dir);
  const entries = [];
  const marks = [];
  if (!existsSync(file)) return { entries, marks };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (item?.type === "supersede") marks.push(item);
    else if (item && typeof item === "object") entries.push(migrateEntry(item));
  }
  return { entries, marks };
}

// Every decision, oldest first, with supersede lines folded in. The project's own journal and each legacy
// dir's are read; a round id found in several is kept once, from the project's own dir first.
function readAll(project) {
  const dirs = [project.dataDir, ...(project.legacyDirs || [])];
  const read = dirs.map(readDir);
  const seen = new Set();
  let entries = [];
  const byRound = new Map();
  for (const { entries: es } of read) {
    for (const e of es) {
      if (dirs.length > 1 && seen.has(e.round)) continue;
      seen.add(e.round);
      entries.push(e);
      byRound.set(e.round, e);
    }
  }
  // The earlier journals come first when the lines are folded, the project's own last: its word is the latest.
  for (const { marks } of [...read].reverse()) {
    for (const m of marks) {
      const e = byRound.get(m.round);
      if (e) e.superseded = { by: m.by, reason: m.reason, at: m.at };
    }
  }
  if (dirs.length > 1) entries = entries.map((e, i) => ({ e, i })).sort((a, b) => String(a.e.at).localeCompare(String(b.e.at)) || a.i - b.i).map((x) => x.e);
  return entries;
}

// One decision by round id, however old.
export const findDecision = (project, round) => readAll(projectOf(project)).find((e) => e.round === round) || null;

// Newest first. query matches title, questions and digest, case-insensitive.
// status: "all" (default), "live" or "superseded"; mode: "questions" or "swipe".
export function readJournal(project, { limit = 20, query = "", status = "all", mode = "" } = {}) {
  const needle = String(query).trim().toLowerCase();
  const out = [];
  for (const entry of readAll(projectOf(project)).reverse()) {
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

// ---- deferred decisions: questions the user put off with "Later"

// Every deferred question of a decision that still holds, newest first: {id, round, qid, title, revisit, at, entry}.
export function deferredDecisions(project, { limit = 50 } = {}) {
  const out = [];
  for (const entry of readJournal(project, { limit: 500, status: "live" })) {
    for (const r of entry.records || []) {
      if (!r?.deferred) continue;
      out.push({ id: r.id, round: entry.round, qid: String(r.id || "").split("/").slice(1).join("/"), title: r.title, revisit: r.revisit || "", at: entry.at, entry });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

const deferredLine = (d) => `- [${d.id}] ${d.title}${d.revisit ? ` — revisit when: ${d.revisit}` : ""} (round ${d.round} «${d.entry.title}», ${String(d.at).slice(0, 10)})`;

export function formatDeferred(list, heading = "Deferred decisions (the user said «later»; nothing reminds you of them):") {
  return list.length ? [heading, ...list.map(deferredLine)].join("\n") : "";
}

// Deferred decisions that touch a new round: the same question id, or two shared topic words (half of the
// shorter text's), as overlaps judges live decisions. questions: [{id, title}].
export function deferredOverlaps(project, questions, { limit = 5 } = {}) {
  const hits = [];
  for (const d of deferredDecisions(project, { limit: 500 })) {
    const b = topicWords(d.title);
    const touches = questions.some((q) => {
      if (q.id && q.id === d.qid && !/^q\d+$/.test(q.id)) return true; // q1, q2…: default ids say nothing
      const a = topicWords(q.title);
      const shared = [...a].filter((w) => b.has(w)).length;
      return shared >= 2 && shared / Math.min(a.size, b.size) >= 0.5;
    });
    if (touches) hits.push(d);
    if (hits.length >= limit) break;
  }
  return hits;
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

// An index of the live decisions: for each question its words, and for each word the questions that have it.
// Built once per call from the journal; a text then looks only at the questions that share a word with it.
export function overlapIndex(project) {
  const live = readJournal(project, { limit: 500, status: "live" });
  const items = [];
  const byWord = new Map();
  for (const entry of live) {
    const ids = new Map((entry.records || []).map((r) => [r.title, String(r.id || "").split("/").pop()]));
    for (const question of entry.questions || []) {
      const words = topicWords(question);
      const item = { entry, question, words, n: items.length, qid: ids.get(question) || "" };
      items.push(item);
      for (const w of words) {
        const list = byWord.get(w);
        if (list) list.push(item);
        else byWord.set(w, [item]);
      }
    }
  }
  return { items, byWord };
}

// Live decisions whose questions share most of their words with one of these texts. A text may be { id, text }:
// the same question id as the earlier one lowers the bar a little.
export function overlaps(project, texts, { limit = 5, index = overlapIndex(project) } = {}) {
  const hits = [];
  for (const raw of texts) {
    const text = typeof raw === "string" ? raw : raw.text;
    const id = typeof raw === "string" ? "" : String(raw.id || "");
    const a = topicWords(text);
    if (a.size < 2) continue;
    const counts = new Map();
    for (const w of a) for (const item of index.byWord.get(w) || []) counts.set(item, (counts.get(item) || 0) + 1);
    const seen = new Set();
    for (const [item, shared] of [...counts].sort((x, y) => x[0].n - y[0].n)) {
      const need = id && item.qid === id ? 0.34 : 0.5;
      if (shared < 2 || shared / Math.min(a.size, item.words.size) < need) continue;
      if (seen.has(item.entry.round)) continue;
      seen.add(item.entry.round);
      if (!hits.some((h) => h.entry.round === item.entry.round && h.question === item.question)) hits.push({ text, entry: item.entry, question: item.question });
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

// ---- the decision map: the records as nodes, and the edges from dependsOn, rules and supersede.

// entries: journal entries (superseded folded in). A ref is resolved in this order: a record id, a question of the
// same round, a round id (its first record), any record whose question id matches. What resolves to nothing is dropped.
// Above `max` nodes the map shows the neighbourhood of `round` (one step each way), or, with no round, the newest
// `max` records; `trimmed` says so.
export function buildGraph(entries, { round = "", max = 40 } = {}) {
  const sorted = entries.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const nodes = new Map();
  const firstOf = new Map();
  for (const e of sorted) {
    for (const r of e.records || []) {
      nodes.set(r.id, { id: r.id, title: r.title, round: e.round, at: e.at, superseded: Boolean(e.superseded), flag: r.flag });
      if (!firstOf.has(e.round)) firstOf.set(e.round, r.id);
    }
  }
  const resolve = (ref, entry) => {
    if (nodes.has(ref)) return ref;
    if (nodes.has(`${entry.round}/${ref}`)) return `${entry.round}/${ref}`;
    if (firstOf.has(ref)) return firstOf.get(ref);
    for (const id of [...nodes.keys()].reverse()) if (id.endsWith(`/${ref}`)) return id;
    return null;
  };
  const edges = [];
  const seen = new Set();
  const add = (from, to, kind) => {
    if (!from || !to || from === to) return;
    const key = `${from}>${to}>${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind });
  };
  for (const e of sorted) {
    for (const ed of e.edges || []) add(resolve(ed.from, e), resolve(ed.to, e), ed.kind);
    if (e.superseded?.by) add(firstOf.get(e.superseded.by), firstOf.get(e.round), "supersede");
  }
  let keep = [...nodes.keys()];
  let trimmed = null;
  if (keep.length > max) {
    if (round && firstOf.has(round)) {
      const own = new Set([...nodes.values()].filter((n) => n.round === round).map((n) => n.id));
      const near = new Set(own);
      for (const ed of edges) {
        if (own.has(ed.from)) near.add(ed.to);
        if (own.has(ed.to)) near.add(ed.from);
      }
      keep = [...near].slice(0, max);
      trimmed = { round };
    } else {
      keep = keep.slice(-max);
      trimmed = { newest: max };
    }
  }
  const set = new Set(keep);
  return { nodes: keep.map((id) => nodes.get(id)), edges: edges.filter((ed) => set.has(ed.from) && set.has(ed.to)), total: nodes.size, trimmed };
}

const label = (s) => String(s).replace(/["\n\r\[\]{}()<>|#;`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) || "—";

// The graph as a Mermaid flowchart: superseded nodes are dashed, a supersede edge is dotted, a rule edge is labelled.
export function graphMermaid(graph) {
  if (!graph.nodes.length) return "";
  const ids = new Map(graph.nodes.map((n, i) => [n.id, `n${i}`]));
  const lines = ["flowchart LR"];
  for (const n of graph.nodes) lines.push(`  ${ids.get(n.id)}["${label(n.title)}"]${n.superseded ? ":::old" : ""}`);
  for (const ed of graph.edges) {
    const arrow = ed.kind === "supersede" ? "-. supersedes .->" : ed.kind === "rule" ? "-- if -->" : "-->";
    lines.push(`  ${ids.get(ed.from)} ${arrow} ${ids.get(ed.to)}`);
  }
  lines.push("  classDef old stroke-dasharray: 4 3,opacity:0.6");
  return lines.join("\n");
}
