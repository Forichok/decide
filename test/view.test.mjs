/**
 * Feature:    decide-3 reactive rounds, the computed view (R3)
 * Layer:      Pure unit (no server, no disk)
 * Contract:   lib/store/view.mjs — viewOf(spec, events, { seen })
 * Covers:
 *   - a rule still applies after a patch touched the item
 *   - a user restore survives both the rules and an override patch
 *   - answers from answer events, or from the last draft for a round from before them
 *   - a ghost's answer is left out of answers and kept in ghostAnswers
 *   - a rule's stale mark counts from the answer that made it hold; answering again clears it
 *   - the same events give the same view
 * Why exists: the round's state is computed, never stored; a wrong order here silently changes what the agent acts on.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { viewOf } = await import(path.join(toolDir, "lib/store/view.mjs"));
const { applyPatch } = await import(path.join(toolDir, "lib/store/patch.mjs"));

const q = (id, options = ["a", "b"]) => ({ id, title: `Question ${id}`, options: options.map((o) => ({ id: o, label: o.toUpperCase() })) });
const pick = (...selected) => ({ selected, other: "", note: "", value: null, text: "", touched: true });
const answer = (seq, qid, a) => ({ seq, type: "answer", qid, answer: a });
const item = (view, id) => view.items.find((e) => e.id === id);

const spec = {
  title: "Sign-in",
  questions: [q("confirm", ["link", "password"]), q("recover", ["email", "sms"]), q("store", ["guest-account", "db"])],
  rules: [
    {
      when: { question: "confirm", in: ["link"] },
      reason: "you chose sign-in without an account",
      do: [{ ghost: ["recover"] }, { removeOptions: { question: "store", options: ["guest-account"] } }],
    },
  ],
};

test("the spec as opened: every item normal, no answers", () => {
  const v = viewOf(spec, []);
  assert.deepEqual(v.items.map((e) => [e.id, e.state, e.reason, e.was]), [["confirm", "normal", null, null], ["recover", "normal", null, null], ["store", "normal", null, null]]);
  assert.deepEqual(v.answers, {});
  assert.deepEqual(v.stale, []);
  assert.equal(v.brief, null);
  assert.equal(v.settled, true);
});

test("a rule still applies after a patch touched the item", () => {
  const events = [
    answer(1, "recover", pick("sms")),
    { seq: 2, type: "patch", ops: [{ set: { id: "recover", title: "How does a user get back in?" } }], reason: "clearer words", keepAnswers: true },
    { seq: 3, type: "patch", ops: [{ addOptions: { question: "store", options: [{ id: "file", label: "File" }] } }], reason: "one more way" },
    answer(4, "confirm", pick("link")),
  ];
  const v = viewOf(spec, events);
  const recover = item(v, "recover");
  assert.equal(recover.state, "ghost");
  assert.equal(recover.reason, "you chose sign-in without an account");
  assert.equal(recover.item.title, "How does a user get back in?", "the patch's change is kept under the ghost");
  assert.deepEqual(item(v, "store").item.options.map((o) => o.id), ["db", "file"], "the rule removed one, the patch's stays");
  // The ghost's answer is kept, and left out of the answers the agent acts on.
  assert.deepEqual(v.answers, { confirm: pick("link") });
  assert.deepEqual(v.ghostAnswers, { recover: pick("sms") });
  assert.deepEqual(v.ghosts, [{ id: "recover", reason: "you chose sign-in without an account" }]);

  // Even a patch that restores it outright does not undo the rule.
  const restored = viewOf(spec, [...events, { seq: 5, type: "patch", ops: [{ restore: "recover" }], reason: "I want it back" }]);
  assert.equal(item(restored, "recover").state, "ghost");

  // The answer changes back: the rule lets go, the patch's change shows.
  const back = viewOf(spec, [...events, answer(5, "confirm", pick("password"))]);
  assert.equal(item(back, "recover").state, "changed");
  assert.deepEqual(back.answers.recover, pick("sms"));
  assert.deepEqual(item(back, "store").item.options.map((o) => o.id), ["guest-account", "db", "file"]);
});

test("a user restore survives both the rules and an override patch", () => {
  const events = [
    answer(1, "recover", pick("email")),
    answer(2, "confirm", pick("link")),
    { seq: 3, type: "restore", id: "recover" },
    { seq: 4, type: "patch", ops: [{ ghost: "recover" }], reason: "really not needed", override: true },
    { seq: 5, type: "patch", ops: [{ set: { id: "recover", tldr: "a line" } }], reason: "context" },
  ];
  const v = viewOf(spec, events);
  const recover = item(v, "recover");
  assert.equal(recover.state, "changed");
  assert.deepEqual(v.answers.recover, pick("email"));
  assert.deepEqual(v.ghosts, []);
  // The user's restore does not lift the rule's other effects.
  assert.deepEqual(item(v, "store").item.options.map((o) => o.id), ["db"]);
  // The restored question's answer counts for the rules again.
  const chained = { ...spec, rules: [...spec.rules, { when: { question: "recover", in: ["email"] }, reason: "email recovery", do: [{ ghost: "store" }] }] };
  assert.equal(item(viewOf(chained, events), "store").state, "ghost");
  assert.notEqual(item(viewOf(chained, events.filter((e) => e.type !== "restore")), "store").state, "ghost");
});

test("an old round's answers come from its last draft", () => {
  const events = [
    { seq: 1, type: "opened" },
    { seq: 2, type: "draft", draft: { answers: { confirm: pick("password"), store: pick("guest-account") }, comment: "" } },
    { seq: 3, type: "draft", draft: { answers: { confirm: pick("link"), store: pick("guest-account") }, comment: "hi" } },
  ];
  const v = viewOf(spec, events);
  assert.deepEqual(v.answers, { confirm: pick("link"), store: pick("guest-account") });
  assert.equal(item(v, "recover").state, "ghost");
  // The rule took away the option store picked: an answer to check.
  assert.deepEqual(v.stale, ["store"]);
  assert.equal(v.staleReasons.store, "you chose sign-in without an account");
  // Once a round has answer events, drafts no longer speak for the answers.
  const mixed = viewOf(spec, [...events, answer(4, "recover", pick("sms"))]);
  assert.deepEqual(mixed.answers, { recover: pick("sms") });
});

test("a rule's stale mark counts from the answer that made it hold", () => {
  const ruled = { questions: [q("plan"), q("budget")], rules: [{ when: { question: "plan", in: ["b"] }, reason: "plan b costs more", do: [{ stale: "budget" }] }] };
  const first = [answer(1, "budget", pick("a")), answer(2, "plan", pick("b"))];
  assert.deepEqual(viewOf(ruled, first).stale, ["budget"]);
  // Answered again after the rule began to hold: nothing to check.
  assert.deepEqual(viewOf(ruled, [...first, answer(3, "budget", pick("b"))]).stale, []);
  assert.deepEqual(viewOf(ruled, [...first, { seq: 3, type: "keep", qid: "budget" }]).stale, []);
  // Answered while it already held: also nothing to check.
  assert.deepEqual(viewOf(ruled, [answer(1, "plan", pick("b")), answer(2, "budget", pick("a"))]).stale, []);
  // The rule lets go and holds again later: the new start counts, the old keep does not.
  const again = [...first, { seq: 3, type: "keep", qid: "budget" }, answer(4, "plan", pick("a")), answer(5, "plan", pick("b"))];
  assert.deepEqual(viewOf(ruled, again).stale, ["budget"]);
});

test("a patch can only drop what the user has not seen", () => {
  const events = [{ seq: 1, type: "patch", ops: [{ remove: ["recover", "store"] }], reason: "not needed" }];
  assert.deepEqual(viewOf(spec, events).items.map((e) => e.id), ["confirm"]);
  const seen = viewOf(spec, events, { seen: ["recover"] });
  assert.deepEqual(seen.items.map((e) => [e.id, e.state]), [["confirm", "normal"], ["recover", "ghost"]]);
  // An answer is proof the user saw it.
  const answered = viewOf(spec, [answer(1, "store", pick("db")), { ...events[0], seq: 2 }]);
  assert.equal(item(answered, "store").state, "ghost");
  assert.deepEqual(answered.ghostAnswers, { store: pick("db") });
});

test("new items, the brief and the order of patches", () => {
  const events = [
    { seq: 1, type: "patch", ops: [{ add: { item: q("extra"), after: "confirm" } }, { brief: "first" }], reason: "you mentioned SSO" },
    { seq: 2, type: "patch", ops: [{ brief: "second" }, { set: { id: "extra", title: "SSO provider?" } }], reason: "sharper" },
  ];
  const v = viewOf(spec, events);
  assert.deepEqual(v.items.map((e) => e.id), ["confirm", "extra", "recover", "store"]);
  assert.equal(item(v, "extra").state, "new");
  assert.equal(item(v, "extra").reason, "you mentioned SSO");
  assert.equal(item(v, "extra").item.title, "SSO provider?");
  assert.equal(v.brief, "second");
  // A rule can reach an added item: rules see the patched round.
  const ruled = { ...spec, rules: [{ when: { question: "confirm", in: ["password"] }, reason: "no SSO with passwords", do: [{ ghost: "extra" }] }] };
  assert.equal(item(viewOf(ruled, [...events, answer(3, "confirm", pick("password"))]), "extra").state, "ghost");
});

test("the same events give the same view, and the view takes a further patch", () => {
  const events = [answer(1, "confirm", pick("link")), answer(2, "store", pick("guest-account")), { seq: 3, type: "patch", ops: [{ recommend: { question: "store", option: "db", reason: "safer" } }] }];
  const a = viewOf(spec, events);
  assert.deepEqual(viewOf(spec, events), a);
  assert.deepEqual(viewOf(spec, structuredClone(events)), a);
  // Events without seq take their place in the list.
  assert.deepEqual(viewOf(spec, events.map(({ seq, ...e }) => e)).items, a.items);
  const next = applyPatch(a, { ops: [{ ghost: "store" }], reason: "preview" });
  assert.equal(item(next, "store").state, "ghost");
  assert.equal(item(a, "store").state, "changed", "the view handed in is untouched");
});

test("a swipe deck's cards are items too", () => {
  const deck = {
    cards: [{ id: "c1", title: "Dark mode?", left: { label: "No" }, right: { label: "Yes" } }, { id: "c2", title: "Which dark?", left: { label: "Pure" }, right: { label: "Dim" } }],
    rules: [{ when: { question: "c1", in: ["left"] }, reason: "no dark mode", do: [{ ghost: "c2" }] }],
    brief: [],
  };
  const v = viewOf(deck, [answer(1, "c1", { side: "left", at: 1 })]);
  assert.deepEqual(v.items.map((e) => [e.id, e.state]), [["c1", "normal"], ["c2", "ghost"]]);
  assert.deepEqual(v.brief, []);
});

test("seen events: a patch drops only what was unseen when it came; swipe events are a deck's answers", () => {
  const removeAll = (seq) => ({ seq, type: "patch", ops: [{ remove: ["confirm", "recover", "store"] }], reason: "moot" });
  const v = viewOf(spec, [{ seq: 1, type: "seen", ids: ["confirm"] }, removeAll(2), { seq: 3, type: "seen", ids: ["recover"] }]);
  assert.deepEqual(v.items.map((e) => [e.id, e.state]), [["confirm", "ghost"]], "seen before the patch: a ghost; seen after: already gone");
  assert.deepEqual(v.seen, ["confirm", "recover"]);

  const deck = { cards: [{ id: "c1", title: "?", left: { label: "L" }, right: { label: "R" } }, { id: "c2", title: "?", left: { label: "L" }, right: { label: "R" } }] };
  const w = viewOf(deck, [{ seq: 1, type: "swipe", card: "c1", side: "left" }, { seq: 2, type: "swipe", card: "c2", side: "skip" }, { seq: 3, type: "patch", ops: [{ set: { id: "c1", left: { label: "Other" } } }, { remove: ["c2"] }], reason: "r" }]);
  assert.deepEqual(w.answers.c1, { side: "left" });
  assert.deepEqual(w.stale, ["c1"], "a changed side makes the answer doubtful");
  assert.deepEqual(w.ghosts, [{ id: "c2", reason: "r" }], "a skipped card was on screen: it greys out");
  const undone = viewOf(deck, [{ seq: 1, type: "swipe", card: "c1", side: "left" }, { seq: 2, type: "swipe", card: "c1", undo: true }]);
  assert.deepEqual(undone.answers, {});
});
