#!/usr/bin/env node
// demo-journal.mjs: fills the journal of the running decide server (DECIDE_HOME) with answered rounds so the
// journal's project switch and the map's neighbourhood picker have something to show: two projects, and in the
// first one a chain of decisions that lean on each other.
//
//   node scripts/demo-journal.mjs [count]    count of rounds in the first project (default 45; the map
//                                            shows one neighbourhood at a time above 40)
//
// Use it only with a scratch DECIDE_HOME (see the milestone 5 demo note). It starts the server when none runs.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const decide = path.join(here, "..", "decide.mjs");
const home = process.env.DECIDE_HOME;
if (!home) {
  console.error("Set DECIDE_HOME to a scratch directory first: this script writes rounds.");
  process.exit(2);
}
const count = Math.max(2, Number(process.argv[2]) || 45);

// A running server for this home, or one started now (any command that needs it starts it).
const daemon = () => JSON.parse(readFileSync(path.join(home, "daemon.json"), "utf8"));
try {
  daemon();
} catch {
  execFileSync(process.execPath, [decide, "open", "--no-open"], { stdio: "ignore" });
}
const info = daemon();
const origin = `http://127.0.0.1:${info.port}`;
const headers = { "content-type": "application/json", "x-decide-token": info.token, origin };
const call = async (route, body) => {
  const r = await fetch(origin + route, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${route} -> ${r.status} ${await r.text()}`);
  return r.json();
};

// The two project folders sit next to the scratch DECIDE_HOME, so nothing lands outside it.
const projectDir = (name) => {
  const dir = path.join(path.dirname(path.resolve(home)), "journal-demo", name);
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
};

async function answered(project, title, qid, dependsOn) {
  const spec = {
    title,
    questions: [
      {
        id: qid,
        type: "single",
        title: `${title}?`,
        why: "It comes before the rest.",
        ...(dependsOn ? { dependsOn } : {}),
        options: [
          { id: "a", label: "Yes", then: "We go on." },
          { id: "b", label: "No", then: "We stop here." },
        ],
      },
    ],
  };
  const { id } = await call("/api/rounds", { project, spec, live: false, open: false });
  await call(`/api/rounds/${id}/submit`, { answers: { [qid]: { selected: ["a"] } } });
  return id;
}

const first = projectDir("task-app");
const second = projectDir("wedding-site");
let prev = null;
for (let i = 1; i <= count; i++) {
  const qid = `d${i}`;
  // Each decision rests on the one before it, and every fifth also on the first one.
  const deps = [prev, i % 5 === 0 ? "d1" : null].filter(Boolean);
  await answered(first, `Decision ${i} for the task app`, qid, deps.length ? deps : undefined);
  prev = qid;
}
for (const title of ["Pick the venue", "Pick the date", "Invitation text"]) await answered(second, title, title.toLowerCase().replace(/\W+/g, "-"));
console.log(`${count} answered rounds in ${first} and 3 in ${second}. Open ${origin}/#journal`);
