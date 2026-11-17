/**
 * Feature:    swipe rounds that react (R6) and what the user has seen
 * Layer:      Core (state replay, the store on disk, no server) and the page's seen reporter
 * Contract:   lib/store/state.mjs pushAsPatch / deckOf / deckView, lib/store/rounds.mjs push / patch / seen,
 *             ui/js/seen.js
 * Covers:
 *   - push is the swipe-shaped form of patch: replace → set, remove → remove, add next / end, brief, deck fields
 *   - removing an answered or seen card leaves a ghost the deck skips (counts, front card, answers file)
 *   - replacing an answered card makes its answer stale unless keepAnswers; keep or answering again settles it
 *   - finish is refused (409, with the list) while a deck answer is stale
 *   - patch works on a swipe round; restore brings a ghost back with its answer
 *   - seen: logged once per id, unknown ids dropped; a seen event after a patch does not turn its drop into a ghost
 *   - 2.x push events replay as they did: answered cards untouched, no ghosts
 *   - the page's reporter batches ids, skips known ones and gives failed ones back
 * Why exists: the agent steers the deck while the user answers; a card that vanished under the user, or an
 *             answer to a question that changed, would derail the interview without a word.
 */

import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "./helpers.mjs";
import { fileURLToPath } from "node:url";

const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const S = await import(path.join(toolDir, "lib/store/state.mjs"));
const { normalizeDeck, normalizePatch, deckStats } = await import(path.join(toolDir, "lib/swipe.mjs"));
const { createStore } = await import(path.join(toolDir, "lib/store/rounds.mjs"));
const { createRoots } = await import(path.join(toolDir, "lib/assets.mjs"));
const { openProject } = await import(path.join(toolDir, "lib/project.mjs"));
const { answersPathFor } = await import(path.join(toolDir, "lib/prepare.mjs"));
const { seenReporter } = await import(path.join(toolDir, "ui/js/seen.js"));

const card = (id, title = `Q ${id}?`) => ({ id, title, why: "w", left: { label: `${id}-L` }, right: { label: `${id}-R` }, recommended: "left" });
const deckRaw = { title: "Deck", goal: "g", batch: 10, cards: ["c1", "c2", "c3", "c4", "c5", "c6"].map((id) => card(id)) };
const meta = { format: 3, id: "1-abc123", mode: "swipe", title: "Deck" };

function logOf() {
  let seq = 0;
  return (type, data = {}) => ({ seq: ++seq, at: new Date(Date.UTC(2026, 10, 16, 10, 0, seq)).toISOString(), type, ...data });
}
const ids = (deck) => deck.cards.map((c) => c.id);
const push = (raw) => normalizePatch(raw).patch;

test("push becomes patch ops: replace → set, remove → remove, add behind the front card, brief and deck fields", () => {
  const { deck } = normalizeDeck(deckRaw);
  const ev = logOf();
  const state = S.replay(meta, deck, [ev("opened"), ev("swipe", { card: "c1", side: "left" })]);
  assert.equal(S.frontCard(state), "c2");
  const { patch, issues, added } = S.pushAsPatch(
    state,
    push({ add: [card("n1"), card("n2"), card("c3")], position: "next", replace: [card("c4", "New?"), card("c2", "x"), card("zz")], remove: ["c5", "c2", "nope"], brief: ["b"], confidence: 70, done: true, reason: "you said left" }),
  );
  assert.equal(added, 2);
  assert.deepEqual(
    patch.ops.map((op) => Object.keys(op)[0]),
    ["set", "remove", "add", "add", "brief"],
  );
  assert.deepEqual(patch.ops[2].add.after, "c2", "next: right behind the card on the user's screen");
  assert.deepEqual(patch.ops[3].add.after, "n1", "and the next one behind that");
  assert.deepEqual(patch.deck, { confidence: 70, done: true });
  assert.equal(patch.reason, "you said left");
  const warned = issues.map((i) => i.message).join("\n");
  assert.match(warned, /replace: "c2" is on the user's screen/);
  assert.match(warned, /remove: "c2" is on the user's screen/);
  assert.match(warned, /replace: no card "zz"/);
  assert.match(warned, /remove: no card "nope"/);
  assert.match(warned, /add: card "c3" exists/);
});

test("a removed answered card is a ghost; a replaced one goes stale unless keepAnswers; keep and a new answer settle it", () => {
  const { deck } = normalizeDeck(deckRaw);
  const ev = logOf();
  const events = [ev("opened"), ev("swipe", { card: "c1", side: "left" }), ev("swipe", { card: "c2", side: "right" }), ev("swipe", { card: "c3", side: "skip" })];
  let state = S.replay(meta, deck, events);
  const send = (raw) => {
    const { patch } = S.pushAsPatch(state, push(raw));
    const e = ev("patch", patch);
    events.push(e);
    state = S.apply(state, e);
  };
  send({ remove: ["c1"], replace: [card("c2", "Rewritten?")], reason: "the plan moved" });
  assert.deepEqual(ids(state.swipe.deck), ["c1", "c2", "c3", "c4", "c5", "c6"], "a ghost stays in place");
  assert.deepEqual(state.swipe.deck.ghosts, { c1: "the plan moved" });
  assert.deepEqual(deckStats(state.swipe.deck, state.swipe.answers), { total: 5, answered: 2, left: 3, skipped: 1 }, "the ghost leaves the counts");
  assert.equal(state.swipe.deck.cards[1].rev, 1, "a rewritten card has a new revision");
  assert.equal(state.swipe.deck.cards[1].title, "Rewritten?");
  let view = S.deckView(state);
  assert.deepEqual(view.stale, ["c2"]);
  assert.equal(view.staleReasons.c2, "the plan moved");
  assert.deepEqual(view.ghosts, [{ id: "c1", reason: "the plan moved" }]);
  assert.equal(view.answers.c1, undefined, "a ghost's answer is left out");
  assert.equal(state.swipe.answers.c1.side, "left", "and kept on disk");

  // keepAnswers: a cosmetic rewrite leaves the answer alone.
  send({ replace: [card("c3", "Reworded?")] });
  send({ replace: [{ ...card("c2", "Rewritten again?") }], keepAnswers: true });
  view = S.deckView(state);
  assert.deepEqual(view.stale, ["c2"], "an earlier mark holds; keepAnswers adds none");

  // keep settles it; a new answer settles it too.
  const keep = ev("keep", { qid: "c2" });
  state = S.apply(state, keep);
  assert.deepEqual(S.deckView(state).stale, []);
  send({ replace: [card("c2", "Third text?")] });
  assert.deepEqual(S.deckView(state).stale, ["c2"]);
  state = S.apply(state, ev("swipe", { card: "c2", undo: true }));
  state = S.apply(state, ev("swipe", { card: "c2", side: "left" }));
  assert.deepEqual(S.deckView(state).stale, []);

  // The user brings the ghost back: its answer comes with it.
  state = S.apply(state, ev("restore", { id: "c1" }));
  assert.equal(state.swipe.deck.ghosts, undefined);
  assert.deepEqual(S.deckView(state).answers.c1, { side: "left" });
  assert.equal(deckStats(state.swipe.deck, state.swipe.answers).total, 6);
});

test("an unseen open card is dropped, a seen one is a ghost; a seen event after the patch changes nothing", () => {
  const { deck } = normalizeDeck(deckRaw);
  const ev = logOf();
  let state = S.replay(meta, deck, [ev("opened"), ev("seen", { ids: ["c5"] })]);
  const { patch } = S.pushAsPatch(state, push({ remove: ["c5", "c6"], reason: "moot" }));
  state = S.apply(state, ev("patch", patch));
  assert.deepEqual(ids(state.swipe.deck), ["c1", "c2", "c3", "c4", "c5"]);
  assert.deepEqual(state.swipe.deck.ghosts, { c5: "moot" });
  state = S.apply(state, ev("seen", { ids: ["c6"] }));
  assert.deepEqual(ids(state.swipe.deck), ["c1", "c2", "c3", "c4", "c5"]);
  assert.deepEqual(S.deckView(state).seen.sort(), ["c5", "c6"]);
  // The front card skips the ghost.
  state = S.replay(meta, deck, [ev("opened"), ev("seen", { ids: ["c1"] }), ev("patch", { ops: [{ ghost: ["c1"] }], reason: "r" })]);
  assert.equal(S.frontCard(state), "c2");
});

test("new cards reopen a deck the agent called done; the deck fields ride on the patch", () => {
  const { deck } = normalizeDeck(deckRaw);
  const ev = logOf();
  let state = S.replay(meta, deck, [ev("opened")]);
  const step = (raw) => (state = S.apply(state, ev("patch", S.pushAsPatch(state, push(raw)).patch)));
  step({ done: true, confidence: 90, goal: "new goal", brief: [{ kind: "risk", text: "r" }] });
  assert.deepEqual([state.swipe.deck.done, state.swipe.deck.confidence, state.swipe.deck.goal, state.swipe.deck.brief[0].kind], [true, 90, "new goal", "risk"]);
  step({ add: [card("n1")] });
  assert.equal(state.swipe.deck.done, false);
  assert.deepEqual(ids(state.swipe.deck).at(-1), "n1");
  assert.equal(state.swipe.thinking, false);
});

test("2.x push events replay as before: answered cards untouched, no ghosts", () => {
  const { deck } = normalizeDeck(deckRaw);
  const ev = logOf();
  const state = S.replay(meta, deck, [ev("opened"), ev("swipe", { card: "c1", side: "left" }), ev("push", { patch: push({ remove: ["c1", "c6"], replace: [card("c1", "x"), card("c3", "y")] }) })]);
  assert.deepEqual(ids(state.swipe.deck), ["c1", "c2", "c3", "c4", "c5"]);
  assert.equal(state.swipe.deck.cards[0].title, "Q c1?");
  assert.equal(state.swipe.deck.cards[2].rev, 1);
  assert.equal(state.swipe.deck.ghosts, undefined);
  assert.equal(state.swipe.deck, state.swipe.base, "with no patch the deck is the 2.x deck itself");
  assert.deepEqual(S.deckView(state).stale, []);
});

// ---- the store

async function setup(t) {
  const dir = realFs.realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "decide-r6-")));
  const home = path.join(dir, ".home");
  const prevHome = process.env.DECIDE_HOME;
  process.env.DECIDE_HOME = home;
  const stores = [];
  t.after(() => {
    for (const s of stores) s.close();
    if (prevHome === undefined) delete process.env.DECIDE_HOME;
    else process.env.DECIDE_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });
  const project = openProject(dir);
  const specDir = path.join(dir, "specs");
  mkdirSync(specDir);
  const deckFile = path.join(specDir, "deck.json");
  writeFileSync(deckFile, JSON.stringify(deckRaw));
  const { deck } = normalizeDeck(deckRaw, { specDir });
  const told = { deck: 0, view: 0 };
  const open = () => {
    const s = createStore({ home, roots: createRoots(), on: { deck: () => told.deck++, view: () => told.view++ }, warn: () => {} });
    stores.push(s);
    return s;
  };
  return { open, told, args: { project, spec: deck, raw: deckRaw, outPath: answersPathFor(deckFile), source: "deck.json", specFile: deckFile, live: true, mode: "swipe" } };
}

test("store: push ghosts an answered card, a stale answer blocks finish until kept, the answers file names the ghosts", async (t) => {
  const { open, told, args } = await setup(t);
  const s = open();
  const r = s.create(args);
  s.swipeAnswer(r, { card: "c1", side: "left" });
  s.swipeAnswer(r, { card: "c2", side: "right" });
  const out = s.push(r, push({ remove: ["c1"], replace: [card("c2", "Changed?")], add: [card("n1")], reason: "you picked left" }));
  assert.equal(out.added, 1);
  assert.deepEqual(out.stats, { total: 6, answered: 1, left: 5, skipped: 0 });
  const view = s.swipeView(r).view;
  assert.deepEqual(view.ghosts, [{ id: "c1", reason: "you picked left" }]);
  assert.deepEqual(view.stale, ["c2"]);
  assert.ok(view.items.some((i) => i.id === "n1" && i.state === "new"));
  assert.ok(told.deck >= 1);

  // The page posts what it showed: c3 now; the stack (front + two behind) was logged as seen by the push.
  assert.deepEqual(s.seen(r, ["c3", "c3", "nope"]).added, 0, "c3 was in the stack when the agent pushed");
  assert.equal(s.seen(r, ["c6"]).added, 1);
  assert.equal(s.seen(r, ["c6"]).added, 0, "once per id");
  assert.throws(() => s.seen(r, "c6"), (e) => e.status === 400);

  assert.throws(() => s.finish(r, {}), (e) => e.status === 409 && e.stale.length === 1 && e.stale[0].id === "c2" && e.stale[0].reason === "you picked left");
  s.keep(r, "c2");
  assert.deepEqual(s.swipeView(r).view.stale, []);

  // A second store replays the same deck from the log.
  const b = open();
  assert.equal(b.load(), 1);
  assert.deepEqual(b.get(r.id).state, r.state, "the replay agrees: seen, patch and keep events included");
  assert.deepEqual(b.get(r.id).state.swipe.deck.ghosts, { c1: "you picked left" });

  const result = s.finish(r, {});
  assert.deepEqual(Object.keys(result.answers), ["c2"]);
  assert.deepEqual(result.ghosts, [{ id: "c1", reason: "you picked left" }]);
});

test("store: patch works on a swipe round; restore brings a ghost back; an unknown card is refused", async (t) => {
  const { open, args } = await setup(t);
  const s = open();
  const r = s.create(args);
  s.swipeAnswer(r, { card: "c1", side: "left" });
  const res = s.patch(r, { ops: [{ ghost: ["c1"] }, { add: { item: { id: "n1", title: "New?", left: "a", right: "b", why: "w" }, after: "c2" } }, { set: { id: "c3", title: "Reworded?" } }], reason: "moved on" });
  assert.deepEqual(res.view.ghosts, [{ id: "c1", reason: "moved on" }]);
  const deck = r.state.swipe.deck;
  assert.deepEqual(ids(deck), ["c1", "c2", "n1", "c3", "c4", "c5", "c6"]);
  assert.equal(deck.cards[2].left.label, "a", "an added card is normalized as a deck's");
  assert.equal(deck.cards[3].title, "Reworded?");
  assert.equal(deck.cards[3].left.label, "c3-L", "set merges into the card");
  assert.throws(() => s.patch(r, { ops: [{ add: { item: { id: "bad", title: "?", left: "a" } } }] }), (e) => e.status === 400 && /right side/.test(e.message));
  s.restore(r, "c1");
  assert.deepEqual(s.swipeView(r).view.ghosts, []);
  assert.deepEqual(r.state.swipe.answers.c1.side, "left");
  assert.throws(() => s.restore(r, "nope"), (e) => e.status === 400);
});

test("store: seen on a questions round logs once and tells the page nothing", async (t) => {
  const { open, told, args } = await setup(t);
  const s = open();
  const q = s.create({ ...args, mode: "questions", spec: { title: "Q", questions: [{ id: "a", title: "A?", options: [{ id: "x", label: "X" }] }, { id: "b", title: "B?", options: [{ id: "y", label: "Y" }] }] } });
  const before = told.view;
  assert.equal(s.seen(q, ["a", "zz"]).added, 1);
  assert.equal(told.view, before, "seen does not move the view");
  assert.deepEqual(s.roundView(q).seen, ["a"]);
  const res = s.patch(q, { ops: [{ remove: ["a", "b"] }], reason: "not needed" });
  assert.deepEqual(res.view.ghosts, [{ id: "a", reason: "not needed" }], "the seen question greys out");
  assert.deepEqual(res.view.items.map((e) => e.id), ["a"], "the unseen one is gone");
});

// ---- the page's reporter

test("seen reporter: one batch per delay, known ids skipped, a failed batch given back", async () => {
  const calls = [];
  let fail = true;
  const rep = seenReporter(
    async (ids) => {
      calls.push(ids);
      if (fail) throw new Error("offline");
    },
    { delay: 20, known: ["k"] },
  );
  rep.add("a");
  rep.add("b");
  rep.add("a");
  rep.add("k");
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(calls, [["a", "b"]]);
  fail = false;
  rep.add("a");
  rep.flush();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls.at(-1), ["a"], "a failed id is sent again");
  rep.add("a");
  rep.stop();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 2);
});

test("store: a set on a swipe card with media changes what it names and keeps the media and the answer", async (t) => {
  const { open, args } = await setup(t);
  const specDir = path.dirname(args.specFile);
  writeFileSync(path.join(specDir, "x.png"), "x");
  writeFileSync(path.join(specDir, "m.html"), "<p>x</p>");
  const raw = { ...deckRaw, cards: [{ ...card("m1"), images: ["x.png"], preview: "m.html" }, ...deckRaw.cards] };
  const { deck } = normalizeDeck(raw, { specDir });
  const s = open();
  const r = s.create({ ...args, spec: deck, raw });
  s.swipeAnswer(r, { card: "m1", side: "left" });
  const before = r.state.swipe.deck.cards.find((c) => c.id === "m1");
  const res = s.patch(r, { ops: [{ set: { id: "m1", why: "A new reason." } }], reason: "clearer" });
  const after = r.state.swipe.deck.cards.find((c) => c.id === "m1");
  assert.equal(after.why, "A new reason.");
  for (const k of ["images", "preview", "left", "right", "title"]) assert.deepEqual(after[k], before[k], k);
  assert.deepEqual(res.view.stale, [], "only the reason changed: the answer stands");
  s.patch(r, { ops: [{ set: { id: "m1", title: "Reworded?" } }] });
  assert.equal(r.state.swipe.deck.cards.find((c) => c.id === "m1").title, "Reworded?");
});
