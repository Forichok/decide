// client.mjs — the agent side: find or start the decide home's server, post a
// round, wait for the user, post live explanations.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { pidAlive, readInfo } from "./home.mjs";
import { PROTOCOL, speaks } from "./protocol.mjs";
import { decideHome } from "./project.mjs";

const HEADERS = { "content-type": "application/json", "x-decide": "1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(port, path, { method = "GET", body, timeoutMs = 1500 } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${data.error || ""}`), { status: res.status, data });
  return data;
}

async function ping(port) {
  try {
    return await call(port, "/api/ping", { timeoutMs: 800 });
  } catch {
    return null;
  }
}

// What daemon.json's server is now: { state: "live", info } when its pid is alive and its port answers
// as decide of this home with that pid (info carries the protocol); { state: "silent", info } when its
// pid is alive but the port gave no answer in time (a server that is only busy, or a pid reused by
// something that hangs: nobody can tell yet); { state: "none" } otherwise. A dead pid's port is not
// asked: it may belong to something else by now.
export async function serverOf(home = decideHome()) {
  const info = readInfo(home);
  if (!info || !pidAlive(info.pid)) return { state: "none" };
  try {
    const pong = await call(info.port, "/api/ping", { timeoutMs: 800 });
    return pong?.app === "decide" && pong.home === home && pong.pid === info.pid ? { state: "live", info: { ...info, protocol: pong.protocol } } : { state: "none" };
  } catch (err) {
    return err?.name === "TimeoutError" ? { state: "silent", info } : { state: "none" };
  }
}

// The guard before anything is asked of, or sent to, a running server: its info, or null.
export async function liveServer(home = decideHome()) {
  const found = await serverOf(home);
  return found.state === "live" ? found.info : null;
}

// What to tell the user about a named server that does not answer. Nobody has confirmed it is decide.
export const silentServer = (home, info) =>
  `the decide server named in ${join(home, "daemon.json")} (pid ${info.pid}, port ${info.port}) is not answering`;

// The port of this home's running server, or null. The project dir no longer matters: one server serves the home.
export async function findDaemon() {
  const server = await liveServer();
  return server && speaks(server.protocol, PROTOCOL) ? server.port : null;
}

// Returns { port, embedded } — embedded when a detached server cannot start,
// in which case this process serves the round itself and exits after it.
export async function ensureDaemon({ engine, port }) {
  const running = await findDaemon();
  if (running) return { port: running };

  const home = decideHome();
  mkdirSync(home, { recursive: true });
  const log = openSync(join(home, "daemon.log"), "a");
  try {
    spawn(process.execPath, [engine, "serve", ...(port ? ["--port", String(port)] : [])], {
      detached: true,
      stdio: ["ignore", log, log],
    }).unref();
  } catch {
    // fall through to embedded mode
  } finally {
    closeSync(log);
  }
  for (const end = Date.now() + 6_000; Date.now() < end; ) {
    await sleep(150);
    const found = await findDaemon();
    if (found) return { port: found };
  }
  const own = await startServer({ embedded: true, ...(port ? { port } : {}) });
  if (own) return { port: own.port, embedded: true };
  const found = await findDaemon();
  if (found) return { port: found };
  // Both stepped back for a server the home names that still does not answer: nothing else is started beside it.
  const named = await serverOf(home);
  if (named.state === "silent") {
    throw new Error(`${silentServer(home, named.info)}, so no second server was started beside it. Try again shortly; if pid ${named.info.pid} is not a decide server, remove ${join(home, "daemon.json")} and ${join(home, "daemon.lock")} and try again.`);
  }
  throw new Error(`no decide server could start for ${home}`);
}

export const postRound = (port, round) => call(port, "/api/rounds", { method: "POST", body: round, timeoutMs: 5000 });
export const postExplain = (port, id, body) => call(port, `/api/rounds/${id}/explain`, { method: "POST", body, timeoutMs: 5000 });
export const postPush = (port, id, body) => call(port, `/api/rounds/${id}/push`, { method: "POST", body, timeoutMs: 5000 });
export const getRoundView = (port, id) => call(port, `/api/rounds/${id}`);
export const postExport = (port, id, body) => call(port, `/api/rounds/${id}/export`, { method: "POST", body, timeoutMs: 120_000 });
export const postImport = (port, id, body) => call(port, `/api/rounds/${id}/import`, { method: "POST", body, timeoutMs: 10_000 });
export const getJournal = (port, limit, q = "") => call(port, `/api/journal?limit=${limit}&q=${encodeURIComponent(q)}`);

// One long-poll: the result, an { event: "ask" } (events only) or null on timeout.
export function waitOnce(port, id, { events = false, timeoutMs } = {}) {
  const qs = new URLSearchParams({ ...(events && { events: "1" }), ...(timeoutMs && { timeout: String(timeoutMs) }) });
  return call(port, `/api/rounds/${id}/wait?${qs}`, { timeoutMs: 0 });
}

// Blocks until the round ends (or, with events, until the user asks something).
export async function waitResult(port, id, outPath, { events = false } = {}) {
  let failures = 0;
  for (;;) {
    try {
      const result = await waitOnce(port, id, { events });
      failures = 0;
      if (result) return result;
    } catch (e) {
      if (e.status === 404) return savedResult(outPath, id, e);
      failures += 1;
      if (failures >= 20) return savedResult(outPath, id, e);
      await sleep(500);
    }
  }
}

// Daemon gone or restarted: the answers file may still have been written.
function savedResult(outPath, id, error) {
  const saved = outPath && existsSync(outPath) && JSON.parse(readFileSync(outPath, "utf8"));
  if (saved && saved.round === id) return saved;
  throw new Error(`decide round ${id} is gone: ${error.message}`);
}
