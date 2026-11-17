// patch.mjs — git's unified diff as data. Pure: text in, files out.
//
// parsePatch(text) → [{ path, oldPath?, status, binary, oldMode?, newMode?, similarity?, hunks, added, removed }]
//   status: "modified" | "added" | "deleted" | "renamed" | "copied"
//   hunk:   { oldStart, oldLines, newStart, newLines, section, lines }
//   line:   { t: "ctx" | "add" | "del", text, o, n, noeol? }   o / n: 1-based line numbers of the old and new file
//
// What is read is what `git diff` prints with a/ and b/ prefixes: renames and copies, new and deleted
// files, mode changes, binary files (no hunks), "\ No newline at end of file", and names git puts in
// quotes. Anything before the first "diff --git" line is skipped.

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const ESCAPES = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", '"': '"', "\\": "\\" };

// A name as git quotes it: "dir/na\tme" with C escapes and octal bytes (UTF-8). An unquoted name is itself.
export function unquote(name) {
  if (!(name.length >= 2 && name.startsWith('"') && name.endsWith('"'))) return name;
  const bytes = [];
  const body = name.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[++i];
    const octal = /^[0-7]{3}/.exec(body.slice(i));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 2;
    } else bytes.push(...Buffer.from(ESCAPES[next] ?? next ?? "", "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

// "a/x" or "b/x" → "x"; /dev/null → null. A name with a blank ends in a tab on the ---/+++ lines.
function side(raw, prefix) {
  const name = unquote(raw.replace(/\t$/, ""));
  if (name === "/dev/null") return null;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

// The two names of a "diff --git a/X b/Y" line. Quoted names are told apart by their quotes; unquoted
// ones only when both are the same (a rename or a copy says its names on lines of its own).
function headerNames(rest) {
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|.+)$/.exec(rest);
  if (rest.startsWith('"') || rest.endsWith('"')) return quoted ? [side(quoted[1], "a/"), side(quoted[2], "b/")] : [null, null];
  const half = (rest.length - 1) / 2;
  const same = Number.isInteger(half) && rest.startsWith("a/") && rest.slice(half, half + 3) === " b/" && rest.slice(2, half) === rest.slice(half + 3);
  return same ? [rest.slice(2, half), rest.slice(half + 3)] : [null, null];
}

export function parsePatch(text) {
  const lines = String(text ?? "").split("\n");
  const files = [];
  let file = null;
  let hunk = null;
  let o = 0;
  let n = 0;

  const close = () => {
    if (!file) return;
    file.path = file.newName ?? file.oldName ?? file.gitNew ?? file.gitOld ?? "";
    const old = file.oldName ?? file.gitOld;
    if ((file.status === "renamed" || file.status === "copied") && old && old !== file.path) file.oldPath = old;
    for (const key of ["newName", "oldName", "gitNew", "gitOld"]) delete file[key];
    files.push(file);
    file = null;
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      close();
      const [gitOld, gitNew] = headerNames(line.slice("diff --git ".length));
      file = { path: "", status: "modified", binary: false, hunks: [], added: 0, removed: 0, gitOld, gitNew };
      continue;
    }
    if (!file) continue;
    // Inside a hunk every line is the diff's own: it ends when its counts are used up.
    if (hunk && (hunk.oldLeft > 0 || hunk.newLeft > 0)) {
      const mark = line[0];
      const body = line.slice(1);
      if (mark === "+") {
        hunk.lines.push({ t: "add", text: body, o: null, n: n++ });
        hunk.newLeft--;
        file.added++;
      } else if (mark === "-") {
        hunk.lines.push({ t: "del", text: body, o: o++, n: null });
        hunk.oldLeft--;
        file.removed++;
      } else if (mark === "\\") {
        const last = hunk.lines[hunk.lines.length - 1];
        if (last) last.noeol = true;
      } else {
        // A context line; an empty one may have lost its leading blank on the way.
        hunk.lines.push({ t: "ctx", text: mark === " " ? body : line, o: o++, n: n++ });
        hunk.oldLeft--;
        hunk.newLeft--;
      }
      continue;
    }
    if (line.startsWith("\\")) {
      const last = hunk?.lines[hunk.lines.length - 1];
      if (last) last.noeol = true;
      continue;
    }
    const at = HUNK.exec(line);
    if (at) {
      hunk = { oldStart: Number(at[1]), oldLines: at[2] === undefined ? 1 : Number(at[2]), newStart: Number(at[3]), newLines: at[4] === undefined ? 1 : Number(at[4]), section: at[5] || "", lines: [] };
      hunk.oldLeft = hunk.oldLines;
      hunk.newLeft = hunk.newLines;
      o = hunk.oldStart;
      n = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }
    if (line.startsWith("--- ")) file.oldName = side(line.slice(4), "a/") ?? file.oldName;
    else if (line.startsWith("+++ ")) file.newName = side(line.slice(4), "b/") ?? file.newName;
    else if (line.startsWith("rename from ")) (file.status = "renamed"), (file.oldName = unquote(line.slice(12)));
    else if (line.startsWith("rename to ")) (file.status = "renamed"), (file.newName = unquote(line.slice(10)));
    else if (line.startsWith("copy from ")) (file.status = "copied"), (file.oldName = unquote(line.slice(10)));
    else if (line.startsWith("copy to ")) (file.status = "copied"), (file.newName = unquote(line.slice(8)));
    else if (line.startsWith("new file mode ")) (file.status = "added"), (file.newMode = line.slice(14).trim());
    else if (line.startsWith("deleted file mode ")) (file.status = "deleted"), (file.oldMode = line.slice(18).trim());
    else if (line.startsWith("old mode ")) file.oldMode = line.slice(9).trim();
    else if (line.startsWith("new mode ")) file.newMode = line.slice(9).trim();
    else if (line.startsWith("similarity index ")) file.similarity = parseInt(line.slice(17), 10);
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true;
  }
  close();
  for (const f of files) for (const h of f.hunks) (delete h.oldLeft, delete h.newLeft);
  return files;
}

// Totals of a parsed patch.
export function patchStats(files) {
  return {
    files: files.length,
    added: files.reduce((sum, f) => sum + f.added, 0),
    removed: files.reduce((sum, f) => sum + f.removed, 0),
    binary: files.filter((f) => f.binary).length,
  };
}
