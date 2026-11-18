// snapshot.mjs — the diff a review is read against, taken once when the round opens and kept in the
// round's folder: review/diff.patch (git's own text) and review/snapshot.json (which commits, when).
// The review survives a restart and a later commit: nothing here looks at the working tree again.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_CANDIDATES, checkRef, currentBranch, defaultBase, differsFromTree, diffText, insideRepo, isAncestor, mergeBase, refusal, resolveCommit } from "../git.mjs";
import { assign, findingsOf, focusOf, piecesOf } from "./chapters.mjs";
import { effective } from "../settings.mjs";
import { changedPaths } from "./reviewers.mjs";
import { parsePatch, patchStats } from "./patch.mjs";
import { previousItems, reconcile } from "./resolved.mjs";

const user = (message) => Object.assign(new Error(message), { status: 400, user: true });
const short = (id) => String(id).slice(0, 7);

// takeSnapshot({ top, base?, head? }) → { meta, patch, issues }
//   head: the commit reviewed (default HEAD). base: what it is reviewed against (default: the remote's
//   default branch, else main or master). The diff is from their common ancestor to head: the branch
//   against its base, whatever landed on the base since.
//   meta: { format, at, base, head, baseTip, baseRef, headRef, branch, dirty, stats }
export async function takeSnapshot({ top, base = "", head = "", previous, specFile = "", lookupPrevious, now = Date.now } = {}) {
  const issues = [];
  if (!(await insideRepo(top))) throw user(`${top} is not a git working tree: the review mode reads the diff from git`);
  const headRef = head || "HEAD";
  checkRef(headRef, "head");
  if (base) checkRef(base, "base");
  const headCommit = await resolveCommit(top, headRef);
  if (!headCommit) throw refusal(`head "${headRef}" names no commit`);
  const branch = !head || headRef === "HEAD" ? await currentBranch(top) : "";
  const automatic = previous === undefined;
  let prior = previous === false ? null : lookupPrevious?.({ previous, headRef, branch, top, specFile });
  let fallback = false;
  if (prior) {
    let reason = prior.error;
    if (!reason && prior.head === headCommit) throw user(`no new commits since round ${prior.id}; for a full review pass --no-previous (spec: "previous": false)`);
    if (!reason) {
      try {
        if (!(await isAncestor(top, prior.head, headCommit))) reason = "its head is not an ancestor of the new head";
      } catch (e) {
        if (!e.user) throw e;
        reason = `its ancestry could not be checked (${e.message})`;
      }
    }
    if (reason) {
      const message = `Cannot follow up on round ${prior.id ?? previous}: ${reason}`;
      if (!automatic) throw user(message);
      issues.push({ level: "warn", where: "snapshot", message: `${message}. Showing the full review.` });
      prior = null;
      fallback = true;
    }
  }
  let baseRef = base;
  let baseTip;
  if (base) {
    baseTip = await resolveCommit(top, base);
    if (!baseTip) throw refusal(`base "${base}" names no commit`);
  } else if (prior) {
    baseTip = prior.base ?? prior.head;
    baseRef = prior.baseRef || baseTip;
  } else {
    const found = await defaultBase(top, headCommit);
    if (!found) throw user(`no base to review against: none of ${BASE_CANDIDATES.join(", ")} names a commit other than the head. Pass base: the branch or commit this change started from.`);
    baseRef = found.ref;
    baseTip = found.commit;
  }
  const fork = (await mergeBase(top, baseTip, headCommit)) ?? baseTip;
  if (!prior && fork === headCommit) throw user(`nothing to review: ${headRef} (${short(headCommit)}) is already in ${baseRef}. Pass base, or review from the branch that holds the change.`);
  const wholePatch = await diffText(top, fork, headCommit);
  const wholeStats = patchStats(parsePatch(wholePatch));
  if (!prior && !wholeStats.files) throw user(`nothing to review: ${baseRef}..${headRef} changes no file`);
  const dirty = !head && (await differsFromTree(top, headCommit));
  if (dirty) issues.push({ level: "warn", where: "snapshot", message: `the working tree has uncommitted changes: they are not in this review (the snapshot is commit ${short(headCommit)}). Commit first if the reviewer should see them.` });
  const patch = prior ? await diffText(top, prior.head, headCommit) : wholePatch;
  const meta = {
    format: 1,
    at: new Date(now()).toISOString(),
    base: prior?.head ?? fork,
    head: headCommit,
    baseTip,
    baseRef,
    headRef,
    branch,
    dirty,
    stats: prior ? patchStats(parsePatch(patch)) : wholeStats,
    ...(prior ? {
      previous: { round: prior.id, head: prior.head },
      previousAutomatic: automatic,
      roundNumber: prior.number + 1,
      wholeStats,
      wholeBase: fork,
    } : {}),
  };
  return { meta, patch, issues, ...(prior ? { previousItems: previousItems(prior.result) } : {}), fallback };
}

const dirOf = (roundDir) => join(roundDir, "review");

// Writes the snapshot into the round's folder; throws what the disk throws.
export function saveSnapshot(roundDir, { meta, patch }, mode = 0o600) {
  mkdirSync(dirOf(roundDir), { recursive: true, mode: 0o700 });
  writeFileSync(join(dirOf(roundDir), "diff.patch"), patch, { mode });
  writeFileSync(join(dirOf(roundDir), "snapshot.json"), JSON.stringify(meta, null, 2), { mode });
}

// Reads it back: { meta, patch }; throws when the round's folder has none.
export function loadSnapshot(roundDir) {
  const meta = JSON.parse(readFileSync(join(dirOf(roundDir), "snapshot.json"), "utf8"));
  if (meta?.format !== 1 || typeof meta.head !== "string" || typeof meta.base !== "string") throw new Error("review/snapshot.json is not a review snapshot");
  return { meta, patch: readFileSync(join(dirOf(roundDir), "diff.patch"), "utf8") };
}

// The snapshot laid out by the spec: the files, the pieces, who took which, the lint of that.
// Pure: a review read back from disk is built the same way.
export function buildReview(spec, patch) {
  const files = parsePatch(patch);
  const pieces = piecesOf(files);
  const placed = assign(pieces, spec);
  const places = focusOf(pieces, placed, spec.chapters, files);
  const mechanicalIds = new Set(placed.mechanical.flat());
  const mechanical = pieces.filter((p) => mechanicalIds.has(p.id));
  const added = mechanical.reduce((n, p) => n + p.added, 0);
  const removed = mechanical.reduce((n, p) => n + p.removed, 0);
  const total = pieces.reduce((n, p) => n + p.added + p.removed, 0);
  const mechanicalShare = { files: new Set(mechanical.map((p) => p.file)).size, added, removed, changed: added + removed, total, percent: total ? Math.round(100 * (added + removed) / total) : 0 };
  const findings = findingsOf(spec.reviewers?.findings ?? [], pieces, files);
  const issues = [...placed.issues, ...places.issues, ...findings.issues];
  if ((added + removed) * 3 > total) issues.push({ level: spec.mechanicalWhy ? "warn" : "error", where: "mechanical", message: `mechanical groups hold ${added + removed} of ${total} changed lines (${mechanicalShare.percent}%); move code that changes behaviour into chapters, or state the reason in mechanicalWhy${spec.mechanicalWhy ? ` (agent's reason: ${spec.mechanicalWhy})` : ""}` });
  return { files, pieces, placed, mechanicalShare, focus: places.focus, issues, findings: findings.findings, paths: changedPaths(files) };
}

// Opening and lint use the same diff and the same reconciliation.
export function prepareReview(spec, snapshot) {
  const built = buildReview(spec, snapshot.patch);
  const { resolved, issues } = reconcile(spec.resolved, snapshot.previousItems, built, { fallback: snapshot.fallback });
  if (resolved) snapshot.meta.resolved = resolved;
  return { ...built, issues: [...built.issues, ...issues] };
}

export function followupRange(meta) {
  const { previous, roundNumber, wholeStats, previousAutomatic } = meta;
  return previous ? { previous, roundNumber, wholeStats, previousAutomatic } : {};
}

export function snapshotLine(meta) {
  const stats = ({ files, added, removed }) => `${files} file${files === 1 ? "" : "s"}, +${added} −${removed}`;
  return meta.previous
    ? `since round ${meta.previous.round} (${short(meta.previous.head)}): ${stats(meta.stats)}; the whole branch: ${stats(meta.wholeStats)}`
    : `${meta.baseRef} (${short(meta.base)}) → ${meta.headRef} (${short(meta.head)}); ${stats(meta.stats)}`;
}

const tally = (pieces) => ({ ids: pieces.map((p) => p.id), pieces: pieces.length, files: new Set(pieces.map((p) => p.file)).size, added: pieces.reduce((n, p) => n + p.added, 0), removed: pieces.reduce((n, p) => n + p.removed, 0) });

// What the page gets when it opens the round: the snapshot's facts and, for every chapter, mechanical
// group and the rest, how much is in it. The lines come later, a group at a time (groupPieces).
export function reviewIndex(spec, meta, built) {
  const byId = new Map(built.pieces.map((p) => [p.id, p]));
  const of = (ids) => ids.map((id) => byId.get(id));
  return {
    snapshot: { at: meta.at, base: meta.base, head: meta.head, baseRef: meta.baseRef, headRef: meta.headRef, branch: meta.branch, dirty: meta.dirty, stats: meta.stats, ...followupRange(meta) },
    reviewers: { ...spec.reviewers, findings: built.findings, requirement: meta.reviewers ?? null, defaultRoles: effective().reviewers.value.roles },
    total: built.placed.total,
    mechanicalShare: built.mechanicalShare,
    files: built.files.map((f) => ({ file: f.path, status: f.status, ...tally(built.pieces.filter((p) => p.file === f.path)) })),
    owners: built.placed.where,
    sorted: built.placed.sorted,
    chapters: spec.chapters.map((c, i) => ({ id: c.id, ...tally(of(built.placed.chapters[i])), names: [...new Set(of(built.placed.chapters[i]).map((p) => p.file))], focus: built.focus[i] })),
    mechanical: spec.mechanical.map((m, i) => tally(of(built.placed.mechanical[i]))),
    rest: tally(of(built.placed.rest)),
  };
}

// The ids of one group: "ch:<chapter id>", "mech:<index>" or "rest"; null for a group the review has not.
export function groupIds(spec, built, group) {
  const text = String(group ?? "");
  if (text === "rest") return built.placed.rest;
  if (text.startsWith("ch:")) {
    const i = spec.chapters.findIndex((c) => c.id === text.slice(3));
    return i < 0 ? null : built.placed.chapters[i];
  }
  if (text.startsWith("mech:")) return built.placed.mechanical[Number(text.slice(5))] ?? null;
  return null;
}

// The pieces of one group with their lines, as the page draws them.
export function groupPieces(spec, built, group) {
  const ids = groupIds(spec, built, group);
  if (!ids) return null;
  const byId = new Map(built.pieces.map((p) => [p.id, p]));
  return ids.map((id) => {
    const piece = byId.get(id);
    const { fileIndex, hunkIndex, ...rest } = piece;
    return { ...rest, lines: piece.kind === "hunk" ? built.files[fileIndex].hunks[hunkIndex].lines : [] };
  });
}

// One line of a piece: the text at `line` of its old or new side; null when the piece has no such line.
export function lineOf(built, pieceId, side, line) {
  const piece = built.pieces.find((p) => p.id === pieceId);
  if (!piece || piece.kind !== "hunk") return null;
  const key = side === "old" ? "o" : "n";
  return built.files[piece.fileIndex].hunks[piece.hunkIndex].lines.find((l) => l[key] === line) ?? null;
}
