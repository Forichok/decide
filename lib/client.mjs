// client.mjs — the agent side: find the decide home's server, check that it
// speaks this client's protocol, start one when there is none, and ask an
// older one to hand over. A client never stops a server: the only ways one
// stops are idle, the user's stop command (commands.mjs) and a handover it agreed to.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.mjs";
import { WAIT_MS } from "./store/rounds.mjs";
import { pidAlive, readInfo } from "./home.mjs";
import { PROTOCOL, speaks } from "./protocol.mjs";
import { PING_BODY_MAX, request } from "./request.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The engine a client starts when the home has no server: this plugin's decide.mjs.
const ENGINE = fileURLToPath(new URL("../decide.mjs", import.meta.url));
// This process's waiter id: one per agent process, sent with every next and ack.
export const WAITER = randomBytes(8).toString("hex");
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

// Server = { port, token, protocol, home, pid, embedded?: true }: protocol is the server's, embedded marks one this process runs.

// Errors from request() carry `kind` (refused, timeout, aborted, failed); a non-2xx answer throws with `status` and `data`.
async function send(port, path, { method = "GET", body, timeoutMs = 1500, signal, headers = {}, maxBytes } = {}) {
  const res = await request(port, path, {
    maxBytes,
    method,
    headers: { ...(body !== undefined && { "content-type": "application/json" }), ...headers },
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

// Every request to the home's server: its token and this client's protocol go with it. A server that came
// back has a new token, so a handle that knows its home and is refused (403) reads daemon.json again, once,
// and sends the request again when the token there is a different one; a refusal the new token does not cure
// is the guard's answer and is thrown. The handle is updated in place: a held handle follows the server.
export async function api(server, path, opts = {}) {
  const attempt = () => send(server.port, path, { ...opts, headers: { "x-decide-token": String(server.token), "x-decide-protocol": String(PROTOCOL) } });
  try {
    try {
      return await attempt();
    } catch (err) {
      if (err.status !== 403 || !server.home) throw err;
      const found = await findServer(server.home);
      if (!found || found.token === server.token) throw err;
      follow(server, found);
      return await attempt();
    }
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

// home: the decide home it serves, so a wait can find the home's server again after a restart.
const serverFrom = (info) => ({ port: info.port, token: info.token, protocol: info.protocol, home: resolve(info.home), pid: info.pid, ...(info.pid === process.pid && { embedded: true }) });

// A handle on a named server that does not answer (info from a busy error), for a wait that keeps trying it.
export const heldServer = (home, info) => ({ port: info.port, token: info.token, protocol: info.protocol, home: resolve(home), pid: info.pid });

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
  if (found.state === "silent") throw Object.assign(new Error(busy(home, found.info, "so nothing was sent to it")), { user: true, busy: true, info: found.info });
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
  // tags: busy (a named server that does not answer) or mismatch (a server too new), for waitNext's retry.
  const failure = (message, tags = {}) =>
    Object.assign(handedOver ? Object.assign(new Error(`${message}. ${askedToHandOver(home, handedOver)}, and it did. ${RETRY}`), { user: true }) : new Error(message), tags);
  const gaveUp = () => failure(`no decide server could start for ${home} within ${GIVE_UP_MS / 1000} s; see ${join(home, "daemon.log")}`);
  for (;;) {
    if (Date.now() > giveUp) throw gaveUp();
    const found = await serverOf(home);
    if (found.state === "live") {
      const theirs = found.info.protocol;
      if (speaks(theirs, protocol)) return serverFrom(found.info);
      if (!(protocol > theirs)) throw Object.assign(new Error(mismatch(protocol, theirs, home)), { mismatch: true });
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
      if (Date.now() - silentSince >= patience || Date.now() > giveUp) throw failure(busy(home, found.info), { busy: true, info: found.info });
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
      if (own) return { port: own.port, token: own.token, protocol, home, pid: process.pid, embedded: true };
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

// ---- delivery: an item is handed out again and again until the agent acknowledges it

// How long past the server's hold a wait may take before it counts as failed (a server that froze). Never
// more than a second past the wait's own time: an item cut off then was not acknowledged, so it comes again.
const HOLD_SLACK_MS = 5_000;
const LATE_MS = 1_000;
// A wait that failed (refused, cut, timed out, 503 stopping) is tried again after RETRY_MS; after RETRIES
// failures in a row the home's server is found, or started, again: it may have been killed and restarted, or
// handed over.
const RETRY_MS = 500;
const RETRIES = 3;

// A sleep that an abort ends early.
const pause = (ms, signal) =>
  new Promise((done) => {
    if (signal?.aborted) return done();
    const finish = () => (clearTimeout(timer), signal?.removeEventListener("abort", finish), done());
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });

// The handle follows the home's server: after a restart or a handover it names the new one.
function follow(server, fresh) {
  for (const key of Object.keys(server)) delete server[key];
  Object.assign(server, fresh);
}

const unknownRound = (server, id) =>
  Object.assign(new Error(`round ${id} is unknown to the decide server of ${server.home || "this home"}: it was never opened in this home, or its files were removed`), { status: 404, user: true });

// Item = { seq, kind: "ask" | "batch" | "deeper" | "final" | "cancel" | "dismissed", payload }.
// One wait for round id's next item: the first one this agent has not acknowledged, held by the server for up
// to timeoutMs. Resolves the Item, { superseded: true } when another waiter took the round over, or null when
// nothing came in time (or signal aborted). Nothing is acknowledged here: ack() once the agent has the item.
// A network failure is not an answer and never "not running": the request is tried again every 0.5 s, and
// after three failures in a row the home's server is found or started again (the round is on disk), all
// within timeoutMs. A busy server (one that does not answer, or answers 503 while it stops) is waited for,
// never started beside. Throws for a round the server does not know (404, naming it), a server that no longer
// speaks this protocol (426), any other refusal (4xx) and any other server error (5xx, with its text): those
// are answers, and trying them again until the time is up would hide them behind "still waiting".
// server is updated in place when the home's server changed, so an ack after it reaches the new one.
// report (optional): report.answered turns true once the server answered anything during this call.
export async function waitNext(server, id, { waiter = WAITER, events = false, timeoutMs = WAIT_MS, signal, engine = ENGINE, report = {} } = {}) {
  const end = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let failures = 0;
  for (;;) {
    if (signal?.aborted) return null;
    const left = end - Date.now();
    const hold = Math.max(1_000, Math.min(left, WAIT_MS));
    const qs = new URLSearchParams({ waiter: String(waiter), timeout: String(hold), ...(events && { events: "1" }) });
    try {
      const got = await api(server, `/api/rounds/${encodeURIComponent(id)}/next?${qs}`, { timeoutMs: Math.min(hold + HOLD_SLACK_MS, Math.max(left, 0) + LATE_MS), signal });
      report.answered = true;
      return got;
    } catch (err) {
      if (signal?.aborted || err.kind === "aborted") return null;
      if (err.status) report.answered = true;
      if (err.status === 404) throw unknownRound(server, id);
      if (err.status && err.status !== 503) throw serverError(server, id, err);
      failures += 1;
    }
    if (Date.now() + RETRY_MS >= end) return null;
    await pause(RETRY_MS, signal);
    if (failures >= RETRIES && server.home) {
      failures = 0;
      // ensureServer is not bounded by this wait's time or signal (it is not redesigned for it): at worst it
      // takes its own GIVE_UP_MS (30 s) plus an election that waits out a slow rival (about 7 s), so a wait
      // may end that much past timeoutMs, and an abort is seen only once it returns. Both are checked before
      // it is called and after it returns, so neither is overrun more than that once.
      if (signal?.aborted || Date.now() + RETRY_MS >= end) return null;
      try {
        follow(server, await ensureServer({ home: server.home, engine }));
      } catch (err) {
        if (!err.busy) throw err; // busy is not an answer either: tried again within the budget
      }
      if (signal?.aborted || Date.now() >= end) return null;
    }
  }
}

// A server error that is an answer (anything but 503): the agent gets the server's own text at once.
function serverError(server, id, err) {
  if (err.status < 500) return err;
  const said = err.data?.error ? `: ${err.data.error}` : "";
  const next = "The round is still open and its answers are on disk: tell the user what the server said, then call wait again.";
  return Object.assign(new Error(`the decide server of ${server.home || "this home"} could not serve round ${id} (HTTP ${err.status})${said}. ${next}`),{ status: err.status, data: err.data, user: true });
}

// The agent has every item of round id up to seq. An ack of a seq already acknowledged is a no-op. A server
// that went away is looked up once more (it may have been restarted); when that fails too, this throws and
// the item is handed out again on the next wait: delivery is at least once.
export async function ack(server, id, seq, waiter = WAITER) {
  const send = () => api(server, `/api/rounds/${encodeURIComponent(id)}/ack`, { method: "POST", body: { seq, waiter: String(waiter) }, timeoutMs: 5_000 });
  try {
    await send();
  } catch (err) {
    if (err.status === 404) throw unknownRound(server, id);
    if (err.status || !server.home) throw err;
    const found = await runningServer(server.home);
    if (!found) throw err;
    follow(server, found);
    await send();
  }
}

// The caller that settled a round itself (import) has its answers: acknowledge the final item, so no
// other session is told the round is uncollected. A failure is not an error: the round then stays announced.
export async function collectFinal(server, id, waiter = WAITER) {
  const item = await waitNext(server, id, { waiter, timeoutMs: 1_000 });
  if (item?.kind === "final") await ack(server, id, item.seq, waiter);
}

// What the 2.1 callers read: the payload (an { event } for ask, batch and deeper; the result otherwise),
// and a dismissed round's result says so.
const valueOf = (item) => (item.kind === "dismissed" ? { ...item.payload, status: "dismissed" } : item.payload);

// The caller gets the value first (use); the item is acknowledged once use has returned. A failed ack is
// not an error: the item comes again on the next wait.
async function deliver(server, id, item, waiter, use) {
  if (item.superseded) throw Object.assign(new Error(`another session took over the wait for round ${id}`), { superseded: true, user: true });
  const out = await use(valueOf(item));
  if (item.kind !== "dismissed") await ack(server, id, item.seq, waiter).catch(() => {});
  return out;
}

// One wait: use(value) for the next item (the answers, an { event } item, a dismissed round's result) and what
// it returns, or null when nothing came within timeoutMs.
export async function waitOnce(server, id, { events = false, timeoutMs, waiter = WAITER, use = (v) => v } = {}) {
  const item = await waitNext(server, id, { events, timeoutMs, waiter });
  return item ? deliver(server, id, item, waiter, use) : null;
}

// Blocks until the round ends (or, with events, until the user asks something): use(value), then the ack.
export async function waitResult(server, id, outPath, { events = false, waiter = WAITER, use = (v) => v } = {}) {
  for (;;) {
    let item;
    const started = Date.now();
    try {
      item = await waitNext(server, id, { events, waiter });
    } catch (e) {
      if (e.status === 404) return use(savedResult(outPath, id, e));
      throw e;
    }
    if (item) return deliver(server, id, item, waiter, use);
    // Nothing, and back before the hold was up: something let go of this waiter. Never loop on that without
    // a pause of its own (the same pause as the MCP wait's).
    if (Date.now() - started < WAIT_MS - 1_000) await sleep(1_000);
  }
}

// Server gone or restarted: the answers file may still have been written.
function savedResult(outPath, id, error) {
  const saved = outPath && existsSync(outPath) && JSON.parse(readFileSync(outPath, "utf8"));
  if (saved && saved.round === id) return saved;
  throw new Error(`decide round ${id} is gone: ${error.message}`);
}
