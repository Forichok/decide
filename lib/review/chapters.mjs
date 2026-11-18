// chapters.mjs — which hunk goes to which chapter. Pure.
//
// A piece is the unit of a review: one hunk of a text file, or a whole file that has no hunks (a binary
// file, a rename with no edit, a mode change, an empty file). Pieces are numbered in the diff's order:
// h1, h2, … The agent's spec names pieces by file and, when a file's hunks belong to different chapters,
// by a line range of the new file:
//   "lib/server.mjs"          every piece of the file
//   "lib/server.mjs:120-180"  the hunks that touch lines 120 to 180 of the new file (context lines count)
//   "lib/server.mjs:120"      the hunk that holds line 120
//   "docs/shots/"             every file under the directory
//   "ui/css/*.css", "e2e/**"  a glob: * within a name, ** across directories ("**/x" is x at any depth)
// A renamed file answers to its old name too. A piece goes to the first chapter that names it, then to the
// first mechanical group; what nobody names is "the rest".

const TEST_FILE = /(^|\/)(tests?|e2e|spec|__tests__)\//i;
const TEST_NAME = /\.(test|spec)\.[a-z0-9]+$/i;
export const isTestFile = (path) => TEST_FILE.test(path) || TEST_NAME.test(path);

// The pieces of a parsed patch (patch.mjs), in its order.
export function piecesOf(files) {
  const pieces = [];
  const add = (file, index, extra) => pieces.push({ id: `h${pieces.length + 1}`, file: file.path, ...(file.oldPath ? { oldFile: file.oldPath } : {}), fileIndex: index, test: isTestFile(file.path), ...extra });
  files.forEach((file, index) => {
    if (!file.hunks.length) {
      const kind = file.binary ? "binary" : file.status === "renamed" || file.status === "copied" ? "rename" : file.oldMode && file.newMode ? "mode" : "empty";
      return add(file, index, { kind, status: file.status, added: 0, removed: 0 });
    }
    // A mode change on a file that is edited too rides on its pieces: there is no piece of its own to carry it.
    const modes = file.oldMode && file.newMode && file.oldMode !== file.newMode ? { modes: [file.oldMode, file.newMode] } : {};
    file.hunks.forEach((hunk, hunkIndex) => {
      const added = hunk.lines.filter((l) => l.t === "add").length;
      const removed = hunk.lines.filter((l) => l.t === "del").length;
      add(file, index, { kind: "hunk", status: file.status, ...modes, hunkIndex, oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, section: hunk.section, added, removed });
    });
  });
  return pieces;
}

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
// "**/" is any number of directories, none included: "**/*.mjs" names a file at the top too.
const globRe = (glob) =>
  new RegExp(
    `^${glob
      .split("**/")
      .map((seg) => seg.split("**").map((part) => part.split("*").map(escapeRe).join("[^/]*")).join(".*"))
      .join("(?:.*/)?")}$`,
  );

// A ref as a matcher: { ok, match(piece) }; ok false when the ref is not one of the shapes above.
export function refMatcher(ref) {
  if (typeof ref !== "string" || !ref.trim()) return { ok: false };
  const text = ref.trim();
  const ranged = /^(.+):(\d+)(?:-(\d+))?$/.exec(text);
  const path = ranged ? ranged[1] : text;
  const from = ranged ? Number(ranged[2]) : null;
  const to = ranged ? Number(ranged[3] ?? ranged[2]) : null;
  if (ranged && to < from) return { ok: false };
  const names = path.includes("*") ? globRe(path) : null;
  const named = (file) => (names ? names.test(file) : path.endsWith("/") ? file.startsWith(path) : file === path);
  return {
    ok: true,
    match(piece) {
      if (!named(piece.file) && !(piece.oldFile && named(piece.oldFile))) return false;
      if (from === null) return true;
      if (piece.kind !== "hunk") return false;
      // A hunk that only deletes has no new lines: it sits at the line before which the lines were.
      const start = piece.newStart;
      const end = piece.newLines ? piece.newStart + piece.newLines - 1 : piece.newStart;
      if (start <= to && end >= from) return true;
      // A deleted file has no new side at all: its hunk answers to the lines it had.
      return piece.status === "deleted" && piece.oldStart <= to && piece.oldStart + Math.max(piece.oldLines, 1) - 1 >= from;
    },
  };
}

// assign(pieces, { chapters, mechanical }) → { where, chapters, mechanical, rest, sorted, total, issues }
//   where: piece id → { chapter } | { mechanical } | {} (the rest)
//   chapters / mechanical: for each, in the spec's order, the ids of its pieces
//   issues: [{ level, where, message }]: a ref that names nothing or adds nothing, pieces in no chapter
export function assign(pieces, { chapters = [], mechanical = [] } = {}) {
  const issues = [];
  const add = (level, where, message) => issues.push({ level, where, message });
  const where = new Map();
  const taken = new Map(); // piece id → the label of who took it
  const claim = (groups, kind, label) =>
    groups.map((group, i) => {
      const place = `${kind}[${i}]${group.id ? ` (${group.id})` : ""}`;
      const mine = new Set();
      (group.hunks ?? []).forEach((ref) => {
        const matcher = refMatcher(ref);
        if (!matcher.ok) return add("error", place, `"${String(ref)}" is not a hunk reference: write "path", "path:from-to", "dir/" or a glob`);
        const hits = pieces.filter((p) => matcher.match(p));
        if (!hits.length) return add("warn", place, `"${ref}" names no hunk of this diff`);
        // "lib/x.mjs:1-40" in one chapter and "lib/x.mjs" in a later one is how a file is split: the later
        // reference takes what is left. Only a reference that is left with nothing is worth a word.
        const free = hits.filter((p) => mine.has(p.id) || !taken.has(p.id));
        if (!free.length) {
          const owners = [...new Set(hits.map(p => taken.get(p.id)))];
          const hint = hits.some(p => p.status === "added") && owners.length === 1 && owners[0].startsWith("chapter ")
            ? `; a hunk cannot be split between chapters: keep it in ${owners[0].slice(8)} and name the lines that matter there as key places` : "";
          return add("warn", place, `"${ref}" adds nothing: ${hits.length === 1 ? "its hunk is" : `all ${hits.length} of its hunks are`} already in ${owners.join(", ")}${hint}`);
        }
        for (const piece of free) {
          if (mine.has(piece.id)) continue;
          mine.add(piece.id);
          taken.set(piece.id, label(group, i));
          where.set(piece.id, { [kind === "chapters" ? "chapter" : "mechanical"]: kind === "chapters" ? group.id : i });
        }
      });
      if (!mine.size) add("warn", place, kind === "chapters" ? "the chapter has no hunks of this diff" : "the mechanical group has no hunks of this diff");
      return pieces.filter((p) => mine.has(p.id)).map((p) => p.id);
    });
  const inChapters = claim(chapters, "chapters", (c) => `chapter "${c.id}"`);
  const inMechanical = claim(mechanical, "mechanical", (m, i) => `mechanical group ${i + 1}`);
  const rest = pieces.filter((p) => !taken.has(p.id)).map((p) => p.id);
  if (rest.length) add("warn", "chapters", `${rest.length} hunk${rest.length === 1 ? "" : "s"} in no chapter: the page shows ${rest.length === 1 ? "it" : "them"} under "The rest" (${restFiles(pieces, rest)})`);
  return { where: Object.fromEntries(pieces.map((p) => [p.id, where.get(p.id) ?? {}])), chapters: inChapters, mechanical: inMechanical, rest, sorted: pieces.length - rest.length, total: pieces.length, issues };
}

// The files the unsorted pieces are in, the first few by name.
function restFiles(pieces, rest) {
  const ids = new Set(rest);
  const files = [...new Set(pieces.filter((p) => ids.has(p.id)).map((p) => p.file))];
  return files.length > 4 ? `${files.slice(0, 4).join(", ")} and ${files.length - 4} more` : files.join(", ");
}

// ---- key places: the lines of a chapter a person should read

export const FOCUS_MAX = 5;
export const FOCUS_MAX_LINES = 60;

// "path:from-to" or "path:line" → { file, from, to }; null for anything else.
export function placeOf(at) {
  const m = typeof at === "string" ? /^(.+):(\d+)(?:-(\d+))?$/.exec(at.trim()) : null;
  if (!m) return null;
  const [from, to] = [Number(m[2]), Number(m[3] ?? m[2])];
  return from >= 1 && to >= from ? { file: m[1], from, to } : null;
}

// focusOf(pieces, placed, chapters) → { focus, issues }
//   focus: for each chapter, its key places that name lines of its own hunks:
//     [{ file, from, to, note, pieces: [ids] }], in the spec's order
//   A place whose lines are in no hunk of the chapter is left out, with a word on where they are.
export function focusOf(pieces, placed, chapters = [], files = []) {
  const issues = [];
  const covers = (p, place) => p.kind === "hunk" && p.newLines > 0 && p.file === place.file && p.newStart <= place.to && p.newStart + p.newLines - 1 >= place.from;
  const home = (id) => {
    const at = placed.where[id] ?? {};
    return at.chapter !== undefined ? `chapter "${at.chapter}"` : at.mechanical !== undefined ? `mechanical group ${at.mechanical + 1}` : '"The rest"';
  };
  const focus = chapters.map((chapter, i) => {
    const mine = new Set(placed.chapters[i]);
    return (chapter.focus ?? [])
      .map((f, k) => {
        const where = `chapters[${i}] (${chapter.id}).focus[${k}]`;
        const place = placeOf(f.at);
        if (!place) return null;
        if (f.text !== undefined) {
          const ownLines = new Map();
          for (const p of pieces.filter(p => mine.has(p.id) && p.file === place.file && p.kind === "hunk")) {
            for (const l of files[p.fileIndex]?.hunks[p.hunkIndex]?.lines ?? []) {
              if (l.n !== null) ownLines.set(l.n, l.text.trim());
            }
          }
          const current = files.find(file => file.path === place.file)?.hunks.flatMap(h => h.lines).find(l => l.n === place.from)?.text.trim();
          if (current !== f.text) {
            const matches = [...ownLines].filter(([, text]) => text === f.text);
            issues.push({ level: "error", where, message: matches.length === 1
              ? `the place moved: \`text\` is now at line ${matches[0][0]}; write at: ${place.file}:${matches[0][0]}-${matches[0][0] + place.to - place.from}`
              : `line ${place.from} of ${place.file} holds ${current === undefined ? "(no new-file line in this diff)" : JSON.stringify(current)} now; text ${JSON.stringify(f.text)} ${matches.length ? "appears more than once" : "was not found"} in this chapter's hunks; re-check the place` });
          }
        }
        const hits = pieces.filter((p) => covers(p, place));
        const own = hits.filter((p) => mine.has(p.id));
        if (own.length) {
          const ranges = own.map((p) => [Math.max(place.from, p.newStart), Math.min(place.to, p.newStart + p.newLines - 1)]).sort((a, b) => a[0] - b[0]);
          let end = place.from - 1;
          for (const [a, b] of ranges) { if (a > end + 1) break; end = Math.max(end, b); }
          if (end < place.to) issues.push({ level: "warn", where, message: `"${f.at}" extends outside this chapter's hunks; shown lines: ${ranges.map(([a, b]) => `${a}-${b}`).join(", ")} (new file)` });
          return { ...place, ...(f.question ? { at: f.at, question: f.question, ...(f.options ? { options: f.options } : {}) } : {}), ...(f.checkedBy ? { checkedBy: f.checkedBy } : {}), note: f.note ?? "", ...(f.kind ? { kind: f.kind } : {}), pieces: own.map((p) => p.id) };
        }
        const ranges = pieces.filter((p) => mine.has(p.id) && p.file === place.file && p.kind === "hunk" && p.newLines > 0).map((p) => `${p.newStart}-${p.newStart + p.newLines - 1}`);
        issues.push({ level: "error", where, message: hits.length ? `"${f.at}" is not in this chapter: those lines are in ${[...new Set(hits.map((p) => home(p.id)))].join(", ")}; move the place or the hunk` : `"${f.at}" names no changed lines of this diff (lines of the new file, inside a hunk); ${ranges.length ? `this chapter has new-file lines ${ranges.join(", ")}` : "the file has no hunk in this chapter"}; move the place or the hunk` });
        return null;
      })
      .filter(Boolean);
  });
  return { focus, issues };
}

// Keep the reviewer's location and display the warning when the anchor text moved.
export function findingsOf(findings, pieces, files) {
  const issues = [];
  const changed = new Set(files.flatMap(f => [f.path, f.oldPath].filter(Boolean)));
  const linesByFile = new Map();
  const linesOf = (file) => {
    if (!linesByFile.has(file)) {
      linesByFile.set(file, pieces.filter(p => p.kind === "hunk" && p.file === file).flatMap(p =>
        files[p.fileIndex].hunks[p.hunkIndex].lines.filter(l => l.n !== null).map(l => ({ n: l.n, text: l.text.trim(), hunk: p.id }))));
    }
    return linesByFile.get(file);
  };
  const placed = findings.map((f, i) => {
    if (!f.at) return f;
    const where = `reviewers.findings[${i}] (${f.id})`;
    const warn = (message) => issues.push({ level: "warn", where, message });
    const place = placeOf(f.at);
    if (!place) {
      if (changed.has(f.at.trim())) return f;
      warn(`about ${f.at}, not in this diff`);
      return { ...f, outside: true };
    }
    const lines = linesOf(place.file);
    const hit = lines.find(l => l.n >= place.from && l.n <= place.to);
    if (!hit) warn(`about ${f.at}, not in this diff`);
    let anchorMismatch;
    const text = f.line?.trim();
    if (text !== undefined && lines.find(l => l.n === place.from)?.text !== text) {
      const matches = [...new Set(lines.filter(l => l.text === text).map(l => l.n))];
      anchorMismatch = matches.length === 1 ? { movedTo: matches[0] } : {};
      warn(`the line at ${f.at} differs from the finding's anchor${anchorMismatch.movedTo ? `; its text is now at line ${anchorMismatch.movedTo} of ${place.file}` : ""}`);
    }
    return { ...f, ...(hit ? { anchor: { hunk: hit.hunk, line: hit.n } } : { outside: true }), ...(anchorMismatch ? { anchorMismatch } : {}) };
  });
  return { findings: placed, issues };
}
