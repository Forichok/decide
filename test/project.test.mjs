/**
 * Feature:    project identity
 * Layer:      Unit (file reads and the git binary for fixtures)
 * Contract:   lib/project.mjs: gitCommonDir, worktreeTop, projectRoot, dataDirPath, openProject
 * Covers:
 *   - Worktrees of one repository share one root and one data dir
 *   - A worktree's 2.1 data dir is reported as a legacy source and never created
 *   - The main checkout keeps its 2.1.1 data dir name
 *   - Outside git the directory itself is the project; a submodule is its own project
 * Why exists: the 3.0 core keys one journal per repository, not per checkout.
 * Isolation:  every test sets its own DECIDE_HOME and restores it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { dataDirPath, fnv1a, gitCommonDir, openProject, projectRoot, worktreeTop } from "../lib/project.mjs";
import { appendJournal, readJournal } from "../lib/journal.mjs";
import { HANDLERS, enginePath, envOf, hasGit, homeOf, repoWithWorktree, scratchDir } from "./helpers.mjs";

const skip = hasGit ? false : "git binary not found";

async function withHome(t) {
  const dir = realpathSync.native(await scratchDir(t));
  const prev = process.env.DECIDE_HOME;
  process.env.DECIDE_HOME = path.join(dir, ".home");
  t.after(() => {
    if (prev === undefined) delete process.env.DECIDE_HOME;
    else process.env.DECIDE_HOME = prev;
  });
  return dir;
}

test("a worktree and its main checkout are one project", { skip }, async (t) => {
  const { main, wt } = await repoWithWorktree(t);
  await withHome(t);
  assert.equal(openProject(wt).root, openProject(main).root);
  assert.equal(openProject(wt).dataDir, openProject(main).dataDir);
  assert.equal(openProject(wt).root, main);
  assert.equal(openProject(wt).top, wt);
  assert.equal(gitCommonDir(wt), path.join(main, ".git"));
});

test("a subdirectory of a worktree resolves to the same project", { skip }, async (t) => {
  const { main, wt } = await repoWithWorktree(t);
  await withHome(t);
  const sub = path.join(wt, "a", "b");
  mkdirSync(sub, { recursive: true });
  assert.equal(projectRoot(sub), main);
  assert.equal(worktreeTop(sub), wt);
});

test("a worktree's 2.1 data dir is a legacy source and is not created", { skip }, async (t) => {
  const { wt } = await repoWithWorktree(t);
  await withHome(t);
  assert.deepEqual(openProject(wt).legacyDirs, []);
  assert.equal(existsSync(dataDirPath(wt)), false);
  mkdirSync(dataDirPath(wt), { recursive: true });
  assert.deepEqual(openProject(wt).legacyDirs, [dataDirPath(wt)]);
});

test("the main checkout keeps its 2.1 data dir", { skip }, async (t) => {
  const { main } = await repoWithWorktree(t);
  const dir = await withHome(t);
  const expected = path.join(dir, ".home", "projects", `main-${fnv1a(main).toString(16).padStart(8, "0")}`);
  assert.equal(dataDirPath(main), expected);
  assert.equal(dataDirPath("/x/decide"), path.join(dir, ".home", "projects", "decide-71c932ef"), "golden value from the 2.1.1 code");
  const project = openProject(main);
  assert.equal(project.dataDir, expected);
  assert.equal(project.top, main);
  assert.deepEqual(project.legacyDirs, []);
});

test("outside git the directory itself is the project", async (t) => {
  const dir = await withHome(t);
  const plain = path.join(dir, "plain");
  mkdirSync(plain);
  assert.equal(gitCommonDir(plain), null);
  const project = openProject(plain);
  assert.equal(project.root, plain);
  assert.equal(project.top, plain);
  assert.deepEqual(project.legacyDirs, []);
});

test("a submodule is its own project", async (t) => {
  const dir = await withHome(t);
  const outer = path.join(dir, "outer");
  const sub = path.join(outer, "libs", "sub");
  const modules = path.join(outer, ".git", "modules", "sub");
  mkdirSync(sub, { recursive: true });
  mkdirSync(modules, { recursive: true });
  writeFileSync(path.join(sub, ".git"), "gitdir: ../../.git/modules/sub\n");
  assert.equal(gitCommonDir(sub), null);
  assert.equal(projectRoot(sub), sub);
  assert.equal(openProject(sub).root, sub);
});

test("a relative gitdir and commondir resolve without spawning git", async (t) => {
  const dir = await withHome(t);
  const main = path.join(dir, "m");
  const wt = path.join(dir, "w");
  const gitdir = path.join(main, ".git", "worktrees", "w");
  mkdirSync(gitdir, { recursive: true });
  mkdirSync(wt);
  writeFileSync(path.join(wt, ".git"), `gitdir: ${path.relative(wt, gitdir)}\n`);
  writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  assert.equal(gitCommonDir(wt), path.join(main, ".git"));
  assert.equal(projectRoot(wt), main);
});

test("a worktree of a bare repository is rooted at the bare directory", async (t) => {
  const dir = await withHome(t);
  const bare = path.join(dir, "repo.git");
  const wt = path.join(dir, "w");
  const gitdir = path.join(bare, "worktrees", "w");
  mkdirSync(gitdir, { recursive: true });
  mkdirSync(wt);
  writeFileSync(path.join(wt, ".git"), `gitdir: ${gitdir}\n`);
  writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  assert.equal(projectRoot(wt), bare);
});

const symlinkSkip = hasGit && process.platform !== "win32" ? false : "needs git and symlinks (skipped on win32: symlinks need privileges)";

test("a repository reached through a symlink and its worktree are one project (skipped on win32: symlinks need privileges)", { skip: symlinkSkip }, async (t) => {
  const { dir, main, wt } = await repoWithWorktree(t);
  await withHome(t);
  const link = path.join(dir, "link");
  symlinkSync(main, link);
  const viaLink = openProject(link);
  assert.equal(viaLink.root, main);
  assert.equal(viaLink.dataDir, openProject(wt).dataDir);
});

test("a main checkout that 2.1.1 opened through a symlink finds its old data dir as legacy (skipped on win32: symlinks need privileges)", { skip: symlinkSkip }, async (t) => {
  const { dir, main } = await repoWithWorktree(t);
  await withHome(t);
  const link = path.join(dir, "link");
  symlinkSync(main, link);
  assert.deepEqual(openProject(link).legacyDirs, []);
  mkdirSync(dataDirPath(link), { recursive: true });
  assert.deepEqual(openProject(link).legacyDirs, [dataDirPath(link)]);
  assert.notEqual(openProject(link).dataDir, dataDirPath(link));
});

test("from a worktree, files the agent names resolve inside the worktree, not the main checkout", { skip }, async (t) => {
  const { main, wt } = await repoWithWorktree(t);
  await withHome(t);
  const project = openProject(wt);
  const specFile = path.join(wt, "x.questions.json");
  const raw = { title: "Where", questions: [{ id: "q", title: "Which side?", options: [{ id: "a", label: "A" }] }] };
  writeFileSync(specFile, JSON.stringify(raw));
  const answers = path.join(wt, "x.answers.json");
  const result = { round: "r1", title: "Where", submittedAt: "2026-10-01T10:00:00.000Z", answers: { q: { selected: ["a"] } }, digest: "1. Which side? -> A" };
  writeFileSync(answers, JSON.stringify(result));
  appendJournal(project.dataDir, { specFile, outPath: answers, spec: raw }, result);
  assert.equal(readJournal(project.dataDir).length, 1);
  const out = await HANDLERS.adr({ project: wt });
  assert.match(out, /Wrote /);
  assert.ok(existsSync(path.join(wt, "docs", "decisions")), "ADR dir is in the worktree");
  assert.equal(existsSync(path.join(main, "docs")), false, "main checkout is untouched");
});

test("a 2.x export recorded in a worktree's 2.1 data dir is imported from that worktree (skipped without git)", { skip }, async (t) => {
  const { dir, wt } = await repoWithWorktree(t);
  const specFile = path.join(wt, "colour.questions.json");
  writeFileSync(specFile, JSON.stringify({ title: "Colour", questions: [{ id: "color", title: "Which colour?", options: [{ id: "pink", label: "Pink" }, { id: "blue", label: "Blue" }] }] }));
  const outPath = path.join(wt, "colour.answers.json");
  // What 2.1 wrote on export, in the worktree's own data dir: the round, its spec and where its answers go.
  const legacy = dataDirPath(wt, homeOf(dir));
  mkdirSync(path.join(legacy, "exports"), { recursive: true });
  writeFileSync(path.join(legacy, "exports", "5-abcdef.json"), JSON.stringify({ round: "5-abcdef", specFile, outPath, source: "colour.questions.json", at: "2026-10-01T10:00:00.000Z" }));
  const theirs = path.join(wt, "a.answers.json");
  writeFileSync(theirs, JSON.stringify({ version: 2, round: "5-abcdef", name: "Ann", answers: { color: { selected: ["pink"] } } }));
  const res = spawnSync(process.execPath, [enginePath, "--import", "a.answers.json"], { cwd: wt, env: envOf(dir, { DECIDE_NOTIFY: "0" }), encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(JSON.parse(readFileSync(outPath, "utf8")).answers.color.selected[0], "pink");
});
