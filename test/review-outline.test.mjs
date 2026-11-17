import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { outlineText } from "../lib/review/outline.mjs";
import { COMMANDS, toolList, runCommand } from "../lib/commands/index.mjs";
import { normalizeReview } from "../lib/review/spec.mjs";
import { takeSnapshot, buildReview } from "../lib/review/snapshot.mjs";
async function lintReview(raw, args) {
  const { spec, issues } = normalizeReview(raw);
  const snapshot = await takeSnapshot(args);
  return [...issues, ...buildReview(spec, snapshot.patch).issues];
}
import { envOf, pluginDir, scratchDir } from "./helpers.mjs";

function git(dir, ...args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
async function repo(t) {
  const dir = await scratchDir(t);
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "Test"); git(dir, "config", "user.email", "test@example.test");
  writeFileSync(join(dir, "gone.txt"), "gone\n");
  writeFileSync(join(dir, "old.txt"), "rename me\n");
  git(dir, "add", "."); git(dir, "commit", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  renameSync(join(dir, "old.txt"), join(dir, "new.txt"));
  git(dir, "rm", "gone.txt");
  mkdirSync(join(dir, "lib")); mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "lib/long.mjs"), Array.from({ length: 310 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  writeFileSync(join(dir, "test/a.test.mjs"), "test line\n");
  writeFileSync(join(dir, "image.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  git(dir, "add", "."); git(dir, "commit", "-m", "pieces");
  return { dir, base };
}
function cli(dir, ...args) {
  return spawnSync(process.execPath, [join(pluginDir, "decide.mjs"), "outline", "--project", dir, ...args], {
    encoding: "utf8", env: envOf(dir, { DECIDE_PORT: "48777", BROWSER: "none" }),
  });
}
test("outline is registered for CLI and MCP with its schema", () => {
  assert.ok(COMMANDS.find(c => c.name === "outline")?.cli);
  const tool = toolList().find(t => t.name === "outline");
  assert.equal(tool.inputSchema.properties.place.type, "string");
  assert.equal(tool.inputSchema.properties.force.type, "boolean");
  assert.equal(tool.inputSchema.properties.previous, undefined);
});
test("outline JSON reaches a delayed pipe reader with every piece", { timeout: 20_000 }, async t => {
  const { dir, base } = await repo(t);
  const files = Array.from({ length: 1200 }, (_, i) => `lib/piece-${i}.mjs`);
  for (const file of files) writeFileSync(join(dir, file), `${file} ${"x".repeat(120)}\n`);
  git(dir, "add", "."); git(dir, "commit", "-m", "large outline");
  const child = spawn(process.execPath, [join(pluginDir, "decide.mjs"), "outline", "--project", dir, "--base", base, "--json"], {
    env: envOf(dir, { DECIDE_PORT: "48779", BROWSER: "none" }), stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  // Leave stdout unread long enough for the writer to fill the pipe.
  await new Promise(resolve => setTimeout(resolve, 500));
  child.stdout.on("data", chunk => { stdout += chunk; });
  const { code, signal } = await closed;
  assert.equal(signal, null);
  assert.equal(code, 0, stderr);
  const out = JSON.parse(stdout);
  assert.ok(Buffer.byteLength(stdout) > 256 * 1024, "fixture exceeds the pipe buffer");
  assert.equal(out.pieces.length, files.length + 6);
  const byFile = new Map(out.pieces.map(p => [p.file, p]));
  for (const file of files) {
    assert.equal(byFile.get(file)?.excerpt[0].text, `${file} ${"x".repeat(120)}`.slice(0, 120), file);
  }
});
test("outline lists the snapshot pieces, exact anchors and a lintable starting skeleton", async t => {
  const { dir, base } = await repo(t);
  const result = cli(dir, "--base", base, "--json", "--place", "lib/long.mjs:3-5");
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.reviewers.required, true);
  assert.match(out.reviewers.reason, /the threshold is 200/);
  assert.ok(out.reviewers.roles.some(r => r.id === "correctness" && r.brief && r.model === ""));
  assert.equal(out.snapshot.commits[0].subject, "pieces");
  assert.equal(out.snapshot.commits[0].sha.length, 7);
  assert.equal(out.pieces.length, 6);
  assert.ok(out.pieces.some(p => p.kind === "binary"));
  assert.ok(out.pieces.some(p => p.status === "deleted"));
  assert.ok(out.pieces.some(p => p.kind === "rename"));
  assert.ok(out.pieces.find(p => p.file === "test/a.test.mjs").test);
  assert.match(out.pieces.find(p => p.file === "lib/long.mjs").hint, /cannot be split/);
  assert.deepEqual(out.place, { at: "lib/long.mjs:3-5", text: "line 3" });
  assert.ok(out.skeleton.mechanical.some(g => g.hunks.includes("new.txt")));
  out.skeleton.title = "Review"; out.skeleton.summary = "Changed files";
  for (const c of out.skeleton.chapters) { c.title = c.id; c.summary = "An idea"; }
  assert.deepEqual((await lintReview(out.skeleton, { top: dir, base })).filter(i => i.level === "error"), []);
  const human = cli(dir, "--base", base);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Risks named in the spec can also require a team/);
  assert.match(human.stdout, /regroup by meaning: a chapter is an idea, not a directory/);
  for (const p of out.pieces) assert.ok(human.stdout.includes(p.id + " "));
  assert.match(human.stdout, /--json/);
  assert.equal(existsSync(join(dir, ".home")), false, "outline creates no decide state");
  const mcp = await runCommand("outline", { project: dir, base }, { project: { top: dir }, noticeProject: dir });
  assert.equal(mcp.structuredContent.pieces.length, 6);
});
test("outline writes only on request, refuses overwrite and confines real paths", async t => {
  const { dir, base } = await repo(t);
  const args = ["--base", base, "--out", "spec.json"];
  assert.equal(cli(dir, ...args).status, 0);
  writeFileSync(join(dir, "spec.json"), "keep");
  assert.equal(cli(dir, ...args).status, 2);
  assert.equal(readFileSync(join(dir, "spec.json"), "utf8"), "keep");
  assert.equal(cli(dir, ...args, "--force").status, 0);
  const outside = await scratchDir(t);
  symlinkSync(outside, join(dir, "escape"));
  assert.equal(cli(dir, "--base", base, "--out", "escape/spec.json").status, 2);
  assert.equal(cli(dir, "--base", base, "--out", "escape/spec.json", "--outside").status, 0);
  symlinkSync(join(outside, "not-yet.json"), join(dir, "dangling.json"));
  assert.equal(cli(dir, "--base", base, "--out", "dangling.json", "--force").status, 2);
  assert.equal(existsSync(join(outside, "not-yet.json")), false);
  for (const ref of ["--output=bad", "HEAD:lib/x", "HEAD..main"]) {
    const r = await runCommand("outline", { project: dir, base: ref }, { cli: true, project: { top: dir }, warn() {} }).then(() => null, e => e);
    assert.ok(r?.user, ref);
  }
});
test("key-place text detects a committed move, missing and ambiguous text, and warns once for absent text", async t => {
  const { dir, base } = await repo(t);
  const raw = { title: "Review", chapters: [{ id: "code", title: "Code", hunks: ["lib/long.mjs"], focus: [
    { at: "lib/long.mjs:3-5", text: "line 3", note: "Check" },
  ] }] };
  const lint = () => lintReview(raw, { top: dir, base });
  assert.deepEqual((await lint()).filter(i => i.level === "error"), []);
  const file = join(dir, "lib/long.mjs");
  writeFileSync(file, "inserted\n" + readFileSync(file, "utf8"));
  git(dir, "add", "lib/long.mjs"); git(dir, "commit", "-m", "shift");
  assert.match((await lint()).find(i => i.level === "error").message, /the place moved:.*line 4; write at: lib\/long.mjs:4-6/);
  raw.chapters[0].focus[0].text = "missing";
  assert.match((await lint()).find(i => i.level === "error").message, /line 3.*line 2.*re-check/);
  writeFileSync(file, "duplicate\nduplicate\n" + readFileSync(file, "utf8"));
  git(dir, "add", "lib/long.mjs"); git(dir, "commit", "-m", "duplicate");
  raw.chapters[0].focus[0].text = "duplicate";
  assert.match((await lint()).find(i => i.level === "error").message, /re-check/);
  raw.chapters[0].focus = [{ at: "lib/long.mjs:3" }, { at: "lib/long.mjs:4" }];
  assert.equal((await lint()).filter(i => /key places have no/.test(i.message)).length, 1);
});
test("a new-file hunk cannot be split between chapters: the warning names its owner", async t => {
  const { dir, base } = await repo(t);
  const issues = await lintReview({ chapters: [
    { id: "owner", title: "Owner", hunks: ["lib/long.mjs:1-20"] },
    { id: "other", title: "Other", hunks: ["lib/long.mjs:200-230"] },
  ] }, { top: dir, base });
  assert.match(issues.find(i => /adds nothing/.test(i.message)).message, /a hunk cannot be split between chapters: keep it in "owner" and name the lines that matter there as key places/);
});

test("MCP transports outline text and the structured object without opening or storing a round", async t => {
  const { dir, base } = await repo(t);
  const child = spawn(process.execPath, [join(pluginDir, "mcp.mjs")], {
    env: envOf(dir, { DECIDE_PORT: "48778", BROWSER: "none" }), stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const messages = createInterface({ input: child.stdout });
  t.after(() => messages.close());
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP outline timed out")), 10_000);
    messages.on("line", line => {
      const message = JSON.parse(line);
      if (message.id === 1) { clearTimeout(timer); resolve(message.result); }
    });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "outline", arguments: { project: dir, base, place: "lib/long.mjs:3-5" },
  } }) + "\n");
  const result = await response;
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /6 pieces/);
  assert.deepEqual(result.structuredContent.place, { at: "lib/long.mjs:3-5", text: "line 3" });
  assert.equal(existsSync(join(dir, ".home")), false);
});

test("text caps excerpts while listing every piece", () => {
  const pieces = Array.from({ length: 105 }, (_, i) => ({
    id: `h${i + 1}`, file: `file${i}.mjs`, status: "added", kind: "hunk",
    newStart: 1, newLines: 1, oldStart: 0, oldLines: 0, added: 1, removed: 0,
    excerpt: [{ at: `file${i}.mjs:1`, side: "new", text: "excerpt-sentinel" }],
  }));
  const text = outlineText({ reviewers: { required: false, reason: "no risk named", roles: [] }, snapshot: { baseRef: "main", headRef: "HEAD", base: "a".repeat(40),
    head: "b".repeat(40), stats: { files: 105, added: 105, removed: 0 }, commits: [] },
    pieces, skeleton: { title: "", summary: "", chapters: [] } });
  assert.equal((text.match(/excerpt-sentinel/g) || []).length, 100);
  for (const p of pieces) assert.ok(text.includes(p.id + " "));
});

test("outline caps commits and excerpts, keeps full anchor text, checks refs before git", async t => {
  const { dir, base } = await repo(t);
  const long = "x".repeat(150);
  writeFileSync(join(dir, "lib/long.mjs"), `  ${long}  \n`);
  git(dir, "add", "lib/long.mjs"); git(dir, "commit", "-m", "long text");
  for (let i = 0; i < 31; i++) git(dir, "commit", "--allow-empty", "-m", `empty ${i}`);
  const result = cli(dir, "--base", base, "--json", "--place", "lib/long.mjs:1");
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.snapshot.commits.length, 30);
  assert.equal(out.place.text, long);
  assert.equal(out.pieces.find(p => p.file === "lib/long.mjs").excerpt[0].text.length, 120);
  assert.match(out.skeleton.chapters[0].title, /regroup by meaning/);
  const bad = cli(dir, "--base", "HEAD;touch(SHOULD_NOT_EXIST)", "--json");
  assert.equal(bad.status, 2);
  assert.equal(existsSync(join(dir, "SHOULD_NOT_EXIST")), false);
  assert.equal(cli(dir, "--base", base, "--place", "../outside:1").status, 2);
});
