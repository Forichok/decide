/**
 * Feature:    "Later" and conditions reach the agent (decide 3.0, milestone 2, P6, server side), plus two M1 notes
 * Layer:      Integration: an in-process server over loopback HTTP, the answers file on disk, the journal, and
 *             the commands as an agent calls them (history, ask)
 * Contract:   lib/store/rounds.mjs (withFlags, format), lib/journal.mjs (records, deferredDecisions,
 *             deferredOverlaps), lib/commands/history.mjs, lib/commands/ask.mjs, lib/server.mjs (journal, handover)
 * Covers:
 *   - a question put off with "later" lands in the answers file with flag, revisit and its note; a "Yes, but…"
 *     answer carries its condition; the file says format 3
 *   - the journal keeps the deferred question as deferred: true with revisit
 *   - history lists deferred decisions before the journal; ask names the deferred ones a new round touches
 *   - the journal of every project names each entry's project; `event: handover` names the new page's url
 * Why exists: a "later" that only the page knew about was forgotten the moment the round ended (design "The question").
 */

import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import test from "node:test";
import { startServer } from "../lib/server.mjs";
import { openProject } from "../lib/project.mjs";
import { prepareSpec } from "../lib/prepare.mjs";
import { api, findServer } from "../lib/client.mjs";
import { deferredDecisions, deferredOverlaps, readJournal } from "../lib/journal.mjs";
import { PROTOCOL } from "../lib/protocol.mjs";
import { HANDLERS, asAgent, asPage, homeOf, scratchDir } from "./helpers.mjs";

delete process.env.DECIDE_PORT;
process.env.DECIDE_NOTIFY = "0";

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

const raw = {
  title: "Storage plan",
  questions: [
    { id: "engine", title: "Which database engine for the orders service?", options: [{ id: "pg", label: "Postgres" }, { id: "sqlite", label: "SQLite" }] },
    { id: "backups", title: "How often do we take backups?", options: [{ id: "daily", label: "Daily" }, { id: "hourly", label: "Hourly" }] },
    { id: "region", title: "Which hosting region?", options: [{ id: "eu", label: "EU" }, { id: "us", label: "US" }] },
  ],
};

async function served(t) {
  const made = await scratchDir(t);
  const dir = realpathSync(made); // the project root as the server resolves it
  const home = homeOf(made);
  await mkdir(home, { recursive: true });
  const started = await startServer({ home, embedded: true });
  t.after(() => started.stop());
  const s = await findServer(home);
  const project = openProject(dir, home);
  const open = async (spec0, name) => {
    const { spec, errors } = await prepareSpec(spec0, { specDir: dir, dataDir: project.dataDir, shots: false });
    assert.deepEqual(errors, []);
    const outPath = path.join(dir, `${name}.answers.json`);
    const { id } = await api(s, "/api/rounds", { method: "POST", body: { project: dir, spec, outPath, source: `${name}.questions.json`, specFile: path.join(dir, `${name}.questions.json`), open: false, live: true } });
    return { id, outPath };
  };
  return { dir, home, s, port: started.port, project, open };
}

const post = (port, route, body) => fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: asPage(port), body: JSON.stringify(body) });

async function inHome(home, fn) {
  const before = process.env.DECIDE_HOME;
  process.env.DECIDE_HOME = home;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.DECIDE_HOME;
    else process.env.DECIDE_HOME = before;
  }
}

test("«later», its revisit and a condition reach the answers file, the journal, history and the next ask", async (t) => {
  const { dir, home, port, project, open } = await served(t);
  const { id, outPath } = await open(raw, "storage");

  // The page: a "Yes, but…" answer with its condition, a question put off, one answered plainly.
  assert.equal((await post(port, `/api/rounds/${id}/answer`, { qid: "engine", answer: { selected: ["pg"], condition: "if the ops team signs off" } })).status, 200);
  assert.equal((await post(port, `/api/rounds/${id}/flag`, { qid: "backups", flag: "later", revisit: "after the first paying customer", note: "depends on the SLA" })).status, 200);
  assert.equal((await post(port, `/api/rounds/${id}/answer`, { qid: "region", answer: { selected: ["eu"] } })).status, 200);
  const submitted = await post(port, `/api/rounds/${id}/submit`, {
    answers: { engine: { selected: ["pg"] }, backups: { selected: ["daily"], auto: true }, region: { selected: ["eu"], note: "GDPR" } },
  });
  assert.equal(submitted.status, 200);

  const file = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(file.format, 3);
  assert.deepEqual(file.answers.backups, { flag: "later", revisit: "after the first paying customer", note: "depends on the SLA" }, "the flag replaces an answer the page filled in itself");
  assert.deepEqual(file.answers.engine, { selected: ["pg"], condition: "if the ops team signs off" });
  assert.deepEqual(file.answers.region, { selected: ["eu"], note: "GDPR" });

  // The journal: one record per question, the deferred one marked.
  await until(() => readJournal(project).length === 1, "the journal entry");
  const [entry] = readJournal(project);
  assert.equal(entry.project, dir);
  const backups = entry.records.find((r) => r.id.endsWith("/backups"));
  assert.equal(backups.deferred, true);
  assert.equal(backups.revisit, "after the first paying customer");
  assert.equal(entry.records.find((r) => r.id.endsWith("/engine")).condition, "if the ops team signs off");
  assert.ok(!entry.records.find((r) => r.id.endsWith("/region")).deferred);
  assert.deepEqual(
    deferredDecisions(project).map((d) => [d.qid, d.round, d.revisit]),
    [["backups", id, "after the first paying customer"]],
  );

  // history: the deferred block first, then the journal.
  const history = await inHome(home, () => HANDLERS.history({ project: dir }));
  const deferredAt = history.indexOf("Deferred decisions");
  const journalAt = history.indexOf("## Storage plan");
  assert.ok(deferredAt >= 0 && journalAt > deferredAt, history);
  assert.match(history, /How often do we take backups\? — revisit when: after the first paying customer/);

  // A new round on the same topic (other ids, shared words) or with the same id names the deferred question.
  assert.equal(deferredOverlaps(project, [{ id: "freq", title: "How often should backups run?" }]).length, 1);
  assert.equal(deferredOverlaps(project, [{ id: "backups", title: "Snapshots?" }]).length, 1);
  assert.equal(deferredOverlaps(project, [{ id: "q1", title: "Which logo?" }]).length, 0, "an unrelated question with a default id");
  const asked = await inHome(home, () => HANDLERS.ask({ project: dir, spec: { title: "Ops", questions: [{ id: "cadence", title: "How often do backups happen?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] }, open: false }));
  assert.match(asked, /The user put off decisions that touch this round/);
  assert.match(asked, /How often do we take backups\?/);
  const plain = await inHome(home, () => HANDLERS.ask({ project: dir, spec: { title: "Logo", questions: [{ id: "logo", title: "Which logo colour?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] }, open: false }));
  assert.doesNotMatch(plain, /put off/);
});

test("the journal of every project names each entry's project", async (t) => {
  const { dir, port, open } = await served(t);
  const { id } = await open(raw, "storage");
  assert.equal((await post(port, `/api/rounds/${id}/submit`, { answers: { engine: { selected: ["pg"] } } })).status, 200);
  const all = await until(async () => {
    const { entries } = await (await fetch(`http://127.0.0.1:${port}/api/journal`)).json();
    return entries.length ? entries : null;
  }, "the merged journal");
  assert.equal(all[0].round, id);
  assert.equal(all[0].project, dir);
  assert.equal(all[0].projectName, path.basename(dir));
});

test("`event: handover` names the url the page goes to", async (t) => {
  const { port } = await served(t);
  const heard = [];
  const req = request({ host: "127.0.0.1", port, path: "/api/events" }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      for (const block of chunk.split("\n\n")) {
        const name = block.match(/^event: (.+)$/m)?.[1];
        if (name) heard.push({ name, data: JSON.parse(block.match(/^data: (.+)$/m)?.[1] || "null") });
      }
    });
  });
  req.on("error", () => {});
  req.end();
  t.after(() => req.destroy());
  await until(() => heard.some((e) => e.name === "hello"), "the stream");
  const res = await fetch(`http://127.0.0.1:${port}/api/handover`, { method: "POST", headers: asAgent(port, { "x-decide-protocol": String(PROTOCOL + 1) }), body: "{}" });
  assert.equal(res.status, 200);
  const handover = await until(() => heard.find((e) => e.name === "handover"), "the handover event");
  assert.deepEqual(handover.data, { protocol: PROTOCOL + 1, url: `http://127.0.0.1:${port}/` });
});
