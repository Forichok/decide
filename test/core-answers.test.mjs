/**
 * Feature:    answers as events (decide 3.0, milestone 2, P3)
 * Layer:      Core unit (state replay, the page's store.js with a fake net) and integration (an in-process
 *             server over loopback HTTP and its event stream, two store.js "tabs" on one round)
 * Contract:   lib/store/state.mjs (answer, note, flag), lib/store/rounds.mjs (saveAnswer, saveNote, saveFlag),
 *             lib/server.mjs (POST /api/rounds/:id/answer|note|flag, `event: round`), ui/js/store.js
 * Covers:
 *   - answer, note and flag events replay per question; null and "" clear; a 2.x draft with answers still replays
 *   - the routes answer {seq} once the event is on disk; the page's Origin or the token is needed; a bad
 *     question, a swipe round and a finished round are refused
 *   - every write reaches every page as `event: round` {round, seq, prev, patch}
 *   - two writers on one round converge and neither wipes the other; replay equals live state
 *   - store.js: a failed write is "retrying" and goes again; a refused one is final; a missed change refetches
 *   - a restart restores answers and notes (the text of an unsent question to the agent)
 * Why exists: 2.x saved the whole page as one draft, so two tabs wiped each other's answers (Review Focus 4).
 */

import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { startServer } from "../lib/server.mjs";
import { createStore as createRoundStore, roundDir } from "../lib/store/rounds.mjs";
import { createRoots } from "../lib/assets.mjs";
import { openProject } from "../lib/project.mjs";
import { apply, replay } from "../lib/store/state.mjs";
import { createStore } from "../ui/js/store.js";
import { api, findServer } from "../lib/client.mjs";
import { asPage, homeOf, scratchDir } from "./helpers.mjs";

delete process.env.DECIDE_PORT;
process.env.DECIDE_NOTIFY = "0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spec = {
  title: "Colours",
  questions: [
    { id: "color", title: "Which colour?", options: [{ id: "pink", label: "Pink" }, { id: "blue", label: "Blue" }] },
    { id: "size", title: "Which size?", options: [{ id: "s", label: "Small" }, { id: "l", label: "Large" }] },
    { id: "name", title: "What name?", type: "text", options: [] },
  ],
};

async function until(check, what, ms = 5_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

// ---- state replay

function logOf() {
  let seq = 0;
  return (type, data = {}) => ({ seq: ++seq, at: new Date(Date.UTC(2026, 10, 16, 10, 0, seq)).toISOString(), type, ...data });
}
const meta = { format: 3, id: "1-abc123", mode: "questions", title: "Colours" };

test("answer, note and flag events replay per question; null and empty text clear them", () => {
  const ev = logOf();
  const events = [
    ev("opened"),
    ev("answer", { qid: "color", answer: { selected: ["pink"] } }),
    ev("answer", { qid: "size", answer: { selected: ["s"] } }),
    ev("note", { qid: "color", text: "why pink?" }),
    ev("flag", { qid: "size", flag: "later", revisit: "after the launch" }),
    ev("answer", { qid: "color", answer: { selected: ["blue"] } }),
    ev("note", { qid: "size", text: "x" }),
    ev("note", { qid: "size", text: "" }),
    ev("flag", { qid: "name", flag: "none", note: "other names" }),
    ev("flag", { qid: "name", flag: null }),
    ev("answer", { qid: "size", answer: null }),
  ];
  const state = replay(meta, spec, events);
  assert.deepEqual(state.answers, { color: { selected: ["blue"] } });
  assert.deepEqual(state.notes, { color: "why pink?" });
  assert.deepEqual(state.flags, { size: { flag: "later", revisit: "after the launch" } });
  assert.equal(state.patchSeq, 11);
  // Applying one at a time gives the same state, and never changes the state it is given.
  let live = replay(meta, spec, []);
  for (const e of events) {
    const before = JSON.stringify(live);
    const next = apply(live, e);
    assert.equal(JSON.stringify(live), before);
    live = next;
  }
  assert.deepEqual(live, state);
});

test("a draft with every answer (a page from before 3.0) still replays, and answer events go on from it", () => {
  const ev = logOf();
  const state = replay(meta, spec, [
    ev("opened"),
    ev("draft", { draft: { answers: { color: { selected: ["pink"] }, size: { selected: ["l"] } }, comment: "c" } }),
    ev("answer", { qid: "size", answer: { selected: ["s"] } }),
    ev("draft", { draft: { comment: "only the comment" } }),
  ]);
  assert.deepEqual(state.answers, { color: { selected: ["pink"] }, size: { selected: ["s"] } }, "a draft without answers leaves them alone");
  assert.deepEqual(state.draft, { comment: "only the comment" });
});

// ---- the server

async function served(t) {
  const dir = await scratchDir(t);
  const home = homeOf(dir);
  await mkdir(home, { recursive: true });
  const started = await startServer({ home, embedded: true });
  t.after(() => started.stop());
  const port = started.port;
  const id = await createRound(port, dir, spec);
  return { dir, home, port, id, started };
}

async function createRound(port, dir, body, mode) {
  const s = await findServer(homeOf(dir));
  const base = mode === "swipe" ? "deck" : "colour";
  const { id } = await api(s, "/api/rounds", {
    method: "POST",
    body: { project: dir, spec: body, outPath: path.join(dir, `${base}.answers.json`), source: `${base}.questions.json`, open: false, live: true, ...(mode ? { mode } : {}) },
  });
  return id;
}

const pagePost = (port, route, body, headers = asPage(port)) => fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
const getRound = async (port, id) => (await fetch(`http://127.0.0.1:${port}/api/rounds/${id}`)).json();

// The page's event stream: every named event in order, with its data parsed.
function stream(t, port) {
  const seen = [];
  const listeners = new Set();
  let ready;
  const opened = new Promise((r) => (ready = r));
  const req = request({ host: "127.0.0.1", port, path: "/api/events" }, (res) => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const name = block.match(/^event: (.+)$/m)?.[1];
        const data = block.match(/^data: (.+)$/m)?.[1];
        if (!name) continue;
        const ev = { name, data: data ? JSON.parse(data) : null };
        seen.push(ev);
        if (name === "hello") ready();
        for (const fn of listeners) fn(ev);
      }
    });
  });
  req.on("error", () => {});
  req.end();
  t.after(() => req.destroy());
  return { seen, opened, on: (fn) => listeners.add(fn) };
}

test("the routes save one question each, answer {seq} once it is on disk, and every page hears it", async (t) => {
  const { dir, home, port, id } = await served(t);
  const events = stream(t, port);
  await events.opened;

  const a = await pagePost(port, `/api/rounds/${id}/answer`, { qid: "color", answer: { selected: ["pink"] } });
  assert.equal(a.status, 200);
  const { seq } = await a.json();
  const log = readFileSync(path.join(roundDir(openProject(dir, home).dataDir, id), "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(log.at(-1), { ...log.at(-1), seq, type: "answer", qid: "color", answer: { selected: ["pink"] } }, "the event is on disk when the answer comes");

  const n = await (await pagePost(port, `/api/rounds/${id}/note`, { qid: "size", text: "is large too big?" })).json();
  const f = await (await pagePost(port, `/api/rounds/${id}/flag`, { qid: "name", flag: "later", revisit: "when marketing picks", note: "n" })).json();
  assert.ok(n.seq > seq && f.seq > n.seq);

  const view = await getRound(port, id);
  assert.equal(view.seq, f.seq);
  assert.deepEqual(view.answers, { color: { selected: ["pink"] } });
  assert.deepEqual(view.notes, { size: "is large too big?" });
  assert.deepEqual(view.flags, { name: { flag: "later", revisit: "when marketing picks", note: "n" } });

  const rounds = await until(() => (events.seen.filter((e) => e.name === "round").length >= 3 ? events.seen.filter((e) => e.name === "round") : null), "three round events");
  assert.deepEqual(
    rounds.map((e) => e.data),
    [
      { round: id, seq, prev: 0, patch: { answers: { color: { selected: ["pink"] } } } },
      { round: id, seq: n.seq, prev: seq, patch: { notes: { size: "is large too big?" } } },
      { round: id, seq: f.seq, prev: n.seq, patch: { flags: { name: { flag: "later", revisit: "when marketing picks", note: "n" } } } },
    ],
  );
});

test("the routes refuse what they must: no Origin or token, another origin, a bad question or flag, a swipe or finished round", async (t) => {
  const { dir, port, id } = await served(t);
  const route = `/api/rounds/${id}/answer`;
  assert.equal((await pagePost(port, route, { qid: "color", answer: {} }, { "content-type": "application/json" })).status, 403, "neither the page's Origin nor the token");
  assert.equal((await pagePost(port, route, { qid: "color", answer: {} }, { "content-type": "application/json", origin: "http://evil.example" })).status, 403);
  assert.equal((await pagePost(port, route, { qid: "nope", answer: {} })).status, 400);
  assert.equal((await pagePost(port, route, { qid: "color", answer: [1] })).status, 400);
  assert.equal((await pagePost(port, route, { qid: "color", answer: { text: "x".repeat(300 * 1024) } })).status, 413);
  assert.equal((await pagePost(port, `/api/rounds/${id}/flag`, { qid: "color", flag: "maybe" })).status, 400);
  assert.equal((await pagePost(port, `/api/rounds/${id}/note`, { qid: "color", text: 5 })).status, 400);

  const deck = { title: "Deck", goal: "g", cards: [{ id: "c1", title: "Q?", why: "w", left: { label: "L" }, right: { label: "R" }, recommended: "left" }] };
  const swipeId = await createRound(port, dir, deck, "swipe");
  assert.equal((await pagePost(port, `/api/rounds/${swipeId}/answer`, { qid: "c1", answer: {} })).status, 409);

  assert.equal((await pagePost(port, `/api/rounds/${id}/submit`, { answers: {} })).status, 200);
  assert.equal((await pagePost(port, route, { qid: "color", answer: {} })).status, 409);
});

// ---- the page's store over Node: fetch with the page's Origin, the event stream for `round`

function nodeNet(t, port) {
  const handlers = new Map();
  const s = stream(t, port);
  s.on((ev) => {
    for (const fn of handlers.get(ev.name) || []) fn(ev.data);
  });
  const json = async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
  };
  return {
    opened: s.opened,
    getRound: (id) => fetch(`http://127.0.0.1:${port}/api/rounds/${id}`).then(json),
    postAnswer: (id, qid, answer) => pagePost(port, `/api/rounds/${id}/answer`, { qid, answer }).then(json),
    postNote: (id, qid, text) => pagePost(port, `/api/rounds/${id}/note`, { qid, text }).then(json),
    postFlag: (id, qid, flag, extra) => pagePost(port, `/api/rounds/${id}/flag`, { qid, flag, ...extra }).then(json),
    putDraft: (id, draft) => fetch(`http://127.0.0.1:${port}/api/rounds/${id}/draft`, { method: "PUT", headers: asPage(port), body: JSON.stringify(draft) }).then(json),
    onEvent(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
    },
  };
}

const settled = (stores) => until(() => stores.every((s) => s.pending() === 0 && s.status() === "saved"), "every write on disk");
const plain = (state) => JSON.parse(JSON.stringify({ answers: state.answers, notes: state.notes, flags: state.flags }));

test("two writers on one round converge and neither wipes the other; replay equals live state", async (t) => {
  const { home, port, id } = await served(t);
  const netA = nodeNet(t, port);
  const netB = nodeNet(t, port);
  await Promise.all([netA.opened, netB.opened]);
  const A = createStore(netA);
  const B = createStore(netB);
  await Promise.all([A.load(id), B.load(id)]);
  const heard = { A: new Set(), B: new Set() };
  A.subscribe(id, (_, qids) => qids.forEach((q) => heard.A.add(q)));
  B.subscribe(id, (_, qids) => qids.forEach((q) => heard.B.add(q)));

  // Different questions at once, many times over, as two people typing would.
  const writes = [];
  for (let i = 0; i < 8; i++) {
    writes.push(A.saveAnswer(id, "color", { selected: [i % 2 ? "blue" : "pink"], note: `a${i}` }));
    writes.push(B.saveAnswer(id, "size", { selected: [i % 2 ? "l" : "s"], note: `b${i}` }));
  }
  writes.push(A.saveNote(id, "name", "a question for the agent"));
  writes.push(B.saveFlag(id, "size", "later", { revisit: "after the pilot" }));
  await Promise.all(writes);
  await settled([A, B]);
  const server = plain(await getRound(port, id));
  assert.deepEqual(server.answers, { color: { selected: ["blue"], note: "a7" }, size: { selected: ["l"], note: "b7" } }, "neither page wiped the other's question");
  assert.deepEqual(server.notes, { name: "a question for the agent" });
  assert.deepEqual(server.flags, { size: { flag: "later", revisit: "after the pilot" } });
  await until(() => isDeepStrictEqual(plain(A.state(id)), server) && isDeepStrictEqual(plain(B.state(id)), server), "both pages show the server's state");
  assert.ok(heard.A.has("size") && heard.B.has("color"), "each page heard the other's question");

  // The same question at once, many times: the last write the server took wins on both pages.
  const same = [];
  for (let i = 0; i < 6; i++) {
    same.push(A.saveAnswer(id, "color", { selected: ["pink"], note: `A${i}` }));
    same.push(B.saveAnswer(id, "color", { selected: ["blue"], note: `B${i}` }));
  }
  await Promise.all(same);
  await settled([A, B]);
  const after = plain(await getRound(port, id));
  assert.match(after.answers.color.note, /^[AB]5$/, "the last write of one of the two");
  assert.deepEqual(after.answers.size, server.answers.size, "the other question is untouched");
  await until(() => isDeepStrictEqual(plain(A.state(id)), after) && isDeepStrictEqual(plain(B.state(id)), after), "both pages converge on the same question");

  // Replay from disk (what a restarted server reads) equals the live state.
  const roots = createRoots({ home });
  const fresh = createRoundStore({ home, roots, warn: () => {} });
  t.after(() => fresh.close());
  fresh.load();
  const replayed = fresh.get(id);
  assert.deepEqual(plain({ answers: replayed.answers, notes: replayed.notes, flags: replayed.flags }), after);
  assert.equal(replayed.seq, (await getRound(port, id)).seq);
});

test("a restart gives the page back every answer and the unsent question to the agent", async (t) => {
  const dir = await scratchDir(t);
  const home = homeOf(dir);
  await mkdir(home, { recursive: true });
  let started = await startServer({ home, embedded: true });
  const id = await createRound(started.port, dir, spec);
  await pagePost(started.port, `/api/rounds/${id}/answer`, { qid: "color", answer: { selected: ["blue"], other: "teal-ish" } });
  await pagePost(started.port, `/api/rounds/${id}/note`, { qid: "size", text: "half-written question" });
  started.stop();
  await sleep(100);
  started = await startServer({ home, embedded: true });
  t.after(() => started.stop());
  const view = await getRound(started.port, id);
  assert.deepEqual(view.answers, { color: { selected: ["blue"], other: "teal-ish" } });
  assert.deepEqual(view.notes, { size: "half-written question" });
});

// ---- store.js alone, with a net that fails on purpose

function fakeNet() {
  const calls = [];
  const handlers = new Map();
  let seq = 10;
  const net = {
    calls,
    fail: [],
    round: { id: "r", seq: 10, answers: { color: { selected: ["pink"] } }, notes: {}, flags: {} },
    getRound: async () => structuredClone(net.round),
    postAnswer: async (id, qid, answer) => {
      calls.push(["answer", qid, answer]);
      const f = net.fail.shift();
      if (f) throw f;
      return { seq: ++seq };
    },
    postNote: async () => ({ seq: ++seq }),
    postFlag: async () => ({ seq: ++seq }),
    onEvent: (name, fn) => handlers.set(name, fn),
    emit: (name, data) => handlers.get(name)?.(data),
  };
  return net;
}

// Timers that run when the test says so.
function manualTimers() {
  const due = [];
  return { setTimer: (fn) => (due.push(fn), due.length), clearTimer: () => {}, run: () => due.splice(0).forEach((fn) => fn()) };
}

test("store.js: a write that fails is retrying and goes again; a refused one is final", async () => {
  const net = fakeNet();
  const timers = manualTimers();
  const store = createStore(net, timers);
  await store.load("r");
  const statuses = [];
  store.onStatus((s) => statuses.push(s));
  net.fail.push(new TypeError("fetch failed"));
  const saving = store.saveAnswer("r", "color", { selected: ["blue"] });
  assert.equal(store.status(), "saving");
  await until(() => store.status() === "retrying", "retrying");
  // Typed again while offline: only the newest value goes when the retry fires.
  const newer = store.saveAnswer("r", "color", { selected: ["pink"], note: "newest" });
  timers.run();
  const [a, b] = await Promise.all([saving, newer]);
  assert.equal(a.seq, b.seq, "both promises resolve with the write that carried them");
  assert.deepEqual(statuses, ["saving", "retrying", "saved"], "it says retrying until a write lands");
  assert.deepEqual(net.calls.map((c) => c[2]), [{ selected: ["blue"] }, { selected: ["pink"], note: "newest" }]);

  net.fail.push(Object.assign(new Error("round is answered"), { status: 409 }));
  await assert.rejects(store.saveAnswer("r", "size", { selected: ["s"] }), { status: 409 });
  assert.equal(store.status(), "saved");
  assert.equal(store.pending(), 0);
});

test("store.js: a change after the page's seq applies, its own echo does not, and a missed one refetches", async () => {
  const net = fakeNet();
  const store = createStore(net);
  await store.load("r");
  const changes = [];
  store.subscribe("r", (state, qids) => changes.push([qids, structuredClone(state.answers)]));
  net.emit("round", { round: "r", seq: 9, prev: 8, patch: { answers: { color: { selected: ["blue"] } } } });
  assert.equal(changes.length, 0, "older than what the page holds");
  net.emit("round", { round: "r", seq: 11, prev: 10, patch: { answers: { size: { selected: ["l"] } } } });
  assert.deepEqual(changes.at(-1), [["size"], { color: { selected: ["pink"] }, size: { selected: ["l"] } }]);
  // Its own write: seq 12 comes back as an echo and changes nothing.
  const { seq } = await store.saveAnswer("r", "color", { selected: ["blue"] });
  net.emit("round", { round: "r", seq, prev: 11, patch: { answers: { color: { selected: ["blue"] } } } });
  assert.equal(changes.length, 1);
  // A gap: prev is after what the page holds, so the page asks for the round again.
  net.round = { id: "r", seq: 20, answers: { color: { selected: ["blue"] }, size: { selected: ["s"] } }, notes: { name: "n" }, flags: {} };
  net.emit("round", { round: "r", seq: 20, prev: 19, patch: { answers: { size: { selected: ["s"] } } } });
  await until(() => changes.length === 2, "the refetch");
  assert.deepEqual(changes[1][0].sort(), ["name", "size"]);
  assert.equal(store.state("r").seq, 20);
});
