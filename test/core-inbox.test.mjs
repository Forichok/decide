/**
 * Feature:    the inbox (decide 3.0, milestone 2, P4, server side)
 * Layer:      Core unit (the round store with a clock the test moves) and integration (an in-process server
 *             over loopback HTTP and its event stream)
 * Contract:   lib/store/rounds.mjs (inbox, summary), lib/server.mjs (GET /api/inbox, `event: inbox`, `event: state`)
 * Covers:
 *   - open rounds of every project in one list: high stakes first, then the longest waiting, then the older
 *     group (no agent for a day) in the same order
 *   - each row: project and its name, title, mode, answered / total, listening, stakes, createdAt, waitingSince
 *   - answered counts a flag beside an answer
 *   - `event: inbox` goes out when the list changes, and with `event: state` when an agent starts waiting
 *   - the state names the engine and each round's stakes, for the page's copy-a-command note
 * Why exists: one page for every project (design "One page"); the order is the contract the rail is drawn from.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import test from "node:test";
import { startServer } from "../lib/server.mjs";
import { createStore } from "../lib/store/rounds.mjs";
import { createRoots } from "../lib/assets.mjs";
import { openProject } from "../lib/project.mjs";
import { prepareSpec } from "../lib/prepare.mjs";
import { api, findServer, waitNext } from "../lib/client.mjs";
import { asPage, homeOf, scratchDir } from "./helpers.mjs";

delete process.env.DECIDE_PORT;
process.env.DECIDE_NOTIFY = "0";

const HOUR = 3_600_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, what, ms = 5_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const specOf = (title, stakes) => ({
  title,
  questions: [
    { id: "color", title: "Which colour?", ...(stakes ? { stakes } : {}), options: [{ id: "pink", label: "Pink" }, { id: "blue", label: "Blue" }] },
    { id: "size", title: "Which size?", options: [{ id: "s", label: "Small" }, { id: "l", label: "Large" }] },
    { id: "extra", title: "Anything else?", optional: true, options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] },
  ],
});

test("the inbox puts high stakes first, then the longest waiting, then the rounds no agent has heard for a day", async (t) => {
  const dir = await scratchDir(t);
  const home = homeOf(dir);
  mkdirSync(home, { recursive: true });
  const projects = ["alpha", "beta"].map((name) => {
    mkdirSync(path.join(dir, name), { recursive: true });
    return openProject(path.join(dir, name), home);
  });
  const base = Date.now();
  let clock = base;
  const store = createStore({ home, roots: createRoots(), listenGraceMs: 0, now: () => clock, warn: () => {} });
  t.after(() => store.close());
  const open = async (title, stakes, project, at) => {
    clock = at;
    const raw = specOf(title, stakes);
    const { spec, errors } = await prepareSpec(raw, { specDir: project.root, dataDir: project.dataDir, shots: false });
    assert.deepEqual(errors, []);
    return store.create({ project, spec, raw, outPath: path.join(project.root, `${title}.answers.json`), source: `${title}.questions.json`, live: true });
  };
  const low1 = await open("low-first", null, projects[0], base);
  const high1 = await open("high-first", "high", projects[0], base + 10);
  const lowOld = await open("low-old", null, projects[1], base + 5);
  const low2 = await open("low-second", null, projects[1], base + 20);
  const high2 = await open("high-second", "high", projects[1], base + 30);
  const highOld = await open("high-old", "high", projects[0], base + 40);

  // Fresh: nobody is older, so stakes and age decide.
  assert.deepEqual(store.inbox().rounds.map((r) => r.title), ["high-first", "high-second", "high-old", "low-first", "low-old", "low-second"]);

  // A day later an agent comes back for four of them; the other two have not been heard of since they opened.
  clock = base + 25 * HOUR;
  for (const round of [low1, high1, low2, high2]) {
    const gone = new AbortController();
    const waiting = store.next(round, { waiter: "w", signal: gone.signal, timeoutMs: 60_000 });
    gone.abort();
    assert.equal(await waiting, null);
  }
  const rows = store.inbox().rounds;
  assert.deepEqual(
    rows.map((r) => [r.title, r.older]),
    [
      ["high-first", false],
      ["high-second", false],
      ["low-first", false],
      ["low-second", false],
      ["high-old", true],
      ["low-old", true],
    ],
  );
  const first = rows[0];
  assert.deepEqual(first, {
    id: high1.id,
    project: projects[0].root,
    projectName: "alpha",
    title: "high-first",
    mode: "questions",
    answered: 0,
    total: 2,
    listening: false,
    stakes: "high",
    createdAt: base + 10,
    waitingSince: base + 10,
    older: false,
  });
  assert.equal(rows.find((r) => r.id === lowOld.id).projectName, "beta");
  assert.equal(rows.find((r) => r.id === highOld.id).stakes, "high");
  assert.equal(rows.find((r) => r.id === low1.id).stakes, null);

  // An answer counts, a flag beside a question counts, and the optional question is not counted.
  await store.saveAnswer(low1, { qid: "color", answer: { selected: ["pink"] } });
  await store.saveFlag(low1, { qid: "size", flag: "later", revisit: "next sprint" });
  await store.saveAnswer(low1, { qid: "extra", answer: { selected: ["y"] } });
  const counted = store.inbox().rounds.find((r) => r.id === low1.id);
  assert.deepEqual([counted.answered, counted.total], [2, 2]);

  // A waiter held now listens, and a listening round is never older.
  const waiter = store.next(lowOld, { waiter: "w", timeoutMs: 60_000 });
  const listening = store.inbox().rounds.find((r) => r.id === lowOld.id);
  assert.deepEqual([listening.listening, listening.older], [true, false]);
  store.close();
  await waiter;
  // The summary the page draws from names each round's stakes.
  const again = createStore({ home, roots: createRoots(), now: () => clock, warn: () => {} });
  t.after(() => again.close());
  again.load();
  assert.deepEqual(
    Object.fromEntries(again.summary().rounds.map((r) => [r.title, r.stakes])),
    { "low-first": null, "high-first": "high", "low-old": null, "low-second": null, "high-second": "high", "high-old": "high" },
  );
});

// ---- the server

function stream(t, port) {
  const seen = [];
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
        seen.push({ name, data: data ? JSON.parse(data) : null });
        if (name === "inbox" && seen.length >= 3) ready();
      }
    });
  });
  req.on("error", () => {});
  req.end();
  t.after(() => req.destroy());
  return { seen, opened };
}

test("GET /api/inbox, `event: inbox` on a change, and both inbox and state when an agent starts or stops waiting", async (t) => {
  const dir = await scratchDir(t);
  const home = homeOf(dir);
  await mkdir(home, { recursive: true });
  const started = await startServer({ home, embedded: true, listenGraceMs: 50, tickMs: 20 });
  t.after(() => started.stop());
  const s = await findServer(home);
  const port = started.port;
  const events = stream(t, port);
  await events.opened;
  const names = () => events.seen.map((e) => e.name);
  assert.deepEqual(names().slice(0, 3), ["hello", "state", "inbox"], "a page that connects hears the inbox at once");
  assert.deepEqual(events.seen[2].data, { rounds: [] });
  assert.ok(path.isAbsolute(events.seen[1].data.engine) && existsSync(events.seen[1].data.engine), "the state names the engine");
  assert.equal(path.basename(events.seen[1].data.engine), "decide.mjs");

  const { spec } = await prepareSpec(specOf("colours", "high"), { specDir: dir, dataDir: openProject(dir, home).dataDir, shots: false });
  const { id } = await api(s, "/api/rounds", {
    method: "POST",
    body: { project: dir, spec, outPath: path.join(dir, "colours.answers.json"), source: "colours.questions.json", open: false, live: true },
  });
  const inboxes = () => events.seen.filter((e) => e.name === "inbox").map((e) => e.data);
  const row = await until(() => inboxes().at(-1)?.rounds.find((r) => r.id === id), "the new round in the inbox");
  assert.equal(row.stakes, "high");
  assert.equal(row.projectName, path.basename(dir));
  const fetched = await (await fetch(`http://127.0.0.1:${port}/api/inbox`)).json();
  assert.deepEqual(fetched.rounds.map((r) => r.id), [id]);
  const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.equal(state.rounds.find((r) => r.id === id).stakes, "high");
  assert.equal(state.engine, events.seen[1].data.engine);

  // An answer changes answered: a new inbox goes out. An unchanged list is not sent again.
  // The ask itself counts as the agent listening for the grace; let it lapse first.
  await until(() => inboxes().at(-1).rounds[0].listening === false, "the grace after the ask lapses");
  await sleep(100);
  const before = inboxes().length;
  const answer = await fetch(`http://127.0.0.1:${port}/api/rounds/${id}/answer`, { method: "POST", headers: asPage(port), body: JSON.stringify({ qid: "color", answer: { selected: ["pink"] } }) });
  assert.equal(answer.status, 200);
  await until(() => inboxes().at(-1).rounds[0].answered === 1, "answered 1");
  await sleep(100);
  assert.equal(inboxes().length, before + 1, "one change, one inbox");

  // An agent starts waiting: state and inbox both say it listens; it leaves: both say it does not.
  const gone = new AbortController();
  const waiting = waitNext(s, id, { waiter: "agent", timeoutMs: 60_000, signal: gone.signal });
  await until(() => inboxes().at(-1).rounds[0].listening === true, "the inbox says the agent listens");
  const listened = events.seen.filter((e) => e.name === "state").at(-1).data;
  assert.equal(listened.rounds.find((r) => r.id === id).listening, true, "so does the state");
  gone.abort();
  await waiting;
  await until(() => inboxes().at(-1).rounds[0].listening === false, "the inbox says the agent left");
  await until(() => events.seen.filter((e) => e.name === "state").at(-1).data.rounds.find((r) => r.id === id).listening === false, "the state says it left");
});
