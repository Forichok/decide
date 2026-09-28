// project.mjs — where a project's decide state lives. Every project gets one
// data directory under ~/.decide (DECIDE_HOME overrides it): the session
// daemon's info and log, inline specs and their answers, screenshots and the
// decision journal. Claude and Codex sessions of one project share it, so
// they share one browser tab too.

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export function decideHome() {
  return resolve(process.env.DECIDE_HOME || join(homedir(), ".decide"));
}

// The git top level (a worktree counts as its own project), else the directory itself.
export function projectRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}

export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

export function dataDirFor(root) {
  const name = basename(root).replace(/[^\w.-]+/g, "_").slice(0, 40) || "root";
  const dir = join(decideHome(), "projects", `${name}-${fnv1a(root).toString(16).padStart(8, "0")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function openProject(start) {
  const root = projectRoot(start);
  return { root, dataDir: dataDirFor(root) };
}

export function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

export function slugify(text, fallback = "round") {
  const slug = String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || fallback;
}
