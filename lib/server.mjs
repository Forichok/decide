// server.mjs — one long-lived loopback server per decide home, serving every
// project of that home. It is elected by binding the home's port (home.mjs):
// a second server of the same home finds the first there and steps back; when
// something else holds the port, the lock file elects one server, which takes
// any free port. Every winner holds the lock and names itself in daemon.json
// before it loads, and a server that answers slowly is never taken for absent. It keeps the browser tab alive
// across rounds (SSE push), serves the rounds of the on-disk store, appends
// each round's journal line to its own project, and hands the agent each item
// meant for it (GET …/next) until the agent acknowledges it (POST …/ack).

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoots, mimeOf } from "./assets.mjs";
import { createStore, WAIT_MS } from "./store/rounds.mjs";
import { collectMedia } from "./media.mjs";
import { buildExport, checkExportTarget, recordExport, writeHtml } from "./export.mjs";
import { checkAnswers, compareAnswers, formatComparison } from "./answers.mjs";
import { appendJournal, buildGraph, findDecision, graphMermaid, readJournal } from "./journal.mjs";
import { writeAdr } from "./adr.mjs";
import { fitBudget } from "./spec.mjs";
import { LEVELS, RULE_MODES, addRule, readLevel, readRules, removeRule, writeLevel } from "./settings.mjs";
import { ASSET_CSP, frameCsp, guard, inside, PAGE_CSP, parseTarget, readBody, readJson, reply, safeDecode } from "./http.mjs";
import { notify, openBrowser } from "./open.mjs";
import { injectBridge } from "./bridge.mjs";
import { words } from "./words.mjs";
import { decideHome, openProject } from "./project.mjs";
import { ensureHome, lockPath, pidAlive, portForHome, readInfo, writeInfo } from "./home.mjs";
import { PROTOCOL, speaks } from "./protocol.mjs";
import { PING_BODY_MAX, request } from "./request.mjs";
import { changesOf } from "../ui/js/logic.js";

// The engine the page names in a command to copy (`node <engine> wait <id>`).
const ENGINE = fileURLToPath(new URL("../decide.mjs", import.meta.url));

export const VERSION = "3.0.0";
const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));
const UI_REAL = realpathSync.native(UI_DIR);
// One ping's budget, and how long a rival keeps asking a named server that does not answer before it steps back.
const PROBE_MS = 1_000;
const PATIENCE_MS = 6_000;
// A lock this young whose pid is alive belongs to a server still starting, even if nothing serves for it yet.
const START_GRACE_MS = 10_000;

const isInside = (parent, child) => {
  const rel = relative(parent, child);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
};

const ofHome = (pong, home) => pong?.app === "decide" && pong.home === home;

// What is on a port. Only ever asked of the home's port or of the port daemon.json names.
// "home": a decide server of this home; "foreign": an answer that is not one; "refused": nobody
// listens; "unknown": no answer in time. A slow answer is never absence. Any other failure (an answer
// that is not HTTP, a connection reset or closed before an answer) is foreign: a decide server always
// speaks HTTP, and one that is only busy leaves the connection open without a word.
async function probe(port, home, ms = PROBE_MS) {
  try {
    const res = await request(port, "/api/ping", { timeoutMs: ms, maxBytes: PING_BODY_MAX });
    const pong = res.status >= 200 && res.status < 300 ? res.data : null;
    return { kind: ofHome(pong, home) ? "home" : "foreign", pong };
  } catch (err) {
    if (err.kind === "refused") return { kind: "refused" };
    if (err.kind === "timeout") return { kind: "unknown" };
    return { kind: "foreign" };
  }
}

const lockPid = (home) => {
  try {
    return Number(readFileSync(lockPath(home), "utf8").trim()) || 0;
  } catch {
    return 0;
  }
};
const holdsLock = (home) => lockPid(home) === process.pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A live pid that the lock or daemon.json names: a server of this home names itself in the lock right after
// it binds the home's port, and in daemon.json once it won.
const namedPid = (home, pid) => Number.isInteger(pid) && pid > 0 && pidAlive(pid) && (lockPid(home) === pid || readInfo(home)?.pid === pid);

// The lock as it is on disk: its pid (0 when empty) and its age, or null when there is none.
function readLock(home) {
  try {
    const file = lockPath(home);
    return { pid: Number(readFileSync(file, "utf8").trim()) || 0, age: Date.now() - statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

// A server of this home that may only be slow: another live pid whose lock is fresh (a server still
// starting), or that daemon.json names on a port that answers as this home or does not answer in
// time. The same rule lockStale holds a lock by, so a pid reused by some other process after a crash
// is not waited for. Returns { pid, port } (port null while it starts), or null.
async function slowServer(home) {
  const lock = readLock(home);
  const info = readInfo(home);
  for (const pid of new Set([lock?.pid, info?.pid])) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !pidAlive(pid)) continue;
    const port = info?.pid === pid && Number.isInteger(info.port) ? info.port : null;
    if (lock?.pid === pid && lock.age <= START_GRACE_MS) return { pid, port };
    if (port !== null && ["home", "unknown"].includes((await probe(port, home)).kind)) return { pid, port };
  }
  return null;
}

// A lock is stale when its pid is dead, or when its pid is alive but nothing serves for it past the
// starting grace: daemon.json does not name it, or its port refuses or answers as something else.
// A live pid that daemon.json names on a port that answers as this home, or does not answer in
// time, holds the lock whatever its age: a busy server is not an absent one.
async function lockStale(home, pid, age) {
  if (!pid) return age > START_GRACE_MS; // created, not written yet
  if (!pidAlive(pid)) return true;
  if (age <= START_GRACE_MS) return false;
  const info = readInfo(home);
  if (info?.pid !== pid || !Number.isInteger(info.port)) return true;
  const seen = await probe(info.port, home);
  return seen.kind === "refused" || seen.kind === "foreign";
}

// The lock file (wx, holding the pid) is taken by every winner: it names the home's server while
// it starts, and elects one server when the home's port is held by something else.
async function takeLock(home) {
  const file = lockPath(home);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    let pid;
    let age;
    try {
      pid = Number(readFileSync(file, "utf8").trim());
      age = Date.now() - statSync(file).mtimeMs;
    } catch {
      continue; // removed meanwhile: try again
    }
    if (pid === process.pid) return true;
    if (!(await lockStale(home, pid, age))) return false;
    rmSync(file, { force: true });
  }
  return false;
}

// A server of this home that daemon.json names, other than this process, alive and not shown absent:
// its port answers as this home, or does not answer in time.
async function rivalNamed(home) {
  const info = readInfo(home);
  if (!info || info.pid === process.pid || !pidAlive(info.pid) || !Number.isInteger(info.port)) return false;
  const seen = await probe(info.port, home);
  return seen.kind === "home" || seen.kind === "unknown";
}

function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

// home: the decide home (DECIDE_HOME or ~/.decide when omitted). port: the port to win, the home's by default.
// Resolves null when a decide server of the same home already serves it, or may be serving it but
// does not answer in time: a second server is never started beside one that is only slow.
// Test seams, not features: listenGraceMs (the store's listening grace), tickMs (the idle and listening timer),
// beforeLoad (called once the election is won, right before the store loads).
export async function startServer(options = {}) {
  const home = resolve(options.home ?? decideHome());
  // One election per home at a time in this process, and none while a server of this process serves
  // it: the lock and daemon.json tell processes apart by pid, which two servers of one process share.
  const before = elections.get(home) || Promise.resolve();
  let release;
  const turn = new Promise((r) => (release = r));
  const tail = before.then(() => turn);
  elections.set(home, tail);
  await before;
  try {
    return servingHere.has(home) ? null : await runServer({ ...options, home });
  } finally {
    release();
    if (elections.get(home) === tail) elections.delete(home);
  }
}

// Resolved home → the last election of this process queued for it; homes a server of this process serves.
const elections = new Map();
const servingHere = new Set();

async function runServer({ home, port, idleMs = 30 * 60_000, embedded = false, protocol = PROTOCOL, listenGraceMs, tickMs = 10_000, beforeLoad }) {
  ensureHome(home);
  const wanted = Number.isInteger(port) ? port : portForHome(home);
  const roots = createRoots({ home });
  const clients = new Set();
  // Pages that have the user's eye right now (focused and visible): page id → true.
  const watching = new Map();
  // Which connection a page's flag belongs to: an old stream closing late must not clear its reconnect's flag.
  const pageConn = new Map();
  const token = randomBytes(16).toString("hex");
  const startedAt = Date.now();
  let lastBusy = Date.now();
  let open = 0; // responses open right now, pings and early refusals excepted
  let actualPort = 0;
  let stopped = false;
  let heard = "";
  // Requests other than ping wait until the election is won and the store is loaded.
  let opened;
  const ready = new Promise((r) => (opened = r));

  const store = createStore({
    home,
    roots,
    ...(listenGraceMs ? { listenGraceMs } : {}),
    on: {
      change: () => pushState(),
      dialog: (round, entry) => {
        push("dialog", { round: round.id, dialog: store.publicDialog(round) });
        if (entry?.reply && entry.repliedAt) nudge(words(round.spec.lang).replied(round.title));
      },
      // 3.0: the round's view changed (an agent patch, a restore, a keep): the page applies it as a round patch.
      view: (round, view, seq) => push("round", { round: round.id, seq, patch: { view } }),
      deck: (round, info) => {
        push("deck", { round: round.id, deck: round.spec, swipe: store.swipeView(round) });
        if (info?.refilled) nudge(words(round.spec.lang).refilled(round.title));
      },
      // The journal line goes to the round's own project; a round with no spec file names its own answers.json.
      finish: (round, result) => appendJournal(round.dataDir, { mode: round.mode, spec: round.spec, specFile: round.specFile, outPath: round.outPath || round.answersFile, project: round.project }, result),
      // One question's answer, note or flag: every page on the round applies it; the inbox counts may move.
      round: (round, change) => {
        push("round", { round: round.id, ...change });
        pushInbox();
      },
    },
  });
  const pageUrl = (id) => `http://127.0.0.1:${actualPort}/#r=${id}`;

  // A request that resumes after stop() began touches nothing: it is answered 503.
  const STOPPING = "this decide server is stopping";
  const gate = () => {
    if (stopped) throw Object.assign(new Error(STOPPING), { status: 503 });
  };
  const json = async (req) => {
    const body = await readJson(req);
    gate();
    return body;
  };
  const raw = async (req) => {
    const buf = await readBody(req);
    gate();
    return buf;
  };

  function push(event, data) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(chunk);
  }

  // What the page last heard about who listens: the timer tells it when that changes on its own.
  const listeningOf = (summary) => JSON.stringify([...summary.rounds, ...summary.history].map((r) => [r.id, Boolean(r.listening)]));

  function pushState() {
    const summary = store.summary();
    heard = listeningOf(summary);
    push("state", { ...summary, engine: ENGINE });
    pushInbox();
  }

  // The inbox as the page last heard it: `event: inbox` goes out only when the list changed.
  let inboxHeard = "";
  function pushInbox() {
    const inbox = store.inbox();
    const text = JSON.stringify(inbox);
    if (text === inboxHeard) return;
    inboxHeard = text;
    push("inbox", inbox);
  }

  // A system notification, only while a page is open but nobody is looking at it: a page in
  // front already shows the news itself. DECIDE_NOTIFY=0 turns them off.
  function nudge(message) {
    if (process.env.DECIDE_NOTIFY === "0" || !clients.size || [...watching.values()].some(Boolean)) return;
    notify("decide", message);
  }

  function announce(round, open) {
    if (!open) return;
    if (clients.size) return nudge(words(round.spec.lang).newRound(round.title));
    // A tab left from an earlier server on this port reconnects within ~1.5 s.
    const grace = Date.now() - startedAt < 5_000 ? 1_600 : 0;
    setTimeout(() => {
      if (!clients.size && round.status === "pending") openBrowser(pageUrl(round.id));
    }, grace);
  }

  // The project a request names: the directory the client was started for, resolved as the client does,
  // in this server's own home (never the one the environment names).
  function projectOf(dir) {
    if (typeof dir !== "string" || !isAbsolute(dir) || !existsSync(dir)) return null;
    const project = openProject(dir, home);
    if (!isInside(home, project.dataDir)) throw Object.assign(new Error("the project's data dir is not inside this server's home"), { status: 400 });
    return project;
  }

  function journalOf(url) {
    const opts = {
      limit: Math.min(Number(url.searchParams.get("limit")) || 20, 500),
      query: url.searchParams.get("q") || "",
      status: ["live", "superseded"].includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "all",
      mode: ["questions", "swipe"].includes(url.searchParams.get("mode")) ? url.searchParams.get("mode") : "",
    };
    const named = url.searchParams.get("project");
    if (named) {
      const project = projectOf(named);
      return project ? readJournal(project, opts) : [];
    }
    // No project: every project of the home, newest first.
    const projects = join(home, "projects");
    let dirs = [];
    try {
      dirs = readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {}
    // Each entry says whose it is: the project root it was written for, else one a round of that data dir names.
    return dirs
      .flatMap((d) => {
        const dataDir = join(projects, d.name);
        const root = rootOf(dataDir);
        return readJournal(dataDir, opts).map((e) => {
          const project = e.project || root || d.name;
          return { ...e, project, projectName: e.project || root ? basename(project) : d.name.replace(/-[0-9a-f]{8}$/, "") };
        });
      })
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, opts.limit);
  }

  // The project root a data dir belongs to, from the meta.json of any of its rounds; "" when none says.
  function rootOf(dataDir) {
    let names = [];
    try {
      names = readdirSync(join(dataDir, "rounds"));
    } catch {
      return "";
    }
    for (const name of names) {
      try {
        const meta = JSON.parse(readFileSync(join(dataDir, "rounds", name, "meta.json"), "utf8"));
        if (typeof meta?.project === "string" && meta.project) return meta.project;
      } catch {}
    }
    return "";
  }

  const routes = {
    "GET /api/state": (req, res) => reply(res, 200, { version: VERSION, startedAt, ...store.summary(), engine: ENGINE }),
    "GET /api/journal": (req, res, url) => reply(res, 200, { entries: journalOf(url) }),
    "GET /api/inbox": (req, res) => reply(res, 200, store.inbox()),
    // The decision map: one project's (project=...) or every project's decisions as nodes and edges, and the same as Mermaid.
    "GET /api/map": (req, res, url) => {
      url.searchParams.set("limit", "500");
      url.searchParams.set("status", "all");
      const graph = buildGraph(journalOf(url), { round: url.searchParams.get("round") || "" });
      reply(res, 200, { ...graph, mermaid: graphMermaid(graph) });
    },
    "GET /api/events": (req, res, url) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      // hello first: a page that sees another startedAt than before knows the server was restarted.
      res.write(`retry: 1500\nevent: hello\ndata: ${JSON.stringify({ version: VERSION, protocol, startedAt })}\n\nevent: state\ndata: ${JSON.stringify({ ...store.summary(), engine: ENGINE })}\n\nevent: inbox\ndata: ${JSON.stringify(store.inbox())}\n\n`);
      clients.add(res);
      const page = String(url.searchParams.get("page") || "").slice(0, 40);
      if (page) watching.set(page, url.searchParams.get("watching") === "1"), pageConn.set(page, res);
      const beat = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(beat);
        clients.delete(res);
        if (page && pageConn.get(page) === res) watching.delete(page), pageConn.delete(page);
      });
    },
    // How much to ask: the level and the rules of one project (the page reads and edits them).
    "GET /api/settings": (req, res, url) => {
      const project = projectOf(url.searchParams.get("project"));
      if (!project) return reply(res, 400, { error: "project required: the absolute path of an existing directory" });
      reply(res, 200, { level: readLevel(project.dataDir), levels: LEVELS, rules: readRules(project.dataDir) });
    },
    "POST /api/settings": async (req, res) => {
      const body = (await json(req)) || {};
      const project = projectOf(body.project);
      if (!project) return reply(res, 400, { error: "project required: the absolute path of an existing directory" });
      if (!LEVELS.includes(body.level)) return reply(res, 400, { error: `level is one of: ${LEVELS.join(", ")}` });
      reply(res, 200, { level: writeLevel(project.dataDir, body.level) });
    },
    "POST /api/rules": async (req, res) => {
      const body = (await json(req)) || {};
      const project = projectOf(body.project);
      if (!project) return reply(res, 400, { error: "project required: the absolute path of an existing directory" });
      try {
        if (body.remove) removeRule(project.dataDir, String(body.remove));
        else if (!RULE_MODES.includes(body.mode)) return reply(res, 400, { error: `mode is one of: ${RULE_MODES.join(", ")}` });
        else addRule(project.dataDir, { text: body.text, mode: body.mode, question: body.question });
      } catch (e) {
        return reply(res, e.user ? 400 : 500, { error: e.message });
      }
      reply(res, 200, { rules: readRules(project.dataDir) });
    },
    "POST /api/watching": async (req, res) => {
      const body = (await json(req)) || {};
      const page = String(body.page || "").slice(0, 40);
      if (page && watching.has(page)) watching.set(page, body.watching === true);
      reply(res, 200, { ok: true });
    },
    "POST /api/rounds": async (req, res) => {
      const body = await json(req);
      const swipe = body?.mode === "swipe";
      if (!(swipe ? body?.spec?.cards?.length : body?.spec?.questions?.length)) return reply(res, 400, { error: "spec required" });
      const project = projectOf(body.project);
      if (!project) return reply(res, 400, { error: "project required: the absolute path of an existing directory" });
      const round = store.create({
        project,
        spec: body.spec,
        raw: body.raw ?? body.spec,
        outPath: typeof body.outPath === "string" && body.outPath ? resolve(body.outPath) : "",
        source: String(body.source || ""),
        specFile: typeof body.specFile === "string" && body.specFile ? resolve(body.specFile) : "",
        live: swipe || body.live === true || body.spec?.live === true,
        mode: swipe ? "swipe" : "questions",
      });
      announce(round, body.open !== false);
      reply(res, 200, { id: round.id, url: pageUrl(round.id) });
    },
    // The user's stop command: the guard has checked its token from daemon.json.
    "POST /api/stop": (req, res) => {
      reply(res, 200, { ok: true });
      setTimeout(stop, 50);
    },
    // A client of a newer protocol replaces this server: the pages are told, then it stops as stop() does.
    // Rounds stay on disk for the server that comes next.
    "POST /api/handover": (req, res) => {
      const theirs = Number(req.headers["x-decide-protocol"]);
      if (!Number.isInteger(theirs) || theirs <= protocol) return reply(res, 409, { error: `only a client of a protocol newer than ${protocol} may ask this server to hand over`, protocol });
      // The newer server takes the home's port, which this one lets go of now.
      push("handover", { protocol: theirs, url: `http://127.0.0.1:${wanted}/` });
      reply(res, 200, { ok: true });
      setTimeout(stop, 50);
    },
  };

  // GET …/next: the first item the agent has not acknowledged, { seq, kind, payload }, handed out again on
  // every call until POST …/ack names its seq; a finished round's final item goes to anyone who asks. Held
  // until there is one: nothing in time is a 204, another waiter taking the round over is { superseded: true }.
  // The agent names itself with ?waiter= (one id per agent process).
  async function next(req, res, url, round) {
    const waiter = String(url.searchParams.get("waiter") || randomBytes(6).toString("hex")).slice(0, 64);
    const gone = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) gone.abort();
    });
    const item = await store.next(round, {
      waiter,
      events: url.searchParams.get("events") === "1",
      timeoutMs: Number(url.searchParams.get("timeout")) || WAIT_MS,
      signal: gone.signal,
    });
    if (res.destroyed) return;
    if (stopped) return reply(res, 503, { error: STOPPING });
    if (!item) return res.writeHead(204).end();
    reply(res, 200, item);
  }

  async function roundRoute(req, res, url, round, action) {
    const key = `${req.method} ${action}`;
    if (key === "GET ") {
      // project, dataDir and specFile: what a tool needs to work on a round it knows only by id.
      // seq: the round's last event; a page applies `event: round` changes after it. answers, notes, flags: per question.
      const { id, mode, status, spec, draft, result, live, delivered, project, dataDir, specFile, seq, answers, notes, flags } = round;
      const files = status === "pending" ? store.files(round) : {};
      return reply(res, 200, { id, mode, status, seq, spec, draft, answers, notes, flags, files, result, live, delivered, project, dataDir, specFile, listening: store.listening(round), dialog: store.publicDialog(round), swipe: store.swipeView(round), view: store.roundView(round) });
    }
    if (key === "GET next") return next(req, res, url, round);
    // The agent has every item up to seq. Answered on a finished round too; an old or unknown seq changes nothing.
    if (key === "POST ack") {
      const body = (await json(req)) || {};
      store.ack(round, body.seq, String(body.waiter ?? "").slice(0, 64));
      return reply(res, 200, { ok: true, acked: round.state.acked });
    }
    // The page's "save as ADR": the answered round's decision goes into the repo, with no agent.
    if (key === "POST adr") {
      const entry = findDecision({ dataDir: round.dataDir, legacyDirs: [] }, round.id);
      if (!entry) return reply(res, 409, { error: "this round has no decision in the journal yet: answer it first" });
      const { file, created } = writeAdr({ root: round.top || round.project, entry, consequences: "" });
      return reply(res, 200, { ok: true, file, created });
    }
    if (round.status !== "pending") return reply(res, 409, { error: `round is ${round.status}`, result: round.result });
    // "I have 5 minutes": keep the questions that matter most, list the rest as left out.
    if (key === "POST fit") {
      if (round.mode === "swipe") return reply(res, 409, { error: "a swipe deck has no budget" });
      const body = (await json(req)) || {};
      const minutes = Math.max(1, Math.min(240, Number(body.minutes) || 5));
      const { kept, leftOut } = fitBudget(round.spec.questions, minutes * 60);
      store.refit(round, kept.map((q) => q.id), leftOut.map((q) => ({ id: q.id, title: q.title })), minutes);
      return reply(res, 200, { ok: true, kept: kept.length, leftOut: leftOut.length });
    }
    if (key === "POST export") {
      const body = (await json(req)) || {};
      // An inline round has no answers path to sit beside: its page goes to the round's own directory.
      const beside = round.outPath ? `${round.outPath.replace(/(\.answers)?\.json$/i, "")}.decide.html` : join(round.dir, "round.decide.html");
      // The working tree the round was opened from: where a relative `out` starts, and what "inside the project" means (the CLI judges the same).
      const top = round.top || round.project;
      const file = resolve(top, typeof body.out === "string" && body.out ? body.out : beside);
      // The CLI and MCP check this too; the route holds the line for any caller. Without `out` the file goes beside the answers file or into the round's own directory.
      if (typeof body.out === "string" && body.out && body.outside !== true) checkExportTarget(file, { root: top, top, dataDir: round.dataDir }, false);
      const { id, mode, spec } = round;
      const built = buildExport({ id, mode, spec }, roots.fileFor, { from: round.source });
      await writeHtml(file, built.html);
      recordExport(round.dataDir, { round: id, title: round.title, source: round.source, specFile: round.specFile, outPath: round.outPath || round.answersFile, file });
      return reply(res, 200, { ok: true, file, bytes: built.bytes, missing: built.missing });
    }
    if (key === "POST import") {
      const body = (await json(req)) || {};
      // The page may have answered while the body was on its way: then its answers stand and the import lost.
      if (round.status !== "pending") return reply(res, 409, { error: `round is ${round.status}: it was settled while the import was on its way; nothing was imported`, result: round.result });
      if (round.mode === "swipe") return reply(res, 409, { error: "import works on question rounds" });
      const files = Array.isArray(body.files) ? body.files : [];
      const spec = round.spec;
      const checked = files.map((f) => ({ name: typeof f?.name === "string" ? f.name.trim().slice(0, 80) : "", comment: typeof f?.comment === "string" ? f.comment : "", file: f?.file, ...checkAnswers(spec, f) }));
      const errors = checked.flatMap((c, i) => c.errors.map((e) => `${c.file || `file ${i + 1}`}: ${e}`));
      const warnings = checked.flatMap((c, i) => c.warnings.map((w) => `${c.file || `file ${i + 1}`}: ${w}`));
      if (!checked.length) errors.push("no answer files");
      if (errors.length) return reply(res, 422, { error: errors.join("; "), errors });
      // Several people: show where they disagree and leave the round open; one person settles it.
      if (checked.length > 1) {
        const { disagreements } = compareAnswers(spec, checked);
        return reply(res, 200, { ok: true, settled: false, report: formatComparison(spec, checked), disagreements: disagreements.length, warnings });
      }
      const [one] = checked;
      const result = store.finish(round, { answers: one.answers, comment: one.comment, elapsedSec: files[0].elapsedSec, name: one.name, importedFrom: one.file });
      return reply(res, 200, { ok: true, settled: true, result, file: round.outPath || round.answersFile, warnings });
    }
    if (key === "PUT draft") {
      store.saveDraft(round, await json(req));
      return reply(res, 200, { ok: true });
    }
    // One question at a time: { qid, answer } / { qid, text } / { qid, flag, revisit?, note? } → { seq }.
    if (key === "POST answer" || key === "POST note" || key === "POST flag") {
      const body = (await json(req)) || {};
      if (key === "POST answer") return reply(res, 200, store.saveAnswer(round, { qid: body.qid, answer: body.answer === undefined ? null : body.answer }));
      if (key === "POST note") return reply(res, 200, store.saveNote(round, { qid: body.qid, text: body.text }));
      return reply(res, 200, store.saveFlag(round, { qid: body.qid, flag: body.flag ?? null, revisit: body.revisit, note: body.note }));
    }
    if (key === "POST upload") {
      const buf = await raw(req);
      const name = safeDecode(req.headers["x-file-name"]);
      return reply(res, 200, store.saveUpload(round, name, req.headers["content-type"] || "", buf));
    }
    if (key === "POST ask") {
      if (!round.live) return reply(res, 409, { error: "no agent is listening to this round" });
      const body = (await json(req)) || {};
      const entry = store.ask(round, { qid: String(body.question || ""), text: body.text });
      return reply(res, 200, { ok: true, id: entry.id });
    }
    if (key === "POST explain") {
      const body = (await json(req)) || {};
      const warnings = [];
      // Relative paths are read from the project's working tree, which the client names (`base`); without it, from
      // the working tree the round was opened from (never the server's own cwd).
      const base = typeof body.base === "string" && isAbsolute(body.base) ? body.base : round.top || round.project;
      const media = collectMedia(body, "explain", { add: (l, w, m) => warnings.push(/^unknown field/.test(m) ? `${w}: ${m}` : m), exists: existsSync, abs: (p) => resolve(base, p), fieldLevel: "warn" });
      // Unpublished: the store publishes it on the way to the page.
      // 3.0: a patch rides with the reply; it is checked first, so a refused patch sends no reply either.
      let patched = null;
      try {
        patched = body.patch && typeof body.patch === "object" ? store.patch(round, body.patch) : null;
      } catch (e) {
        return reply(res, e.status || 500, { error: e.message, ...(e.issues ? { issues: e.issues } : {}) });
      }
      // What the reply changed: a list for the page to show under it (R8).
      const changes = changesOf(body);
      const entry = store.explain(round, { qid: String(body.question || ""), askId: body.askId, text: body.text, media: changes.length ? { ...media, changes } : media });
      return reply(res, 200, { ok: true, id: entry.id, warnings: [...warnings, ...(patched?.warnings ?? [])], ...(patched ? { seq: patched.seq } : {}) });
    }
    if (key === "POST swipe" || key === "POST push" || key === "POST deeper") {
      if (round.mode !== "swipe") return reply(res, 409, { error: "not a swipe round" });
      const body = (await json(req)) || {};
      if (key === "POST push") return reply(res, 200, { ok: true, ...store.push(round, body) });
      if (key === "POST deeper") return reply(res, 200, { ok: true, ...store.deeper(round, { note: typeof body.note === "string" ? body.note : "" }) });
      return reply(res, 200, { ok: true, answers: store.swipeAnswer(round, { card: String(body.card || ""), side: body.side, text: typeof body.text === "string" ? body.text : undefined, undo: body.undo === true, rev: Number.isInteger(body.rev) ? body.rev : undefined, ms: Number.isFinite(body.ms) ? body.ms : undefined }) });
    }
    // 3.0 rounds that react: the agent's patch, the user's restore of a ghost and keep of a stale answer.
    if (key === "POST patch" || key === "POST restore" || key === "POST keep") {
      const body = (await json(req)) || {};
      try {
        if (key === "POST patch") return reply(res, 200, { ok: true, ...store.patch(round, body) });
        const out = key === "POST restore" ? store.restore(round, body.id) : store.keep(round, body.qid);
        return reply(res, 200, { ok: true, seq: out.seq, view: out.view });
      } catch (e) {
        return reply(res, e.status || 500, { error: e.message, ...(e.issues ? { issues: e.issues } : {}) });
      }
    }
    if (key === "POST submit") {
      const body = (await json(req)) || {};
      try {
        return reply(res, 200, { ok: true, result: store.finish(round, body) });
      } catch (e) {
        if (e.stale) return reply(res, 409, { error: e.message, stale: e.stale });
        throw e;
      }
    }
    if (key === "POST cancel") return reply(res, 200, { ok: true, result: store.finish(round, { cancelled: true }) });
    if (key === "POST dismiss") return reply(res, 200, { ok: true, result: store.dismiss(round) });
    reply(res, 404, { error: "not found" });
  }

  const server = createServer(async (req, res) => {
    // Every answer is read as the type it says it is: a file served as text is never run as a script.
    res.setHeader("x-content-type-options", "nosniff");
    try {
      // Once stop() began this server no longer claims the home, not even to a ping.
      if (stopped) return reply(res, 503, { error: STOPPING });
      // The one reading of the target: the guard and the router both use its pathname.
      const url = parseTarget(req.url);
      if (!url) return reply(res, 400, { error: "bad request target" });
      const verdict = guard(req, { port: actualPort, token, pathname: url.pathname });
      if (!verdict.ok) return reply(res, verdict.status, { error: verdict.error });
      // Answered at once, also while the election runs: a rival server of this home must find this one.
      if (req.method === "GET" && url.pathname === "/api/ping") return reply(res, 200, { ok: true, app: "decide", protocol, version: VERSION, home, pid: process.pid });
      // A client names its protocol; one this server does not speak is refused before anything is done.
      // Not for ping (a client must learn what it talks to) nor handover (only a newer client asks for it).
      const theirs = req.headers["x-decide-protocol"];
      if (theirs !== undefined && url.pathname.startsWith("/api/") && !(req.method === "POST" && url.pathname === "/api/handover") && !speaks(protocol, Number(theirs))) {
        return reply(res, 426, { error: `this decide server speaks protocol ${protocol}, the client protocol ${String(theirs).slice(0, 20)}`, protocol });
      }
      // Busy means any open response but a ping: a held waiter, an SSE stream, a request whose body is
      // still arriving. The idle clock runs from the moment the last one closes. Counted before the
      // wait on the election: a client that gives up meanwhile has closed its response before the wait ends.
      open++;
      res.once("close", () => {
        open--;
        lastBusy = Date.now();
      });
      await ready;
      gate();
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) return await route(req, res, url);
      const m = url.pathname.match(/^\/api\/rounds\/([\w-]+)(?:\/(\w+))?$/);
      if (m) {
        const round = store.get(m[1]);
        return round ? await roundRoute(req, res, url, round, m[2] || "") : reply(res, 404, { error: "unknown round" });
      }
      if (req.method === "GET") return serveStatic(url.pathname, res);
      reply(res, 404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) reply(res, e.status || 500, { error: e.message });
    }
  });

  // A file of ui/, only when the URL spells its real path exactly: on a case-insensitive file system
  // /ui/Vendor/x would find vendor/x, and nothing may pick a policy by a spelling the disk does not use.
  function uiFile(rel) {
    const full = inside(UI_DIR, rel);
    if (!full) return null;
    try {
      const real = realpathSync.native(full);
      return real === join(UI_REAL, relative(resolve(UI_DIR), full)) ? real : null;
    } catch {
      return null;
    }
  }

  function serveStatic(pathname, res) {
    // An html block: a document of its own, served under the sandbox policy.
    const block = pathname.startsWith("/h/") ? roots.htmlFor(pathname) : null;
    if (block !== null) return void res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": ASSET_CSP }).end(block);
    // The installable page: the manifest and the service worker sit at the root so the worker's scope is "/".
    const pwa = pathname === "/manifest.webmanifest" || pathname === "/sw.js" ? uiFile(pathname.slice(1)) : null;
    const file = pwa ? pwa : pathname === "/" ? join(UI_REAL, "index.html") : pathname.startsWith("/ui/") ? uiFile(pathname.slice(4)) : roots.fileFor(pathname);
    if (!file) return reply(res, 404, { error: "not found" });
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      return reply(res, 404, { error: "not found" });
    }
    const headers = { "content-type": mimeOf(file), "cache-control": "no-store" };
    if (pwa && pathname === "/sw.js") headers["service-worker-allowed"] = "/";
    if (pathname.startsWith("/r/")) {
      headers["content-security-policy"] = ASSET_CSP;
      // A tune question's mockup gets the knobs bridge (bridge.mjs); the policy stays ASSET_CSP.
      if (roots.bridgeFor(pathname)) buf = Buffer.from(injectBridge(buf.toString("utf8")));
    } else if (/\.html?$/i.test(file)) {
      // The policy follows the real file, never the spelling of the URL. An html file of ui/ that is neither the page nor the frame is not served.
      if (file === join(UI_REAL, "vendor", "mermaid-frame.html")) headers["content-security-policy"] = frameCsp(buf.toString("utf8"));
      else if (file === join(UI_REAL, "index.html")) {
        headers["content-security-policy"] = PAGE_CSP;
        headers["x-frame-options"] = "DENY"; // the page only; its own frames (/r/, /h/) stay frameable by it
      } else return reply(res, 404, { error: "not found" });
    }
    res.writeHead(200, headers).end(buf);
  }

  let lockHeld = false;
  let ticker;

  // Idle: no open response (waiter, page stream, request in flight) for idleMs. An open round alone keeps nothing alive.
  // The same timer tells the page when an agent stops (or starts) listening. It never ends a round.
  // It starts once the election is won: it cannot stop a server that is still being elected.
  function startTicker() {
    lastBusy = Date.now();
    ticker = setInterval(() => {
      const summary = store.summary();
      if (listeningOf(summary) !== heard) pushState();
      else pushInbox(); // a round turns older with no event at all
      if (open) lastBusy = Date.now();
      else if (Date.now() - lastBusy > idleMs) stop();
    }, Math.max(10, Math.min(tickMs, idleMs)));
    ticker.unref();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    servingHere.delete(home);
    clearInterval(ticker);
    store.close();
    if (readInfo(home)?.pid === process.pid) rmSync(join(home, "daemon.json"), { force: true });
    if (lockHeld && holdsLock(home)) rmSync(lockPath(home), { force: true });
    for (const res of clients) res.end();
    server.close();
    server.closeIdleConnections?.();
    // A request still reading its body is answered 503 when it resumes; whatever lingers is cut.
    setTimeout(() => server.closeAllConnections?.(), 1_000).unref();
    if (!embedded) process.exit(0);
  }

  // Steps back from an election this process lost: nothing of this server stays behind. Only files that
  // name this process are removed: a daemon.json or lock of another pid belongs to the server that won.
  function lose() {
    stopped = true;
    clearInterval(ticker);
    store.close();
    if (readInfo(home)?.pid === process.pid) rmSync(join(home, "daemon.json"), { force: true });
    if (lockHeld && holdsLock(home)) rmSync(lockPath(home), { force: true });
    server.close();
    // Every connection is cut, those of requests that waited on the election too: they get no answer.
    server.closeAllConnections?.();
    // Their handlers, still awaiting ready, then run on into gate() and end against a stopped server
    // without touching the store.
    opened();
    return null;
  }

  // On EADDRINUSE: who holds the home's port? A server of this home that may only be slow (see
  // slowServer) is waited for and never started beside; anything else that hangs there is foreign.
  async function holderOf(port) {
    let seen = await probe(port, home);
    if (seen.kind === "home") return proven(port, seen);
    if (seen.kind !== "unknown") return seen.kind;
    const other = await slowServer(home);
    if (!other) return "foreign"; // nothing of this home may be serving: something else hangs on the port
    const end = Date.now() + PATIENCE_MS;
    while (Date.now() < end) {
      if (other.port !== null && other.port !== port) {
        const there = await probe(other.port, home);
        if (there.kind === "home" && there.pong?.pid === other.pid) return "home";
        if (there.kind !== "unknown") return "foreign"; // the named pid serves nothing there
      }
      seen = await probe(port, home);
      if (seen.kind === "home") return proven(port, seen);
      if (seen.kind !== "unknown") return seen.kind;
    }
    return "home"; // still no answer: step back rather than start a second writer
  }

  // Anything can answer a ping with this home's name: the home's port is stepped back from only when the pid
  // that answers is the one the lock or daemon.json names. A server that has just bound the port may not have
  // written the lock yet, so its pid gets PATIENCE_MS to appear there; one that never does is a squatter.
  async function proven(port, seen) {
    const end = Date.now() + PATIENCE_MS;
    while (!namedPid(home, seen.pong?.pid)) {
      if (Date.now() > end) return "foreign";
      await sleep(100);
      const again = await probe(port, home);
      if (again.kind === "home") seen = again;
      else if (again.kind !== "unknown") return again.kind;
    }
    return "home";
  }

  // ---- the election
  let onFixedPort = true;
  try {
    await listen(server, wanted);
    // Set at once: hostAllowed checks it, and a rival's ping must be answered during the election.
    actualPort = server.address().port;
  } catch (err) {
    if (err.code !== "EADDRINUSE") throw err;
    onFixedPort = false;
  }
  if (!onFixedPort) {
    if ((await holderOf(wanted)) === "home") return lose();
  }
  // Every winner holds the lock: a live, fresh lock is a server still starting, an older one a server
  // daemon.json names; either way this process steps back.
  if (!(await takeLock(home))) return lose();
  lockHeld = true;
  if (!onFixedPort) {
    try {
      await listen(server, 0);
      actualPort = server.address().port;
    } catch (e) {
      lose();
      throw e;
    }
  }
  // A server of this home that daemon.json names elsewhere (elected while the port was taken) keeps serving.
  if (await rivalNamed(home)) return lose();

  // Named before the load, so a rival that finds this server busy loading knows it is there. The lock
  // is checked in the same synchronous step as the write: a rival that replaced the same stale lock
  // meanwhile wins, and this process never writes over the daemon.json that rival is about to write.
  if (!holdsLock(home)) return lose();
  writeInfo(home, { pid: process.pid, port: actualPort, protocol, version: VERSION, home, token, startedAt });
  if (!holdsLock(home)) return lose();
  try {
    beforeLoad?.();
    store.load();
  } catch (err) {
    // No half-server: a server named in daemon.json whose requests wait forever on a load that failed.
    lose();
    throw err;
  }
  heard = listeningOf(store.summary());
  if (!embedded) {
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }
  servingHere.add(home);
  startTicker();
  opened();
  return { port: actualPort, token, store, stop };
}
