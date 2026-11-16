/*
 * What:       the tune question: registry normalisation, the answer and its check, derived values.
 * Why exists: the knobs answer must survive a save and a reload exactly; a bad knob must be named.
 * Isolation:  pure.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pluginDir } from "./helpers.mjs";
import { normalizeSpec } from "../lib/spec.mjs";
import { emptyAnswer as logicEmpty, finalizeAnswers } from "../ui/js/logic.js";
import { cleanValues, derivedOf, nextName } from "../ui/js/tune-logic.js";
import * as tune from "../ui/js/types/tune.js";

const examples = path.join(pluginDir, "examples/v3");
const mk = (extra = {}) => ({
  questions: [{ id: "k", title: "t", type: "tune", knobs: [{ id: "a", kind: "range", min: 0, max: 10, default: 3 }, { id: "on", kind: "toggle" }, { id: "mode", kind: "select", options: ["x", "y"] }], ...extra }],
});
const errors = (issues) => issues.filter((i) => i.level === "error").map((i) => i.message);

test("the example spec normalises with no error and its mockup is found", () => {
  const raw = JSON.parse(readFileSync(path.join(examples, "tune.questions.json"), "utf8"));
  const { spec, issues } = normalizeSpec(raw, { specDir: examples });
  assert.deepEqual(errors(issues), []);
  const q = spec.questions[0];
  assert.equal(q.type, "tune");
  assert.ok(q.preview?.src.endsWith("card.html"));
  assert.deepEqual(q.knobs.map((k) => k.kind), ["range", "color", "text", "image"]);
  assert.deepEqual(q.frames, ["phone", "desktop"]);
  assert.deepEqual(q.themes, ["light", "dark"]);
  assert.equal(q.presets[2].values.accent, "#d6245f");
  assert.equal(q.presets[0].values.names, "Anna and Misha", "a preset leaves the other knobs at their defaults");
  assert.deepEqual(spec.questions[1].derived.map((d) => d.id), ["kept", "revenue"]);
});

test("a knob is normalised: defaults, clamping, aliases", () => {
  const { spec } = normalizeSpec(mk({ knobs: [{ id: "a", type: "range", min: 0, max: 10, value: 99 }, { id: "m", kind: "select", options: [{ id: "x", label: "X" }], default: "nope" }] }));
  const [a, m] = spec.questions[0].knobs;
  assert.equal(a.kind, "range");
  assert.equal(a.default, 10, "value is the older spelling of default, and is clamped");
  assert.equal(m.default, "x");
  assert.equal(spec.questions[0].frames[0], "phone");
});

test("bad knobs are errors that name the knob", () => {
  const e = (extra) => errors(normalizeSpec(mk(extra)).issues).join("\n");
  assert.match(e({ knobs: [{ id: "a b" }] }), /needs an id of letters/);
  assert.match(e({ knobs: [{ id: "a", kind: "dial" }] }), /kind "dial"/);
  assert.match(e({ knobs: [{ id: "a" }, { id: "a" }] }), /used twice/);
  assert.match(e({ knobs: [{ id: "s", kind: "select" }] }), /needs options/);
  assert.match(e({ knobs: [] }), /at least one knob/);
  assert.match(e({ derived: [{ id: "d", formula: "a * zzz" }] }), /derived "d": unknown name 'zzz'/);
});

test("derived values follow the knobs, in order, and are null when they cannot be computed", () => {
  const { spec } = normalizeSpec(mk({ derived: [{ id: "double", formula: "a * 2" }, { id: "plus", formula: "double + on" }, { id: "bad", formula: "a / 0" }] }));
  assert.deepEqual(derivedOf(spec.questions[0], { a: 4, on: true, mode: "x" }), { double: 8, plus: 9, bad: null });
});

test("the answer keeps values, snapshots, picks and derived; a reload gives the same", () => {
  const { spec } = normalizeSpec(mk({ derived: [{ id: "double", formula: "a * 2" }] }));
  const q = spec.questions[0];
  const blank = logicEmpty(q);
  assert.equal(tune.isAnswered(q, blank), false);
  assert.deepEqual(tune.compact(q, blank), {});
  const a = { ...blank, tuned: true, preset: "Airy", values: { a: 7, on: true, mode: "y" }, snapshots: [{ name: "A", values: { a: 2, on: false, mode: "x" } }, { name: "B", values: { a: 9, on: true, mode: "y" } }], candidates: ["A", "B", "ghost"], picked: null };
  assert.equal(tune.isAnswered(q, a), true);
  const out = finalizeAnswers(spec, { k: a }).k;
  assert.deepEqual(out.values, { a: 7, on: true, mode: "y" });
  assert.equal(out.preset, "Airy");
  assert.deepEqual(out.candidates, ["A", "B"], "a name that was never saved is dropped");
  assert.deepEqual(out.derived, { double: 14 });
  assert.deepEqual(tune.check(q, JSON.parse(JSON.stringify(out))), { values: out.values, preset: "Airy", snapshots: out.snapshots, picked: null, candidates: ["A", "B"], derived: out.derived });
});

test("an answers file is read back clamped: unknown knobs dropped, values fitted, picked must exist", () => {
  const { spec } = normalizeSpec(mk());
  const q = spec.questions[0];
  const r = tune.check(q, { values: { a: 99, on: "yes", mode: "z", extra: 1 }, snapshots: [{ name: "A", values: { a: -5 } }], picked: "B", candidates: ["A"] });
  assert.deepEqual(r.values, { a: 10, on: false, mode: "x" });
  assert.deepEqual(r.snapshots[0].values, { a: 0, on: false, mode: "x" });
  assert.equal(r.picked, null);
  assert.deepEqual(r.candidates, ["A"]);
  assert.equal(tune.check(q, { picked: "now", values: {} }).picked, "now");
});

test("helpers: snapshot names run A, B, C; cleanValues takes the base for a missing knob", () => {
  assert.equal(nextName([]), "A");
  assert.equal(nextName([{ name: "A" }, { name: "C" }]), "B");
  const { spec } = normalizeSpec(mk());
  assert.deepEqual(cleanValues(spec.questions[0].knobs, { a: 5 }, { a: 1, on: true, mode: "y" }), { a: 5, on: true, mode: "y" });
});

test("the digest line says what was set, in English", () => {
  const { spec } = normalizeSpec(mk({ derived: [{ id: "double", formula: "a * 2" }] }));
  const q = spec.questions[0];
  const out = finalizeAnswers(spec, { k: { ...logicEmpty(q), tuned: true, values: { a: 4, on: true, mode: "x" }, snapshots: [{ name: "A", values: { a: 1 } }], picked: "A" } }).k;
  assert.equal(tune.describe(q, out, {}), 'a 4, on on, mode "x" · double = 8 · saved A · picked A');
});

test("the colour arrow keys move hue and lightness", () => {
  assert.notEqual(tune.nudgeColor("#3b6cff", "ArrowRight"), "#3b6cff");
  assert.notEqual(tune.nudgeColor("#3b6cff", "ArrowUp"), tune.nudgeColor("#3b6cff", "ArrowDown"));
});
