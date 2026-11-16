/**
 * Feature:    the server may die at any moment; rounds come back
 * Layer:      Integration (real `node decide.mjs serve` processes over loopback HTTP)
 * Covers:
 *   - kill -9 mid-round and mid-deck: the restarted server serves the same round, draft, dialog and card
 *   - a save answers 200 only after its event is in events.jsonl
 *   - the idle rule: the clock runs only while no waiter is held and no page holds /api/events
 *   - GET /api/events opens with `hello` { version, protocol, startedAt }
 * Isolation:  every test has its own DECIDE_HOME; every server is stopped by its pid.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";
import test from "node:test";
import { readInfo } from "../lib/home.mjs";
import { PROTOCOL } from "../lib/protocol.mjs";
import { openProject } from "../lib/project.mjs";
import { roundDir } from "../lib/store/rounds.mjs";
import { alive, exitOf, homeOf, ping, scratchDir, spawnServer, asAgent, asPage } from "./helpers.mjs";

delete process.env.DECIDE_PORT;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (port, route) => `http://127.0.0.1:${port}${route}`;
const get = async (port, route) => (await fetch(url(port, route))).json();
// The page's side (its Origin) and the agent's (the token of the home's daemon.json).
const post = (port, route, body) => fetch(url(port, route), { method: "POST", headers: asPage(port), body: body === undefined ? undefined : JSON.stringify(body) });
const agentPost = (port, route, body) => fetch(url(port, route), { method: "POST", headers: asAgent(port), body: body === undefined ? undefined : JSON.stringify(body) });
const put = (port, route, body) => fetch(url(port, route), { method: "PUT", headers: asPage(port), body: JSON.stringify(body) });

async function until(check, what, ms = 5_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const questions = {
  title: "Pick a layout",
  questions: [
    { id: "layout", title: "Which layout?", options: [{ id: "today", label: "Today" }, { id: "split", label: "Split" }] },
    { id: "colour", title: "Which colour?", options: [{ id: "red", label: "Red" }, { id: "blue", label: "Blue" }] },
  ],
};
const card = (id) => ({ id, title: `Card ${id}?`, left: { label: `${id}-L` }, right: { label: `${id}-R` }, recommended: "left" });
const deck = { title: "Deck", goal: "g", batch: 2, cards: ["c1", "c2", "c3", "c4", "c5", "c6"].map(card) };

async function scratch(t) {
  const dir = await scratchDir(t);
  mkdirSync(homeOf(dir), { recursive: true });
  return { dir, home: homeOf(dir) };
}

async function openRound(port, dir, extra = {}) {
  const res = await agentPost(port, "/api/rounds", { project: dir, spec: questions, outPath: path.join(dir, "layout.answers.json"), source: "layout.questions.json", open: false, live: true, ...extra });
  const body = await res.json();
  assert.equal(res.status, 200, body.error);
  return body.id;
}

// An in-process server for the idle rule, which needs a short idleMs.
async function inProcess(t, options) {
  // Registered first, so it runs before the scratch dir goes; a throw from startServer still restores the variable.
  const saved = process.env.DECIDE_HOME;
  let started;
  t.after(() => {
    started?.stop();
    saved === undefined ? delete process.env.DECIDE_HOME : (process.env.DECIDE_HOME = saved);
  });
  const { dir, home } = await scratch(t);
  process.env.DECIDE_HOME = home;
  const { startServer } = await import("../lib/server.mjs");
  started = await startServer({ home, embedded: true, tickMs: 50, ...options });
  assert.ok(started);
  return { dir, home, ...started };
}

// An SSE connection the test can read and close.
function stream(t, port, query = "") {
  const seen = [];
  const req = request({ host: "127.0.0.1", port, path: `/api/events${query}` }, (res) => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const name = block.match(/^event: (.+)$/m)?.[1];
        const data = block.match(/^data: (.+)$/m)?.[1];
        if (name) seen.push({ name, data: JSON.parse(data) });
      }
    });
  });
  req.on("error", () => {});
  req.end();
  t.after(() => req.destroy());
  return { seen, close: () => req.destroy() };
}

const killed = async (s) => {
  process.kill(s.pid, "SIGKILL");
  await exitOf(s.child);
};
const SKIP = { skip: process.platform === "win32" };

test("kill -9 mid-round: the restarted server serves the same round (skipped on win32: needs SIGKILL)", SKIP, async (t) => {
  const { dir, home } = await scratch(t);
  const s1 = await spawnServer(t, home);
  const id = await openRound(s1.port, dir);
  assert.equal((await put(s1.port, `/api/rounds/${id}/draft`, { answers: { layout: { selected: ["today"] } } })).status, 200);
  assert.equal((await post(s1.port, `/api/rounds/${id}/ask`, { question: "layout", text: "why?" })).status, 200);
  await killed(s1);
  assert.equal(alive(s1.pid), false);
  const s2 = await spawnServer(t, home);
  assert.equal(s2.exited, null, s2.output.stderr);
  assert.notEqual(s2.pid, s1.pid);
  const view = await get(s2.port, `/api/rounds/${id}`);
  assert.deepEqual(view.draft.answers.layout.selected, ["today"]);
  assert.equal(view.dialog.length, 1);
  assert.equal(view.status, "pending");
  assert.equal((await get(s2.port, "/api/state")).rounds.length, 1);
});

test("kill -9 mid-deck: the swipe round resumes on the same card (skipped on win32: needs SIGKILL)", SKIP, async (t) => {
  const { dir, home } = await scratch(t);
  const s1 = await spawnServer(t, home);
  const id = await openRound(s1.port, dir, { spec: deck, mode: "swipe", outPath: path.join(dir, "deck.answers.json"), source: "deck.json" });
  const swipe = (body) => post(s1.port, `/api/rounds/${id}/swipe`, body);
  assert.equal((await swipe({ card: "c1", side: "left" })).status, 200);
  assert.equal((await swipe({ card: "c2", side: "right" })).status, 200);
  assert.equal((await agentPost(s1.port, `/api/rounds/${id}/push`, { add: [card("c7")] })).status, 200);
  const before = await get(s1.port, `/api/rounds/${id}`);
  assert.equal(before.mode, "swipe");
  assert.ok(before.spec.cards.some((c) => c.id === "c7"), "the pushed card is in the deck");
  assert.deepEqual(Object.keys(before.swipe.answers ?? {}).sort(), ["c1", "c2"]);
  await killed(s1);
  const s2 = await spawnServer(t, home);
  assert.equal(s2.exited, null, s2.output.stderr);
  const after = await get(s2.port, `/api/rounds/${id}`);
  assert.equal(after.mode, "swipe");
  assert.deepEqual(after.spec.cards.map((c) => c.id), before.spec.cards.map((c) => c.id), "same cards in the same order");
  assert.deepEqual(after.swipe, before.swipe, "same answers, same front card");
  assert.equal(after.swipe.answers.c1.side, "left");
  assert.equal(after.swipe.answers.c2.side, "right");
});

test("a save answers 200 only after the event is in events.jsonl", async (t) => {
  const { dir, home } = await scratch(t);
  const s = await spawnServer(t, home);
  const id = await openRound(s.port, dir);
  // The project's data dir lives in the scratch home, never the real one.
  const saved = process.env.DECIDE_HOME;
  process.env.DECIDE_HOME = home;
  let file;
  try {
    file = path.join(roundDir(openProject(dir).dataDir, id), "events.jsonl");
  } finally {
    saved === undefined ? delete process.env.DECIDE_HOME : (process.env.DECIDE_HOME = saved);
  }
  const countOf = () => readFileSync(file, "utf8").trim().split("\n").length;
  for (let i = 1; i <= 5; i++) {
    const before = countOf();
    const res = await put(s.port, `/api/rounds/${id}/draft`, { answers: { layout: { selected: [i % 2 ? "today" : "split"] } } });
    assert.equal(res.status, 200);
    // No wait: the file already holds the event the response promised.
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, before + 1, "the save is on disk when the response arrives");
    assert.match(lines.at(-1), /draft/);
  }
  const res = await post(s.port, `/api/rounds/${id}/ask`, { question: "layout", text: "why?" });
  assert.equal(res.status, 200);
  const last = readFileSync(file, "utf8").trim().split("\n").at(-1);
  assert.match(last, /why\?/, "an ask is on disk when it is acknowledged");
});

test("the server stops idleMs after the last waiter and page left, with a round still open", async (t) => {
  const { dir, port, home } = await inProcess(t, { idleMs: 300 });
  const id = await openRound(port, dir);
  const page = stream(t, port);
  await until(() => page.seen.length, "the stream to open");
  const waiting = new AbortController();
  const held = fetch(url(port, `/api/rounds/${id}/next?timeout=10000`), { headers: asAgent(port), signal: waiting.signal }).catch(() => {});
  await until(async () => (await get(port, "/api/state")).rounds[0].waiting, "the waiter to be held");
  await sleep(500);
  assert.ok(await ping(port), "held waiter and page: still serving");
  page.close();
  await sleep(500);
  assert.ok(await ping(port), "the waiter alone keeps it alive");
  const left = Date.now();
  waiting.abort();
  await held;
  await until(async () => (await ping(port)) === null, "the idle stop", 3_000);
  const took = Date.now() - left;
  assert.ok(took >= 250, `stopped ${took} ms after the last waiter left, not before idleMs`);
  assert.equal(readInfo(home), null);
});

test("the server does not stop while a waiter is connected", async (t) => {
  const { dir, port } = await inProcess(t, { idleMs: 300 });
  const id = await openRound(port, dir);
  const waiting = new AbortController();
  t.after(() => waiting.abort());
  fetch(url(port, `/api/rounds/${id}/next?timeout=10000`), { headers: asAgent(port), signal: waiting.signal }).catch(() => {});
  await until(async () => (await get(port, "/api/state")).rounds[0].waiting, "the waiter to be held");
  await sleep(1_000);
  assert.ok(await ping(port), "three idle periods with a waiter held");
  assert.equal((await get(port, "/api/state")).rounds[0].waiting, true);
});

test("the server does not stop while a page holds /api/events", async (t) => {
  const { dir, port } = await inProcess(t, { idleMs: 300 });
  await openRound(port, dir);
  const page = stream(t, port);
  await until(() => page.seen.length, "the stream to open");
  await sleep(1_000);
  assert.ok(await ping(port), "three idle periods with a page connected");
  page.close();
  await until(async () => (await ping(port)) === null, "the idle stop after the page left", 3_000);
});

// Raw HTTP so the test controls when the body arrives.
function slowPost(port, route, halves, gapMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(halves);
    const req = request({ host: "127.0.0.1", port, path: route, method: "POST", headers: { ...asPage(port), "content-length": Buffer.byteLength(body) } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.write(body.slice(0, 5));
    setTimeout(() => {
      req.end(body.slice(5));
    }, gapMs);
  });
}

test("requests keep the server alive while they come; it stops idleMs after the last response closes", async (t) => {
  const { port } = await inProcess(t, { idleMs: 300 });
  for (let i = 0; i < 4; i++) {
    assert.equal((await fetch(url(port, "/api/state"))).status, 200);
    await sleep(100);
  }
  const last = Date.now();
  await until(async () => (await ping(port)) === null, "the idle stop after the last request", 5_000);
  assert.ok(Date.now() - last >= 150, "not stopped before the clock ran");
});

test("a request whose body arrives slower than idleMs is answered, and the server stops after it", async (t) => {
  const { dir, port } = await inProcess(t, { idleMs: 300 });
  const id = await openRound(port, dir);
  const started = Date.now();
  assert.equal(await slowPost(port, `/api/rounds/${id}/ask`, { question: "layout", text: "slow" }, 1_000), 200);
  assert.ok(Date.now() - started >= 900);
  assert.ok(await ping(port), "still serving just after the answer");
  await until(async () => (await ping(port)) === null, "the idle stop after the slow request", 5_000);
});

test("pings alone do not keep the server alive", async (t) => {
  const { port } = await inProcess(t, { idleMs: 300 });
  const end = Date.now() + 2_000;
  let stopped = false;
  while (Date.now() < end && !stopped) {
    stopped = (await ping(port)) === null;
    await sleep(50);
  }
  assert.ok(stopped, "pinged every 50 ms for 2 s, the server still stopped");
});

test("GET /api/state names the server's startedAt, the one hello carries", async (t) => {
  const { port } = await inProcess(t, { idleMs: 60_000 });
  const page = stream(t, port);
  await until(() => page.seen.length, "hello");
  assert.equal((await get(port, "/api/state")).startedAt, page.seen[0].data.startedAt);
});

test("GET /api/events opens with hello { version, protocol, startedAt }; startedAt changes across a restart (skipped on win32: needs SIGKILL)", SKIP, async (t) => {
  const { home } = await scratch(t);
  const s1 = await spawnServer(t, home);
  const first = stream(t, s1.port);
  await until(() => first.seen.length >= 2, "the first events");
  assert.equal(first.seen[0].name, "hello", "hello comes before state");
  assert.equal(first.seen[1].name, "state");
  const hello = first.seen[0].data;
  assert.deepEqual(Object.keys(hello).sort(), ["protocol", "startedAt", "version"]);
  assert.equal(hello.protocol, PROTOCOL);
  assert.equal(hello.version, (await ping(s1.port)).version);
  assert.equal(hello.startedAt, readInfo(home).startedAt);
  await killed(s1);
  const s2 = await spawnServer(t, home);
  const second = stream(t, s2.port);
  await until(() => second.seen.length, "the restarted server's hello");
  assert.equal(second.seen[0].name, "hello");
  assert.notEqual(second.seen[0].data.startedAt, hello.startedAt);
  assert.equal(second.seen[0].data.startedAt, readInfo(home).startedAt);
});
