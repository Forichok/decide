// client.mjs — the agent side: find or start the session daemon for a project
// data directory, post a round, wait for the user, post live explanations.

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { infoPath, startDaemon, VERSION } from "./daemon.mjs";
import { fnv1a } from "./project.mjs";

const HEADERS = { "content-type": "application/json", "x-decide": "1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stable per-directory port, so a tab left open reconnects to a restarted daemon.
export const portFor = (dir) => 43100 + (fnv1a(dir) % 800);

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

export function readInfo(dir) {
  try {
    return JSON.parse(readFileSync(infoPath(dir), "utf8"));
  } catch {
    return null;
  }
}

// The port of a running daemon of this version, or null.
export async function findDaemon(dir) {
  const info = readInfo(dir);
  return info && (await ping(info.port))?.version === VERSION ? info.port : null;
}

// Returns { port, embedded } — embedded when a detached daemon cannot start,
// in which case this process serves the round itself and exits after it.
export async function ensureDaemon({ dir, engine, port }) {
  const known = readInfo(dir);
  if (known) {
    const alive = await ping(known.port);
    if (alive?.version === VERSION) return { port: known.port };
    if (alive) await call(known.port, "/api/shutdown", { method: "POST" }).catch(() => {});
  }

  const wanted = port || portFor(dir);
  const log = openSync(join(dir, ".decide-daemon.log"), "a");
  try {
    spawn(process.execPath, [engine, "--daemon", "--dir", dir, "--port", String(wanted)], {
      detached: true,
      stdio: ["ignore", log, log],
    }).unref();
  } catch {
    // fall through to embedded mode
  } finally {
    closeSync(log);
  }
  for (let i = 0; i < 40; i += 1) {
    await sleep(150);
    const info = existsSync(infoPath(dir)) && readInfo(dir);
    if (info && info.pid !== known?.pid && (await ping(info.port))?.version === VERSION) return { port: info.port };
  }
  const { port: own } = await startDaemon({ dir, port: 0, embedded: true });
  return { port: own, embedded: true };
}

export const postRound = (port, round) => call(port, "/api/rounds", { method: "POST", body: round, timeoutMs: 5000 });
export const postExplain = (port, id, body) => call(port, `/api/rounds/${id}/explain`, { method: "POST", body, timeoutMs: 5000 });
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
