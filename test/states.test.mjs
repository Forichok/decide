/**
 * Feature:    project-decide-states
 * Layer:      Page logic unit (pure, no DOM)
 * Contract:   ui/js/states.js + ui/js/rules.js, lib/swipe.mjs applyPatch ghosts
 * Covers:
 *   - a rule ghosts a question and removes an option from the current answers; changing the answer undoes it
 *   - the server view adds ghosts, changed/new items and stale answers
 *   - a restored ghost is shown again; a kept answer is not counted for checking until it changes
 *   - a removed option that was picked makes the answer one to check
 *   - swipe queues skip ghosts and bring answers to check back at the end
 *   - push removal of a seen card makes it a ghost
 * Why exists: the owner sees these states live; a wrong ghost or a missed stale answer lets a round go out on a doubtful answer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import "./helpers.mjs";

const { resolve, sigOf, swipeQueues } = await import("../ui/js/states.js");
const { applyPatch } = await import("../lib/swipe.mjs");

const spec = {
  questions: [
    { id: "confirm", options: [{ id: "link" }, { id: "pass" }] },
    { id: "recover", options: [{ id: "a" }] },
    { id: "store", options: [{ id: "guest-account" }, { id: "db" }] },
  ],
  rules: [
    {
      when: { question: "confirm", in: ["link"] },
      reason: "you chose sign-in without an account",
      do: [{ ghost: ["recover"] }, { removeOptions: { question: "store", options: ["guest-account"] } }],
    },
  ],
};

test("rules ghost and remove options, and undo when the answer changes", () => {
  const on = resolve(spec, { confirm: { selected: ["link"] } });
  assert.equal(on.ghosts.get("recover"), "you chose sign-in without an account");
  assert.ok(on.removed.get("store").has("guest-account"));
  const off = resolve(spec, { confirm: { selected: ["pass"] } });
  assert.equal(off.ghosts.size, 0);
});

test("a picked option that is removed makes the answer one to check; keeping it clears the mark until it changes", () => {
  const answers = { confirm: { selected: ["link"] }, store: { selected: ["guest-account"] } };
  const first = resolve(spec, answers);
  assert.ok(first.stale.has("store"));
  const kept = new Map([["store", sigOf(answers.store)]]);
  assert.equal(resolve(spec, answers, null, { kept }).stale.size, 0);
  assert.ok(resolve(spec, { ...answers, store: { selected: ["guest-account", "db"] } }, null, { kept }).stale.has("store"));
});

test("the server view adds ghosts, changed and new items, stale answers; restore brings a ghost back", () => {
  const view = {
    items: [
      { id: "recover", state: "ghost", reason: "agent: not needed" },
      { id: "store", state: "changed", reason: "options rewritten", was: "old title" },
      { id: "confirm", state: "new", reason: "" },
    ],
    stale: ["store"],
    staleReasons: { store: "text changed" },
    ghosts: [],
  };
  const answers = { store: { selected: ["db"] } };
  const st = resolve(spec, answers, view, { viewSig: new Map([["store", sigOf(answers.store)]]) });
  assert.equal(st.ghosts.get("recover"), "agent: not needed");
  assert.equal(st.items.get("store").state, "changed");
  assert.equal(st.items.get("store").was, "old title");
  assert.equal(st.items.get("confirm").state, "new");
  assert.equal(st.stale.get("store"), "text changed");
  assert.equal(resolve(spec, answers, view, { restored: new Set(["recover"]) }).ghosts.has("recover"), false);
  // Answering again clears the agent's mark.
  assert.equal(resolve(spec, { store: { selected: ["guest-account"] } }, view, { viewSig: new Map([["store", sigOf(answers.store)]]) }).stale.size, 0);
});

test("swipe queues skip ghosts and put answers to check at the end", () => {
  const deck = { cards: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] };
  const answers = { c1: { side: "left" } };
  const st = resolve(deck, answers, { ghosts: [{ id: "c2", reason: "dropped" }], stale: ["c1"] });
  const q = swipeQueues(deck, answers, st);
  assert.deepEqual(q.open.map((c) => c.id), ["c3"]);
  assert.deepEqual(q.recheck.map((c) => c.id), ["c1"]);
  assert.deepEqual(q.ghosts.map((c) => c.id), ["c2"]);
});

test("push removal of a seen open card makes it a ghost; the front card still warns", () => {
  const deck = { cards: [{ id: "a" }, { id: "b" }, { id: "c" }], brief: [] };
  const patch = { add: [], replace: [], remove: ["b", "a"], reason: "no longer needed" };
  const out = applyPatch(deck, new Set(), patch, { front: "a", seen: new Set(["b"]) });
  assert.equal(out.deck.cards.length, 3);
  assert.equal(out.deck.ghosts.b, "no longer needed");
  assert.match(out.issues.map((i) => i.message).join("|"), /"a" is on the user's screen/);
});
