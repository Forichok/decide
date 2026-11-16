/**
 * Feature:    decide-3 reactive rounds, patch operations (R2)
 * Layer:      Pure unit (no server, no disk)
 * Contract:   lib/store/patch.mjs — applyPatch, validatePatch; precedence through lib/store/view.mjs
 * Covers:
 *   - one test per operation: ghost, restore, set, addOptions, removeOptions, setOptions, add,
 *     remove (unseen goes, seen becomes a ghost), recommend, stale, brief, knobs (K8: values fitted, preview, seq, reason)
 *   - keepAnswers marks nothing stale; an answer given after the patch outranks its stale mark
 *   - one test per row of the precedence order: user restore > override patch > rules > ordinary patch > spec
 *   - validatePatch names unknown items, options and operations
 * Why exists: an agent's patch must never drop an answer silently or undo the user's own choice.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { applyPatch, validatePatch } = await import(path.join(toolDir, "lib/store/patch.mjs"));
const { viewOf } = await import(path.join(toolDir, "lib/store/view.mjs"));

const q = (id, options = ["a", "b"]) => ({ id, title: `Question ${id}`, options: options.map((o) => ({ id: o, label: o.toUpperCase() })) });
const pick = (...selected) => ({ selected, other: "", note: "", value: null, text: "", touched: true });
const spec = { title: "Round", questions: [q("a"), q("b"), q("c")] };
const answer = (seq, qid, a) => ({ seq, type: "answer", qid, answer: a });
// A view of the spec with b answered "a" at seq 1.
const base = (opts = {}) => viewOf(spec, [answer(1, "b", pick("a"))], opts);
const item = (view, id) => view.items.find((e) => e.id === id);
const states = (view) => Object.fromEntries(view.items.map((e) => [e.id, e.state]));
const patch = (ops, extra = {}) => ({ ops, reason: "the agent learned something", seq: 10, ...extra });

test("applyPatch returns a new view and leaves the old one as it was", () => {
  const v = base();
  const before = JSON.stringify(v);
  const next = applyPatch(v, patch([{ ghost: "b" }, { set: { id: "a", title: "New" } }]));
  assert.notEqual(next, v);
  assert.equal(JSON.stringify(v), before);
});

test("ghost: greys an item out with the reason; its answer moves to ghostAnswers", () => {
  const v = applyPatch(base(), patch([{ ghost: ["b"], reason: "you chose link sign-in" }]));
  const b = item(v, "b");
  assert.equal(b.state, "ghost");
  assert.equal(b.reason, "you chose link sign-in");
  assert.equal(v.answers.b, undefined);
  assert.deepEqual(v.ghostAnswers.b, pick("a"));
});

test("restore: a ghost comes back with its answer", () => {
  const ghosted = applyPatch(base(), patch([{ ghost: "b" }]));
  const v = applyPatch(ghosted, patch([{ restore: "b" }]));
  assert.equal(item(v, "b").state, "normal");
  assert.deepEqual(v.answers.b, pick("a"));
  assert.deepEqual(v.ghostAnswers, {});
});

test("set: changes fields and marks the item changed; a new title makes the answer stale", () => {
  const cosmetic = applyPatch(base(), patch([{ set: { id: "b", tldr: "a better line" } }]));
  assert.equal(item(cosmetic, "b").state, "changed");
  assert.equal(item(cosmetic, "b").item.tldr, "a better line");
  assert.deepEqual(item(cosmetic, "b").was, q("b"), "what it was");
  assert.deepEqual(cosmetic.stale, []);

  const retitled = applyPatch(base(), patch([{ set: { id: "b", title: "A different question" } }]));
  assert.deepEqual(retitled.stale, ["b"]);
  assert.equal(retitled.staleReasons.b, "the agent learned something");
  // An unanswered question has no answer to check.
  assert.deepEqual(applyPatch(base(), patch([{ set: { id: "a", title: "Other" } }])).stale, []);
});

test("addOptions: adds at the end or next to an option; an existing id is reworded", () => {
  const v = applyPatch(base(), patch([{ addOptions: { question: "a", options: [{ id: "c", label: "C" }, "Dee"], after: "a" } }]));
  assert.deepEqual(item(v, "a").item.options.map((o) => o.id), ["a", "c", "d", "b"]);
  assert.equal(item(v, "a").state, "changed");
  // Rewording the picked option makes b's answer stale.
  const reworded = applyPatch(base(), patch([{ addOptions: { question: "b", options: [{ id: "a", label: "Alpha, but different" }] } }]));
  assert.equal(item(reworded, "b").item.options[0].label, "Alpha, but different");
  assert.deepEqual(reworded.stale, ["b"]);
});

test("removeOptions: a removed option that was selected makes the answer stale", () => {
  const other = applyPatch(base(), patch([{ removeOptions: { question: "b", options: ["b"] } }]));
  assert.deepEqual(item(other, "b").item.options.map((o) => o.id), ["a"]);
  assert.equal(item(other, "b").state, "changed");
  assert.deepEqual(other.stale, []);
  const picked = applyPatch(base(), patch([{ removeOptions: { question: "b", options: ["a"] } }]));
  assert.deepEqual(picked.stale, ["b"]);
  assert.deepEqual(picked.answers.b, pick("a"), "the answer stays, marked for checking");
});

test("setOptions: replaces the list; the picked option gone makes the answer stale", () => {
  const v = applyPatch(base(), patch([{ setOptions: { question: "b", options: [{ id: "x", label: "X" }, "Why"] } }]));
  assert.deepEqual(item(v, "b").item.options, [{ id: "x", label: "X" }, { id: "a", label: "Why" }]);
  // "Why" took the free id "a", but its words differ from the picked "A": still stale.
  assert.deepEqual(v.stale, ["b"]);
  const kept = applyPatch(base(), patch([{ setOptions: { question: "b", options: [{ id: "a", label: "A" }, { id: "z", label: "Z" }] } }]));
  assert.deepEqual(kept.stale, [], "the picked option is still there, same words");
});

test("add: a new item before or after another, else at the end", () => {
  const v = applyPatch(base(), patch([
    { add: { item: q("n1"), after: "a" } },
    { add: { item: q("n2"), before: "a" } },
    { add: { item: q("n3") } },
    { add: { item: q("a") } },
  ]));
  assert.deepEqual(v.items.map((e) => e.id), ["n2", "a", "n1", "b", "c", "n3"]);
  assert.equal(item(v, "n1").state, "new");
  assert.equal(item(v, "n1").reason, "the agent learned something");
  assert.equal(item(v, "a").item.title, "Question a", "an add with a taken id changes nothing");
});

test("remove: an unseen item goes; a seen or answered one becomes a ghost", () => {
  const v = applyPatch(base({ seen: ["a"] }), patch([{ remove: ["a", "b", "c"] }]));
  assert.deepEqual(v.items.map((e) => e.id), ["a", "b"]);
  assert.equal(item(v, "a").state, "ghost", "seen");
  assert.equal(item(v, "b").state, "ghost", "answered");
  assert.deepEqual(v.ghostAnswers.b, pick("a"));
});

test("recommend: moves the recommendation with its reason and marks the item changed", () => {
  const start = { questions: [{ id: "a", title: "A", options: [{ id: "x", label: "X", recommended: true }, { id: "y", label: "Y" }] }] };
  const v = applyPatch(viewOf(start, []), patch([{ recommend: { question: "a", option: "y", reason: "cheaper after all" } }]));
  const opts = item(v, "a").item.options;
  assert.deepEqual(opts.map((o) => o.recommended), [false, true]);
  assert.equal(opts[1].reason, "cheaper after all");
  assert.equal(item(v, "a").state, "changed");
  assert.equal(item(v, "a").reason, "cheaper after all");
  assert.deepEqual(v.stale, [], "a moved recommendation does not doubt the answer");
});

test("stale: marks an answer for checking, even with keepAnswers", () => {
  const v = applyPatch(base(), patch([{ stale: ["b", "a"] }], { keepAnswers: true }));
  assert.deepEqual(v.stale, ["b"], "a has no answer to check");
});

test("brief: rewrites the task panel", () => {
  const v = applyPatch(base(), patch([{ brief: [{ kind: "decision", text: "link sign-in" }] }]));
  assert.deepEqual(v.brief, [{ kind: "decision", text: "link sign-in" }]);
});

test("keepAnswers: a cosmetic edit marks nothing stale", () => {
  const v = applyPatch(base(), patch([{ set: { id: "b", title: "Same question, better words" } }, { removeOptions: { question: "b", options: ["a"] } }], { keepAnswers: true }));
  assert.equal(item(v, "b").state, "changed");
  assert.deepEqual(v.stale, []);
});

test("an answer given after the patch outranks its stale mark", () => {
  const events = [answer(1, "b", pick("a")), { seq: 2, type: "patch", ops: [{ set: { id: "b", title: "Rewritten" } }], reason: "r" }];
  assert.deepEqual(viewOf(spec, events).stale, ["b"]);
  assert.deepEqual(viewOf(spec, [...events, answer(3, "b", pick("b"))]).stale, []);
  assert.deepEqual(viewOf(spec, [...events, { seq: 3, type: "keep", qid: "b" }]).stale, [], "keep confirms it");
});

// ---- precedence, weakest first: spec < ordinary patch < rules < override patch < user restore

const ruled = {
  questions: [q("auth", ["link", "password"]), q("recover", ["email", "sms"]), q("store", ["guest", "db"])],
  rules: [{ when: { question: "auth", in: ["link"] }, reason: "you chose link sign-in", do: [{ ghost: "recover" }] }],
};
const link = answer(1, "auth", pick("link"));
const ev = (seq, ops, extra = {}) => ({ seq, type: "patch", ops, reason: `patch ${seq}`, ...extra });

test("precedence row 1: the spec as opened when nothing else speaks", () => {
  assert.deepEqual(states(viewOf(ruled, [])), { auth: "normal", recover: "normal", store: "normal" });
});

test("precedence row 2: an ordinary patch beats the spec", () => {
  const v = viewOf(ruled, [ev(1, [{ ghost: "store" }, { set: { id: "auth", tldr: "x" } }])]);
  assert.deepEqual(states(v), { auth: "changed", recover: "normal", store: "ghost" });
});

test("precedence row 3: the rules beat an ordinary patch", () => {
  // The patch brings recover back, the rule keeps it a ghost.
  const v = viewOf(ruled, [link, ev(2, [{ restore: "recover" }])]);
  assert.equal(item(v, "recover").state, "ghost");
  assert.equal(item(v, "recover").reason, "you chose link sign-in");
  // And a rule's restore beats a patch's ghost.
  const restoring = { ...ruled, rules: [{ when: { question: "auth", in: ["password"] }, reason: "passwords need recovery", do: [{ restore: "recover" }] }] };
  const w = viewOf(restoring, [ev(1, [{ ghost: "recover" }]), answer(2, "auth", pick("password"))]);
  assert.equal(item(w, "recover").state, "normal");
});

test("precedence row 4: an override patch beats the rules", () => {
  const v = viewOf(ruled, [link, ev(2, [{ restore: "recover" }], { override: true })]);
  assert.equal(item(v, "recover").state, "normal");
  // Arrival order does not matter: an override sent before the answer still wins.
  const early = viewOf(ruled, [ev(1, [{ restore: "recover" }], { override: true }), answer(2, "auth", pick("link"))]);
  assert.equal(item(early, "recover").state, "normal");
});

test("precedence row 5: the user's restore beats an override patch", () => {
  const ghostAgain = ev(3, [{ ghost: "recover" }], { override: true, reason: "the agent insists" });
  const after = viewOf(ruled, [link, { seq: 2, type: "restore", id: "recover" }, ghostAgain]);
  assert.equal(item(after, "recover").state, "normal");
  const before = viewOf(ruled, [link, ghostAgain, { seq: 4, type: "restore", id: "recover" }]);
  assert.equal(item(before, "recover").state, "normal");
  // Without the user's restore the override holds.
  assert.equal(item(viewOf(ruled, [link, ghostAgain]), "recover").state, "ghost");
});

test("validatePatch names unknown items, options and operations", () => {
  const issues = validatePatch(spec, {
    reason: "",
    ops: [
      { ghost: "nope" },
      { set: { id: "a" } },
      { addOptions: { question: "a", options: [{ id: "a", label: "A2" }, { label: "" }], after: "zz" } },
      { removeOptions: { question: "b", options: ["q"] } },
      { setOptions: { question: "c", options: [] } },
      { add: { item: { id: "b" }, before: "a", after: "c" } },
      { add: { item: { id: "n" } } },
      { set: { id: "n", title: "fine: added above" } },
      { remove: "c" },
      { stale: "c" },
      { recommend: { question: "a", option: "zz" } },
      { knobs: {} },
      { ghost: "a", restore: "b" },
    ],
  });
  const has = (level, at, re) => assert.ok(issues.some((i) => i.level === level && i.path === at && re.test(i.message)), `${level} ${at} ${re}: ${JSON.stringify(issues, null, 1)}`);
  has("error", "ops[0]", /no item "nope"/);
  has("warn", "ops[0]", /without a reason/);
  has("warn", "ops[1]", /changes no field/);
  has("warn", "ops[2]", /"a" exists and will be reworded/);
  has("error", "ops[2].options[1]", /needs a label/);
  has("error", "ops[2]", /no option "zz"/);
  has("error", "ops[3]", /no option "q" in "b"/);
  has("error", "ops[4]", /at least one option/);
  has("error", "ops[5]", /"b" exists/);
  has("error", "ops[5]", /before or after, not both/);
  assert.ok(!issues.some((i) => i.path === "ops[7]"), "an item added earlier in the patch is known");
  has("error", "ops[9]", /no item "c"/);
  has("error", "ops[10]", /no option "zz"/);
  has("warn", "ops[10]", /without a reason/);
  has("error", "ops[11]", /knobs names no question/);
  has("error", "ops[12]", /exactly one/);
  assert.deepEqual(validatePatch(spec, { ops: [] }).map((i) => i.level), ["error"]);
  assert.deepEqual(validatePatch(spec, { ops: [{ ghost: "a" }], reason: "fine" }), []);
  // A view works as well as a spec.
  assert.deepEqual(validatePatch(base(), { ops: [{ ghost: "a" }], reason: "fine" }), []);
});

// ---- K8: the knobs op

const tuneSpec = {
  title: "Card",
  questions: [
    {
      id: "card",
      type: "tune",
      title: "How dense?",
      preview: { src: "/abs/card.html", local: true },
      knobs: [
        { id: "density", kind: "range", min: 0, max: 10, step: 1, default: 4 },
        { id: "accent", kind: "color", default: "#3b6cff" },
        { id: "calm", kind: "toggle", default: false },
        { id: "mode", kind: "select", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }], default: "x" },
      ],
    },
    q("other"),
  ],
};

test("knobs: values are fitted to their knobs and land in view.knobs with the seq and reason", () => {
  const v = viewOf(tuneSpec, [{ seq: 4, type: "patch", reason: "calmer", ops: [{ knobs: { question: "card", values: { density: 99, accent: "red", calm: true, mode: "y", ghost: 1 } } }] }]);
  assert.deepEqual(v.knobs, { card: { seq: 4, reason: "calmer", values: { density: 10, accent: "#3b6cff", calm: true, mode: "y" } } });
  assert.equal(item(v, "card").state, "normal", "moving knobs does not mark the question changed");
  assert.deepEqual(v.answers, {}, "the answer is the page's to change");
});

test("knobs: a preview swaps the mockup; a later op merges into the earlier one; the op's own reason wins", () => {
  const v = viewOf(tuneSpec, [
    { seq: 2, type: "patch", reason: "calmer", ops: [{ knobs: { question: "card", values: { density: 2 } } }] },
    { seq: 5, type: "patch", reason: "patch reason", ops: [{ knobs: { question: "card", values: { calm: true }, preview: "/abs/calm.html" }, reason: "a calmer layout" }] },
  ]);
  assert.deepEqual(v.knobs.card, { seq: 5, reason: "a calmer layout", values: { density: 2, calm: true }, preview: "/abs/calm.html" });
  const only = viewOf(tuneSpec, [{ seq: 3, type: "patch", ops: [{ knobs: { question: "card", preview: "/abs/b.html" } }] }]);
  assert.deepEqual(only.knobs.card, { seq: 3, reason: "", preview: "/abs/b.html" });
});

test("knobs: an op on another question type, or one that sets nothing, changes nothing", () => {
  const v = applyPatch(viewOf(tuneSpec, []), patch([{ knobs: { question: "other", values: { density: 1 } } }, { knobs: { question: "card", values: { nope: 1 } } }]));
  assert.deepEqual(v.knobs, {});
  // With no seq (a dry run), each op counts on from the last.
  const dry = applyPatch(applyPatch(viewOf(tuneSpec, []), { ops: [{ knobs: { question: "card", values: { density: 1 } } }] }), { ops: [{ knobs: { question: "card", values: { density: 3 } } }] });
  assert.equal(dry.knobs.card.seq, 2);
});

test("knobs: validatePatch names a wrong question, a missing change and unknown knobs", () => {
  const issues = validatePatch(tuneSpec, {
    reason: "calmer",
    ops: [
      { knobs: { question: "nope", values: {} } },
      { knobs: { question: "other", values: {} } },
      { knobs: { question: "card" } },
      { knobs: { question: "card", values: { density: 2, ghost: 1 } } },
      { knobs: { question: "card", values: [1] } },
      { knobs: { question: "card", preview: "" } },
      { knobs: { question: "card", values: { density: 1 }, preview: "calm.html" } },
    ],
  });
  const at = (i) => issues.filter((x) => x.path === `ops[${i}]`).map((x) => `${x.level}: ${x.message}`);
  assert.match(at(0).join(), /error: knobs: no item "nope"/);
  assert.match(at(1).join(), /error: knobs: "other" is a .* question, not tune/);
  assert.match(at(2).join(), /error: knobs moves values or swaps the preview/);
  assert.match(at(3).join(), /warn: knobs: "card" has no knob "ghost"/);
  assert.match(at(4).join(), /error: knobs: values is/);
  assert.match(at(5).join(), /error: knobs: preview is the path/);
  assert.deepEqual(at(6), []);
});

test("set on a swipe card: a changed side makes its answer stale, keepAnswers does not", () => {
  const deck = { cards: [{ id: "c1", title: "?", left: { label: "L" }, right: { label: "R" } }] };
  const v = viewOf(deck, [{ seq: 1, type: "swipe", card: "c1", side: "right" }]);
  assert.deepEqual(applyPatch(v, patch([{ set: { id: "c1", right: { label: "R2" } } }])).stale, ["c1"]);
  assert.deepEqual(applyPatch(v, patch([{ set: { id: "c1", right: { label: "R2" } } }], { keepAnswers: true })).stale, []);
  assert.deepEqual(applyPatch(v, patch([{ set: { id: "c1", body: "more words" } }])).stale, [], "a body edit is not a new question");
});
