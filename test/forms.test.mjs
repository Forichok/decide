/*
 * What:       the four 3.0 forms (buckets, tradeoff, spot, versus): normalising, answer logic, digest line.
 * Why exists: each form keeps its answer logic in a page module the server imports; this pins it.
 * Isolation:  pure, no server, no home.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkAnswers } from "../lib/answers.mjs";
import { normalizeSpec } from "../lib/spec.mjs";
import { pluginDir } from "./helpers.mjs";

const logic = await import(new URL("../ui/js/logic.js", import.meta.url));
const versus = await import(new URL("../ui/js/types/versus.js", import.meta.url));
const errorsOf = (issues) => issues.filter((i) => i.level === "error").map((i) => `${i.where}: ${i.message}`);
const opts = (n) => Array.from({ length: n }, (_, i) => ({ id: `v${i + 1}`, label: `Variant ${i + 1}` }));
const one = (q) => {
  const { spec, issues } = normalizeSpec({ title: "t", questions: [{ title: "T", why: "w", ...q }] });
  return { q: spec.questions[0], issues, spec };
};

test("the shipped forms example validates with no error", () => {
  const raw = JSON.parse(readFileSync(path.join(pluginDir, "examples/v3/forms.questions.json"), "utf8"));
  const { spec, issues } = normalizeSpec(raw, { specDir: path.join(pluginDir, "examples/v3") });
  assert.deepEqual(errorsOf(issues), []);
  assert.deepEqual(spec.questions.map((q) => q.type), ["buckets", "tradeoff", "spot", "versus"]);
});

test("buckets: normalises, needs all options sorted, checks the file, writes a digest line", () => {
  const { q, issues } = one({ type: "buckets", buckets: ["now", "later", { id: "no", label: "Never" }], options: opts(3) });
  assert.deepEqual(errorsOf(issues), []);
  assert.deepEqual(q.buckets.map((b) => b.id), ["now", "later", "no"]);
  assert.equal(errorsOf(one({ type: "buckets", options: opts(1) }).issues).length, 1, "one option cannot be sorted");
  assert.equal(one({ type: "buckets", options: opts(2) }).q.buckets.length, 3, "default now/later/no");
  const a = logic.emptyAnswer(q);
  assert.equal(logic.isAnswered(q, a), false);
  const full = { ...a, buckets: { now: ["v1"], later: ["v2", "v1"], no: ["v3"] } };
  assert.equal(logic.isAnswered(q, full), true);
  const r = logic.finalizeAnswers({ questions: [q] }, { [q.id]: full })[q.id];
  assert.deepEqual(r.buckets, { now: ["v1"], later: ["v2"], no: ["v3"] }, "an option sits once");
  assert.equal(logic.describe(q, r), "now: Variant 1; later: Variant 2; Never: Variant 3");
  const { answers, warnings } = checkAnswers({ questions: [q] }, { answers: { [q.id]: { buckets: { now: ["v1", "zz"], bogus: ["v2"] } } } });
  assert.deepEqual(answers[q.id].buckets, { now: ["v1"], later: [], no: [] });
  assert.ok(warnings.some((w) => /unknown bucket "bogus"/.test(w)));
});

test("tradeoff: normalises, clamps, marks the recommendation, writes a digest line", () => {
  const { q, issues } = one({ type: "tradeoff", poles: ["faster", "more careful"], recommendedAt: 70 });
  assert.deepEqual(errorsOf(issues), []);
  assert.equal(q.recommendedAt, 70);
  assert.equal(errorsOf(one({ type: "tradeoff", poles: ["only"] }).issues).length, 1);
  assert.equal(errorsOf(one({ type: "tradeoff", poles: ["a", "b"], recommendedAt: 120 }).issues).length, 1);
  assert.equal(logic.isAnswered(q, logic.emptyAnswer(q)), false);
  assert.equal(logic.isAnswered(q, { ...logic.emptyAnswer(q), value: 0 }), true);
  const { answers } = checkAnswers({ questions: [q] }, { answers: { [q.id]: { value: 250 } } });
  assert.equal(answers[q.id].value, 100);
  assert.equal(logic.describe(q, { value: 30 }), "30/100 (faster ↔ more careful), toward faster");
  assert.match(logic.describe(q, { value: 50 }), /in the middle/);
  const filled = logic.finalizeAnswers({ questions: [q] }, {}, { fill: "recommend" });
  assert.equal(filled[q.id].value, 70, "the recommendation fills the slider");
});

test("spot: needs a picture, keeps marks in percent, writes a digest line", () => {
  assert.equal(errorsOf(one({ type: "spot" }).issues).length, 1, "no picture, no spot");
  const { q, issues } = one({ type: "spot", images: ["https://example.com/a.png"] });
  assert.deepEqual(errorsOf(issues), []);
  assert.equal(logic.isAnswered(q, logic.emptyAnswer(q)), false);
  const a = { ...logic.emptyAnswer(q), points: [{ x: 10, y: 20, w: 0, h: 0, text: "here" }, { x: 90, y: 90, w: 40, h: 40, text: "" }, { x: "bad" }] };
  assert.equal(logic.isAnswered(q, a), true);
  const r = logic.finalizeAnswers({ questions: [q] }, { [q.id]: a })[q.id];
  assert.deepEqual(r.points, [{ x: 10, y: 20, w: 0, h: 0, text: "here" }, { x: 90, y: 90, w: 10, h: 10, text: "" }], "an area stays inside the picture");
  assert.equal(logic.describe(q, r), '2 marked: point 10,20% "here"; area 90,90 10x10%');
  const { answers } = checkAnswers({ questions: [q] }, { answers: { [q.id]: { points: [{ x: 150, y: -5, text: "t" }] } } });
  assert.deepEqual(answers[q.id].points, [{ x: 100, y: 0, w: 0, h: 0, text: "t" }]);
});

test("versus: four to eight options, a knockout of at most 12 pairs (7 for 8), no agent calls", () => {
  assert.equal(errorsOf(one({ type: "versus", options: opts(3) }).issues).length, 1);
  assert.equal(errorsOf(one({ type: "versus", options: opts(9) }).issues).length, 1);
  for (let n = 4; n <= 8; n += 1) {
    const ids = opts(n).map((o) => o.id);
    let pairs = [];
    for (let s = versus.run(ids, pairs); !s.done; s = versus.run(ids, pairs)) pairs = [...pairs, { a: s.next[0], b: s.next[1], pick: s.next[0] }];
    const end = versus.run(ids, pairs);
    assert.ok(pairs.length <= 12 && pairs.length === n - 1, `${n} variants: ${pairs.length} pairs`);
    assert.equal(end.winner, "v1");
    assert.deepEqual([...end.order].sort(), [...ids].sort(), "the order lists every variant once");
    assert.equal(end.order[0], end.winner);
  }
  const { q } = one({ type: "versus", options: opts(4) });
  const full = [{ a: "v1", b: "v2", pick: "v2" }, { a: "v3", b: "v4", pick: "v3" }, { a: "v2", b: "v3", pick: "v3" }];
  const a = { ...logic.emptyAnswer(q), pairs: full.slice(0, 2) };
  assert.equal(logic.isAnswered(q, a), false, "undecided until the last pair");
  assert.equal(logic.isAnswered(q, { ...a, pairs: full }), true);
  const r = logic.finalizeAnswers({ questions: [q] }, { [q.id]: { ...a, pairs: full } })[q.id];
  assert.equal(r.winner, "v3");
  assert.equal(r.pairs.length, 3);
  assert.equal(logic.describe(q, r), "winner: Variant 3 (Variant 3 > Variant 2 > Variant 1 > Variant 4; 3 pairs)");
  const bad = checkAnswers({ questions: [q] }, { answers: { [q.id]: { note: "x", pairs: [...full.slice(0, 2), { a: "v2", b: "v3", pick: "v9" }] } } });
  assert.equal(bad.answers[q.id].winner, undefined, "an unfinished run is not an answer");
  const ok = checkAnswers({ questions: [q] }, { answers: { [q.id]: { pairs: full, winner: "v1" } } });
  assert.equal(ok.answers[q.id].winner, "v3", "the winner is replayed, not trusted");
});
