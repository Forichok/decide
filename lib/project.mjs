// project.mjs — where a project's decide state lives. Every project gets one
// data directory under ~/.decide (DECIDE_HOME overrides it): the session
// daemon's info and log, inline specs and their answers, screenshots and the
// decision journal. Claude and Codex sessions of one project share it, so
// they share one browser tab too.

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export function decideHome() {
  return resolve(process.env.DECIDE_HOME || join(homedir(), ".decide"));
}

// What push, explain, wait, export and the others say for a round the home's server does not know (404): only
// then is asking again right. For the user, as it is.
export const unknownRound = (round, home = decideHome()) =>
  Object.assign(new Error(`Round ${round} is unknown to the decide server of ${home}: it was never opened in this decide home, or its files were removed. Ask again if you still need the answers.`), { user: true });

// Nearest directory that holds a .git (file or directory); else the start itself.
export function worktreeTop(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}

function readLine(file) {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/, 1)[0].trim();
  } catch {
    return null;
  }
}

// The .git directory shared by every worktree of one repository, found by
// reading files only (git is never spawned). A submodule's gitdir has no
// commondir, so it has no shared directory: it is its own project.
export function gitCommonDir(start) {
  const top = worktreeTop(start);
  const dotGit = join(top, ".git");
  let stat;
  try {
    stat = statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  const line = readLine(dotGit);
  if (!line || !line.startsWith("gitdir:")) return null;
  const gitdir = resolve(top, line.slice("gitdir:".length).trim());
  const common = readLine(join(gitdir, "commondir"));
  return common ? resolve(gitdir, common) : null;
}

// Known and intended for now: a worktree of a --separate-git-dir repository or of
// a submodule reaches the git dir without a ".git" name, so its root is that dir
// while its main checkout's root is its own top; those pairs are two projects.
function spelledRoot(start) {
  const common = gitCommonDir(start);
  if (!common) return worktreeTop(start);
  return basename(common) === ".git" ? dirname(common) : common;
}

function real(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

// One project per repository: the parent of the shared .git, the shared
// directory itself for a bare repository, the worktree top outside git.
// Always a real path, so a symlinked spelling cannot split a project.
export function projectRoot(start) {
  return real(spelledRoot(start));
}

export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

// home: the decide home the data dir belongs to (the environment's when omitted).
export function dataDirPath(root, home = decideHome()) {
  const name = basename(root).replace(/[^\w.-]+/g, "_").slice(0, 40) || "root";
  return join(home, "projects", `${name}-${fnv1a(root).toString(16).padStart(8, "0")}`);
}

export function dataDirFor(root, home = decideHome()) {
  const dir = dataDirPath(root, home);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// top is the working tree: the base for files the agent names. root is identity only.
// legacyDirs: existing 2.1 data dirs (keyed by the spellings 2.1.1 could have used) other than dataDir. Never created.
// home: the decide home to open it in; a server passes its own, so the environment never moves it.
export function openProject(start, home = decideHome()) {
  const spelledTop = worktreeTop(start);
  const root = projectRoot(start);
  const top = real(spelledTop);
  const dataDir = dataDirFor(root, home);
  const keys = [spelledTop, spelledRoot(start), top];
  const legacyDirs = [...new Set(keys.map((key) => dataDirPath(key, home)))].filter((d) => d !== dataDir && existsSync(d));
  return { root, top, dataDir, legacyDirs };
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
