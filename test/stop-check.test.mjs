import assert from "node:assert/strict";
import test from "node:test";
import { pickFiles, shouldRun, summarizeResults, fingerprint } from "../scripts/stop-check.mjs";

test("picks relevant working, untracked and branch files, once, preserving unusual names", () => {
  assert.deepEqual(pickFiles({
    working: "src/a.mjs\0removed.js\0notes.md\0",
    untracked: "new file.json\0line\nbreak.js\0src/a.mjs\0",
    committed: "branch.js\0ui.css\0",
    branch: "topic",
  }), ["branch.js", "line\nbreak.js", "new file.json", "removed.js", "src/a.mjs"]);
});

test("master skips committed changes but still checks local changes", () => {
  assert.deepEqual(pickFiles({ working: "local.js\0", untracked: "new.json\0", committed: "old.mjs\0", branch: "master" }), ["local.js", "new.json"]);
  assert.deepEqual(pickFiles({ committed: "detached.js\0", branch: "" }), ["detached.js"]);
});

test("runs only for relevant changes unless opted out or repeating an active failed Stop", () => {
  const args = { files: ["a.js"], fingerprint: "a", previous: { fingerprint: "a", outcome: "failure" } };
  assert.equal(shouldRun(args), true);
  assert.equal(shouldRun({ ...args, stopHookActive: true }), false);
  assert.equal(shouldRun({ ...args, stopHookActive: "true" }), true);
  assert.equal(shouldRun({ ...args, stopHookActive: true, fingerprint: "b" }), true);
  assert.equal(shouldRun({ ...args, stopHookActive: true, previous: { fingerprint: "a", outcome: "environment" } }), true);
  assert.equal(shouldRun({ ...args, stopHookActive: true, previous: { fingerprint: "a", outcome: "success" } }), true);
  assert.equal(shouldRun({ ...args, optOut: "0" }), false);
  assert.equal(shouldRun({ ...args, files: [] }), false);
});

test("fingerprint changes with contents, deletions, filenames and comparison context", () => {
  const first = fingerprint("head/base", [["a.js", Buffer.from("one")]]);
  assert.equal(first, fingerprint("head/base", [["a.js", Buffer.from("one")]]));
  for (const [context, files] of [
    ["other/base", [["a.js", Buffer.from("one")]]],
    ["head/base", [["a.js", Buffer.from("two")]]],
    ["head/base", [["b.js", Buffer.from("one")]]],
    ["head/base", [["a.js", null]]],
  ]) assert.notEqual(first, fingerprint(context, files));
  assert.notEqual(fingerprint("x", [["a.js", null]]), fingerprint("x", [["a.js", Buffer.alloc(0)]]));
});

test("success has exit 0; real failures have exit 2 and at most 40 stderr lines", () => {
  assert.deepEqual(summarizeResults([{ command: "node --test", status: 0 }]), { outcome: "success", exitCode: 0, stdout: "", stderr: "" });
  const result = summarizeResults([{ command: "node --test", status: 1, stdout: Array.from({ length: 70 }, (_, i) => `line ${i}`).join("\n"), stderr: "assertion failed\n" }]);
  assert.equal(result.exitCode, 2);
  assert.equal(result.outcome, "failure");
  assert.ok(result.stderr.trimEnd().split("\n").length <= 40);
  assert.match(result.stderr, /assertion failed/);
  assert.doesNotMatch(result.stderr, /line 0\n/);
  assert.equal(result.stdout, "");
});

test("environment failures report NOT verified in JSON without blocking", () => {
  for (const result of [
    { error: { code: "ENOENT", message: "spawn node ENOENT" }, status: null },
    { error: { code: "EACCES", message: "permission denied" }, status: null },
    { status: 1, stderr: "Error: ENOENT: no such file or directory" },
    { status: null, signal: "SIGTERM" },
  ]) {
    const summary = summarizeResults([{ command: "node --test", ...result }]);
    assert.equal(summary.exitCode, 0);
    assert.equal(summary.outcome, "environment");
    assert.match(JSON.parse(summary.stdout).systemMessage, /^NOT verified: node --test/);
    assert.equal(summary.stderr, "");
  }
});

test("an environment failure cannot hide another real failure", () => {
  const result = summarizeResults([
    { command: "node --check a.js", status: 1, stderr: "SyntaxError: Unexpected token" },
    { command: "node --test", error: { code: "ENOENT", message: "node missing" } },
  ]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /SyntaxError/);
});

test("mentioning ENOENT does not turn real test failures into environment failures", () => {
  for (const output of [
    "not ok 1 - rejects ENOENT regression\n  error: assertion failed\n  code: ERR_ASSERTION\n",
    "ok 1 - handles ENOENT\nnot ok 2 - broken\n  error: assertion failed\n  code: ERR_ASSERTION\n",
    "not ok 1 - missing fixture\n  error: 'ENOENT: missing'\n  code: ENOENT\nnot ok 2 - broken\n  error: failed\n",
    "SyntaxError: bad token in /tmp/ENOENT.js",
  ]) assert.equal(summarizeResults([{ command: "node --test", status: 1, stdout: output }]).exitCode, 2);
  assert.equal(summarizeResults([{ command: "node --test", status: 1,
    stdout: "not ok 1 - missing fixture\n  error: 'ENOENT: missing'\n  code: ENOENT\n" }]).outcome, "environment");
});

test("ENOENT classification uses diagnostics, including a module that fails before its tests", () => {
  const missing = "not ok 2 - missing fixture\n  error: 'ENOENT: missing'\n  code: ENOENT\n";
  assert.equal(summarizeResults([{ command: "node --test", status: 1,
    stdout: "ok 1 - handles SyntaxError\n  ---\n  duration_ms: 1\n  ...\n" + missing }]).exitCode, 0);
  const crashed = "# Error: ENOENT: no such file or directory\n# code: 'ENOENT'\n# Subtest: missing.test.mjs\nnot ok 1 - missing.test.mjs\n  ---\n  exitCode: 1\n  error: 'test failed'\n  code: 'ERR_TEST_FAILURE'\n  ...\n";
  assert.equal(summarizeResults([{ command: "node --test", status: 1, stdout: crashed }]).exitCode, 0);
  assert.equal(summarizeResults([{ command: "node --test", status: 1,
    stdout: crashed + "# TypeError: broken\n# Subtest: broken.test.mjs\nnot ok 2 - broken.test.mjs\n  ---\n  code: 'ERR_TEST_FAILURE'\n  ...\n" }]).exitCode, 2);
});
