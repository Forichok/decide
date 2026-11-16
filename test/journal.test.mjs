// journal.test.mjs — the decision map: edges from dependsOn, rules (showIf) and supersede, and the size cap.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendJournal, buildGraph, graphMermaid, readJournal, supersedeJournal } from "../lib/journal.mjs";
import { normalizeSpec } from "../lib/spec.mjs";

const opts = (...labels) => labels.map((l) => ({ id: l.toLowerCase(), label: l }));
const scratch = () => mkdtempSync(path.join(tmpdir(), "decide-journal-"));

function record(dir, id, questions, at = "2026-11-16T10:00:00Z") {
  const { spec } = normalizeSpec({ title: id, questions: questions.map((q) => ({ options: opts("A", "B"), ...q })) });
  const answers = Object.fromEntries(spec.questions.map((q) => [q.id, { selected: ["a"] }]));
  appendJournal(dir, { mode: "questions", spec, outPath: "answers.json" }, { round: id, title: id, answers, submittedAt: at, digest: "" });
}

test("dependsOn and showIf rules become edges, resolved to record ids", () => {
  const dir = scratch();
  record(dir, "r-1", [{ id: "db", title: "Database" }], "2026-11-16T10:00:00Z");
  record(dir, "r-2", [{ id: "host", title: "Hosting", dependsOn: ["r-1"] }, { id: "pool", title: "Pooling", dependsOn: "db" }, { id: "x", title: "X", showIf: { q: "host", in: "a" } }], "2026-11-16T11:00:00Z");
  const g = buildGraph(readJournal(dir, { limit: 100 }));
  assert.equal(g.nodes.length, 4);
  const has = (from, to, kind) => g.edges.some((e) => e.from === from && e.to === to && e.kind === kind);
  assert.ok(has("r-1/db", "r-2/host", "dependsOn"), "a round id resolves to its first record");
  assert.ok(has("r-1/db", "r-2/pool", "dependsOn"), "a bare question id resolves to the latest record with it");
  assert.ok(has("r-2/host", "r-2/x", "rule"), "a showIf is an edge from the question it asks about");
});

test("a supersede line is an edge from the new round to the old one, and the old node is marked", () => {
  const dir = scratch();
  record(dir, "r-1", [{ id: "db", title: "Database" }], "2026-11-16T10:00:00Z");
  record(dir, "r-2", [{ id: "db2", title: "Database again" }], "2026-11-16T11:00:00Z");
  supersedeJournal(dir, { round: "r-1", by: "r-2", reason: "changed" });
  const g = buildGraph(readJournal(dir, { limit: 100 }));
  assert.deepEqual(g.edges, [{ from: "r-2/db2", to: "r-1/db", kind: "supersede" }]);
  assert.equal(g.nodes.find((n) => n.id === "r-1/db").superseded, true);
  const src = graphMermaid(g);
  assert.match(src, /^flowchart LR/);
  assert.match(src, /:::old/);
  assert.match(src, /-\. supersedes \.->/);
});

test("an edge to something unknown is dropped; titles cannot break the Mermaid source", () => {
  const dir = scratch();
  record(dir, "r-1", [{ id: "a1", title: 'Say "hi" [now] {x}', dependsOn: ["nope"] }]);
  const g = buildGraph(readJournal(dir, { limit: 100 }));
  assert.deepEqual(g.edges, []);
  assert.doesNotMatch(graphMermaid(g), /["\[\]{}]x|\[now\]/);
});

test("above the cap the map shows one round's neighbourhood, or the newest nodes", () => {
  const dir = scratch();
  for (let i = 1; i <= 50; i++) record(dir, `r-${i}`, [{ id: `q${i}`, title: `Q${i}`, ...(i > 1 ? { dependsOn: [`r-${i - 1}`] } : {}) }], `2026-11-16T10:${String(i).padStart(2, "0")}:00Z`);
  const entries = readJournal(dir, { limit: 100 });
  const near = buildGraph(entries, { round: "r-10" });
  assert.deepEqual(near.nodes.map((n) => n.round).sort(), ["r-10", "r-11", "r-9"].sort());
  assert.equal(near.total, 50);
  assert.deepEqual(near.trimmed, { round: "r-10" });
  const newest = buildGraph(entries);
  assert.equal(newest.nodes.length, 40);
  assert.equal(newest.nodes.at(-1).round, "r-50");
});

test("the journal line keeps the declared edges as written", () => {
  const dir = scratch();
  record(dir, "r-1", [{ id: "a1", title: "A", dependsOn: ["z"] }]);
  const line = JSON.parse(readFileSync(path.join(dir, "journal.jsonl"), "utf8").trim());
  assert.deepEqual(line.edges, [{ from: "z", to: "a1", kind: "dependsOn" }]);
});
