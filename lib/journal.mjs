// journal.mjs — the project's decision log: one JSON line per answered round,
// so later rounds (and later sessions) can see what was already decided.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const journalPath = (dataDir) => join(dataDir, "journal.jsonl");

export function appendJournal(dataDir, round, result) {
  if (!dataDir || result.cancelled) return;
  const entry = {
    at: result.submittedAt,
    round: result.round,
    title: result.title,
    source: result.source || undefined,
    answers: round.outPath,
    questions: round.spec.questions.map((q) => q.title),
    digest: result.digest || "",
  };
  appendFileSync(journalPath(dataDir), `${JSON.stringify(entry)}\n`);
}

// Newest first. query matches title, questions and digest, case-insensitive.
export function readJournal(dataDir, { limit = 20, query = "" } = {}) {
  const file = journalPath(dataDir);
  if (!existsSync(file)) return [];
  const needle = String(query).trim().toLowerCase();
  const entries = [];
  for (const line of readFileSync(file, "utf8").split("\n").reverse()) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const text = [entry.title, ...(entry.questions || []), entry.digest].join("\n").toLowerCase();
    if (needle && !text.includes(needle)) continue;
    entries.push(entry);
    if (entries.length >= limit) break;
  }
  return entries;
}

export function formatJournal(entries) {
  if (!entries.length) return "No decisions recorded for this project yet.";
  return entries.map((e) => `## ${e.title} — ${e.at}\n${e.digest || "(no answers)"}`).join("\n\n");
}
