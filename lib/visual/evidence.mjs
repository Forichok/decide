import {
  constants,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { invalid } from "./spec.mjs";

const MAX_FILE = 128 * 1024 * 1024;
function mediaType(buf) {
  if (buf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return ".png";
  if (buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return ".jpg";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return ".webp";
  if (buf.toString("ascii", 4, 8) === "ftyp") return ".mp4";
  if (buf.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"))) return ".webm";
  return "";
}
function mapSide(side, fn) {
  if (!side) return;
  for (const kind of ["image", "video"]) if (side[kind]) side[kind] = fn(side[kind], kind);
}
export function mapEvidence(spec, fn) {
  for (const task of spec.tasks)
    for (const e of task.evidence) {
      mapSide(e.before, fn);
      mapSide(e.after, fn);
    }
}
// A return keeps its original coordinates and its original media even when the control moved.
export function snapshotEvidence(spec, dir, sourceDir, previous) {
  const media = join(dir, "visual-media");
  mkdirSync(media, { mode: 0o700 });
  const copies = new Map();
  let total = 0;
  function copy(path, kind, base) {
    let file;
    try {
      file = realpathSync(resolve(base, path));
    } catch {
      invalid(`Capture unavailable: ${path}`);
    }
    const rel = relative(realpathSync(base), file);
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      invalid("Captures must be inside the spec directory");
    const ext = extname(file)
      .toLowerCase()
      .replace(/^\.jpeg$/, ".jpg");
    if (!(kind === "image" ? [".png", ".jpg", ".webp"] : [".webm", ".mp4"]).includes(ext))
      invalid(`Unsupported ${kind} format`);
    if (copies.has(file)) return copies.get(file);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE || (total += stat.size) > 512 * 1024 * 1024)
        invalid("Capture size exceeds the round's media limit");
      const header = Buffer.alloc(16);
      readSync(fd, header, 0, 16, 0);
      if (mediaType(header) !== ext) invalid(`Capture contents do not match ${ext}`);
      const target = join(media, `capture-${copies.size + 1}${ext}`);
      // Read the same descriptor we validated. A capture being replaced cannot silently
      // substitute another path, and a growing capture cannot exhaust the storage budget.
      const dest = openSync(target, "wx", 0o600);
      try {
        const chunk = Buffer.allocUnsafe(Math.min(stat.size, 64 * 1024));
        let at = 0;
        while (at < stat.size) {
          const n = readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - at), at);
          if (!n) invalid("Capture changed while opening the round");
          let written = 0;
          while (written < n) written += writeSync(dest, chunk, written, n - written);
          at += n;
        }
        const after = fstatSync(fd);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
          invalid("Capture changed while opening the round");
      } finally {
        closeSync(dest);
      }
      copies.set(file, target);
      return target;
    } finally {
      closeSync(fd);
    }
  }
  mapEvidence(spec, (path, kind) => copy(path, kind, sourceDir));
  if (!previous) {
    if (spec.previous || spec.replies?.length)
      invalid("Replies require a returned visual round from this project");
    return;
  }
  const unresolved = new Map();
  for (const reply of previous.spec.replies ?? [])
    if (previous.state.visual.resolutions[reply.ref] !== "fixed") unresolved.set(reply.ref, reply.original);
  for (const mark of previous.state.visual.marks) {
    const pair = previous.spec.tasks
      .find((t) => t.id === mark.task)
      .evidence.find((e) => e.id === mark.evidence);
    unresolved.set(mark.id, { ...pair[mark.side], ...mark });
  }
  if (previous.state.result.note) spec.previousNote = previous.state.result.note;
  for (const reply of spec.replies ?? []) {
    const original = unresolved.get(reply.ref);
    if (!original) invalid("Reply names an unknown, duplicate or closed remark");
    reply.original = { ...original };
    mapSide(reply.original, (path, kind) => copy(path, kind, join(previous.dir, "visual-media")));
    unresolved.delete(reply.ref);
  }
  if (unresolved.size) invalid("Every open remark needs an author reply");
}
export function publishVisual(spec, publish) {
  const out = structuredClone(spec);
  mapEvidence(out, publish);
  for (const reply of out.replies ?? []) mapSide(reply.original, publish);
  return out;
}
