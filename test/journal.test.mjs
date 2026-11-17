// journal.test.mjs — the decision map: edges from dependsOn, rules (showIf) and supersede, and the size cap.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendJournal, buildGraph, graphMermaid, readJournal, supersedeJournal } from "../lib/journal.mjs";
import { normalizeSpec } from "../lib/spec.mjs";
import { dataDirFor, projectRoot } from "../lib/project.mjs";
import { homeOf, scratchDir, spawnServer } from "./helpers.mjs";

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

// ---- the page's project switch and round picker (GET /api/map) ----

// Two projects in one scratch home: `a` and `b` decisions each, a chain of dependsOn inside each project.
export function seedHome(home, { a = 30, b = 20 } = {}) {
  const roots = [];
  for (const [name, n] of [["alpha", a], ["beta", b]]) {
    const root = mkdtempSync(path.join(tmpdir(), `decide-proj-${name}-`));
    roots.push(root);
    const dir = dataDirFor(projectRoot(root), home);
    for (let i = 1; i <= n; i++) {
      const { spec } = normalizeSpec({ title: `${name} ${i}`, questions: [{ id: "q", title: `${name} question ${i}`, options: opts("A", "B"), ...(i > 1 ? { dependsOn: [`${name}-${i - 1}`] } : {}) }] });
      const at = `2026-11-${name === "alpha" ? "10" : "11"}T10:${String(i).padStart(2, "0")}:00Z`;
      appendJournal(dir, { mode: "questions", spec, outPath: "answers.json", project: projectRoot(root) }, { round: `${name}-${i}`, title: `${name} ${i}`, answers: { q: { selected: ["a"] } }, submittedAt: at, digest: "" });
    }
  }
  return roots;
}

test("/api/map lists the projects, takes project= and round=, and offers rounds only when trimmed", async (t) => {
  const dir = await scratchDir(t);
  const home = homeOf(dir);
  const [alpha] = seedHome(home);
  const server = await spawnServer(t, home);
  assert.equal(server.exited, null, server.output.stderr);
  const map = async (q = "") => (await fetch(`http://127.0.0.1:${server.port}/api/map${q}`)).json();

  const all = await map();
  assert.equal(all.total, 50);
  assert.equal(all.nodes.length, 40);
  assert.deepEqual(all.trimmed, { newest: 40 });
  assert.ok(all.projects.some((p) => p.project === projectRoot(alpha)), "the project root is the switch value");
  assert.equal(all.projects.length, 2);
  assert.equal(all.rounds.length, 50, "every round can be picked");
  assert.ok(all.rounds[0].at >= all.rounds.at(-1).at, "newest first");

  const one = await map(`?project=${encodeURIComponent(alpha)}`);
  assert.equal(one.nodes.length, 30);
  assert.equal(one.trimmed, null);
  assert.deepEqual(one.rounds, [], "nothing to pick when the map is whole");
  assert.equal(one.projects.length, 2, "the switch always lists every project");

  const near = await map(`?round=alpha-5`);
  assert.deepEqual(near.trimmed, { round: "alpha-5" });
  assert.deepEqual(near.nodes.map((n) => n.round).sort(), ["alpha-4", "alpha-5", "alpha-6"]);
});

test("a big map goes top down and stacks unlinked decisions in columns", () => {
  const dir = scratch();
  for (let i = 1; i <= 20; i++) record(dir, `r-${i}`, [{ id: `q${i}`, title: `Q${i}` }], `2026-11-16T10:${String(i).padStart(2, "0")}:00Z`);
  const src = graphMermaid(buildGraph(readJournal(dir, { limit: 100 })));
  assert.match(src, /^flowchart TD/);
  assert.equal((src.match(/~~~/g) || []).length, 17, "three columns of 8, 8 and 4: 7 + 7 + 3 invisible links");
});
