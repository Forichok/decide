// Preparation reads the same committed snapshot as review; it never stores a round.
import { execFile } from "node:child_process";
import { takeSnapshot } from "./snapshot.mjs";
import { parsePatch } from "./patch.mjs";
import { piecesOf, placeOf } from "./chapters.mjs";
import { refusal } from "../git.mjs";

const GROUPING = "Starting point: regroup by meaning: a chapter is an idea, not a directory";
const LOCK = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|composer\.lock)$/;

// Only snapshot-resolved commit ids reach this read-only call. show avoids adding a git subcommand.
function commitsOf(top, base, head) {
  if (![base, head].every(s => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(s))) throw refusal("outline needs resolved commits");
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_PAGER: "cat" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_EXTERNAL_DIFF"]) delete env[key];
  return new Promise((done, fail) => {
    execFile("git", ["--no-pager", "-c", "core.fsmonitor=false", "show", "--no-patch", "--no-notes", "--format=%h%x00%s", "--abbrev=7", "--max-count=30", `${base}..${head}`, "--"],
      { cwd: top, env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) return fail(refusal(`cannot read commits: ${err.message}`));
        done(stdout.trimEnd().split("\n").filter(Boolean).map(line => {
          const [sha, subject] = line.split("\0");
          return { sha: sha.slice(0, 7), subject };
        }));
      });
  });
}

export async function outline({ top, base, head, place } = {}) {
  const { meta, patch } = await takeSnapshot({ top, base, head });
  const files = parsePatch(patch);
  const pieces = piecesOf(files).map(({ fileIndex, hunkIndex, ...p }) => {
    const lines = hunkIndex === undefined ? [] : files[fileIndex].hunks[hunkIndex].lines;
    const excerpt = lines.filter(l => l.t !== "ctx").slice(0, 3).map(l => ({
      at: `${p.file}:${l.n ?? l.o}`, side: l.n === null ? "old" : "new", text: l.text.trim().slice(0, 120),
    }));
    return { ...p, excerpt, ...(Math.max(p.newLines ?? 0, p.oldLines ?? 0) > 300 ? {
      hint: "a hunk cannot be split between chapters: keep it in one chapter and name the lines that matter there as key places",
    } : {}) };
  });
  const groups = new Map();
  const mechanical = [];
  for (const p of pieces) {
    const ref = p.kind === "hunk" && p.status !== "deleted"
      ? `${p.file}:${p.newStart}-${p.newStart + Math.max(p.newLines, 1) - 1}` : p.file;
    if (LOCK.test(p.file) || p.kind === "rename") {
      mechanical.push({ title: LOCK.test(p.file) ? "Lock file" : "Pure rename", hunks: [ref] });
      continue;
    }
    const group = p.file.includes("/") ? p.file.split("/")[0] : "(root)";
    if (!groups.has(group)) groups.set(group, { id: `group${groups.size + 1}`, title: `${group} — ${GROUPING}`, summary: "", hunks: [] });
    groups.get(group).hunks.push(ref);
  }
  // A mechanical-only snapshot still needs one chapter for the existing review spec format.
  const chapters = [...groups.values()];
  if (!chapters.length) chapters.push({ id: "overview", title: "Overview", summary: "", hunks: [] });
  const skeleton = { title: "", summary: "", checks: [], chapters, mechanical };
  const changed = pieces.reduce((n, p) => n + p.added + p.removed, 0);
  const mechanicalFiles = new Set(mechanical.flatMap(g => g.hunks.map(r => r.replace(/:\d+(?:-\d+)?$/, ""))));
  const mechanicalLines = pieces.filter(p => mechanicalFiles.has(p.file)).reduce((n, p) => n + p.added + p.removed, 0);
  if (mechanicalLines * 3 > changed) skeleton.mechanicalWhy = "Lock files and pure renames were sorted here by outline; re-check this grouping.";
  const result = { snapshot: { ...meta, commits: await commitsOf(top, meta.base, meta.head) }, pieces, reviewers: null, skeleton };
  if (place !== undefined) {
    const at = placeOf(place);
    const line = at && files.find(f => f.path === at.file)?.hunks.flatMap(h => h.lines).find(l => l.n === at.from);
    if (!line) throw refusal(`place "${place}" needs a new-file line inside a hunk of this snapshot`);
    result.place = { at: place.trim(), text: line.text.trim() };
  }
  return result;
}

export function outlineText(result) {
  const { snapshot: s, pieces, skeleton } = result;
  const lines = [
    `Review ${s.baseRef} (${s.base.slice(0, 7)}) → ${s.headRef} (${s.head.slice(0, 7)})`,
    `${s.stats.files} files, +${s.stats.added}/-${s.stats.removed}`,
    "Commits (up to 30):", ...s.commits.map(c => `  ${c.sha} ${c.subject}`),
    `${pieces.length} pieces; --json has everything. Excerpts shown for the first 100 pieces.`,
  ];
  pieces.forEach((p, i) => {
    const range = (start, count) => count ? `${start}-${start + count - 1}` : "none";
    lines.push(`${p.id} ${p.file} [${p.status}, ${p.kind}${p.test ? ", test" : ""}] new:${range(p.newStart, p.newLines)} old:${range(p.oldStart, p.oldLines)} +${p.added}/-${p.removed}${p.section ? ` — ${p.section}` : ""}`);
    if (p.hint) lines.push(`  ${p.hint}`);
    if (i < 100) for (const e of p.excerpt) lines.push(`  ${e.at} (${e.side}) ${e.text}`);
  });
  if (result.place) lines.push("Key place:", JSON.stringify(result.place));
  lines.push(GROUPING, "Skeleton (fill title and summaries; no checks have been run):", JSON.stringify(skeleton, null, 2));
  return lines.join("\n");
}
