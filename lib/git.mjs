// git.mjs — read-only git for review and visual acceptance. Every call is execFile("git", [fixed arguments…])
// with no shell, the working directory at the project top, and an allowlisted subcommand. A ref or a path that comes from a spec or from the page is checked before
// it reaches git: nothing that starts with "-", no path outside the project, and a file's content only
// for a file the snapshot names.

import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const SUBCOMMANDS = ["rev-parse", "merge-base", "diff", "show", "ls-files", "grep", "reflog"];
// A diff or a file larger than this is not a review a person reads.
const MAX_BYTES = 64 * 1024 * 1024;
// Longer than any read of a repository a person reviews; a filter or a hook that hangs is stopped.
const TIMEOUT_MS = 30_000;
const REF_MAX = 250;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// A refusal is for whoever named the ref or the path: status 400, said as it is.
export function refusal(message) {
  return Object.assign(new Error(message), { status: 400, user: true, refused: true });
}

// A ref as git takes it on a command line: a branch, a tag, a sha, HEAD~2, name@{upstream}.
// Refused: an option ("-…"), a range or a rev:path ("a..b", "sha:file"), blanks and control characters.
export function checkRef(ref, what = "ref") {
  if (typeof ref !== "string" || !ref) throw refusal(`${what} must be a non-empty string`);
  if (ref.startsWith("-")) throw refusal(`${what} "${ref}" starts with "-": refused, it would be read as a git option`);
  if (ref.length > REF_MAX || /[\s\x00-\x1f\x7f:\\?*[]/.test(ref) || ref.includes("..")) throw refusal(`${what} "${ref.slice(0, 80)}" is not a single commit name`);
  return ref;
}

// A path inside the project, as git names it: relative to the top, with forward slashes.
// Refused: an option ("-…"), a pathspec with magic (":…"), an absolute path or one that leaves the top.
export function checkPath(top, path, what = "path") {
  if (typeof path !== "string" || !path) throw refusal(`${what} must be a non-empty string`);
  if (path.startsWith("-")) throw refusal(`${what} "${path}" starts with "-": refused, it would be read as a git option`);
  if (path.includes("\0") || path.startsWith(":")) throw refusal(`${what} "${path.slice(0, 80)}" is not a file path`);
  const abs = resolve(top, path);
  const rel = relative(resolve(top), abs);
  if (isAbsolute(path) || !rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw refusal(`${what} "${path}" is outside the project`);
  return rel.split(sep).join("/");
}

// A file of the snapshot: the path as checkPath returns it, and only when the snapshot's file list has it.
export function checkSnapshotPath(top, path, files) {
  const rel = checkPath(top, path);
  if (!files.includes(rel)) throw refusal(`"${rel}" is not a file of this review's snapshot`);
  return rel;
}

const sha = (value, what) => {
  if (!SHA.test(String(value))) throw refusal(`${what} is not a commit id`);
  return value;
};

// Runs one git subcommand: { code, stdout }. codes: the exit codes that are an answer, not a failure.
// The global options make git quiet and literal: no pager, no prompt, no optional locks, paths as written
// (no pathspec magic), names not quoted. Nothing here writes to the repository.
function git(top, args, { codes = [0] } = {}) {
  if (!SUBCOMMANDS.includes(args[0])) throw new Error(`git ${args[0]} is not an allowed read-only subcommand`);
  // GIT_NO_LAZY_FETCH: in a partial clone a missing object is an error, never a fetch from the remote.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_PAGER: "cat", LC_ALL: "C" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_EXTERNAL_DIFF"]) delete env[name];
  const fixed = ["--no-pager", "--literal-pathspecs", "-c", "core.quotepath=off", "-c", "core.warnAmbiguousRefs=true", "-c", "core.fsmonitor=false", "-c", "color.ui=never"];
  return new Promise((done, fail) => {
    execFile("git", [...fixed, ...args], { cwd: top, env, maxBuffer: MAX_BYTES, encoding: "utf8", windowsHide: true, timeout: TIMEOUT_MS, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
      if (err?.killed && err.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return fail(Object.assign(new Error(`git ${args[0]} did not finish in ${TIMEOUT_MS / 1000} s: stopped`), { status: 504, user: true }));
      const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
      if (code !== null && codes.includes(code)) return done({ code, stdout });
      if (err?.code === "ENOENT") return fail(Object.assign(new Error("git is not installed, or not on PATH: the review mode reads the diff from git"), { status: 400, user: true }));
      if (err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return fail(Object.assign(new Error(`git ${args[0]} printed more than ${MAX_BYTES >> 20} MB: too large to review in one round`), { status: 413, user: true }));
      fail(Object.assign(new Error(`git ${args[0]} failed${code === null ? "" : ` (exit ${code})`}: ${String(stderr || err?.message || "").trim().split("\n")[0]}`), { status: 400, user: true }));
    });
  });
}

// The commit a ref names, as a full id; null when git knows no such commit.
export async function resolveCommit(top, ref) {
  checkRef(ref);
  const { code, stdout } = await git(top, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { codes: [0, 1, 128] });
  const id = stdout.trim();
  return code === 0 && SHA.test(id) ? id : null;
}

// Is `top` inside a git working tree at all?
export async function insideRepo(top) {
  const { code, stdout } = await git(top, ["rev-parse", "--is-inside-work-tree"], { codes: [0, 128] });
  return code === 0 && stdout.trim() === "true";
}

// The short name of the branch HEAD is on; "" when detached.
export async function currentBranch(top) {
  const { code, stdout } = await git(top, ["rev-parse", "--abbrev-ref", "HEAD"], { codes: [0, 128] });
  const name = stdout.trim();
  return code === 0 && name !== "HEAD" ? name : "";
}

// Resolve a branch name without accepting ambiguous short names or expressions such as HEAD~1.
export async function branchRef(top, ref) {
  checkRef(ref);
  const { stdout } = await git(top, ["rev-parse", "--verify", "--symbolic-full-name", "--end-of-options", ref], { codes: [0, 1, 128] });
  const name = stdout.trim();
  return /^refs\/(heads|remotes)\/[^\s]+$/.test(name) ? name : null;
}

// Newest first. The raw reflog date lets us pair branch creation with the HEAD checkout.
export async function branchLog(top, ref) {
  checkRef(ref);
  const { stdout } = await git(top, ["reflog", "show", "--date=raw", "--format=%H%x00%gD%x00%gs", ref, "--"], { codes: [0, 128] });
  return stdout.split("\n").flatMap((line) => {
    const [id, selector, action] = line.split("\0");
    const date = selector?.match(/@\{(\d+ [+-]\d{4})\}$/)?.[1];
    return SHA.test(id) && date && action ? [{ id, date, action }] : [];
  });
}

// The best common ancestor of two commits; null when they share none.
export async function mergeBase(top, a, b) {
  const { code, stdout } = await git(top, ["merge-base", sha(a, "base"), sha(b, "head")], { codes: [0, 1] });
  const id = stdout.trim().split("\n")[0];
  return code === 0 && SHA.test(id) ? id : null;
}

// Only resolved commits reach merge-base, including a head read back from a saved round.
export async function isAncestor(top, ancestor, head) {
  const { code } = await git(top, ["merge-base", "--is-ancestor", sha(ancestor, "ancestor"), sha(head, "head")], { codes: [0, 1] });
  return code === 0;
}

// What a branch is reviewed against when the agent names nothing: the remote's default branch, else
// main or master, the remote's first. The first that names a commit other than `head` wins.
export const BASE_CANDIDATES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];
export async function defaultBase(top, head) {
  for (const ref of BASE_CANDIDATES) {
    const id = await resolveCommit(top, ref);
    if (id && id !== head) return { ref, commit: id };
  }
  return null;
}

// The unified diff between two commits, as git prints it: renames found, three lines of context,
// a/ and b/ prefixes whatever the user's config says, no external diff driver and no textconv filter.
export async function diffText(top, base, head) {
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--unified=3", "--src-prefix=a/", "--dst-prefix=b/", "--no-relative", sha(base, "base"), sha(head, "head"), "--"];
  return (await git(top, args)).stdout;
}

// Does the working tree differ from a commit (tracked files only)? Uncommitted work is not in a snapshot.
export async function differsFromTree(top, commit) {
  const { code } = await git(top, ["diff", "--quiet", "--no-ext-diff", sha(commit, "commit"), "--"], { codes: [0, 1] });
  return code === 1;
}

// One file of the snapshot at one of its commits, whole; null when the commit has no such file
// (a file the change added has no old side). files: the snapshot's file list, the only paths served.
export async function fileAt(top, commit, path, files) {
  const rel = checkSnapshotPath(top, path, files);
  const { code, stdout } = await git(top, ["show", "--no-ext-diff", "--no-textconv", "--end-of-options", `${sha(commit, "commit")}:${rel}`], { codes: [0, 128] });
  return code === 0 ? stdout : null;
}
