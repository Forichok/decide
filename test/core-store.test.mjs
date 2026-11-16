/**
 * Feature:    decide-core-round-store
 * Layer:      Core integration (round directories on disk, no server)
 * Contract:   lib/store/rounds.mjs
 * Covers:
 *   - a second store on the same home replays every open round: draft, dialog, deck position, answers
 *   - finish appends `sent`, then writes answers.json in the round dir and next to the spec file
 *   - a spec directory that is gone does not stop the round from being sent: the result carries a warning
 *   - no sweep: a round nobody waited on for a week is still pending
 *   - dismiss keeps what was answered and ends the round
 *   - a failed append throws 507 and changes nothing (memory, files, callbacks)
 *   - a round killed between `sent` and answers.json gets the file on load
 *   - delivery: a batch is cut only when a waiter that takes events is there; `thinking` ends when
 *     such a waiter finds nothing; a newer waiter supersedes the held one; a finished round answers
 *     any waiter at once; delivery never changes the state it hands out
 *   - load skips a round with a broken meta.json with one line, ids count up per project from disk
 * Why exists: 3.0 rounds survive the server; a store that drifts from its log loses answers.
 */

import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "./helpers.mjs"; // a scratch DECIDE_HOME for a test that names none
import { fileURLToPath } from "node:url";

const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createStore, roundDir } = await import(path.join(toolDir, "lib/store/rounds.mjs"));
const { createRoots } = await import(path.join(toolDir, "lib/assets.mjs"));
const { openProject } = await import(path.join(toolDir, "lib/project.mjs"));
const { answersPathFor, prepareSpec } = await import(path.join(toolDir, "lib/prepare.mjs"));
const { normalizeDeck, normalizePatch } = await import(path.join(toolDir, "lib/swipe.mjs"));
const { frontCard } = await import(path.join(toolDir, "lib/store/state.mjs"));

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const types = (dir) =>
  readFileSync(path.join(dir, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).type);

const card = (id) => ({ id, title: `Q ${id}?`, why: "w", left: { label: `${id}-L` }, right: { label: `${id}-R` }, recommended: "left" });

// A scratch project whose DECIDE_HOME is inside it, a questions spec file with one local image, and a deck file.
// Every store a test opens is closed before the directory is removed (Windows cannot remove open files).
async function setup(t) {
  const dir = realFs.realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "decide-store-")));
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
  writeFileSync(path.join(specDir, "a.png"), "png");
  const raw = {
    title: "Pick a layout",
    questions: [
      { id: "layout", title: "Which layout?", options: [{ id: "today", label: "Today", images: ["a.png"] }, { id: "split", label: "Split" }] },
      { id: "colour", title: "Which colour?", options: [{ id: "red", label: "Red" }, { id: "blue", label: "Blue" }] },
    ],
  };
  const specFile = path.join(specDir, "layout.questions.json");
  writeFileSync(specFile, JSON.stringify(raw));
  const { spec, errors } = await prepareSpec(raw, { specDir, dataDir: project.dataDir, shots: false });
  assert.deepEqual(errors, []);
  const deckRaw = { title: "Deck", goal: "g", batch: 2, cards: ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"].map(card) };
  const deckFile = path.join(specDir, "deck.json");
  writeFileSync(deckFile, JSON.stringify(deckRaw));
  const { deck } = normalizeDeck(deckRaw, { specDir });
  const warnings = [];
  const calls = { change: 0, dialog: 0, deck: 0, finish: 0 };
  const on = { change: () => calls.change++, dialog: () => calls.dialog++, deck: () => calls.deck++, finish: () => calls.finish++ };
  const open = (opts = {}) => {
    const s = createStore({ home, roots: createRoots(), on, warn: (line) => warnings.push(line), ...opts });
    stores.push(s);
    return s;
  };
  return {
    dir,
    home,
    project,
    specDir,
    specFile,
    deckFile,
    open,
    stores,
    warnings,
    calls,
    roundArgs: { project, spec, raw, outPath: answersPathFor(specFile), source: "layout.questions.json", specFile, live: true, mode: "questions" },
    swipeArgs: { project, spec: deck, raw: deckRaw, outPath: answersPathFor(deckFile), source: "deck.json", specFile: deckFile, live: true, mode: "swipe" },
  };
}

test("a second store on the same home sees the open round as it was", async (t) => {
  const { home, roundArgs, stores } = await setup(t);
  const roots = createRoots();
  const a = createStore({ home, roots });
  stores.push(a);
  const r = a.create(roundArgs);
  a.saveDraft(r, { answers: { layout: { selected: ["today"] } } });
  a.ask(r, { qid: "layout", text: "why?" });
  const b = createStore({ home, roots: createRoots() });
  stores.push(b);
  assert.equal(b.load(), 1);
  assert.deepEqual(b.get(r.id).draft, a.get(r.id).draft);
  assert.equal(b.get(r.id).dialog.length, 1);

  // spec.json keeps local paths; each store hands the page its own served URL.
  const dir = roundDir(roundArgs.project.dataDir, r.id);
  assert.deepEqual(readdirSync(dir).sort(), ["events.jsonl", "meta.json", "raw.json", "spec.json"]);
  const onDisk = readJson(path.join(dir, "spec.json")).questions[0].options[0].images[0];
  assert.equal(onDisk.local, true);
  assert.equal(path.isAbsolute(onDisk.src), true);
  assert.match(b.get(r.id).spec.questions[0].options[0].images[0].src, /^\/r\/[0-9a-f]{8}\/a\.png$/);
  const meta = readJson(path.join(dir, "meta.json"));
  assert.equal(meta.format, 3);
  assert.equal(meta.id, r.id);
  assert.equal(meta.project, roundArgs.project.root);
  assert.deepEqual(b.get(r.id).state, a.get(r.id).state);
  assert.equal(b.summary().rounds[0].project, roundArgs.project.root);
});

test("a swipe round restores its position and answers", async (t) => {
  const { swipeArgs, specDir, open } = await setup(t);
  const a = open();
  const r = a.create(swipeArgs);
  a.swipeAnswer(r, { card: "c1", side: "left" });
  a.swipeAnswer(r, { card: "c2", side: "own", text: "  neither  " });
  const { patch } = normalizePatch({ add: [card("c9")], brief: [{ kind: "decision", text: "left for c1" }] }, { specDir });
  a.push(r, patch);
  a.swipeAnswer(r, { card: "c3", side: "right" });
  a.swipeAnswer(r, { card: "c3", undo: true });
  const b = open();
  assert.equal(b.load(), 1);
  const back = b.get(r.id);
  assert.deepEqual(back.state, a.get(r.id).state);
  assert.equal(frontCard(back.state), "c3");
  assert.deepEqual(Object.keys(b.swipeView(back).answers), ["c1", "c2"]);
  assert.equal(b.swipeView(back).answers.c2.text, "neither");
  assert.equal(back.spec.cards.length, 9);
  assert.deepEqual(back.spec.brief, a.get(r.id).spec.brief);
  assert.deepEqual(b.swipeView(back), a.swipeView(a.get(r.id)));
});

test("finish writes answers.json in the round dir and next to the spec file", async (t) => {
  const { roundArgs, swipeArgs, specDir, open, calls } = await setup(t);
  const s = open();
  const r = s.create(roundArgs);
  s.saveDraft(r, { answers: { layout: { selected: ["today"] } } });
  const result = s.finish(r, { answers: { layout: { selected: ["today"] } }, comment: "ok" });
  assert.equal(result.round, r.id);
  assert.equal(result.version, 2);
  assert.equal(result.comment, "ok");
  assert.match(result.digest, /\[layout\]/);
  assert.equal(result.warning, undefined);
  const inRound = path.join(roundDir(roundArgs.project.dataDir, r.id), "answers.json");
  assert.deepEqual(readJson(inRound), result);
  assert.deepEqual(readJson(roundArgs.outPath), result);
  assert.deepEqual(types(roundDir(roundArgs.project.dataDir, r.id)), ["opened", "draft", "sent"]);
  assert.equal(r.status, "answered");
  assert.equal(calls.finish, 1);
  // 2.1's side files are gone: no draft file, no files dir next to the spec.
  assert.deepEqual(readdirSync(specDir).sort(), ["a.png", "deck.json", "layout.answers.json", "layout.questions.json"]);
  // A second finish changes nothing.
  assert.deepEqual(s.finish(r, { answers: {} }), result);
  // The agent gets the result and where it was saved.
  const item = await s.next(r, { waiter: "w1" });
  assert.equal(item.kind, "final");
  assert.equal(item.payload.file, roundArgs.outPath);
  assert.equal(item.payload.round, r.id);

  // A swipe round also writes its brief next to the answers.
  const w = s.create(swipeArgs);
  s.swipeAnswer(w, { card: "c1", side: "left" });
  const swiped = s.finish(w, { note: "  done  " });
  assert.equal(swiped.mode, "swipe");
  assert.equal(swiped.note, "done");
  assert.equal(swiped.briefFile, path.join(specDir, "deck.brief.md"));
  assert.equal(existsSync(swiped.briefFile), true);
  assert.deepEqual(readJson(swipeArgs.outPath), swiped);
  assert.equal(existsSync(path.join(roundDir(swipeArgs.project.dataDir, w.id), "brief.md")), true);
});

test("the spec file's directory is gone: the round is still sent, the result carries a warning", async (t) => {
  const { roundArgs, specDir, open } = await setup(t);
  const s = open();
  const r = s.create(roundArgs);
  rmSync(specDir, { recursive: true, force: true });
  const result = s.finish(r, { answers: { layout: { selected: ["split"] } } });
  assert.equal(r.status, "answered");
  assert.match(result.warning, /could not write/);
  assert.match(result.warning, /layout\.answers\.json/);
  const inRound = path.join(roundDir(roundArgs.project.dataDir, r.id), "answers.json");
  const { warning, ...saved } = result;
  assert.deepEqual(readJson(inRound), saved);
  assert.equal(existsSync(specDir), false, "the store does not recreate the user's directory");
  const item = await s.next(r, { waiter: "w1" });
  assert.equal(item.payload.file, inRound);
  assert.equal(item.payload.warning, warning);
});

test("a round with no waiter for a week is still pending", async (t) => {
  const { roundArgs, open } = await setup(t);
  let clock = Date.parse("2026-11-15T10:00:00Z");
  const s = open({ now: () => clock });
  const r = s.create(roundArgs);
  clock += 7 * 24 * 3600_000;
  assert.equal(typeof s.sweep, "undefined");
  assert.equal(r.status, "pending");
  assert.deepEqual(s.pending().map((x) => x.id), [r.id]);
  const [row] = s.summary().rounds;
  assert.equal(row.id, r.id);
  assert.equal(row.listening, false);
  assert.equal(row.waiting, false);
  const later = open({ now: () => clock });
  assert.equal(later.load(), 1);
  assert.equal(later.get(r.id).status, "pending");
});

test("dismiss keeps what was answered and ends the round", async (t) => {
  const { roundArgs, swipeArgs, open, calls } = await setup(t);
  const s = open();
  const r = s.create(roundArgs);
  s.saveDraft(r, { answers: { layout: { selected: ["today"] } }, comment: "half" });
  const result = s.dismiss(r);
  assert.equal(r.status, "dismissed");
  assert.equal(result.dismissed, true);
  assert.deepEqual(result.answers, { layout: { selected: ["today"] } });
  assert.equal(result.comment, "half");
  assert.match(result.digest, /\[layout\]/);
  assert.deepEqual(s.pending(), []);
  assert.equal(calls.finish, 0, "a dismissed round is not a decision for the journal");
  assert.deepEqual(s.dismiss(r), result);
  assert.deepEqual(s.finish(r, { answers: {} }), result);
  assert.throws(() => s.saveDraft(r, {}), { status: 409 });
  assert.equal(existsSync(roundArgs.outPath), false);

  const w = s.create(swipeArgs);
  s.swipeAnswer(w, { card: "c1", side: "right" });
  const swiped = s.dismiss(w);
  assert.equal(swiped.dismissed, true);
  assert.deepEqual(Object.keys(swiped.answers), ["c1"]);

  // Nothing is owed to an agent, so a restart leaves both on disk and out of memory until asked for.
  const later = open();
  assert.equal(later.load(), 0);
  assert.deepEqual(later.get(r.id).result, result);
  assert.equal(later.get(r.id).status, "dismissed");
});

const enospc = () => Object.assign(new Error("injected: no space"), { code: "ENOSPC" });

test("an append that fails leaves the round unchanged and throws 507", async (t) => {
  const { roundArgs, swipeArgs, open, calls } = await setup(t);
  let boom = false;
  const logFs = {
    ...realFs,
    writeSync(...args) {
      if (boom) throw enospc();
      return realFs.writeSync(...args);
    },
  };
  const s = open({ logFs });
  const r = s.create(roundArgs);
  const w = s.create(swipeArgs);
  s.saveDraft(r, { answers: { layout: { selected: ["today"] } } });
  const dir = roundDir(roundArgs.project.dataDir, r.id);
  const wdir = roundDir(swipeArgs.project.dataDir, w.id);
  const before = { r: r.state, w: w.state, log: readFileSync(path.join(dir, "events.jsonl")), wlog: readFileSync(path.join(wdir, "events.jsonl")), calls: { ...calls } };

  boom = true;
  const refused = [
    () => s.saveDraft(r, { answers: {} }),
    () => s.saveUpload(r, "x.png", "image/png", Buffer.from("png")),
    () => s.ask(r, { qid: "layout", text: "why?" }),
    () => s.explain(r, { qid: "colour", text: "because" }),
    () => s.finish(r, { answers: {} }),
    () => s.dismiss(r),
    () => s.swipeAnswer(w, { card: "c1", side: "left" }),
    () => s.deeper(w, { note: "more" }),
    () => s.push(w, normalizePatch({ add: [card("c9")] }, {}).patch),
  ];
  for (const fn of refused) assert.throws(fn, { status: 507 });
  assert.equal(r.state, before.r);
  assert.equal(w.state, before.w);
  assert.equal(r.status, "pending");
  assert.deepEqual(readFileSync(path.join(dir, "events.jsonl")), before.log);
  assert.deepEqual(readFileSync(path.join(wdir, "events.jsonl")), before.wlog);
  assert.deepEqual(calls, before.calls);
  assert.equal(existsSync(path.join(dir, "answers.json")), false);
  assert.equal(existsSync(roundArgs.outPath), false);
  assert.equal(existsSync(path.join(dir, "files")), false, "the upload and its directory are removed again");
  assert.equal(existsSync(path.join(dir, "brief.md")), false);

  // The disk comes back: the next action is saved with the next sequence number.
  boom = false;
  s.saveDraft(r, { answers: { layout: { selected: ["split"] } } });
  assert.deepEqual(r.draft, { answers: { layout: { selected: ["split"] } } });
  assert.deepEqual(types(dir), ["opened", "draft", "draft"]);
  assert.equal(r.state.lastSeq, 3);
});

test("the round directory removed under the store: 507 and nothing changed (skipped on win32: an open file blocks removing its directory)", { skip: process.platform === "win32" }, async (t) => {
  const { roundArgs, open } = await setup(t);
  const s = open();
  const r = s.create(roundArgs);
  s.saveDraft(r, { answers: { layout: { selected: ["today"] } } });
  const before = r.state;
  rmSync(roundDir(roundArgs.project.dataDir, r.id), { recursive: true, force: true });
  assert.throws(() => s.saveDraft(r, { answers: {} }), { status: 507 });
  assert.equal(r.state, before);
  assert.deepEqual(r.draft, { answers: { layout: { selected: ["today"] } } });
});

test("a round sent but killed before answers.json was written gets the file on load", async (t) => {
  const { roundArgs, open, warnings } = await setup(t);
  const s = open();
  const r = s.create(roundArgs);
  const result = s.finish(r, { answers: { layout: { selected: ["today"] } } });
  s.close();
  // What a kill right after the `sent` append leaves: the event, no files.
  const inRound = path.join(roundDir(roundArgs.project.dataDir, r.id), "answers.json");
  rmSync(inRound);
  rmSync(roundArgs.outPath);
  const later = open();
  assert.equal(later.load(), 1, "the final item was never acknowledged");
  assert.deepEqual(readJson(inRound), result);
  assert.deepEqual(readJson(roundArgs.outPath), result);
  assert.equal(later.get(r.id).status, "answered");
  assert.deepEqual((await later.next(later.get(r.id), { waiter: "w" })).payload.answers, result.answers);
  assert.deepEqual(warnings, []);
});

test("a batch is cut only when a waiter that takes events is there", async (t) => {
  const { swipeArgs, open } = await setup(t);
  const s = open();
  const r = s.create(swipeArgs);
  const dir = roundDir(swipeArgs.project.dataDir, r.id);
  // Batch size 2, nobody waiting: the answers pile up, no batch event.
  s.swipeAnswer(r, { card: "c1", side: "left" });
  s.swipeAnswer(r, { card: "c2", side: "right" });
  // A waiter for the result only does not take batches either.
  const resultOnly = s.next(r, { waiter: "cli", events: false });
  s.swipeAnswer(r, { card: "c3", side: "left" });
  assert.equal(types(dir).includes("batch"), false);
  // The agent comes: one batch with everything since the start.
  const item = await s.next(r, { waiter: "agent", events: true });
  assert.deepEqual(await resultOnly, { superseded: true });
  assert.equal(item.kind, "batch");
  assert.deepEqual(item.payload.entries.map((e) => e.card), ["c1", "c2", "c3"]);
  assert.equal(types(dir).filter((x) => x === "batch").length, 1);
  // Not acknowledged: the same item again, no new batch.
  assert.deepEqual(await s.next(r, { waiter: "agent", events: true }), item);
  s.ack(r, item.seq, "agent");
  assert.equal(types(dir).at(-1), "acked");
  s.ack(r, item.seq, "agent"); // not above the current one: ignored
  assert.equal(types(dir).filter((x) => x === "acked").length, 1);
  // A held waiter gets the batch the moment it is ready.
  const held = s.next(r, { waiter: "agent", events: true });
  s.swipeAnswer(r, { card: "c4", side: "left" });
  assert.equal(types(dir).at(-1), "swipe", "one answer is not a batch yet");
  s.swipeAnswer(r, { card: "c5", side: "skip" });
  const second = await held;
  assert.equal(second.kind, "batch");
  assert.equal(second.payload.batch, 2);
  assert.deepEqual(second.payload.entries.map((e) => e.card), ["c4", "c5"]);
});

test("thinking ends when a waiter that takes events finds nothing, and comes back with the next batch", async (t) => {
  const { swipeArgs, specDir, open, calls } = await setup(t);
  const s = open();
  const r = s.create(swipeArgs);
  s.swipeAnswer(r, { card: "c1", side: "left" });
  s.swipeAnswer(r, { card: "c2", side: "left" });
  const first = await s.next(r, { waiter: "agent", events: true });
  assert.equal(s.swipeView(r).thinking, true);
  s.ack(r, first.seq, "agent");
  // The agent came back without pushing: the page stops showing it as thinking, nothing is logged.
  const deckCalls = calls.deck;
  const held = s.next(r, { waiter: "agent", events: true });
  assert.equal(s.swipeView(r).thinking, false);
  assert.equal(r.state.swipe.thinking, true, "state is untouched");
  assert.equal(calls.deck, deckCalls + 1);
  s.swipeAnswer(r, { card: "c3", side: "left" });
  s.swipeAnswer(r, { card: "c4", side: "left" });
  const second = await held;
  assert.equal(second.kind, "batch");
  assert.equal(s.swipeView(r).thinking, true);
  // A push ends thinking in state.
  s.push(r, normalizePatch({ add: [card("c9")] }, { specDir }).patch);
  assert.equal(s.swipeView(r).thinking, false);
  // Dig deeper is logged when pressed and delivered with its note.
  s.ack(r, second.seq, "agent");
  const res = s.deeper(r, { note: " harder " });
  assert.deepEqual(res, { deeper: 1 });
  assert.equal(s.swipeView(r).thinking, true);
  assert.equal(s.swipeView(r).digging, true);
  const d = await s.next(r, { waiter: "agent", events: true });
  assert.equal(d.kind, "deeper");
  assert.equal(d.payload.note, "harder");
});

test("a newer waiter supersedes the held one; a finished round answers any waiter at once", async (t) => {
  const { roundArgs, open, calls } = await setup(t);
  const s = open();
  const r = s.create(roundArgs);
  const older = s.next(r, { waiter: "a", events: true });
  assert.equal(s.listening(r), true);
  assert.equal(s.summary().rounds[0].waiting, true);
  const newer = s.next(r, { waiter: "b", events: true });
  assert.deepEqual(await older, { superseded: true });
  const dialogCalls = calls.dialog;
  const entry = s.ask(r, { qid: "layout", text: "  why this one?  " });
  assert.equal(calls.dialog, dialogCalls + 1);
  const asked = await newer;
  assert.equal(asked.kind, "ask");
  assert.deepEqual(asked.payload.ask, { id: entry.id, question: "layout", title: "Which layout?", text: "why this one?" });
  assert.equal(s.publicDialog(r)[0].seen, false);
  s.ack(r, asked.seq, "b");
  assert.equal(s.publicDialog(r)[0].seen, true);
  assert.throws(() => s.ask(r, { qid: "nope", text: "?" }), { status: 400 });
  s.explain(r, { qid: "layout", text: "because" });
  assert.equal(s.publicDialog(r)[0].reply.text, "because");
  // A waiter without events does not get asks; it gets the result.
  const cli = s.next(r, { waiter: "cli" });
  const result = s.finish(r, { answers: { layout: { selected: ["today"] } } });
  const final = await cli;
  assert.equal(final.kind, "final");
  assert.equal(final.payload.digest, result.digest);
  assert.equal(r.delivered, false);
  // Any session, acknowledged or not, gets the final item at once.
  s.ack(r, final.seq, "cli");
  assert.equal(r.delivered, true);
  assert.equal((await s.next(r, { waiter: "other", events: true })).seq, final.seq);
  assert.equal(s.summary().history[0].delivered, true);
  // A timeout resolves null and the round stops counting as waited on.
  const w = s.create(roundArgs);
  const keep = setInterval(() => {}, 100);
  try {
    assert.equal(await s.next(w, { waiter: "x", timeoutMs: 10 }), null);
  } finally {
    clearInterval(keep);
  }
  assert.equal(s.summary().rounds.find((x) => x.id === w.id).waiting, false);
});

test("delivery never changes the state it hands out", async (t) => {
  const { roundArgs, open } = await setup(t);
  const s = open();
  const r = s.create(roundArgs);
  s.ask(r, { qid: "layout", text: "why?" });
  s.explain(r, { qid: "layout", text: "see", media: { images: [{ src: path.join(path.dirname(roundArgs.specFile), "a.png"), caption: "", local: true }] } });
  s.finish(r, { answers: { layout: { selected: ["today"] } } });
  const snapshot = structuredClone(r.state);
  const item = await s.next(r, { waiter: "w" });
  item.payload.answers.layout.selected.push("split");
  item.payload.extra = 1;
  const dialog = s.publicDialog(r);
  assert.match(dialog[0].reply.images[0].src, /^\/r\/[0-9a-f]{8}\/a\.png$/);
  dialog[0].reply.text = "changed";
  const spec = r.spec;
  spec.questions[0].title = "changed";
  assert.deepEqual(r.state, snapshot);
  assert.equal(r.state.dialog[0].reply.images[0].local, true, "state keeps the unpublished path");
  assert.equal((await s.next(r, { waiter: "w" })).payload.extra, undefined);
  assert.equal(r.spec.questions[0].title, "Which layout?");
});

test("load skips a round with a broken meta.json and says so in one line", async (t) => {
  const { roundArgs, open, warnings } = await setup(t);
  const s = open();
  const good = s.create(roundArgs);
  const bad = s.create(roundArgs);
  s.close();
  const badDir = roundDir(roundArgs.project.dataDir, bad.id);
  writeFileSync(path.join(badDir, "meta.json"), "{ not json");
  // A 2.1 inline spec in the same rounds/ directory is a file and is left alone.
  const inline = path.join(roundArgs.project.dataDir, "rounds", "20261115-100000-old.questions.json");
  writeFileSync(inline, "{}");
  const later = open();
  assert.equal(later.load(), 1);
  assert.deepEqual(later.pending().map((x) => x.id), [good.id]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], new RegExp(bad.id));
  assert.equal(later.get(bad.id), null);
  assert.equal(readFileSync(inline, "utf8"), "{}");
});

test("round ids count up per project from what is on disk", async (t) => {
  const { roundArgs, open } = await setup(t);
  const s = open();
  const one = s.create(roundArgs);
  const two = s.create(roundArgs);
  assert.match(one.id, /^1-[0-9a-f]{6}$/);
  assert.match(two.id, /^2-[0-9a-f]{6}$/);
  // A fresh store (a restarted server) continues after the highest one on disk.
  mkdirSync(path.join(roundArgs.project.dataDir, "rounds", "z-abcdef"));
  const later = open();
  assert.match(later.create(roundArgs).id, /^10-[0-9a-f]{6}$/);
  assert.equal(later.get("../../x"), null);
  assert.throws(() => later.create({ ...roundArgs, project: { ...roundArgs.project, dataDir: path.join(os.tmpdir(), "elsewhere") } }), { status: 400 });
});

test("an upload lands in the round's files directory and is logged", async (t) => {
  const { roundArgs, open } = await setup(t);
  const s = open();
  const r = s.create(roundArgs);
  const up = s.saveUpload(r, "../экран 1.png", "image/png", Buffer.from("fake-png"));
  const dir = roundDir(roundArgs.project.dataDir, r.id);
  assert.equal(path.dirname(up.path), path.join(dir, "files"));
  assert.equal(readFileSync(up.path, "utf8"), "fake-png");
  assert.match(up.url, /^\/r\/[0-9a-f]{8}\//);
  assert.equal(up.name, "экран 1.png");
  assert.equal(up.size, 8);
  assert.equal(up.type, "image/png");
  assert.deepEqual(r.state.uploads, [up.path]);
  assert.deepEqual(types(dir), ["opened", "upload"]);
});

// ---- fix round 1

const sentRound = (s, args, selected) => {
  const r = s.create(args);
  s.finish(r, { answers: { layout: { selected: [selected] } } });
  return r;
};

test("a kill between answers.json and the copy next to the spec: load writes the copy", async (t) => {
  const { roundArgs, open, warnings } = await setup(t);
  const s = open();
  const r = sentRound(s, roundArgs, "today");
  s.close();
  rmSync(roundArgs.outPath);
  const later = open();
  assert.equal(later.load(), 1);
  assert.equal(readJson(roundArgs.outPath).round, r.id);
  const item = await later.next(later.get(r.id), { waiter: "w" });
  assert.equal(item.payload.file, roundArgs.outPath);
  assert.equal(item.payload.warning, undefined);
  assert.deepEqual(warnings, []);
});

test("a previous round's copy left next to the spec is replaced on load, and never named as this round's", async (t) => {
  const { roundArgs, open } = await setup(t);
  const s = open();
  const r1 = sentRound(s, roundArgs, "today");
  s.ack(r1, (await s.next(r1, { waiter: "w" })).seq, "w");
  const r1Copy = readFileSync(roundArgs.outPath, "utf8");
  const r2 = sentRound(s, roundArgs, "split");
  // As if the copy for round 2 never happened: round 1's answers are still next to the spec.
  writeFileSync(roundArgs.outPath, r1Copy);
  const own = path.join(roundDir(roundArgs.project.dataDir, r2.id), "answers.json");
  const live = await s.next(r2, { waiter: "w" });
  assert.equal(live.payload.file, own);
  assert.match(live.payload.warning, /not this round's/);
  s.close();
  const later = open();
  assert.equal(later.load(), 1);
  assert.equal(readJson(roundArgs.outPath).round, r2.id);
  assert.equal((await later.next(later.get(r2.id), { waiter: "w" })).payload.file, roundArgs.outPath);
});

test("a newer round's copy is never overwritten by an older round, and a copy nobody can place is left alone", async (t) => {
  const { roundArgs, open } = await setup(t);
  const s = open();
  const r1 = sentRound(s, roundArgs, "today");
  const r2 = sentRound(s, roundArgs, "split");
  // Round 1 is still owed to its agent; the file next to the spec is round 2's now.
  const own1 = path.join(roundDir(roundArgs.project.dataDir, r1.id), "answers.json");
  assert.equal((await s.next(r1, { waiter: "a" })).payload.file, own1);
  s.close();
  const later = open();
  assert.equal(later.load(), 2);
  assert.equal(readJson(roundArgs.outPath).round, r2.id);
  assert.equal((await later.next(later.get(r1.id), { waiter: "a" })).payload.file, own1);
  later.close();
  // A 2.1 answers file whose round is not on disk here: which is newer cannot be told, so it stays.
  const legacy = JSON.stringify({ version: 2, round: "3-abcdef", answers: {} });
  writeFileSync(roundArgs.outPath, legacy);
  const third = open();
  assert.equal(third.load(), 2);
  assert.equal(readFileSync(roundArgs.outPath, "utf8"), legacy);
  assert.equal((await third.next(third.get(r2.id), { waiter: "b" })).payload.file, path.join(roundDir(roundArgs.project.dataDir, r2.id), "answers.json"));
});

test("a torn copy next to the spec is replaced on load", async (t) => {
  const { roundArgs, open } = await setup(t);
  const s = open();
  const r = sentRound(s, roundArgs, "today");
  s.close();
  writeFileSync(roundArgs.outPath, '{ "version": 2, "rou');
  const later = open();
  assert.equal(later.load(), 1);
  assert.equal(readJson(roundArgs.outPath).round, r.id);
  assert.equal((await later.next(later.get(r.id), { waiter: "w" })).payload.file, roundArgs.outPath);
});

test("the copy next to the spec file is replaced by rename, never rewritten in place (skipped on win32: inode numbers)", { skip: process.platform === "win32" }, async (t) => {
  const { roundArgs, specDir, open } = await setup(t);
  const s = open();
  sentRound(s, roundArgs, "today");
  const before = realFs.statSync(roundArgs.outPath).ino;
  sentRound(s, roundArgs, "split");
  assert.notEqual(realFs.statSync(roundArgs.outPath).ino, before);
  assert.deepEqual(readdirSync(specDir).filter((f) => f.endsWith(".tmp")), []);
});

test("a copy that cannot be renamed into place leaves no temp file next to the spec", async (t) => {
  const { roundArgs, specDir, open } = await setup(t);
  const s = open();
  mkdirSync(roundArgs.outPath);
  const r = s.create(roundArgs);
  const result = s.finish(r, { answers: {} });
  assert.match(result.warning, /could not write/);
  assert.deepEqual(readdirSync(specDir).filter((f) => f.endsWith(".tmp")), []);
});

test("an agent waiting on a dismissed round gets the dismissal at once", async (t) => {
  const { roundArgs, open } = await setup(t);
  const s = open();
  const r = s.create(roundArgs);
  s.saveDraft(r, { answers: { layout: { selected: ["today"] } } });
  const held = s.next(r, { waiter: "a", events: true });
  const result = s.dismiss(r);
  const dir = roundDir(roundArgs.project.dataDir, r.id);
  const seq = JSON.parse(readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").at(-1)).seq;
  const item = await held;
  assert.deepEqual(item, { seq, kind: "dismissed", payload: result });
  item.payload.answers.extra = 1;
  assert.deepEqual(await s.next(r, { waiter: "b" }), { seq, kind: "dismissed", payload: result });
  const log = readFileSync(path.join(dir, "events.jsonl"));
  s.ack(r, seq, "b");
  assert.deepEqual(readFileSync(path.join(dir, "events.jsonl")), log, "acknowledging a dismissal writes nothing");
  s.close();
  const later = open();
  assert.deepEqual(await later.next(later.get(r.id), { waiter: "c", events: true }), { seq, kind: "dismissed", payload: result });
});

test("a line the log could not roll back is applied before the next payload is built", async (t) => {
  const { swipeArgs, open } = await setup(t);
  let boom = false;
  const eio = () => Object.assign(new Error("injected"), { code: "EIO" });
  const logFs = {
    ...realFs,
    fsyncSync(fd) {
      if (boom) throw eio();
      return realFs.fsyncSync(fd);
    },
    truncateSync(file, len) {
      if (boom) throw eio(); // the rollback fails too: the line stays in the file
      return realFs.truncateSync(file, len);
    },
  };
  const s = open({ logFs });
  const r = s.create(swipeArgs);
  const dir = roundDir(swipeArgs.project.dataDir, r.id);
  s.swipeAnswer(r, { card: "c1", side: "left" });
  s.swipeAnswer(r, { card: "c2", side: "left" });
  boom = true;
  await assert.rejects(s.next(r, { waiter: "a", events: true }), { status: 507 });
  boom = false;
  assert.equal(types(dir).filter((x) => x === "batch").length, 1, "the batch line stayed on disk");
  const item = await s.next(r, { waiter: "a", events: true });
  assert.equal(item.kind, "batch");
  assert.equal(item.payload.batch, 1);
  assert.equal(types(dir).filter((x) => x === "batch").length, 1, "no second batch with the same answers");
});

test("a batch that cannot be saved for a held waiter is one warning line, and is cut on the next answer", async (t) => {
  const { swipeArgs, open, warnings } = await setup(t);
  let boom = false;
  const logFs = {
    ...realFs,
    writeSync(fd, buf, ...rest) {
      if (boom && Buffer.isBuffer(buf) && buf.includes('"type":"batch"')) throw Object.assign(new Error("injected"), { code: "ENOSPC" });
      return realFs.writeSync(fd, buf, ...rest);
    },
  };
  const s = open({ logFs });
  const r = s.create(swipeArgs);
  const held = s.next(r, { waiter: "a", events: true });
  boom = true;
  s.swipeAnswer(r, { card: "c1", side: "left" });
  s.swipeAnswer(r, { card: "c2", side: "left" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], new RegExp(`${r.id}.*batch`));
  boom = false;
  s.swipeAnswer(r, { card: "c3", side: "left" });
  const item = await held;
  assert.deepEqual(item.payload.entries.map((e) => e.card), ["c1", "c2", "c3"]);
});

test("a spec that cannot be shown is refused with 400 and leaves no round behind", async (t) => {
  const { roundArgs, open } = await setup(t);
  const s = open();
  const bad = { title: "Bad", questions: [{ id: "q", title: "Q?" }] };
  assert.throws(() => s.create({ ...roundArgs, spec: bad }), (e) => e.status === 400 && /spec/.test(e.message) && !(e instanceof TypeError));
  assert.deepEqual(s.pending(), []);
  const rounds = path.join(roundArgs.project.dataDir, "rounds");
  assert.deepEqual(existsSync(rounds) ? readdirSync(rounds) : [], []);
  assert.equal(open().load(), 0);
});

test("each project of one home numbers its own rounds", async (t) => {
  const { dir, roundArgs, open } = await setup(t);
  const otherDir = path.join(dir, "other");
  mkdirSync(otherDir);
  const other = openProject(otherDir);
  assert.notEqual(other.dataDir, roundArgs.project.dataDir);
  const s = open();
  assert.match(s.create(roundArgs).id, /^1-/);
  assert.match(s.create(roundArgs).id, /^2-/);
  assert.match(s.create({ ...roundArgs, project: other }).id, /^1-/);
  assert.match(open().create({ ...roundArgs, project: other }).id, /^2-/);
});

// ---- fix round 2

// fsync and the rollback truncate fail while `on` is set: the appended line stays in events.jsonl.
const stuckLog = () => {
  const eio = () => Object.assign(new Error("injected"), { code: "EIO" });
  const fault = { on: false };
  fault.logFs = {
    ...realFs,
    fsyncSync(fd) {
      if (fault.on) throw eio();
      return realFs.fsyncSync(fd);
    },
    truncateSync(file, len) {
      if (fault.on) throw eio();
      return realFs.truncateSync(file, len);
    },
  };
  return fault;
};

test("a send whose line could not be rolled back ends the round once when the page retries", async (t) => {
  const { roundArgs, open, calls } = await setup(t);
  const fault = stuckLog();
  const s = open({ logFs: fault.logFs });
  const r = s.create(roundArgs);
  const held = s.next(r, { waiter: "a" });
  fault.on = true;
  assert.throws(() => s.finish(r, { answers: { layout: { selected: ["today"] } } }), { status: 507 });
  fault.on = false;
  assert.equal(calls.finish, 0);
  const changes = calls.change;
  const result = s.finish(r, { answers: { layout: { selected: ["split"] } } });
  assert.deepEqual(result.answers.layout.selected, ["today"], "the line on disk is the truth");
  assert.equal(r.status, "answered");
  const own = path.join(roundDir(roundArgs.project.dataDir, r.id), "answers.json");
  assert.equal(readJson(own).round, r.id);
  assert.equal(readJson(roundArgs.outPath).round, r.id);
  assert.equal(calls.finish, 1);
  assert.ok(calls.change > changes);
  const item = await held;
  assert.equal(item.kind, "final");
  assert.equal(readJson(item.payload.file).round, r.id);
  s.finish(r, {});
  await s.next(r, { waiter: "a" });
  assert.equal(calls.finish, 1, "the end of the round runs once");
});

test("an agent that comes back after a send the log could not roll back ends the round", async (t) => {
  const { roundArgs, open, calls } = await setup(t);
  const fault = stuckLog();
  const s = open({ logFs: fault.logFs });
  const r = s.create(roundArgs);
  fault.on = true;
  assert.throws(() => s.finish(r, { answers: { layout: { selected: ["today"] } } }), { status: 507 });
  fault.on = false;
  const item = await s.next(r, { waiter: "a" });
  assert.equal(item.kind, "final");
  assert.equal(readJson(item.payload.file).round, r.id);
  assert.ok(existsSync(path.join(roundDir(roundArgs.project.dataDir, r.id), "answers.json")));
  assert.equal(calls.finish, 1);
});

test("a dismissal whose line could not be rolled back still reaches the held waiter", async (t) => {
  const { roundArgs, open, calls } = await setup(t);
  const fault = stuckLog();
  const s = open({ logFs: fault.logFs });
  const r = s.create(roundArgs);
  const held = s.next(r, { waiter: "a" });
  fault.on = true;
  assert.throws(() => s.dismiss(r), { status: 507 });
  fault.on = false;
  const result = s.dismiss(r);
  const item = await held;
  assert.equal(item.kind, "dismissed");
  assert.deepEqual(item.payload, result);
  assert.equal(calls.finish, 0, "a dismissal is not a send");
});

test("a round without a spec file whose answers.json cannot be written names no file and carries the warning", async (t) => {
  const { roundArgs, open } = await setup(t);
  const s = open();
  const r = s.create({ ...roundArgs, specFile: "", outPath: "" });
  // A directory where answers.json goes: the rename fails on every platform.
  mkdirSync(path.join(roundDir(roundArgs.project.dataDir, r.id), "answers.json"));
  const result = s.finish(r, { answers: { layout: { selected: ["today"] } } });
  assert.match(result.warning, /could not write/);
  const item = await s.next(r, { waiter: "a" });
  assert.equal(item.payload.file, undefined);
  assert.equal(item.payload.warning, result.warning);
  s.close();
  const later = open();
  const again = await later.next(later.get(r.id), { waiter: "a" });
  assert.equal(again.payload.file, undefined);
  assert.match(again.payload.warning, /answers/);
});

test("a brief that cannot be written next to the spec: delivery names the round's own brief and warns", async (t) => {
  const { swipeArgs, open } = await setup(t);
  const s = open();
  const r = s.create(swipeArgs);
  s.swipeAnswer(r, { card: "c1", side: "left" });
  const sideBrief = swipeArgs.outPath.replace(/(\.answers)?\.json$/i, "") + ".brief.md";
  mkdirSync(sideBrief);
  const result = s.finish(r, { note: "" });
  assert.equal(result.briefFile, sideBrief);
  assert.match(result.warning, /brief/);
  const dir = roundDir(swipeArgs.project.dataDir, r.id);
  const item = await s.next(r, { waiter: "a" });
  assert.equal(item.payload.briefFile, path.join(dir, "brief.md"));
  assert.ok(existsSync(item.payload.briefFile));
  assert.equal(readJson(item.payload.file).round, r.id);
  assert.match(item.payload.warning, /brief/);
});

// ---- 3.0 rounds that react: patch, restore, keep, the finish guard, ghosts in the answers file

test("a patch ghosts a question, restore brings it back, a stale answer blocks finish until kept, ghosts leave answers", async (t) => {
  const { roundArgs, open } = await setup(t);
  const views = [];
  const s = open({ on: { view: (round, view, seq) => views.push({ id: round.id, view, seq }) } });
  const r = s.create(roundArgs);
  assert.deepEqual(s.roundView(r).ghosts, []);
  s.saveDraft(r, { answers: { layout: { selected: ["today"] }, colour: { selected: ["red"] } } });

  assert.throws(() => s.patch(r, { ops: [{ ghost: ["nope"] }], reason: "x" }), (e) => e.status === 400 && /no item "nope"/.test(e.message) && e.issues.length === 1);
  const out = s.patch(r, { ops: [{ ghost: ["colour"], reason: "split has no colour" }] });
  assert.ok(Number.isInteger(out.seq));
  assert.deepEqual(out.view.ghosts, [{ id: "colour", reason: "split has no colour" }]);
  assert.equal(views.length, 1);
  assert.equal(views[0].seq, out.seq);

  const back = s.restore(r, "colour");
  assert.deepEqual(back.view.ghosts, []);
  assert.throws(() => s.keep(r, "zzz"), (e) => e.status === 400);

  s.patch(r, { ops: [{ stale: ["layout"], reason: "the options moved" }] });
  assert.deepEqual(s.roundView(r).stale, ["layout"]);
  assert.throws(() => s.finish(r, { answers: { layout: { selected: ["today"] } } }), (e) => e.status === 409 && e.stale[0].id === "layout");
  s.keep(r, "layout");
  assert.deepEqual(s.roundView(r).stale, []);

  // The user's restore beats an agent's later ghost, even with override.
  s.patch(r, { ops: [{ ghost: ["colour"], reason: "not needed" }], override: true });
  assert.deepEqual(s.roundView(r).ghosts, []);
  const result = s.finish(r, { answers: { layout: { selected: ["today"] }, colour: { selected: ["red"] } } });
  assert.deepEqual(Object.keys(result.answers), ["layout", "colour"]);
  assert.equal(result.ghosts, undefined);
  assert.deepEqual(types(roundDir(roundArgs.project.dataDir, r.id)), ["opened", "draft", "patch", "restore", "patch", "keep", "patch", "sent"]);
});

test("rules from the spec ghost a question by the answers, and a swipe round has no view", async (t) => {
  const { roundArgs, swipeArgs, open } = await setup(t);
  const s = open();
  const spec = { ...roundArgs.spec, rules: [{ when: { question: "layout", in: ["split"] }, do: [{ ghost: ["colour"] }], reason: "split has one colour" }] };
  const r = s.create({ ...roundArgs, spec });
  assert.deepEqual(s.roundView(r).ghosts, []);
  s.saveDraft(r, { answers: { layout: { selected: ["split"] } } });
  assert.deepEqual(s.roundView(r).ghosts.map((g) => g.id), ["colour"]);
  // R9: the ghost's answer is left out of answers and the file names the ghost.
  const result = s.finish(r, { answers: { layout: { selected: ["split"] }, colour: { selected: ["red"] } } });
  assert.deepEqual(Object.keys(result.answers), ["layout"]);
  assert.deepEqual(result.ghosts, [{ id: "colour", reason: "split has one colour" }]);
  const w = s.create(swipeArgs);
  assert.equal(s.roundView(w), null);
  assert.throws(() => s.patch(w, { ops: [{ ghost: ["c1"] }] }), (e) => e.status === 409);
});
