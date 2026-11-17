// Shared harness for the browser specs. Each spec file starts its own decide server in its own scratch
// HOME and DECIDE_HOME on its own free port, talks to it over HTTP with the token from daemon.json, and
// stops it by pid when the file is done. The real ~/.decide is never touched.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareDeck, prepareSpec } from "../lib/prepare.mjs";
import { openProject } from "../lib/project.mjs";

export const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// DECIDE_E2E_SCRATCH keeps the runs somewhere you choose; otherwise the system temp dir.
const SCRATCH = process.env.DECIDE_E2E_SCRATCH || "";

function freePort(from = 47700) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const s = createServer();
      s.once("error", () => (port < from + 600 ? tryPort(port + 1) : reject(new Error("no free port"))));
      s.listen(port, "127.0.0.1", () => s.close(() => resolve(port)));
    };
    tryPort(from + Math.floor(Math.random() * 300));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Starts a server in a fresh scratch home. Returns the handle every spec uses.
export async function startDecide({ name = "run" } = {}) {
  let base = tmpdir();
  if (SCRATCH) {
    try {
      mkdirSync(SCRATCH, { recursive: true });
      base = SCRATCH;
    } catch {}
  }
  const dir = realpathSync(mkdtempSync(path.join(base, `run-${name}-`)));
  const home = path.join(dir, "home");
  const dh = path.join(dir, "dh");
  const project = path.join(dir, "project");
  for (const d of [home, dh, project]) mkdirSync(d, { recursive: true });
  const port = await freePort();
  const env = { ...process.env, HOME: home, DECIDE_HOME: dh, DECIDE_PORT: String(port), BROWSER: "none" };
  const child = spawn(process.execPath, [path.join(pluginDir, "decide.mjs"), "serve", "--port", String(port)], { env, cwd: project, stdio: "ignore" });
  const log = [];
  child.on("exit", (code) => log.push(`exit ${code}`));
  let info = null;
  for (let i = 0; i < 100 && !info; i++) {
    await sleep(100);
    try {
      info = JSON.parse(readFileSync(path.join(dh, "daemon.json"), "utf8"));
      const r = await fetch(`http://127.0.0.1:${info.port}/api/ping`);
      if (!(await r.json()).ok) info = null;
    } catch {
      info = null;
    }
  }
  if (!info) {
    child.kill("SIGTERM");
    throw new Error(`decide server did not start (${log.join(", ")})`);
  }
  const origin = `http://127.0.0.1:${info.port}`;
  const headers = { "content-type": "application/json", "x-decide-token": info.token, origin };

  async function call(method, route, body) {
    const r = await fetch(origin + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: r.status, ok: r.ok, data };
  }
  const must = async (method, route, body) => {
    const r = await call(method, route, body);
    if (!r.ok) throw new Error(`${method} ${route} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };

  return {
    dir,
    project,
    port: info.port,
    pid: info.pid,
    origin,
    token: info.token,
    call,
    must,
    // Opens a question round (or a swipe deck with {mode: "swipe"}). Returns the round id.
    // The spec goes through the same normalising as the ask command; a spec with errors throws.
    async open(raw, { live = false, mode, specDir = project } = {}) {
      const dataDir = openProject(project, dh).dataDir;
      const swipe = mode === "swipe";
      const prepared = swipe ? await prepareDeck(raw, { specDir, dataDir, shots: false }) : await prepareSpec(raw, { specDir, dataDir, shots: false });
      if (prepared.errors.length) throw new Error(`spec errors: ${JSON.stringify(prepared.errors)}`);
      const out = await must("POST", "/api/rounds", { project, spec: swipe ? prepared.deck : prepared.spec, live: swipe || live, open: false, ...(swipe ? { mode } : {}) });
      return out.id;
    },
    url: (id) => `${origin}/#r=${id}`,
    round: (id) => must("GET", `/api/rounds/${id}`),
    answers: async (id) => (await must("GET", `/api/rounds/${id}`)).answers ?? {},
    // The agent's reply to a user's question.
    explain: (id, qid, text, extra = {}) => must("POST", `/api/rounds/${id}/explain`, { question: qid, text, ...extra }),
    patch: (id, ops, extra = {}) => must("POST", `/api/rounds/${id}/patch`, { ops: Array.isArray(ops) ? ops : [ops], ...extra }),
    push: (id, body) => must("POST", `/api/rounds/${id}/push`, body),
    // Stands in for the user from a script.
    answer: (id, qid, answer) => must("POST", `/api/rounds/${id}/answer`, { qid, answer }),
    // Next outbox item for the agent, or null when none arrives within the timeout.
    async next(id, { timeout = 1500, waiter = "e2e" } = {}) {
      const r = await fetch(`${origin}/api/rounds/${id}/next?waiter=${waiter}&events=1&timeout=${timeout}`, { headers });
      if (r.status === 204) return null;
      return r.json();
    },
    ack: (id, seq, waiter = "e2e") => call("POST", `/api/rounds/${id}/ack`, { seq, waiter }),
    async stop() {
      try {
        process.kill(info.pid, "SIGTERM");
      } catch {}
      try {
        child.kill("SIGTERM");
      } catch {}
      for (let i = 0; i < 50 && (alive(info.pid) || child.exitCode === null); i++) await sleep(100);
      if (alive(info.pid)) {
        try {
          process.kill(info.pid, "SIGKILL");
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// A small question spec. Top-level fields can be overridden.
export function spec(over = {}) {
  return {
    title: "E2E round",
    intro: "A round made by a browser test.",
    questions: [
      {
        id: "db",
        type: "single",
        title: "Which database?",
        why: "It decides the storage layer.",
        options: [
          { id: "pg", label: "Postgres", recommended: true, then: "Runs in a container." },
          { id: "sqlite", label: "SQLite", then: "One file." },
        ],
      },
      {
        id: "tabs",
        type: "multi",
        title: "Which pages come first?",
        why: "Order of the first release.",
        options: [
          { id: "home", label: "Home", then: "Ships first." },
          { id: "search", label: "Search", then: "Ships second." },
          { id: "admin", label: "Admin", then: "Ships last." },
        ],
      },
      { id: "name", type: "text", title: "What is it called?", why: "Used in the title." },
    ],
    ...over,
  };
}

export function swipeSpec() {
  return {
    title: "E2E deck",
    brief: "# Brief\n\nWe are choosing a few things.",
    cards: [
      { id: "c1", title: "Dark mode first?", body: "Ship dark mode before light." },
      { id: "c2", title: "Weekly digest?", body: "Send a weekly digest email." },
      { id: "c3", title: "Offline support?", body: "Work without a network." },
    ],
  };
}

export const MOBILE = { width: 375, height: 812 };
export const DESKTOP = { width: 1440, height: 900 };

export function writeFile(dir, rel, content) {
  const f = path.join(dir, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, content);
  return f;
}
