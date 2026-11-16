/**
 * Feature:    decide-3 reactive rounds, the rule engine (R1)
 * Layer:      Pure unit (no server, no disk but fixtures)
 * Contract:   ui/js/rules.js — evaluate, lintRules, showIfToRule
 * Covers:
 *   - rule effects come from the current answers: changing the answer back undoes them
 *   - a ghosted question's answer does not count for other rules
 *   - contradicting and looping rules end, give the same result on a second run, lint names the loop
 *   - a long chain settles within the questions + 1 passes cap
 *   - lint names unknown questions, options and operations
 *   - a 2.x showIf spec gives a ghost
 * Why exists: Review Focus 5 — rules that feed each other must not hang the page or flip with the run count.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { evaluate, lintRules, rulesLoops, showIfToRule, hasAnswer } = await import(path.join(toolDir, "ui/js/rules.js"));

const q = (id, options = ["a", "b"]) => ({ id, title: `Question ${id}`, options: options.map((o) => ({ id: o, label: o.toUpperCase() })) });
const pick = (...selected) => ({ selected, other: "", note: "", value: null, text: "", touched: true });
const plain = (r) => ({ ghosts: [...r.ghosts], removed: [...r.removed].map(([k, v]) => [k, [...v].sort()]), stale: [...r.stale].sort(), restored: [...r.restored], settled: r.settled });

const signIn = {
  questions: [q("confirm", ["link", "password"]), q("recover", ["email", "sms"]), q("store", ["guest-account", "db"])],
  rules: [
    {
      when: { question: "confirm", in: ["link"] },
      reason: "you chose sign-in without an account",
      do: [{ ghost: ["recover"] }, { removeOptions: { question: "store", options: ["guest-account"] } }],
    },
  ],
};

test("a rule's effects follow the current answers: changing the answer back undoes them", () => {
  const none = evaluate(signIn, {});
  assert.equal(none.ghosts.size, 0);
  assert.equal(none.removed.size, 0);

  const link = evaluate(signIn, { confirm: pick("link") });
  assert.deepEqual([...link.ghosts], [["recover", "you chose sign-in without an account"]]);
  assert.deepEqual([...link.removed.get("store")], ["guest-account"]);
  assert.equal(link.settled, true);

  const back = evaluate(signIn, { confirm: pick("password") });
  assert.deepEqual(plain(back), plain(none));
  // Through link and back again: the same as never having picked it.
  assert.deepEqual(plain(evaluate(signIn, { confirm: pick("link") })), plain(link));
});

test("a removed option that was picked marks the answer stale; the stale op does too", () => {
  const spec = { ...signIn, rules: [...signIn.rules, { when: { question: "store", answered: true }, reason: "storage decides recovery", do: [{ stale: "recover" }] }] };
  const r = evaluate(spec, { confirm: pick("link"), store: pick("guest-account"), recover: pick("sms") });
  assert.deepEqual([...r.stale].sort(), ["store"], "recover is a ghost, so its stale mark is dropped");
  assert.equal(r.reasons.get("store"), "you chose sign-in without an account");
  const r2 = evaluate(spec, { confirm: pick("password"), store: pick("db"), recover: pick("sms") });
  assert.deepEqual([...r2.stale], ["recover"]);
  assert.equal(r2.reasons.get("recover"), "storage decides recovery");
});

test("a ghosted question's answer does not count for other rules", () => {
  const spec = {
    questions: [q("a"), q("b"), q("c")],
    rules: [
      { when: { question: "b", in: ["a"] }, reason: "b is a", do: [{ ghost: "c" }] },
      { when: { question: "a", in: ["b"] }, reason: "a is b", do: [{ ghost: "b" }] },
    ],
  };
  // a = b ghosts b; b's answer then no longer ghosts c, even though it says "a".
  const r = evaluate(spec, { a: pick("b"), b: pick("a") });
  assert.deepEqual([...r.ghosts.keys()], ["b"]);
  assert.equal(r.settled, true);
  // With a = a, b is shown and its answer ghosts c.
  assert.deepEqual([...evaluate(spec, { a: pick("a"), b: pick("a") }).ghosts.keys()], ["c"]);
});

test("conditions: all, any, not, equals, answered, notIn", () => {
  const spec = {
    questions: [q("a"), q("b"), { id: "size", type: "scale", title: "Size" }, { id: "name", type: "text", title: "Name" }, q("t1"), q("t2"), q("t3"), q("t4"), q("t5")],
    rules: [
      { when: { all: [{ question: "a", in: ["a"] }, { question: "b", notIn: ["a"] }] }, reason: "all", do: [{ ghost: "t1" }] },
      { when: { any: [{ question: "size", equals: 5 }, { question: "name", equals: "x" }] }, reason: "any", do: [{ ghost: "t2" }] },
      { when: { not: { question: "a", answered: true } }, reason: "not", do: [{ ghost: "t3" }] },
      { when: { question: "b" }, reason: "bare leaf means answered", do: [{ ghost: "t4" }] },
      { when: { question: "a", equals: ["a"] }, reason: "a list equals the picked set", do: [{ ghost: "t5" }] },
    ],
  };
  const ghosts = (answers) => [...evaluate(spec, answers).ghosts.keys()].sort();
  assert.deepEqual(ghosts({}), ["t3"]);
  assert.deepEqual(ghosts({ a: pick("a") }), ["t1", "t5"]);
  assert.deepEqual(ghosts({ a: pick("a"), b: pick("a") }), ["t4", "t5"]);
  assert.deepEqual(ghosts({ a: pick("b"), size: { value: 5 } }), ["t2"]);
  assert.deepEqual(ghosts({ a: pick("b"), name: { text: " x " } }), ["t2"]);
  // A flag alone is not an answer.
  assert.equal(hasAnswer({ selected: [], flag: "delegate" }), false);
  assert.deepEqual(ghosts({ a: { selected: [], flag: "skip" } }), ["t3"]);
});

test("contradicting rules: in one pass the later rule wins, the same way every run", () => {
  const spec = {
    questions: [q("a"), q("b")],
    rules: [
      { when: { question: "a", in: ["a"] }, reason: "ghost it", do: [{ ghost: "b" }] },
      { when: { question: "a", in: ["a"] }, reason: "keep it", do: [{ restore: "b" }] },
    ],
  };
  const answers = { a: pick("a") };
  const r = evaluate(spec, answers);
  assert.equal(r.ghosts.size, 0);
  assert.equal(r.settled, true);
  assert.deepEqual(plain(evaluate(spec, answers)), plain(r));
  const flipped = evaluate({ ...spec, rules: [...spec.rules].reverse() }, answers);
  assert.deepEqual([...flipped.ghosts], [["b", "ghost it"]]);
  // A rule's restore undoes a ghost an ordinary patch made.
  assert.deepEqual([...evaluate(spec, answers, { ghosted: ["b"] }).restored], [["b", "keep it"]]);
});

test("looping rules end, give the same result on a second run, and lint names the loop", () => {
  const spec = {
    questions: [q("a"), q("b"), q("c")],
    rules: [
      { when: { question: "b", answered: true }, reason: "b answered", do: [{ ghost: "a" }] },
      { when: { question: "a", answered: true }, reason: "a answered", do: [{ ghost: "b" }] },
    ],
  };
  const both = { a: pick("a"), b: pick("b") };
  const r = evaluate(spec, both);
  // Each ghost takes away the answer that made it, so they flip; while they flip both stay shown.
  assert.equal(r.settled, false);
  assert.equal(r.ghosts.size, 0);
  for (let i = 0; i < 5; i++) assert.deepEqual(plain(evaluate(spec, both)), plain(r));

  // With only one answered the loop settles.
  const one = evaluate(spec, { a: pick("a") });
  assert.equal(one.settled, true);
  assert.deepEqual([...one.ghosts.keys()], ["b"]);

  assert.deepEqual(rulesLoops(spec), [["a", "b", "a"]]);
  const loops = lintRules(spec).filter((i) => /loop/.test(i.message));
  assert.equal(loops.length, 1);
  assert.equal(loops[0].level, "warn");
  assert.match(loops[0].message, /"a" → "b" → "a"/);
});

test("a rule that ghosts the question it reads ends shown and lint names the loop", () => {
  const spec = { questions: [q("a")], rules: [{ when: { question: "a", in: ["a"] }, reason: "self", do: [{ ghost: "a" }] }] };
  const r = evaluate(spec, { a: pick("a") });
  assert.equal(r.settled, false);
  assert.equal(r.ghosts.size, 0);
  assert.deepEqual(plain(evaluate(spec, { a: pick("a") })), plain(r));
  assert.match(lintRules(spec).find((i) => /loop/.test(i.message)).message, /"a" → "a"/);
});

test("a three-way loop through notIn ends and is named once, from its smallest id", () => {
  const spec = {
    questions: [q("x"), q("y"), q("z")],
    rules: [
      { when: { question: "x", notIn: ["a"] }, reason: "x", do: [{ ghost: "y" }] },
      { when: { question: "y", notIn: ["a"] }, reason: "y", do: [{ ghost: "z" }] },
      { when: { question: "z", notIn: ["a"] }, reason: "z", do: [{ ghost: "x" }] },
    ],
  };
  const answers = { x: pick("a"), y: pick("a"), z: pick("a") };
  const r = evaluate(spec, answers);
  assert.deepEqual(plain(evaluate(spec, answers)), plain(r));
  assert.deepEqual(rulesLoops(spec), [["x", "y", "z", "x"]]);
  assert.equal(lintRules(spec).filter((i) => /loop/.test(i.message)).length, 1);
});

test("a chain as long as the round settles within the cap of questions + 1 passes", () => {
  const n = 12;
  const ids = Array.from({ length: n }, (_, i) => `q${i + 1}`);
  // Each question is ghosted when the one before it is not "a" (a ghost's answer is no answer).
  const rules = ids.slice(1).map((id, i) => ({ when: { question: ids[i], notIn: ["a"] }, reason: `${ids[i]} is not a`, do: [{ ghost: id }] }));
  const spec = { questions: ids.map((id) => q(id)), rules: rules.reverse() };
  const answers = Object.fromEntries(ids.map((id) => [id, pick("a")]));
  answers.q1 = pick("b");
  const r = evaluate(spec, answers);
  assert.equal(r.settled, true);
  assert.deepEqual([...r.ghosts.keys()].sort(), ids.slice(1).sort());
  assert.deepEqual(rulesLoops(spec), []);
  // q1 back to a: every ghost goes.
  assert.equal(evaluate(spec, { ...answers, q1: pick("a") }).ghosts.size, 0);
});

test("an override or the user's restore beats the rules", () => {
  const forced = evaluate(signIn, { confirm: pick("link") }, { forced: { recover: "shown" } });
  assert.equal(forced.ghosts.size, 0);
  const ghosted = evaluate(signIn, { confirm: pick("link") }, { forced: new Map([["confirm", "ghost"]]) });
  // confirm is a ghost, so its answer no longer ghosts recover.
  assert.equal(ghosted.ghosts.size, 0);
  assert.equal(ghosted.removed.size, 0);
});

test("lint names unknown questions, options and operations", () => {
  const spec = {
    questions: [q("a"), { id: "n", type: "scale", title: "N" }],
    rules: [
      { when: { question: "nope", in: ["a"] }, reason: "r", do: [{ ghost: "a" }] },
      { when: { question: "a", in: ["zz"] }, reason: "r", do: [{ ghost: "ghosty" }] },
      { when: { question: "a" }, reason: "r", do: [{ set: { id: "a", title: "x" } }, { explode: "a" }, { ghost: "a", restore: "a" }] },
      { when: { question: "a", in: ["a"] }, reason: "r", do: [{ removeOptions: { question: "a", options: ["q"] } }] },
      { when: { question: "a", wat: 1 }, do: [] },
      { when: { question: "n", in: ["x"] }, reason: "r", do: [{ stale: "a" }] },
    ],
  };
  const issues = lintRules(spec);
  const has = (level, path, re) => assert.ok(issues.some((i) => i.level === level && i.path === path && re.test(i.message)), `${level} ${path} ${re}: ${JSON.stringify(issues)}`);
  has("error", "rules[0].when", /unknown question "nope"/);
  has("error", "rules[1].when", /unknown option "zz" of "a"/);
  has("error", "rules[1].do[0]", /unknown question "ghosty"/);
  has("error", "rules[2].do[0]", /rules don't set/);
  has("error", "rules[2].do[1]", /unknown operation "explode"/);
  has("error", "rules[2].do[2]", /exactly one/);
  has("error", "rules[3].do[0]", /unknown option "q" of "a"/);
  has("error", "rules[4].when", /unknown condition field "wat"/);
  has("warn", "rules[4]", /no reason/);
  has("warn", "rules[4]", /do is empty/);
  has("warn", "rules[5].when", /"n" has no options/);
  assert.deepEqual(lintRules({ questions: [], rules: {} }), [{ level: "error", message: "rules must be a list", path: "rules" }]);
  assert.deepEqual(lintRules(signIn), []);
});

test("a 2.x showIf spec gives a ghost", () => {
  const raw = JSON.parse(readFileSync(path.join(toolDir, "test/fixtures/2.1/showcase.questions.json"), "utf8"));
  const share = raw.questions.find((x) => x.id === "share");
  const rule = showIfToRule(share);
  assert.deepEqual(rule.when, { question: "rollout", notIn: ["gradual"] });
  assert.deepEqual(rule.do, [{ ghost: ["share"] }]);
  assert.equal(rule.from, "showIf");
  assert.match(rule.reason, /rollout is gradual/);

  // The raw spec and the normalised one behave the same: hidden in 2.x, a ghost now.
  const normalized = JSON.parse(readFileSync(path.join(toolDir, "test/fixtures/2.1/showcase.normalized.json"), "utf8")).spec;
  for (const spec of [raw, normalized]) {
    assert.deepEqual([...evaluate(spec, {}).ghosts.keys()], ["share"], "unanswered: the condition fails");
    assert.deepEqual([...evaluate(spec, { rollout: pick("all") }).ghosts], [["share", rule.reason]]);
    assert.equal(evaluate(spec, { rollout: pick("gradual") }).ghosts.size, 0);
  }

  // notIn, the older spellings, and several conditions.
  assert.deepEqual(showIfToRule({ id: "x", showIf: { question: "a", selected: "b" } }).when, { question: "a", notIn: ["b"] });
  assert.deepEqual(showIfToRule({ id: "x", showIf: [{ q: "a", in: ["b"], notIn: ["c"] }] }).when, { any: [{ question: "a", notIn: ["b"] }, { question: "a", in: ["c"] }] });
  assert.equal(showIfToRule({ id: "x", showIf: [] }), null);
  assert.equal(showIfToRule({ id: "x" }), null);
  const two = { questions: [q("a"), { ...q("x"), showIf: [{ q: "a", notIn: ["b"] }] }] };
  assert.deepEqual([...evaluate(two, { a: pick("b") }).ghosts.keys()], ["x"]);
  assert.equal(evaluate(two, { a: pick("a") }).ghosts.size, 0);
});
