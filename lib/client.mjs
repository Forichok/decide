// client.mjs — the agent side: find the decide home's server, check that it
// speaks this client's protocol, start one when there is none, and ask an
// older one to hand over. A client never stops a server: the only ways one
// stops are idle, the user's stop command (commands.mjs) and a handover it agreed to.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { startServer } from "./server.mjs";
import { pidAlive, readInfo } from "./home.mjs";
import { PROTOCOL, speaks } from "./protocol.mjs";
import { PING_BODY_MAX, request } from "./request.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PING_MS = 800;
// A named server that does not answer is busy, not absent: asked again for this long, then the client gives up.
const BUSY_MS = 6_000;
// How long a started engine has to come up: its election may wait out a slow rival (about 7 s at worst).
// The brief said 6 s; that is shorter than an election that waits out a slow rival.
const START_MS = 15_000;
// How long an older server that agreed to hand over has to let go of its port.
const HANDOVER_MS = 5_000;
// Engines started (or in-process servers tried) before the client gives up, and its overall budget.
const TRIES = 3;
const GIVE_UP_MS = 30_000;

// Server = { port, token, protocol, embedded?: true }: protocol is the server's, embedded marks one this process runs.

// Errors from request() carry `kind` (refused, timeout, aborted, failed); a non-2xx answer throws with `status` and `data`.
async function send(port, path, { method = "GET", body, timeoutMs = 1500, signal, headers = {}, maxBytes } = {}) {
  const res = await request(port, path, {
    maxBytes,
    method,
    // x-decide stays until Task 10 replaces 2.1's check with the token.
    headers: { "x-decide": "1", ...(body !== undefined && { "content-type": "application/json" }), ...headers },
    body,
    timeoutMs,
    signal,
  });
  if (res.status === 204) return null;
  const data = res.data ?? {};
  if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${data.error || ""}`), { status: res.status, data });
  return data;
}

// What to tell the user when this client and the home's server do not speak the same protocol.
function mismatch(mine, theirs, home) {
  const server = home ? `the decide server of ${home}` : "the decide server of this home";
  return theirs > mine
    ? `this session's decide speaks protocol ${mine} and ${server} speaks protocol ${theirs}, which no longer understands it: restart the session so it loads the newer decide`
    : `this session's decide speaks protocol ${mine} and ${server} speaks the older protocol ${theirs}: start a new round (ask or swipe) and it is replaced`;
}

// Every request to the home's server: its token and this client's protocol go with it.
export async function api(server, path, opts = {}) {
  const headers = { "x-decide-token": String(server.token), "x-decide-protocol": String(PROTOCOL) };
  try {
    return await send(server.port, path, { ...opts, headers });
  } catch (err) {
    if (err.status === 426) err.message = mismatch(PROTOCOL, err.data?.protocol ?? server.protocol);
    throw err;
  }
}

// What daemon.json's server is now: { state: "live", info } when its pid is alive and its port answers
// as decide of this home with that pid (info carries the protocol it answered with); { state: "silent",
// info } when its pid is alive but the port gave no answer in time (a server that is only busy, or a pid
// reused by something that hangs: nobody can tell yet); { state: "none" } otherwise. A dead pid's port is
// not asked: it may belong to something else by now. Only <home>/daemon.json is read, only its port asked.
export async function serverOf(home) {
  home = resolve(home);
  const info = readInfo(home);
  if (!info || !pidAlive(info.pid) || !Number.isInteger(info.port)) return { state: "none" };
  try {
    const pong = await send(info.port, "/api/ping", { timeoutMs: PING_MS, maxBytes: PING_BODY_MAX });
    return pong?.app === "decide" && pong.home === home && pong.pid === info.pid ? { state: "live", info: { ...info, protocol: pong.protocol } } : { state: "none" };
  } catch (err) {
    return err?.kind === "timeout" ? { state: "silent", info } : { state: "none" };
  }
}

// What to tell the user about a named server that does not answer. Nobody has confirmed it is decide.
export const silentServer = (home, info) =>
  `the decide server named in ${join(home, "daemon.json")} (pid ${info.pid}, port ${info.port}) is not answering`;

const serverFrom = (info) => ({ port: info.port, token: info.token, protocol: info.protocol, ...(info.pid === process.pid && { embedded: true }) });

// The running server of this home, or null. It never starts anything and never looks at another home.
export async function findServer(home) {
  const found = await serverOf(home);
  return found.state === "live" ? serverFrom(found.info) : null;
}

// For a caller that works with the home's running server and starts none (wait, push, explain, export,
// import, --wait, --reply): the server, or null when there is none. A named server that does not answer is
// busy, never absent: that throws the busy text (user: true), so nobody is told to ask again beside it.
export async function runningServer(home) {
  home = resolve(home);
  const found = await serverOf(home);
  if (found.state === "silent") throw Object.assign(new Error(busy(home, found.info, "so nothing was sent to it")), { user: true, busy: true });
  return found.state === "live" ? serverFrom(found.info) : null;
}

// How the user tells a decide server from a pid that something else reuses.
const commandOf = (pid) =>
  process.platform === "win32" ? `powershell -c "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"` : `ps -p ${pid} -o command=`;

// what: what this client did not do because of it.
export function busy(home, info, what = "so no second server was started beside it") {
  return [
    `${silentServer(home, info)}, ${what}. Try again shortly.`,
    `If it stays silent, check what pid ${info.pid} is before removing anything: ${commandOf(info.pid)} shows "decide.mjs serve" for a decide server (or the session's decide.mjs or mcp.mjs when it serves in-process).`,
    `Only if it is not decide, remove ${join(home, "daemon.json")} and ${join(home, "daemon.lock")} and try again: removing them while a decide server runs lets a second one start beside it.`,
  ].join(" ");
}

// True once nothing accepts connections on the port. How fast Windows refuses a closed loopback port has
// not been measured here: it may take up to about 2 s, hence a 3 s limit (or what is left of the budget).
const portFree = (port, ms = 3_000) =>
  new Promise((done) => {
    const socket = connect(port, "127.0.0.1");
    const timer = setTimeout(() => (socket.destroy(), done(false)), ms);
    socket.once("connect", () => (clearTimeout(timer), socket.destroy(), done(false)));
    socket.once("error", () => (clearTimeout(timer), done(true)));
  });

// Which older server was asked to hand over, and what the user can do about whatever went wrong after.
const askedToHandOver = (home, info) => `This session's decide asked the older decide server of ${home} (pid ${info.pid}, protocol ${info.protocol}) to hand over`;
const RETRY = "Try again: the rounds are on disk, and the next server serves them.";
const handoverError = (home, info, what) => Object.assign(new Error(`${askedToHandOver(home, info)}; ${what}. ${RETRY}`), { user: true });

// Asks an older server to hand over, then waits until its port is free (by giveUp at the latest).
// A server that is already going (another newer client asked first) answers 503, refuses or cuts the
// request: that is a handover too, and the caller's next pass finds what serves the home by then.
async function handover(home, info, protocol, giveUp) {
  const left = () => Math.max(0, giveUp - Date.now());
  try {
    await send(info.port, "/api/handover", { method: "POST", timeoutMs: Math.max(1, Math.min(5_000, left())), headers: { "x-decide-token": String(info.token), "x-decide-protocol": String(protocol) } });
  } catch (err) {
    if (err.status === 503 || err.kind === "refused" || err.kind === "failed") return;
    if (err.kind === "timeout") throw handoverError(home, info, "it did not answer within 5 s");
    throw handoverError(home, info, `it answered ${err.status}${err.data?.error ? ` (${err.data.error})` : ""} and is still serving`);
  }
  for (const end = Date.now() + Math.min(HANDOVER_MS, left()); ; await sleep(100)) {
    // A detached server exits once it has closed; an in-process one only lets go of the port.
    if (!pidAlive(info.pid) || (await portFree(info.port, Math.max(1, Math.min(3_000, end - Date.now()))))) return;
    if (Date.now() > end) throw handoverError(home, info, `it agreed, but still holds port ${info.port} after ${HANDOVER_MS / 1000} s`);
  }
}

// `node <engine> serve` for the home, detached, its output in <home>/daemon.log. The returned record
// follows the process: failed when it could not be spawned or exited with an error.
function spawnEngine(home, engine, port) {
  mkdirSync(home, { recursive: true });
  const started = { pid: 0, at: Date.now(), exited: false, failed: false, exitedAt: 0 };
  const end = (failed) => {
    if (!started.exited) Object.assign(started, { exited: true, failed, exitedAt: Date.now() });
  };
  let log;
  try {
    log = openSync(join(home, "daemon.log"), "a");
    const child = spawn(process.execPath, [engine, "serve", ...(port ? ["--port", String(port)] : [])], {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, DECIDE_HOME: home },
      windowsHide: true,
    });
    started.pid = child.pid;
    child.once("error", () => end(true));
    child.once("exit", (code) => end(code !== 0));
    child.unref();
  } catch {
    end(true);
  } finally {
    if (log !== undefined) closeSync(log);
  }
  return started;
}

// A server that serves home and that this client can talk to. A server it speaks with is used as it is;
// an older one is asked to hand over; a newer one it cannot speak with is an error (restart the session).
// None: `engine serve` is started detached, and only when no engine can start does this process serve
// the home itself (embedded). A named server that does not answer is waited for, never started beside.
// port: the port a started server tries first (decide.mjs --port), else the home's.
export async function ensureServer({ home, engine, protocol = PROTOCOL, port } = {}) {
  if (typeof home !== "string" || !home) throw new Error("ensureServer needs the decide home");
  home = resolve(home);
  const giveUp = Date.now() + GIVE_UP_MS;
  let started = null; // the engine this client started last
  let tries = 0;
  let silentSince = 0;
  let handedOver = null; // the older server this client asked to hand over, if it did
  // After a handover, an error says so: the user learns that an older server let go of the home before it.
  const failure = (message) => (handedOver ? Object.assign(new Error(`${message}. ${askedToHandOver(home, handedOver)}, and it did. ${RETRY}`), { user: true }) : new Error(message));
  const gaveUp = () => failure(`no decide server could start for ${home} within ${GIVE_UP_MS / 1000} s; see ${join(home, "daemon.log")}`);
  for (;;) {
    if (Date.now() > giveUp) throw gaveUp();
    const found = await serverOf(home);
    if (found.state === "live") {
      const theirs = found.info.protocol;
      if (speaks(theirs, protocol)) return serverFrom(found.info);
      if (!(protocol > theirs)) throw new Error(mismatch(protocol, theirs, home));
      await handover(home, found.info, protocol, giveUp);
      handedOver = found.info;
      started = null;
      continue;
    }
    if (found.state === "silent") {
      // Busy, not absent: nothing is started beside it and nothing served in-process instead. The engine
      // this client started gets the time it has to come up (it may be loading).
      silentSince ||= Date.now();
      const patience = started && !started.exited && found.info.pid === started.pid ? START_MS : BUSY_MS;
      if (Date.now() - silentSince >= patience || Date.now() > giveUp) throw failure(busy(home, found.info));
      await sleep(Math.min(150, Math.max(0, giveUp - Date.now())));
      continue;
    }
    silentSince = 0;
    if (started && !started.exited) {
      if (Date.now() - started.at > START_MS) throw failure(`the decide server started for ${home} (pid ${started.pid}) did not come up within ${START_MS / 1000} s; see ${join(home, "daemon.log")}`);
    } else if (started?.failed) {
      // No detached engine can run here: this process serves the home itself. null means another server
      // of this home won meanwhile (or this process serves it already): it is looked up again.
      if (++tries > TRIES) throw gaveUp();
      // Not bounded by the budget: an election cannot be called off, and it waits out a slow rival for
      // about 7 s at worst, so a last pass may run that much over GIVE_UP_MS.
      const own = await startServer({ home, embedded: true, protocol, ...(port && { port }) });
      if (own) return { port: own.port, token: own.token, protocol, embedded: true };
    } else if (!started || Date.now() - started.exitedAt > 1_000) {
      // Nothing started yet, or the engine stepped back for a server that has not shown up within a second.
      if (++tries > TRIES) throw gaveUp();
      started = spawnEngine(home, engine, port);
    }
    await sleep(Math.min(150, Math.max(0, giveUp - Date.now())));
  }
}

// Thin wrappers over api for today's callers (tools, commands, transfer); Task 13 replaces them.
export const postRound = (server, round) => api(server, "/api/rounds", { method: "POST", body: round, timeoutMs: 5000 });
export const postExplain = (server, id, body) => api(server, `/api/rounds/${id}/explain`, { method: "POST", body, timeoutMs: 5000 });
export const postPush = (server, id, body) => api(server, `/api/rounds/${id}/push`, { method: "POST", body, timeoutMs: 5000 });
export const getRoundView = (server, id) => api(server, `/api/rounds/${id}`);
export const postExport = (server, id, body) => api(server, `/api/rounds/${id}/export`, { method: "POST", body, timeoutMs: 120_000 });
export const postImport = (server, id, body) => api(server, `/api/rounds/${id}/import`, { method: "POST", body, timeoutMs: 10_000 });
export const getJournal = (server, limit, q = "") => api(server, `/api/journal?limit=${limit}&q=${encodeURIComponent(q)}`);

// One long-poll: the result, an { event: "ask" } (events only) or null on timeout.
export function waitOnce(server, id, { events = false, timeoutMs } = {}) {
  const qs = new URLSearchParams({ ...(events && { events: "1" }), ...(timeoutMs && { timeout: String(timeoutMs) }) });
  return api(server, `/api/rounds/${id}/wait?${qs}`, { timeoutMs: 0 });
}

// Blocks until the round ends (or, with events, until the user asks something).
export async function waitResult(server, id, outPath, { events = false } = {}) {
  let failures = 0;
  for (;;) {
    try {
      const result = await waitOnce(server, id, { events });
      failures = 0;
      if (result) return result;
    } catch (e) {
      if (e.status === 426) throw e;
      if (e.status === 404) return savedResult(outPath, id, e);
      failures += 1;
      if (failures >= 20) return savedResult(outPath, id, e);
      await sleep(500);
    }
  }
}

// Server gone or restarted: the answers file may still have been written.
function savedResult(outPath, id, error) {
  const saved = outPath && existsSync(outPath) && JSON.parse(readFileSync(outPath, "utf8"));
  if (saved && saved.round === id) return saved;
  throw new Error(`decide round ${id} is gone: ${error.message}`);
}
