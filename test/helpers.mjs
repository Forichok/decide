// Shared harness for the test suites: every test gets a
// scratch dir that is both the project and (under .home) its DECIDE_HOME, so
// no daemon, journal or screenshot leaks into the real ~/.decide.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const enginePath = path.join(pluginDir, "decide.mjs");
export const WRITE = { "content-type": "application/json", "x-decide": "1" };

export const homeOf = (dir) => path.join(dir, ".home");
// DECIDE_PORT is dropped: a scratch home gets its own port, never the real home's.
export function envOf(dir, extra = {}) {
  const env = { ...process.env, DECIDE_HOME: homeOf(dir), ...extra };
  if (!("DECIDE_PORT" in extra)) delete env.DECIDE_PORT;
  return env;
}
export const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));

export async function scratchDir(context) {
  const dir = await mkdtemp(path.join(tmpdir(), "decide-test-"));
  context.after(async () => {
    await shutdownDaemon(dir);
    await rm(dir, { force: true, recursive: true });
  });
  return dir;
}

// Stops the server of the scratch dir's home through POST /api/stop, as the user's stop command does.
export const shutdownDaemon = (dir) => stopServer(homeOf(dir));

export async function stopServer(home) {
  let info;
  try {
    info = await readJson(path.join(home, "daemon.json"));
  } catch {
    return; // no server
  }
  // An in-process server names this very process: never signal or wait on yourself (its test stops it).
  if (info.pid === process.pid) return;
  // Only a decide server of this home with that pid is asked and waited for: daemon.json may name anything.
  const pong = alive(info.pid) ? await ping(info.port) : null;
  if (pong?.app !== "decide" || pong.home !== path.resolve(home) || pong.pid !== info.pid) return;
  notePid(info.pid);
  try {
    await fetch(`http://127.0.0.1:${info.port}/api/stop`, { method: "POST", headers: { ...WRITE, "x-decide-token": String(info.token) }, signal: AbortSignal.timeout(2_000) });
  } catch {
    // server already gone
  }
  // The process must be gone before the test ends: nothing outlives the run.
  for (let i = 0; i < 100 && alive(info.pid); i++) await new Promise((r) => setTimeout(r, 50));
}

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// DECIDE_TEST_PIDLOG=<file>: every server pid a test started or stopped is appended there, so a
// run can be checked for leftovers with `ps -o pid,command -p <pids>`.
export function notePid(pid) {
  if (process.env.DECIDE_TEST_PIDLOG && Number.isInteger(pid)) appendFileSync(process.env.DECIDE_TEST_PIDLOG, `${pid}\n`);
}

// GET /api/ping on a port: the answer, or null when nothing (or nothing that speaks JSON) answers.
export async function ping(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1_500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// `node decide.mjs serve` for a home. Resolves once the process serves ({ pid, port, exited: null })
// or has exited ({ pid, exited: <code> }). A process still running is stopped by its pid after the test.
export function spawnServer(context, home, { env = {} } = {}) {
  const childEnv = { ...process.env, DECIDE_HOME: home, DECIDE_NOTIFY: "0", ...env };
  if (!("DECIDE_PORT" in env)) delete childEnv.DECIDE_PORT;
  const child = spawn(process.execPath, [enginePath, "serve"], { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
  notePid(child.pid);
  const output = collect(child);
  context.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await exitOf(child);
  });
  return new Promise((resolve, reject) => {
    const done = (value) => {
      clearInterval(timer);
      clearTimeout(timeout);
      resolve({ pid: child.pid, child, output, ...value });
    };
    const timer = setInterval(() => {
      const m = output.stdout.match(/DECIDE serving: http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) done({ port: Number(m[1]), exited: null });
    }, 20);
    const timeout = setTimeout(() => {
      clearInterval(timer);
      reject(new Error(`decide serve neither served nor exited: ${output.stderr || output.stdout}`));
    }, 10_000);
    child.once("exit", (code) => done({ exited: code }));
  });
}

export function collect(child) {
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => (output.stdout += c));
  child.stderr.on("data", (c) => (output.stderr += c));
  return output;
}

// Runs decide.mjs for the scratch project; the child dies with the test.
export function runEngine(context, dir, args) {
  const child = spawn(process.execPath, [enginePath, ...args, "--project", dir], {
    stdio: ["ignore", "pipe", "pipe"],
    env: envOf(dir),
  });
  context.after(() => child.kill());
  return { child, output: collect(child) };
}

export function waitForOutput(child, output, pattern, ms = 8_000) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const match = output.stdout.match(pattern);
      if (match) {
        clearInterval(timer);
        clearTimeout(timeout);
        resolve(match);
      }
    }, 25);
    const timeout = setTimeout(() => {
      clearInterval(timer);
      reject(new Error(`no ${pattern} in output: ${output.stderr || output.stdout}`));
    }, ms);
    child.once("exit", (code) => {
      if (code !== 0 && !output.stdout.match(pattern)) {
        clearInterval(timer);
        clearTimeout(timeout);
        reject(new Error(`decide exited with ${code}: ${output.stderr || output.stdout}`));
      }
    });
  });
}

export const waitForReadyUrl = (child, output) =>
  waitForOutput(child, output, /DECIDE ready: (http:\/\/127\.0\.0\.1:\d+\/)#r=([\w-]+)/).then((m) => ({ url: m[1], round: m[2] }));

export const exitOf = (child) =>
  child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise((resolve) => child.once("exit", resolve));

export const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

// A scratch repository with one commit and a linked worktree, all removed after the test.
// Paths are real paths, so /var vs /private/var and short Windows names cannot differ.
export async function repoWithWorktree(context) {
  const dir = realpathSync.native(await scratchDir(context));
  const main = path.join(dir, "main");
  const wt = path.join(dir, "wt");
  mkdirSync(main);
  const git = (cwd, ...args) => {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
    for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
    const r = spawnSync("git", ["-c", "user.name=decide-test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  };
  git(main, "init", "-q");
  git(main, "commit", "-q", "--allow-empty", "-m", "init");
  git(main, "worktree", "add", "-q", "-b", "side", wt);
  return { dir, main, wt, git };
}
