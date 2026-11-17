// digest.mjs — what the agent reads when a review ends: the verdict, then every comment by kind with
// its file, line and the line's code. Pure.

import { checkState } from "./spec.mjs";

export const VERDICTS = ["approve", "nits", "return"];
const VERDICT_WORDS = { approve: "APPROVED", nits: "APPROVED WITH NITS", return: "RETURNED" };
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const quote = (text) => String(text).replace(/\n/g, "\n   ");

// The result of a review round, as it goes into the log and answers.json.
//   comments: [{ id, kind: "fix" | "nit" | "question", hunk, file, line?, side?, code?, chapter?, text, reply? }]
//   questions are the dialog's entries: asked on the page, answered (or not) by the agent while it was open.
//   lineKind(hunk, side, line) → "add" | "del" | "ctx" | undefined: what the commented line is in the diff.
export function reviewResult({ base, spec, meta, placed, pieces = [], review, dialog, payload = {}, extra = {}, lineKind = () => undefined }) {
  if (payload.cancelled) return { ...base, cancelled: true };
  const chapterOf = (hunk) => (Object.hasOwn(placed.where, hunk) ? (placed.where[hunk].chapter ?? "") : "");
  const isRead = (id) => Object.hasOwn(review.read, id);
  const lineOf = (hunk, at) => {
    if (!Number.isInteger(at.line)) return {};
    const change = lineKind(hunk, at.side, at.line);
    return { line: at.line, side: at.side, ...(change ? { change } : {}) };
  };
  const typed = review.comments.map((c) => ({ id: c.id, kind: c.kind, hunk: c.hunk, file: c.file ?? "", ...lineOf(c.hunk, c), ...(c.code !== undefined ? { code: c.code } : {}), chapter: chapterOf(c.hunk), text: c.text }));
  const asked = dialog
    .filter((d) => d.ask)
    .map((d) => ({ id: d.id, kind: "question", hunk: d.qid, file: d.file ?? "", ...lineOf(d.qid, d), ...(d.code !== undefined ? { code: d.code } : {}), chapter: chapterOf(d.qid), text: d.ask, ...(d.reply?.text ? { reply: d.reply.text } : {}) }));
  const verdict = VERDICTS.includes(payload.verdict) ? payload.verdict : extra.dismissed ? null : "return";
  const result = {
    ...base,
    ...extra,
    ...(verdict ? { verdict } : {}),
    ...(typeof payload.note === "string" && payload.note.trim() ? { note: payload.note.trim() } : {}),
    range: { base: meta.base, head: meta.head, baseRef: meta.baseRef, headRef: meta.headRef, ...(meta.newer ? { newer: meta.newer } : {}) },
    comments: [...typed, ...asked],
    read: spec.chapters.filter((c) => isRead(c.id)).map((c) => c.id),
    unread: spec.chapters.filter((c) => !isRead(c.id)).map((c) => c.id),
    checks: { failed: spec.checks.filter((c) => checkState(c) === "failed").length, missing: spec.checks.filter((c) => checkState(c) === "missing").length, total: spec.checks.length },
    coverage: coverageOf(pieces, review.coverage),
    sorted: placed.sorted,
    total: placed.total,
  };
  result.digest = reviewDigest(spec, result);
  return result;
}

// The commented line as a diff shows it: added, removed, or a context line (no mark).
const MARK = { add: "+", del: "-", ctx: " " };
const where = (c) => `${c.file || c.hunk}${Number.isInteger(c.line) ? `:${c.line}${c.side === "old" ? " (old side)" : ""}` : ""}`;

function section(title, comments, spec, tail = () => "") {
  if (!comments.length) return "";
  const titleOf = (id) => spec.chapters.find((c) => c.id === id)?.title ?? "";
  const lines = comments.map((c, i) => {
    const chapter = c.chapter ? ` · chapter «${titleOf(c.chapter)}»` : "";
    const code = c.code !== undefined && c.code.trim() ? `\n   ${MARK[c.change] ?? (c.side === "old" ? "-" : "+")} ${c.code.trim().slice(0, 200)}` : "";
    return `${i + 1}. ${where(c)}${chapter}${code}\n   ${quote(c.text)}${tail(c)}`;
  });
  return `${title} (${comments.length}):\n${lines.join("\n")}`;
}

export function reviewDigest(spec, result) {
  const of = (kind) => result.comments.filter((c) => c.kind === kind);
  const [fix, nit, question] = [of("fix"), of("nit"), of("question")];
  const open = question.filter((q) => !q.reply).length;
  const counts = [fix.length && count(fix.length, "to fix", "to fix"), nit.length && count(nit.length, "nit", "nits"), question.length && `${count(question.length, "question", "questions")}${open ? ` (${open} not answered)` : ""}`].filter(Boolean);
  const unread = result.unread.map((id) => `«${spec.chapters.find((c) => c.id === id)?.title ?? id}»`);
  const head = [
    result.verdict ? `Verdict: ${VERDICT_WORDS[result.verdict]}${result.range?.head ? ` at ${result.range.head.slice(0, 7)} (${result.range.headRef || "HEAD"})` : ""}.` : "No verdict.",
    counts.length ? `Comments: ${counts.join(", ")}.` : "No comments.",
    `Chapters viewed: ${result.read.length} of ${spec.chapters.length}${unread.length ? ` (not viewed: ${unread.join(", ")})` : ""}.`,
    result.verdict && result.verdict !== "return" && (result.checks.failed || result.checks.missing)
      ? `Approved with checks not green: ${[result.checks.failed && `${result.checks.failed} failed`, result.checks.missing && `${result.checks.missing} not run`].filter(Boolean).join(", ")}.`
      : "",
    result.coverage ? coverageLine(result.coverage) : "",
    result.total > result.sorted ? `${result.total - result.sorted} of ${result.total} hunks were in no chapter.` : "",
  ].filter(Boolean);
  return [
    head.join(" "),
    result.range?.newer ? `Branch head ${result.range.newer.head.slice(0, 7)} differs from snapshot ${result.range.head.slice(0, 7)}; the approval covers only the named commit.` : "",
    result.note ? `The reviewer's note:\n> ${result.note.replace(/\n/g, "\n> ")}` : "",
    section("To fix", fix, spec),
    section("Nits", nit, spec),
    section("Questions", question, spec, (c) => (c.reply ? "\n   (you answered on the page)" : "\n   NOT answered yet: answer it in chat")),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// What the agent reads back from wait when the review ends.
export function formatReviewResult(result, outPath) {
  const next = {
    return: "The change was returned. Fix what is under \"To fix\", decide on each nit, and tell the reviewer for every comment what you did: fixed, answered, or declined and why. Then call review again on the new head.",
    nits: "Approved with nits: fix the nits or say why not; no new review round is needed. Merging stays under the repository's own rules: the page merged nothing.",
    approve: "Approved. Merging stays under the repository's own rules: the page merged nothing.",
  }[result.verdict];
  return [result.digest, `Review «${result.title}» is finished.`, `Full JSON: ${outPath}`, next].filter(Boolean).join("\n\n");
}

// Coverage is independent of chapter marks and is conservative for rounds stored before it existed.
export function coverageOf(pieces, states = {}) {
  const files = new Map();
  let opened = 0, part = 0;
  for (const p of pieces) {
    if (!files.has(p.file)) files.set(p.file, { file: p.file, pieces: 0, opened: 0, part: 0 });
    const f = files.get(p.file);
    f.pieces++;
    if (states[p.id] === "opened") { opened++; f.opened++; }
    else if (states[p.id] === "part") { part++; f.part++; }
  }
  return { total: pieces.length, opened, part, unopened: pieces.length - opened - part, files: [...files.values()].filter((f) => f.opened < f.pieces) };
}

function coverageLine(c) {
  const names = c.files.slice(0, 5).map((f) => f.file).join(", ");
  const more = c.files.length > 5 ? ` and ${c.files.length - 5} more` : "";
  return `Opened ${c.opened} of ${c.total} pieces; in part ${c.part}; not opened ${c.unopened}${names ? ` (${names}${more})` : ""}.`;
}
