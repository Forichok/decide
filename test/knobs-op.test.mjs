/**
 * Feature:    the `knobs` patch op (K8, stub until lib/store/patch.mjs): "make it calmer" from the page and the agent's answer
 * Layer:      Unit (pure functions over a view)
 * Covers:
 *   - words with an agent listening become an outbox item with the current values; with none, a note
 *   - a knobs patch moves controls, replaces the panel or the mockup, and keeps the values before as a snapshot
 *   - a patch on an unknown or non-tune question, or a wrong op, throws; the input view is not changed
 */

import assert from "node:assert/strict";
import test from "node:test";
import { currentValues, knobsAsk, knobsOp } from "../lib/store/knobs-op.mjs";

const view = () => ({
  spec: {
    questions: [
      { id: "card", type: "tune", preview: { src: "/r/aaaaaaaa/card.html" }, knobs: [{ id: "density", type: "range", value: 4 }, { id: "accent", type: "color", value: "#3b6cff" }] },
      { id: "q", type: "single", options: [] },
    ],
  },
  answers: { card: { values: { density: 7 } } },
});

test("current values: the answer over the knobs' own", () => {
  assert.deepEqual(currentValues(view(), "card"), { density: 7, accent: "#3b6cff" });
});

test("make it calmer: an outbox item with an agent, a note without one", () => {
  const v = view();
  const sent = knobsAsk(v, { qid: "card", text: " make it calmer " }, { listening: true });
  assert.deepEqual(sent.outbox, [{ kind: "knobs", qid: "card", text: "make it calmer", values: { density: 7, accent: "#3b6cff" } }]);
  assert.equal(sent.notes, undefined);
  const noted = knobsAsk(v, { qid: "card", text: "make it calmer" });
  assert.deepEqual(noted.notes, [{ qid: "card", text: "make it calmer" }]);
  assert.equal(noted.outbox, undefined);
  assert.throws(() => knobsAsk(v, { qid: "card", text: "  " }), /no text/);
  assert.deepEqual(v, view(), "the input is not changed");
});

test("a knobs patch moves controls and keeps the state before", () => {
  const v = view();
  const out = knobsOp(v, { op: "knobs", qid: "card", values: { density: 2, ghost: 1 } });
  assert.deepEqual(out.answers.card.values, { density: 2, accent: "#3b6cff" });
  assert.deepEqual(out.answers.card.snapshots, [{ name: "before", values: { density: 7, accent: "#3b6cff" } }]);
  assert.deepEqual(v, view(), "the input is not changed");
});

test("a knobs patch replaces the panel and the mockup", () => {
  const out = knobsOp(view(), { op: "knobs", question: "card", knobs: [{ id: "density", type: "range", value: 3 }, { id: "calm", type: "toggle" }, { id: "bad id" }], preview: { src: "/r/bbbbbbbb/calm.html" } });
  const q = out.spec.questions[0];
  assert.deepEqual(q.knobs.map((k) => k.id), ["density", "calm"]);
  assert.equal(q.preview.src, "/r/bbbbbbbb/calm.html");
  assert.deepEqual(out.answers.card.values, { density: 7 }, "a knob that is gone loses its value");
  assert.equal(out.spec.questions[1].id, "q");
});

test("a wrong target throws", () => {
  assert.throws(() => knobsOp(view(), { op: "knobs", qid: "nope" }), /no question/);
  assert.throws(() => knobsOp(view(), { op: "knobs", qid: "q" }), /not tune/);
  assert.throws(() => knobsOp(view(), { op: "set", qid: "card" }), /not a knobs op/);
});
