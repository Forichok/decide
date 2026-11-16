/**
 * Feature:    decide-core-round-state
 * Layer:      Core unit (pure functions, no disk, no server)
 * Contract:   lib/store/state.mjs
 * Covers:
 *   - the last draft event is the draft; uploads keep their paths
 *   - swipe events rebuild answers, the log, undo, batches, "dig deeper" and push as 2.1 did
 *   - ask then reply is one dialog entry; a reply with no ask starts an entry the agent has seen
 *   - sent / imported answer the round, cancelled cancels it, dismissed ends it without an item
 *   - acked hides outbox items up to its seq; a waiter without events gets only final and cancel items
 *   - events after the end are ignored, except acked; an unknown type is ignored but advances lastSeq
 *   - replay is deterministic and apply never changes the state it is given
 * Why exists: the server is only a replay of these logs; a replay that drifts from 2.1 loses answers.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import "./helpers.mjs"; // a scratch DECIDE_HOME for a test that names none
import { fileURLToPath } from "node:url";

const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const S = await import(path.join(toolDir, "lib/store/state.mjs"));
const { normalizeDeck, normalizePatch } = await import(path.join(toolDir, "lib/swipe.mjs"));
const { EVENTS, apply, replay, pendingItems } = S;

// Events as the log writes them: seq from 1, an ISO `at` one second apart.
function logOf() {
  let seq = 0;
  return (type, data = {}) => ({ seq: ++seq, at: new Date(Date.UTC(2026, 10, 15, 10, 0, seq)).toISOString(), type, ...data });
}

const questionsMeta = { format: 3, id: "1-abc123", mode: "questions", title: "Pick a layout" };
const questionsSpec = { title: "Pick a layout", questions: [{ id: "layout", title: "Which layout?" }] };
const result = (extra = {}) => ({ version: 2, round: "1-abc123", title: "Pick a layout", submittedAt: "2026-11-15T10:05:00.000Z", answers: { layout: "a" }, digest: "d", ...extra });

// Drops every `at`, for comparing with values recorded from 2.1.
const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === "at" ? undefined : v)));

test("EVENTS lists the twenty-two event types", () => {
  assert.deepEqual(EVENTS, ["opened", "draft", "answer", "note", "flag", "upload", "ask", "reply", "swipe", "push", "deeper", "batch", "request", "acked", "sent", "cancelled", "dismissed", "imported", "patch", "restore", "keep", "words", "seen"]);
});

test("draft events: the last one is the draft", () => {
  const ev = logOf();
  const events = [
    ev("opened"),
    ev("draft", { draft: { answers: { layout: { selected: ["a"] } } } }),
    ev("upload", { path: path.join("rounds", "1-abc123", "files", "x.png"), name: "x.png", size: 3, mime: "image/png" }),
    ev("draft", { draft: { answers: { layout: { selected: ["b"] } } } }),
  ];
  const state = replay(questionsMeta, questionsSpec, events);
  assert.deepEqual(state.draft, { answers: { layout: { selected: ["b"] } } });
  assert.deepEqual(state.uploads, [path.join("rounds", "1-abc123", "files", "x.png")]);
  assert.deepEqual([state.id, state.mode, state.title, state.status, state.swipe, state.lastSeq, state.acked, state.result], ["1-abc123", "questions", "Pick a layout", "pending", null, 4, 0, null]);
  assert.deepEqual(state.outbox, []);
});

// The expected values below were produced once by feeding the same sequence to 2.1's
// createRounds().swipeAnswer / wait / deeper / push (lib/rounds.mjs at f62a924) in a
// scratch script. Timestamps differ by construction (2.1 read the clock, 3.0 takes the
// event's `at`), so `at` is stripped before comparing.
test("swipe events rebuild answers, the log and undo", () => {
  const card = (id) => ({ id, title: `Q ${id}?`, why: "w", left: { label: `${id}-L` }, right: { label: `${id}-R` }, recommended: "left" });
  const { deck } = normalizeDeck({ title: "Deck", goal: "g", batch: 3, cards: ["c1", "c2", "c3", "c4", "c5", "c6"].map(card) });
  const meta = { format: 3, id: "2-def456", mode: "swipe", title: "Deck" };
  const ev = logOf();
  const events = [ev("opened")];
  let state = replay(meta, deck, events);
  const add = (type, data) => {
    const e = ev(type, data);
    events.push(e);
    state = apply(state, e);
    return e;
  };
  const sw = (input) => add("swipe", S.swipePayload(state, input));
  const item = () => {
    const { event, round, ...rest } = state.outbox.at(-1).payload;
    assert.equal(round, "2-def456");
    return { event, ...rest };
  };

  // What the store refuses before it writes anything.
  assert.throws(() => S.swipePayload(state, { card: "nope", side: "left" }), { status: 400 });
  assert.throws(() => S.swipePayload(state, { card: "c1", side: "up" }), { status: 400 });
  assert.throws(() => S.swipePayload(state, { card: "c1", side: "own", text: "   " }), { status: 400 });
  assert.throws(() => S.swipePayload(state, { card: "c1", undo: true }), { status: 400 });
  assert.throws(() => S.swipePayload(state, { card: "c1", side: "left", rev: 2 }), { status: 412 });

  sw({ card: "c1", side: "left", ms: 1000 });
  sw({ card: "c2", side: "right", ms: 10_000_000 });
  sw({ card: "c2", undo: true });
  assert.equal(S.frontCard(state), "c2", "a card taken back comes to the front");
  sw({ card: "c2", side: "own", text: "  mine,\n really " });
  assert.equal(S.batchReady(state), false);
  sw({ card: "c3", side: "skip" });
  assert.equal(S.batchReady(state), true);
  add("batch", S.batchPayload(state));
  assert.equal(S.batchReady(state), false);
  assert.deepEqual(item(), {
    event: "batch",
    batch: 1,
    entries: [
      { card: "c1", side: "left", undo: false },
      { card: "c2", side: "own", text: "mine,\n really", hesitated: true, undo: false },
      { card: "c3", side: "skip", undo: false },
    ],
    digest: "1. [c1] Q c1? → c1-L (left) ★\n2. [c2] Q c2? → their own answer, neither side: «mine, / really» — not sure or hesitated\n3. [c3] Q c3? → skipped",
    stats: { total: 6, answered: 3, left: 3, skipped: 1 },
    done: false,
    confidence: 0,
  });

  sw({ card: "c1", undo: true });
  assert.equal(state.swipe.pinned, "c1");
  sw({ card: "c4", side: "left" });
  sw({ card: "c4", side: "right" });
  add("deeper", S.deeperPayload(state, "  Dig into pricing  "));
  assert.deepEqual(item(), {
    event: "deeper",
    deeper: 1,
    note: "Dig into pricing",
    entries: [
      { card: "c1", side: null, undo: true },
      { card: "c4", side: "right", undo: false },
    ],
    digest: "1. [c1] Q c1? → taken back (the card is open again)\n2. [c4] Q c4? → c4-R (right) (against the recommendation)",
    stats: { total: 6, answered: 3, left: 3, skipped: 1 },
    confidence: 0,
  });
  assert.deepEqual([state.swipe.digging, state.swipe.thinking, state.swipe.deck.done], [true, true, false]);

  const { patch } = normalizePatch({ add: [card("c7")], position: "next", brief: ["Point one"], confidence: 40 });
  const outcome = S.patchDeck(state, patch);
  assert.deepEqual([outcome.issues, outcome.added], [[], 1]);
  add("push", { patch });
  sw({ card: "c1", side: "right" });
  const last = sw({ card: "c7", side: "left" });
  assert.deepEqual(strip(S.swipeView(state)), {
    answers: { c2: { side: "own", text: "mine,\n really", hesitated: true }, c3: { side: "skip" }, c4: { side: "right" }, c1: { side: "right", hesitated: true }, c7: { side: "left" } },
    fresh: ["c1", "c7"],
    thinking: false,
    digging: false,
    deeper: 1,
    batches: 1,
  });
  assert.equal(state.swipe.answers.c7.at, Date.parse(last.at), "an answer's time is its event's, in ms as the page sorts it");
  assert.equal(S.batchReady(state), true, "two cards left: one early batch");
  add("batch", S.batchPayload(state));
  assert.deepEqual(item(), {
    event: "batch",
    batch: 2,
    entries: [
      { card: "c1", side: "right", hesitated: true, undo: false },
      { card: "c7", side: "left", undo: false },
    ],
    digest: "1. [c1] Q c1? → c1-R (right) (against the recommendation) — not sure or hesitated\n2. [c7] Q c7? → c7-L (left) ★",
    stats: { total: 7, answered: 5, left: 2, skipped: 1 },
    done: false,
    confidence: 40,
  });

  const s = state.swipe;
  assert.deepEqual(strip({ answers: s.answers, log: s.log }), {
    answers: { c2: { side: "own", text: "mine,\n really", hesitated: true }, c3: { side: "skip" }, c4: { side: "right" }, c1: { side: "right", hesitated: true }, c7: { side: "left" } },
    log: [
      { card: "c1", side: "left" },
      { card: "c2", side: "right", hesitated: true },
      { card: "c2", undo: true },
      { card: "c2", side: "own", text: "mine,\n really", hesitated: true },
      { card: "c3", side: "skip" },
      { card: "c1", undo: true },
      { card: "c4", side: "left" },
      { card: "c4", side: "right" },
      { card: "c1", side: "right", hesitated: true },
      { card: "c7", side: "left" },
    ],
  });
  assert.deepEqual(
    { sent: s.sent, seen: s.seen, batches: s.batches, briefAt: s.briefAt, pinned: s.pinned, lowSent: s.lowSent, digging: s.digging, thinking: s.thinking, deeper: s.deeper.map((d) => d.note) },
    { sent: 10, seen: { c2: "own:mine,\n really?", c3: "skip", c4: "right", c1: "right?", c7: "left" }, batches: 2, briefAt: 8, pinned: null, lowSent: true, digging: false, thinking: true, deeper: ["Dig into pricing"] },
  );
  assert.deepEqual(s.deck.cards.map((c) => c.id), ["c1", "c7", "c2", "c3", "c4", "c5", "c6"]);
  assert.equal(S.frontCard(state), "c5");
  assert.deepEqual(S.pendingEntries(state), []);
  assert.deepEqual(state.outbox.map((i) => [i.seq, i.kind]), [[7, "batch"], [11, "deeper"], [15, "batch"]], "an item's seq is its event's");
  assert.deepEqual(replay(meta, deck, events), state, "replaying the log gives the same state");
});

test("ask then reply: one dialog entry with both", () => {
  const ev = logOf();
  const opened = ev("opened");
  const ask = ev("ask", { id: "a1b2c3", qid: "layout", title: "Which layout?", text: "why this one?" });
  const reply = ev("reply", { id: "ffffff", qid: "layout", text: "Because.", media: { images: [{ src: "/tmp/x.png", local: true }] } });
  const state = replay(questionsMeta, questionsSpec, [opened, ask, reply]);
  assert.equal(state.dialog.length, 1);
  const [entry] = S.publicDialog(state);
  assert.deepEqual(entry, {
    id: "a1b2c3",
    qid: "layout",
    ask: "why this one?",
    askedAt: Date.parse(ask.at),
    reply: { text: "Because.", images: [{ src: "/tmp/x.png", local: true }] },
    repliedAt: Date.parse(reply.at),
    seen: false,
  });
  assert.deepEqual(state.outbox, [{ seq: 2, kind: "ask", payload: { event: "ask", round: "1-abc123", ask: { id: "a1b2c3", question: "layout", title: "Which layout?", text: "why this one?" } } }]);
  assert.equal(S.dialogEntry(state, { askId: "a1b2c3" }).id, "a1b2c3");
  assert.equal(S.dialogEntry(state, { qid: "layout" }), null, "the only ask on layout is answered");

  // The agent explains on its own: a new entry, seen from the start; an ask is seen once acked.
  const own = apply(state, ev("reply", { id: "eeeeee", qid: "layout", askId: "nope", text: "More." }));
  assert.deepEqual(S.publicDialog(own).map((d) => [d.id, d.ask, d.reply.text, d.seen]), [["a1b2c3", "why this one?", "Because.", false], ["eeeeee", "", "More.", true]]);
  const acked = apply(own, ev("acked", { upTo: 2, waiter: "w1" }));
  assert.equal(S.publicDialog(acked)[0].seen, true);
});

test("sent makes the round answered and adds a final item", () => {
  const ev = logOf();
  const r = result();
  const state = replay(questionsMeta, questionsSpec, [ev("opened"), ev("draft", { draft: { a: 1 } }), ev("sent", { result: r })]);
  assert.equal(state.status, "answered");
  assert.deepEqual(state.result, r);
  assert.deepEqual(state.outbox, [{ seq: 3, kind: "final", payload: r }]);

  const imported = replay(questionsMeta, questionsSpec, [ev("imported", { result: r })]);
  assert.deepEqual([imported.status, imported.outbox[0].kind], ["answered", "final"]);
  const cancelled = replay(questionsMeta, questionsSpec, [ev("cancelled", { result: { ...r, cancelled: true } })]);
  assert.deepEqual([cancelled.status, cancelled.outbox[0].kind, cancelled.result.cancelled], ["cancelled", "cancel", true]);
  const dismissed = replay(questionsMeta, questionsSpec, [ev("dismissed", {})]);
  assert.deepEqual([dismissed.status, dismissed.outbox, dismissed.result], ["dismissed", [], null]);
});

test("acked hides items up to its seq and nothing after", () => {
  const ev = logOf();
  const events = [
    ev("opened"),
    ev("ask", { id: "a1", qid: "layout", title: "Which layout?", text: "one" }),
    ev("ask", { id: "a2", qid: "layout", title: "Which layout?", text: "two" }),
    ev("acked", { upTo: 2, waiter: "w1" }),
    ev("ask", { id: "a3", qid: "layout", title: "Which layout?", text: "three" }),
    ev("sent", { result: result() }),
  ];
  const open = replay(questionsMeta, questionsSpec, events.slice(0, 5));
  assert.equal(open.acked, 2);
  assert.deepEqual(pendingItems(open, { events: true }).map((i) => i.seq), [3, 5]);
  assert.deepEqual(pendingItems(open, { events: false }), [], "asks only go to a waiter that takes events");

  // A finished round hands out only its final item: 2.1's wait returned the result at once and
  // dropped asks nobody collected (an agent that got one would explain into a closed round).
  const state = replay(questionsMeta, questionsSpec, events);
  for (const takes of [true, false]) assert.deepEqual(pendingItems(state, { events: takes }).map((i) => [i.seq, i.kind]), [[6, "final"]]);
  const later = apply(state, ev("acked", { upTo: 6, waiter: "w2" }));
  assert.deepEqual(pendingItems(later, { events: true }), []);
  assert.equal(apply(later, ev("acked", { upTo: 3, waiter: "w1" })).acked, 6, "an older ack does not bring items back");

  const cancel = ev("cancelled", { result: { cancelled: true } });
  const cancelled = replay(questionsMeta, questionsSpec, [...events.slice(0, 5), cancel]);
  for (const takes of [true, false]) assert.deepEqual(pendingItems(cancelled, { events: takes }).map((i) => [i.seq, i.kind]), [[cancel.seq, "cancel"]]);
  const dismissed = replay(questionsMeta, questionsSpec, [...events.slice(0, 5), ev("dismissed", {})]);
  for (const takes of [true, false]) assert.deepEqual(pendingItems(dismissed, { events: takes }), [], "a dismissed round has nothing for the agent");
});

test("events after the end are ignored, except acked", () => {
  const ev = logOf();
  const state = replay(questionsMeta, questionsSpec, [
    ev("opened"),
    ev("cancelled", { result: { cancelled: true } }),
    ev("draft", { draft: { late: true } }),
    ev("sent", { result: result() }),
    ev("acked", { upTo: 2, waiter: "w1" }),
  ]);
  assert.deepEqual([state.status, state.draft, state.outbox.length, state.acked, state.lastSeq], ["cancelled", null, 1, 2, 5]);
});

test("an unknown event type is ignored, not fatal", () => {
  const ev = logOf();
  const before = replay(questionsMeta, questionsSpec, [ev("opened"), ev("draft", { draft: { a: 1 } })]);
  const after = apply(before, ev("annotate", { anything: true }));
  assert.equal(after.lastSeq, 3);
  assert.deepEqual({ ...after, lastSeq: 2 }, before);
});

test("replay is deterministic", () => {
  const card = (id) => ({ id, title: `${id}?`, why: "w", left: "a", right: "b" });
  const { deck } = normalizeDeck({ title: "D", goal: "g", batch: 2, cards: ["x", "y", "z"].map(card) });
  const meta = { format: 3, id: "3-aaaaaa", mode: "swipe", title: "D" };
  const ev = logOf();
  const events = [
    ev("opened"),
    ev("swipe", { card: "x", side: "left" }),
    ev("ask", { id: "q1", qid: "y", title: "y?", text: "what?" }),
    ev("swipe", { card: "y", side: "own", text: "mine", hesitated: true }),
    ev("batch", { batch: 1, entries: [], digest: "", stats: {}, done: false, confidence: 0 }),
    ev("deeper", { note: "more", deeper: 1, entries: [], digest: "", stats: {}, confidence: 0 }),
    ev("acked", { upTo: 5, waiter: "w" }),
    ev("sent", { result: { done: true } }),
  ];
  const a = replay(meta, deck, events);
  assert.deepEqual(a, replay(meta, deck, events));
  assert.deepEqual(a, replay(meta, deck, events.slice()));

  // apply leaves the state it is given as it was.
  const mid = replay(meta, deck, events.slice(0, 4));
  const frozen = structuredClone(mid);
  for (const e of events.slice(4)) apply(mid, e);
  apply(mid, ev("swipe", { card: "z", undo: false, side: "right" }));
  apply(mid, ev("push", { patch: normalizePatch({ add: [card("w")] }).patch }));
  assert.deepEqual(mid, frozen);
});
