import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import test from "node:test";
import { openProject } from "../lib/project.mjs";
import { enginePath, envOf, pluginDir, scratchDir } from "./helpers.mjs";

import { visualRange as range } from "../lib/visual/baseline.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(cwd, text) {
  git(cwd, "commit", "--quiet", "--allow-empty", "-m", text);
  return git(cwd, "rev-parse", "HEAD");
}

async function fixture(t) {
  const dir = await scratchDir(t);
  const top = join(dir, "project");
  mkdirSync(top);
  git(top, "init", "-q", "-b", "main");
  git(top, "config", "user.name", "decide test");
  git(top, "config", "user.email", "test@decide.example");
  git(top, "config", "core.logAllRefUpdates", "true");
  git(top, "config", "commit.gpgSign", "false");
  const main = commit(top, "main");
  git(top, "switch", "-q", "-c", "dev");
  const dev = commit(top, "dev");
  git(top, "switch", "-q", "-c", "topic");
  const head = commit(top, "first feature change");
  const project = openProject(top, join(dir, "home"));
  return { top, dataDir: project.dataDir, home: join(dir, "home"), dir, main, dev, head };
}

test("an automatic preview shows the fork without remembering the policy", async (t) => {
  const { top, dataDir, dev, head } = await fixture(t);
  assert.deepEqual(await range({ top, dataDir, preview: true }), { base: dev, head, baseRef: "dev", headRef: "topic" });
  await assert.rejects(range({ top, dataDir }), /confirm.*--baseline-policy branch-start/i);
});

test("confirmed policy is shared across worktrees and recalculates the source branch", async (t) => {
  const { top, dataDir, home, dir, dev, main, head } = await fixture(t);
  assert.deepEqual(await range({ top, dataDir, baselinePolicy: "branch-start" }), { base: dev, head, baseRef: "dev", headRef: "topic" });
  const worktree = join(dir, "other-worktree");
  git(top, "worktree", "add", "-q", "-b", "another-topic", worktree, "main");
  const nextHead = commit(worktree, "another feature");
  const next = openProject(worktree, home);
  assert.equal(next.dataDir, dataDir);
  assert.deepEqual(await range(next), { base: main, head: nextHead, baseRef: "main", headRef: "another-topic" });
});

test("automation keeps the recorded start after the source advances and is merged in", async (t) => {
  const { top, dataDir, dev } = await fixture(t);
  git(top, "switch", "-q", "dev");
  commit(top, "landed after topic started");
  git(top, "switch", "-q", "topic");
  git(top, "merge", "-q", "--no-edit", "dev");
  const head = git(top, "rev-parse", "HEAD");
  assert.deepEqual(await range({ top, dataDir, baselinePolicy: "branch-start" }), { base: dev, head, baseRef: "dev", headRef: "topic" });
});

test("an explicit base pins the exact requested commit and requires no policy", async (t) => {
  const { top, dataDir, main, head } = await fixture(t);
  git(top, "switch", "-q", "main");
  const override = commit(top, "newer main, outside topic ancestry");
  assert.notEqual(override, main);
  assert.deepEqual(await range({ top, dataDir, base: "main", head: "topic" }), { base: override, head, baseRef: "main", headRef: "topic" });
  await assert.rejects(range({ top, dataDir, head: "topic" }), /confirm.*--baseline-policy branch-start/i);
});

test("ambiguous source ref names ask for an explicit baseline", async (t) => {
  const { top, dataDir, main } = await fixture(t);
  git(top, "tag", "dev", main);
  await assert.rejects(range({ top, dataDir, baselinePolicy: "branch-start" }), /dev.*ambiguous.*--base/i);
});

test("common ancestry alone does not label a branch as the work's source", async (t) => {
  const { top, dataDir, dev } = await fixture(t);
  git(top, "update-ref", "refs/heads/another", dev);
  git(top, "reflog", "expire", "--expire=all", "refs/heads/topic");
  await assert.rejects(range({ top, dataDir, baselinePolicy: "branch-start" }), /branch origin.*--base/i);
});

test("automation asks when the branch no longer descends from its recorded start", async (t) => {
  const { top, dataDir, main } = await fixture(t);
  git(top, "reset", "--hard", main);
  commit(top, "new work with different ancestry");
  await assert.rejects(range({ top, dataDir, baselinePolicy: "branch-start" }), /ancestry.*--base/i);
});

test("CLI prints the proposed revisions before any daemon starts", async (t) => {
  const { top, dir, dev, head } = await fixture(t);
  const result = spawnSync(process.execPath, [enginePath, "visual", "--compare"], { cwd: top, env: envOf(dir), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(dev));
  assert.ok(result.stdout.includes(head));
  assert.match(result.stdout, /confirm.*--baseline-policy branch-start/i);
  assert.equal(existsSync(join(envOf(dir).DECIDE_HOME, "daemon.json")), false);
});

test("MCP previews the pinned comparison without opening a round", async (t) => {
  const { top, dir, dev, head } = await fixture(t);
  const child = spawn(process.execPath, [join(pluginDir, "mcp.mjs")], { cwd: pluginDir, env: envOf(dir), stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const messages = lines[Symbol.asyncIterator]();
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "visual", arguments: { project: top, compare: true } } }) + "\n");
  const message = JSON.parse((await messages.next()).value);
  assert.equal(message.result.isError, undefined, JSON.stringify(message));
  const response = message.result.content.map(({ text }) => text).join("\n");
  assert.ok(response.includes(dev));
  assert.ok(response.includes(head));
});
