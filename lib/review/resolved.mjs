// The previous verdict supplies the words and locations. The author only supplies replies.
import { placeOf } from "./chapters.mjs";

function nextId(used, prefix, n) {
  let id;
  do { id = `${prefix}${++n}`; } while (used.has(id));
  used.add(id);
  return [id, n];
}

export function decisionIds(result) {
  const used = new Set([...(result.comments ?? []).map(c => c.id), ...(result.reviewers?.findings ?? []).flatMap(f => [f.id, f.ref].filter(Boolean))]);
  let n = 0;
  return result.decisions.map(d => {
    let id;
    [id, n] = nextId(used, "d", n);
    return { id, ...d };
  });
}

// Old verdicts had no decision ids. Assign them the same way when they are read back.
function decisionsOf(result) {
  return decisionIds({ ...result, decisions: result.decisions ?? [] });
}

export function carriedFixes(result) {
  const used = new Set([
    ...(result.comments ?? []).map(c => c.id),
    ...(result.reviewers?.findings ?? []).flatMap(f => [f.id, f.ref].filter(Boolean)),
    ...decisionsOf(result).map(d => d.id),
  ]);
  let n = 0;
  return (result.resolved ?? []).filter(r => r.owner === "notFixed").map(r => {
    let id;
    [id, n] = nextId(used, "r", n);
    return { ...r, id };
  });
}

const originalAt = (text, at = "") => {
  const place = placeOf(at);
  return { text, file: place?.file ?? at, ...(place ? { line: place.from } : {}) };
};

export function previousItems(result) {
  const comments = (result.comments ?? []).map(({ id, kind, text, file, line }) => ({
    ref: id, kind, required: kind === "fix", original: { text, file, ...(Number.isInteger(line) ? { line } : {}) },
  }));
  const decisions = decisionsOf(result).filter(d => d.answer === "no").map(d => ({
    ref: d.id, kind: "decision", required: true, original: { ...originalAt(d.question, d.at), answer: d.label },
  }));
  const findings = (result.reviewers?.findings ?? []).filter(f => f.decision !== "dismissed").map(f => ({
    ref: f.ref ?? f.id, kind: "finding", required: f.decision === "fix", original: originalAt(f.text, f.at),
  }));
  const carried = carriedFixes(result).map(r => ({ ref: r.id, kind: "fix", required: true, original: r.original }));
  return [...comments, ...findings, ...decisions, ...carried];
}

export const itemLabel = ({ ref, kind, original }) =>
  `[${ref}] ${kind}${original.file ? ` ${original.file}${original.line ? `:${original.line}` : ""}` : ""}: ${original.text}${original.answer ? ` — ${original.answer}` : ""}`;

function anchorOf(at, files, pieces) {
  const place = placeOf(at);
  if (!place) return null;
  for (const p of pieces) {
    if (p.file !== place.file || p.kind !== "hunk" || !p.newLines) continue;
    if (place.from < p.newStart || place.to >= p.newStart + p.newLines) continue;
    const lines = files[p.fileIndex].hunks[p.hunkIndex].lines;
    const changed = lines.find(l => l.t === "add" && l.n >= place.from && l.n <= place.to);
    if (changed) return { hunk: p.id, line: changed.n };
    // A deletion can be shown on its nearest surviving line in a deletion-only hunk.
    if (!p.added && p.removed) {
      const next = lines.findIndex(l => l.n >= place.from);
      const last = lines.findIndex(l => l.n === place.to);
      if (lines.slice(Math.max(0, next - 1), last + 2).some(l => l.t === "del")) return { hunk: p.id, line: place.from };
    }
  }
  return null;
}

export function reconcile(entries, items, { files, pieces }, { fallback = false } = {}) {
  const issues = [];
  const add = (level, message) => issues.push({ level, where: "resolved", message });
  if (!items) {
    if (entries?.length && !fallback) add("error", "resolved needs a previous review round");
    return { issues };
  }
  const byId = new Map(items.map(item => [item.ref, item]));
  const replies = new Map();
  for (const entry of entries ?? []) {
    const { ref, how, at, note } = entry;
    if (!byId.has(ref)) {
      add("error", `unknown ref "${ref}" in the previous round`);
      continue;
    }
    const anchor = how === "fixed" && anchorOf(at, files, pieces);
    if (how === "fixed" && !at) add("error", `[${ref}] fixed needs at in the new-file lines`);
    else if (how === "fixed" && !anchor) add("error", `[${ref}] "${at}" is outside the follow-up diff's changed lines`);
    if (how !== "fixed" && !note) add("error", `[${ref}] ${how} needs a note`);
    replies.set(ref, { how, ...(how === "fixed" && at ? { at } : {}), note, ...(anchor ? { anchor } : {}) });
  }
  const missing = items.filter(item => item.required && !replies.has(item.ref));
  if (missing.length) add("error", `missing replies for items to fix:\n${missing.map(itemLabel).join("\n")}`);
  for (const item of items) if (!item.required && !replies.has(item.ref)) add("warn", `no reply for ${itemLabel(item)}`);
  const resolved = items.map(({ ref, kind, original }) => ({
    ref, kind, original, ...(replies.get(ref) ?? { how: null, note: "" }),
  }));
  return { resolved, issues };
}

export function markedResolutions(rows, owners = {}) {
  return rows.map(row => ({ ...row, owner: Object.hasOwn(owners, row.ref) ? owners[row.ref] : null }));
}
