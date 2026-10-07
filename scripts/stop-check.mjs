import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function pickFiles({ working = "", untracked = "", committed = "", branch } = {}) {
  return [...new Set([working, untracked, branch === "master" ? "" : committed]
    .flatMap((names) => names.split("\0"))
    .filter((name) => /\.(?:mjs|js|json)$/.test(name)))].sort();
}

export function shouldRun({ files, optOut, stopHookActive, fingerprint: current, previous }) {
  return optOut !== "0" && files.length > 0 && !(stopHookActive === true &&
    previous?.outcome === "failure" && previous.fingerprint === current);
}

export function fingerprint(context, files) {
  return createHash("sha256").update(JSON.stringify([context, files.map(([name, content]) =>
    [name, content === null ? null : createHash("sha256").update(content).digest("hex")])])).digest("hex");
}

function tail(output) {
  return output.trimEnd().split(/\r?\n/).slice(-40).join("\n") + "\n";
}

function environmentReason(result) {
  if (result.error) return result.error.message || result.error.code || "command could not run";
  if (result.status === null || result.status === undefined) return `command ended without an exit code (${result.signal || "unknown reason"})`;
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  // A test title or assertion mentioning ENOENT is not an environment error.
  const missing = /(?:^\s*(?:#\s*)?Error: ENOENT:|^\s*code:\s*['"]?ENOENT['"]?\s*$)/m;
  const parts = output.split(/^([ \t]*(?:not )?ok \d+[^\n]*)$/m);
  const diagnosticEnd = /^[ \t]*\.\.\.[ \t]*$/m;
  const failures = [];
  for (let i = 1; i < parts.length; i += 2) {
    if (!parts[i].trimStart().startsWith("not ok ")) continue;
    const diagnostic = parts[i + 1].split(diagnosticEnd)[0];
    const preamble = parts[i - 1].split(diagnosticEnd).at(-1);
    // Import-time crashes report ERR_TEST_FAILURE; the actual error precedes
    // the Subtest header. Associate it with this result, not another test.
    failures.push(/^\s*code:\s*['"]?ENOENT['"]?\s*$/m.test(diagnostic) ||
      (/^\s*code:\s*['"]?ERR_TEST_FAILURE['"]?\s*$/m.test(diagnostic) && missing.test(preamble)));
  }
  if (failures.length ? failures.every(Boolean) : missing.test(output)) return tail(output).trim();
  return null;
}

export function summarizeResults(results) {
  const failed = results.filter((result) => result.status !== 0 || result.error);
  const real = failed.filter((result) => !environmentReason(result));
  if (real.length) return {
    outcome: "failure", exitCode: 2, stdout: "",
    stderr: tail(real.map((result) => `${result.command} exited ${result.status}\n${result.stdout || ""}\n${result.stderr || ""}`).join("\n")),
  };
  if (failed.length) return {
    outcome: "environment", exitCode: 0, stderr: "",
    stdout: JSON.stringify({ systemMessage: `NOT verified: ${failed.map((result) => `${result.command}: ${environmentReason(result)}`).join("; ")}` }) + "\n",
  };
  return { outcome: "success", exitCode: 0, stdout: "", stderr: "" };
}

function run(command, args, cwd) {
  return { command: [command, ...args].join(" "), ...spawnSync(command, args, {
    cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  }) };
}

function git(args, cwd) {
  const result = run("git", args, cwd);
  if (result.error || result.status !== 0) throw new Error(
    `${result.command}: ${result.error?.message || result.stderr.trim() || `exit ${result.status}`}`,
  );
  return result.stdout;
}

function statePaths(root) {
  const fallback = path.join(tmpdir(), `decide-stop-check-${createHash("sha256").update(root).digest("hex")}.json`);
  try {
    return [path.resolve(root, git(["rev-parse", "--git-path", "decide-stop-check.json"], root).trim()), fallback];
  } catch {
    return [fallback];
  }
}

function readState(paths) {
  for (const file of paths) {
    try { return JSON.parse(readFileSync(file, "utf8")); } catch { /* Missing or invalid cache: run checks. */ }
  }
  return null;
}

function writeState(paths, state) {
  for (const file of paths) {
    try { writeFileSync(file, JSON.stringify(state) + "\n"); return; } catch { /* Try the temp directory. */ }
  }
  process.stdout.write(JSON.stringify({ systemMessage: "NOT verified: Stop loop state could not be saved in the Git directory or temporary directory" }) + "\n");
}

function notVerified(reason) {
  process.stdout.write(JSON.stringify({ systemMessage: `NOT verified: ${reason}` }) + "\n");
  return 0;
}

export function main() {
  if (process.env.AGENT_STOP_CHECK === "0") return notVerified("Stop checks disabled by AGENT_STOP_CHECK=0");
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch (error) {
    return notVerified(`cannot read Stop input: ${error.message}`);
  }
  try {
    const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
    const branch = git(["branch", "--show-current"], root).trim();
    const head = git(["rev-parse", "HEAD"], root).trim();
    const base = branch === "master" ? "" : git(["merge-base", "HEAD", "origin/master"], root).trim();
    const files = pickFiles({
      branch,
      working: git(["diff", "--name-only", "-z", "--no-renames", "HEAD", "--"], root),
      untracked: git(["ls-files", "--others", "--exclude-standard", "-z"], root),
      committed: base ? git(["diff", "--name-only", "-z", "--no-renames", base, "HEAD", "--"], root) : "",
    });
    if (!files.length) return 0;
    const contents = files.map((name) => {
      try { return [name, readFileSync(path.join(root, name))]; } catch (error) {
        if (error.code === "ENOENT") return [name, null];
        throw error;
      }
    });
    const current = fingerprint([root, branch, head, base], contents);
    const paths = statePaths(root);
    if (!shouldRun({ files, stopHookActive: input?.stop_hook_active,
      fingerprint: current, previous: readState(paths) })) return 0;

    const results = [];
    for (const [name, content] of contents) {
      if (content !== null && /\.(?:mjs|js)$/.test(name)) {
        results.push(run(process.execPath, ["--check", path.join(root, name)], root));
      }
    }
    const started = performance.now();
    results.push(run(process.execPath, ["--test"], root));
    const suiteMs = performance.now() - started;
    const summary = summarizeResults(results);
    writeState(paths, { fingerprint: current, outcome: summary.outcome, suiteMs });
    process.stdout.write(summary.stdout);
    process.stderr.write(summary.stderr);
    if (summary.outcome === "success") process.stdout.write(JSON.stringify({
      systemMessage: `Stop check verified: node --check and node --test exited 0; suite runtime ${(suiteMs / 1000).toFixed(3)}s`,
    }) + "\n");
    return summary.exitCode;
  } catch (error) {
    return notVerified(error.message);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main();
}
