import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { prepareSpec } from "../lib/prepare.mjs";
import { asAgent, asPage, envOf, exitOf, hasGit, homeOf, pluginDir, scratchDir, spawnServer } from "./helpers.mjs";

const text = (line) => Array.from({ length: 30 }, (_, i) => i === 1 ? line : `line ${i + 1}`).join("\n") + "\n";
const SPEC = {
  title: "Fix the parser", summary: "The parser reads the new line.",
  acceptance: { changed: "The digit is read again." }, checks: [{ command: "node --test", exit: 0 }],
  chapters: [{ id: "parser", title: "Parser", summary: "Adjust the input.", hunks: ["parser.txt"] }],
};
const reply = (ref = "c1") => ({ ref, how: "fixed", at: "parser.txt:2", note: "Restored the digit." });

async function setup(t) {
  const dir = await scratchDir(t);
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.org", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const write = (file, value) => writeFileSync(join(dir, file), value);
  git("init", "-qb", "main");
  write("parser.txt", text("digit"));
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "feature");
  write("parser.txt", text("word"));
  write("whole.txt", "first round only\n");
  git("add", ".");
  git("commit", "-qm", "first");
  const head = git("rev-parse", "HEAD");
  let server = await spawnServer(t, homeOf(dir));
  const restart = async () => {
    server.child.kill();
    await exitOf(server.child);
    server = await spawnServer(t, homeOf(dir));
  };
  const call = async (route, body, agent = false) => {
    const r = await fetch(`http://127.0.0.1:${server.port}/api/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: agent ? asAgent(server.port) : asPage(server.port),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  const file = join(dir, "review.json");
  const open = (spec = SPEC, extra = {}) => call("rounds", { mode: "review", open: false, project: dir, specFile: file, spec, ...extra }, true);
  const cli = (...args) => spawnSync(process.execPath, [join(pluginDir, "decide.mjs"), ...args], { cwd: dir, encoding: "utf8", env: envOf(dir, { DECIDE_PORT: String(server.port), BROWSER: "none" }) });
  const commit = (line = "digit again") => {
    write("parser.txt", text(line));
    git("add", "parser.txt");
    git("commit", "-qm", "fix");
    return git("rev-parse", "HEAD");
  };
  const finish = (id, verdict = "return") => call(`rounds/${id}/submit`, { verdict });
  return { dir, file, git, write, open, call, cli, commit, finish, head, restart };
}

test("follow-up uses the latest returned or nit round by ref or spec, and can be forced or disabled", { skip: !hasGit }, async (t) => {
  const { dir, open, call, cli, commit, finish, head, file, write } = await setup(t);
  const first = (await open()).data;
  const firstView = (await call(`rounds/${first.id}`)).data.review;
  assert.equal(firstView.snapshot.previous, undefined);
  assert.equal(firstView.resolved, undefined);
  assert.equal(first.review.stats.files, 2);
  await finish(first.id);
  const latest = (await open({ ...SPEC, previous: false }, { head: "feature" })).data;
  await finish(latest.id, "nits");
  const newHead = commit();
  const auto = await open(SPEC, { specFile: join(dir, "different-spec.json") });
  assert.equal(auto.status, 200, JSON.stringify(auto.data));
  assert.deepEqual(auto.data.review.previous, { round: latest.id, head });
  assert.equal(auto.data.review.previousAutomatic, true);
  assert.deepEqual(auto.data.review.wholeStats, { files: 2, added: 2, removed: 1, binary: 0 });
  assert.deepEqual(auto.data.review.stats, { files: 1, added: 1, removed: 1, binary: 0 });
  assert.equal(auto.data.review.base, head);
  const pieces = (await call(`rounds/${auto.data.id}/pieces?group=ch:parser`)).data.pieces;
  assert.deepEqual(pieces.map(p => p.file), ["parser.txt"]);
  assert.deepEqual(pieces[0].lines.filter(l => l.t !== "ctx").map(l => l.text), ["word", "digit again"]);
  const explicit = await open({ ...SPEC, previous: first.id });
  assert.deepEqual(explicit.data.review.previous, { round: first.id, head });
  assert.equal(explicit.data.review.head, newHead);
  const anchored = structuredClone(SPEC);
  anchored.previous = first.id;
  anchored.chapters[0].focus = [{ at: "parser.txt:2", note: "New input", text: "digit again" }];
  anchored.reviewers = {
    ran: [{ role: "correctness", model: "test", summary: "The range needs a label.", verdict: "concerns" }],
    findings: [{ id: "f1", role: "correctness", severity: "minor", at: "whole.txt:1", line: "first round only", text: "Label the first round." }],
  };
  const anchorCheck = await open(anchored);
  assert.equal(anchorCheck.status, 200, JSON.stringify(anchorCheck.data));
  assert.ok(anchorCheck.data.issues.some(i => i.level === "warn" && /whole.txt:1, not in this diff/.test(i.message)));
  anchored.chapters[0].focus[0].text = "word";
  const oldFocus = await open(anchored);
  assert.equal(oldFocus.status, 422);
  assert.ok(oldFocus.data.issues.some(i => /holds "digit again" now/.test(i.message)));

  write("review.json", JSON.stringify(SPEC));
  const chosen = cli("review", file, "--previous", first.id, "--no-open");
  assert.equal(chosen.status, 0, chosen.stderr);
  assert.match(chosen.stdout, new RegExp(`since round ${first.id}`, "i"));
  const full = cli("review", file, "--no-previous", "--no-open");
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /2 files/);
  const inferred = cli("review", file, "--no-open");
  assert.equal(inferred.status, 0, inferred.stderr);
  assert.match(inferred.stdout, new RegExp(`Automatically.*${latest.id}`, "i"));
  const fullOutline = cli("outline", "--no-previous", "--json");
  assert.equal(fullOutline.status, 0, fullOutline.stderr);
  assert.equal(JSON.parse(fullOutline.stdout).snapshot.stats.files, 2);
});

test("previous-round failures explain unknown, wrong mode, unfinished, identical and rebased heads", { skip: !hasGit }, async (t) => {
  const { dir, open, call, cli, git, commit, finish } = await setup(t);
  const first = (await open()).data;
  async function refuses(previous, match) {
    const out = await open({ ...SPEC, previous });
    assert.equal(out.status, 400);
    assert.match(out.data.error, match);
  }
  await refuses("9-abcdef", /unknown round/);
  const { spec: questionSpec } = await prepareSpec({ title: "A question round", questions: [{ id: "q1", title: "What changed?", type: "text" }] }, { specDir: dir, shots: false });
  const questions = await call("rounds", { project: dir, open: false, spec: questionSpec }, true);
  assert.equal(questions.status, 200, JSON.stringify(questions.data));
  await refuses(questions.data.id, /not a review/);
  await refuses(first.id, /not finished/);
  const patch = await call(`rounds/${first.id}/patch`, { ops: [{ op: "ghost", id: "parser" }] }, true);
  assert.equal(patch.status, 409);
  assert.match(patch.data.error, new RegExp(`review --previous ${first.id}`));
  await finish(first.id);
  const finishedPatch = await call(`rounds/${first.id}/patch`, { ops: [] }, true);
  assert.equal(finishedPatch.status, 409);
  assert.match(finishedPatch.data.error, new RegExp(`review --previous ${first.id}`));
  for (const spec of [{ ...SPEC, previous: first.id }, SPEC]) {
    assert.deepEqual(await open(spec), {
      status: 400,
      data: { error: `no new commits since round ${first.id}; for a full review pass --no-previous (spec: "previous": false)` },
    });
  }
  git("checkout", "-qb", "rewritten", "main");
  commit("rewritten input");
  await refuses(first.id, /not an ancestor/);
  const outline = cli("outline", "--previous", first.id);
  assert.equal(outline.status, 2);
  assert.match(outline.stderr, /not an ancestor/);
  const automatic = await open({ ...SPEC, resolved: [reply()] });
  assert.equal(automatic.status, 200, JSON.stringify(automatic.data));
  assert.equal(automatic.data.review.previous, undefined);
  assert.ok(automatic.data.issues.some(i => i.level === "warn" && /not an ancestor/.test(i.message)));
});

for (const verdict of ["approve", "return"]) {
  test(`automatic review after a follow-up ended with ${verdict}`, { skip: !hasGit }, async (t) => {
    const { open, commit, finish } = await setup(t);
    const first = await open();
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal((await finish(first.data.id)).status, 200);
    const head = commit();
    const second = await open();
    assert.equal(second.status, 200, JSON.stringify(second.data));
    assert.equal(second.data.review.previous.round, first.data.id);
    assert.equal((await finish(second.data.id, verdict)).status, 200);
    const thirdHead = commit("digit checked");
    const third = await open();
    assert.equal(third.status, 200, JSON.stringify(third.data));
    assert.equal(third.data.review.head, thirdHead);
    if (verdict === "approve") {
      assert.equal(third.data.review.previous, undefined);
      assert.equal(third.data.review.stats.files, 2);
      assert.ok(!third.data.issues.some(i => i.where === "snapshot"), JSON.stringify(third.data.issues));
    } else {
      assert.deepEqual(third.data.review.previous, { round: second.data.id, head });
      assert.equal(third.data.review.stats.files, 1);
    }
  });
}

test("lint and review reconcile Fix comments, findings and No decisions, and warn on the other items", { skip: !hasGit }, async (t) => {
  const { open, call, cli, file, write, commit, finish } = await setup(t);
  const at = "parser.txt:2";
  const firstSpec = structuredClone(SPEC);
  firstSpec.chapters[0].focus = [{ at, note: "Input spelling", text: "word", kind: "decision", question: "Use the word?", options: ["Keep word", "Use digit"] }];
  firstSpec.reviewers = {
    ran: [{ role: "correctness", model: "test", summary: "One parser issue.", verdict: "concerns" }],
    findings: [{ id: "f1", role: "correctness", severity: "major", at, text: "Parser needs a guard." }, { id: "f2", role: "correctness", severity: "minor", text: "Check docs." }],
  };
  const opened = await open(firstSpec);
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  const { id } = opened.data;
  const post = (route, body) => call(`rounds/${id}/${route}`, body);
  for (const [route, body] of [
    ["comment", { hunk: "h1", line: 2, side: "new", kind: "fix", text: "Keep the digit." }],
    ["comment", { hunk: "h1", line: 2, side: "new", kind: "nit", text: "Spell it out." }],
    ["ask", { question: "h1", line: 2, side: "new", text: "Who reads it?" }],
    ["decision", { chapter: "parser", at, answer: "no" }],
    ["finding", { id: "f1", decision: "fix" }],
    ["message", { text: "A round conversation stays in its own round." }],
  ]) {
    const added = await post(route, body);
    assert.equal(added.status, 200, JSON.stringify(added.data));
  }
  const result = (await finish(id)).data.result;
  const qid = result.comments.find(c => c.kind === "question")?.id;
  const decision = result.decisions[0].id;
  const [fix, nit] = result.comments.filter(c => c.kind !== "question").map(c => c.id);
  for (const ref of [fix, nit, qid, decision, "f1", "f2"]) {
    assert.ok(ref && result.digest.includes(`[${ref}]`), result.digest);
  }
  commit();
  const outline = cli("outline", "--previous", id, "--json");
  assert.equal(outline.status, 0, outline.stderr);
  const printed = JSON.parse(outline.stdout);
  assert.deepEqual(printed.pieces.map(p => p.file), ["parser.txt"]);
  assert.deepEqual(new Set(printed.skeleton.resolved.map(r => r.ref)), new Set([fix, nit, qid, decision, "f1", "f2"]));
  assert.ok(printed.previousItems.some(item => item.ref === fix && item.original.text === "Keep the digit." && item.original.line === 2));
  const good = [reply(fix), { ref: "f1", how: "declined", note: "The parser already checks this." }, { ref: decision, how: "answered", note: "Use the digit." }];
  const previous = { ...SPEC, previous: id };
  const lint = (spec) => {
    write("review.json", JSON.stringify(spec));
    return cli("lint", file, "--previous", id);
  };
  for (const [resolved, match] of [
    [[], new RegExp(`${fix}.*Keep the digit[\\s\\S]*f1.*Parser needs a guard[\\s\\S]*Use the word`)],
    [[...good, { ref: "bad", how: "fixed", at }], /unknown.*bad/],
    [[...good, reply(fix)], new RegExp(`duplicate.*${fix}`)],
    [[{ ref: fix, how: "fixed" }, ...good.slice(1)], /fixed.*at/],
    [[{ ...reply(fix), at: "whole.txt:1" }, ...good.slice(1)], /whole.txt:1.*outside the follow-up diff/],
    [[{ ...reply(fix), at: "parser.txt:2-20" }, ...good.slice(1)], /parser.txt:2-20.*outside the follow-up diff/],
    [[{ ...reply(fix), at: "parser.txt:1" }, ...good.slice(1)], /parser.txt:1.*outside the follow-up diff/],
    [[reply(fix), { ref: "f1", how: "declined", note: " " }, good[2]], /declined.*note/],
    [[...good.slice(0, 2), { ref: decision, how: "answered" }], /answered.*note/],
  ]) {
    const failed = lint({ ...SPEC, resolved });
    assert.equal(failed.status, 1, failed.stdout || failed.stderr);
    assert.match(failed.stdout + failed.stderr, match);
    const refused = await open({ ...previous, resolved });
    assert.equal(refused.status, 422, JSON.stringify(refused.data));
    assert.match(refused.data.issues.map(i => i.message).join("\n"), match);
  }
  const passed = lint({ ...SPEC, resolved: good });
  assert.equal(passed.status, 0, passed.stdout || passed.stderr);
  for (const text of ["Spell it out.", "Check docs.", "Who reads it?"]) assert.ok(passed.stdout.includes(text), passed.stdout);
  const follow = await open({ ...previous, resolved: good });
  assert.equal(follow.status, 200, JSON.stringify(follow.data));
  assert.equal(follow.data.issues.filter(i => i.where === "resolved" && i.level === "warn").length, 3);
  const decisionIn = (rows) => rows.find(row => row.ref === decision).original;
  const view = (await call(`rounds/${follow.data.id}`)).data.review;
  const accepted = await call(`rounds/${follow.data.id}/resolution`, { ref: decision, owner: "accepted" });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  const submitted = await finish(follow.data.id);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  await t.test("the outline keeps the answer chosen by the owner", () => {
    assert.equal(decisionIn(printed.previousItems).answer, "Use digit");
  });
  await t.test("the follow-up view keeps the owner's answer", () => {
    assert.equal(decisionIn(view.resolved).answer, "Use digit");
  });
  await t.test("the follow-up result keeps the owner's answer", () => {
    assert.equal(decisionIn(submitted.data.result.resolved).answer, "Use digit");
  });
  await t.test("the follow-up digest prints the accepted decision's question and answer", () => {
    assert.ok(submitted.data.result.digest.includes(`Accepted (1)\n- [${decision}] decision parser.txt:2: Use the word? — Use digit`), submitted.data.result.digest);
  });
});

test("the follow-up result records the owner's marks and carries Not fixed into another round", { skip: !hasGit }, async (t) => {
  const { dir, open, call, commit, finish, head, restart } = await setup(t);
  const first = (await open()).data;
  for (const [kind, text] of [["fix", "Use a digit."], ["nit", "Keep the label."], ["nit", "Add an example."]]) {
    const saved = await call(`rounds/${first.id}/comment`, { hunk: "h1", line: 2, side: "new", kind, text });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
  }
  const initial = (await finish(first.id)).data.result;
  const [fix, nit, example] = initial.comments.map(c => c.id);
  commit();
  const output = join(dir, "followup.answers.json");
  const opened = await open({ ...SPEC, resolved: [reply(fix), { ref: nit, how: "declined", note: "The label matches the spec." }] }, { outPath: output });
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  const follow = opened.data;
  const mark = (ref, owner) => call(`rounds/${follow.id}/resolution`, { ref, owner });
  assert.equal((await mark("bad", "accepted")).status, 404);
  assert.equal((await mark(fix, "no")).status, 400);
  assert.equal((await mark(fix, "notFixed")).status, 200);
  assert.equal((await mark(nit, "accepted")).status, 200);
  await restart();
  const restored = (await call(`rounds/${follow.id}`)).data.review;
  assert.deepEqual(restored.resolved.map(r => [r.ref, r.owner]), [[fix, "notFixed"], [nit, "accepted"], [example, null]]);
  const { result } = (await finish(follow.id)).data;
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")).resolved, result.resolved);
  assert.deepEqual(result.previous, { round: first.id, head });
  assert.deepEqual(result.resolved[0], { ...reply(fix), kind: "fix", original: { text: "Use a digit.", file: "parser.txt", line: 2 }, owner: "notFixed" });
  assert.deepEqual(result.resolved.map(r => [r.ref, r.how, r.owner]), [[fix, "fixed", "notFixed"], [nit, "declined", "accepted"], [example, null, null]]);
  assert.match(result.digest, new RegExp(`Verdict: RETURNED[^\\n]*\\nFollow-up to round ${first.id}\\.`));
  assert.match(result.digest, /Your fixes, as the owner judged them[\s\S]*Not fixed[\s\S]*Use a digit\.[\s\S]*Restored the digit\.[\s\S]*Not marked[\s\S]*Add an example\.[\s\S]*Accepted \(1\)/);
  assert.deepEqual((await call(`rounds/${first.id}`)).data.result, initial);
  commit("digit checked");
  const third = await open();
  assert.equal(third.status, 422);
  assert.ok(third.data.issues.some(i => i.level === "error" && /Use a digit/.test(i.message)));
});

test("follow-up git arguments must be resolved commit ids", { skip: !hasGit }, async (t) => {
  const { dir, head, commit, cli } = await setup(t);
  const git = await import("../lib/git.mjs");
  assert.equal(typeof git.isAncestor, "function");
  const next = commit();
  assert.equal(await git.isAncestor(dir, head, next), true);
  assert.equal(await git.isAncestor(dir, next, head), false);
  const out = join(dir, "written-by-git");
  for (const pair of [[`--output=${out}`, next], [head, "--help"]]) {
    await assert.rejects(git.isAncestor(dir, ...pair), e => e.refused && /not a commit id/.test(e.message));
  }
  assert.equal(existsSync(out), false);
  const traversal = cli("outline", "--previous", "../../feature");
  assert.equal(traversal.status, 2);
  assert.match(traversal.stderr, /unknown round/);
});
