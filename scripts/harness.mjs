// harness.mjs: shared by screens.mjs and demo-gif.mjs. Starts a decide server of its own in a scratch HOME and
// DECIDE_HOME on a free port, opens rounds over HTTP, and stops the server by pid. The real ~/.decide is never
// touched. Set SCREENS_SCRATCH to choose where the scratch directory goes (default: the OS temp dir) and
// SCREENS_PORT to choose the port (default: the first free one from 47700 up).

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareDeck, prepareSpec } from "../lib/prepare.mjs";
import { openProject } from "../lib/project.mjs";

export const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort(from = 47700) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const s = createServer();
      s.once("error", () => (port < from + 200 ? tryPort(port + 1) : reject(new Error("no free port"))));
      s.listen(port, "127.0.0.1", () => s.close(() => resolve(port)));
    };
    tryPort(from);
  });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function startServer({ name = "run" } = {}) {
  const base = process.env.SCREENS_SCRATCH || tmpdir();
  mkdirSync(base, { recursive: true });
  const dir = realpathSync(mkdtempSync(path.join(base, `${name}-`)));
  const home = path.join(dir, "home");
  const dh = path.join(dir, "dh");
  const project = path.join(dir, "project");
  for (const d of [home, dh, project]) mkdirSync(d, { recursive: true });
  const port = process.env.SCREENS_PORT ? Number(process.env.SCREENS_PORT) : await freePort();
  const env = { ...process.env, HOME: home, DECIDE_HOME: dh, DECIDE_PORT: String(port), BROWSER: "none" };
  const child = spawn(process.execPath, [path.join(pluginDir, "decide.mjs"), "serve", "--port", String(port)], { env, cwd: project, stdio: "ignore" });
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
    throw new Error("decide server did not start");
  }
  const origin = `http://127.0.0.1:${info.port}`;
  const headers = { "content-type": "application/json", "x-decide-token": info.token, origin };
  const call = async (method, route, body) => {
    const r = await fetch(origin + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: r.status, ok: r.ok, data };
  };
  const must = async (method, route, body) => {
    const r = await call(method, route, body);
    if (!r.ok) throw new Error(`${method} ${route} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };
  return {
    dir,
    project,
    origin,
    pid: info.pid,
    call,
    must,
    // Copies an example (a file or a folder) into the project folder.
    copy(rel, to = path.basename(rel)) {
      cpSync(path.join(pluginDir, rel), path.join(project, to), { recursive: true });
    },
    write(rel, text) {
      const f = path.join(project, rel);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, text);
    },
    readSpec: (file) => JSON.parse(readFileSync(path.join(pluginDir, file), "utf8")),
    // Opens a question round, or a swipe deck with {mode: "swipe"}. Returns the round id.
    async open(raw, { mode, live = false } = {}) {
      const dataDir = openProject(project, dh).dataDir;
      const swipe = mode === "swipe";
      const prepared = swipe ? await prepareDeck(raw, { specDir: project, dataDir, shots: false }) : await prepareSpec(raw, { specDir: project, dataDir, shots: false });
      if (prepared.errors.length) throw new Error(`spec errors: ${JSON.stringify(prepared.errors)}`);
      const out = await must("POST", "/api/rounds", { project, spec: swipe ? prepared.deck : prepared.spec, live: swipe || live, open: false, ...(swipe ? { mode } : {}) });
      return out.id;
    },
    // Dismisses every waiting round, so the inbox rail shows only what the next shot opens.
    async clear() {
      for (const r of (await must("GET", "/api/inbox")).rounds) await call("POST", `/api/rounds/${r.id}/dismiss`, {});
    },
    url: (id) => `${origin}/#r=${id}`,
    round: (id) => must("GET", `/api/rounds/${id}`),
    answer: (id, qid, answer) => must("POST", `/api/rounds/${id}/answer`, { qid, answer }),
    patch: (id, ops, extra = {}) => must("POST", `/api/rounds/${id}/patch`, { ops: Array.isArray(ops) ? ops : [ops], ...extra }),
    explain: (id, qid, text, extra = {}) => must("POST", `/api/rounds/${id}/explain`, { question: qid, text, ...extra }),
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
