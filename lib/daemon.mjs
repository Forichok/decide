// daemon.mjs — one long-lived loopback server per project data directory. It
// keeps the browser tab alive across rounds (SSE push), stores rounds, drafts,
// uploads and the live dialog, appends the journal, and answers the agent's
// long-poll when the user asks something or submits.

import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoots, mimeOf } from "./assets.mjs";
import { createRounds, WAIT_MS } from "./rounds.mjs";
import { collectMedia } from "./media.mjs";
import { appendJournal, readJournal } from "./journal.mjs";
import { hostAllowed, inside, readBody, readJson, reply, safeDecode } from "./http.mjs";
import { notify, openBrowser } from "./open.mjs";
import { words } from "./words.mjs";

export const VERSION = "1.0.0";
export const infoPath = (dir) => join(dir, ".decide-daemon.json");
const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));
const ASSET_CSP = "sandbox allow-scripts allow-popups";

export function startDaemon({ dir, port = 0, idleMs = 30 * 60_000, embedded = false }) {
  const roots = createRoots();
  const clients = new Set();
  const startedAt = Date.now();
  let lastActivity = Date.now();
  let actualPort = 0;

  const store = createRounds({
    roots,
    onChange: () => push("state", store.summary()),
    onDialog: (round) => push("dialog", { round: round.id, dialog: store.publicDialog(round) }),
    onFinish: (round, result) => appendJournal(dir, round, result),
  });
  const pageUrl = (id) => `http://127.0.0.1:${actualPort}/#r=${id}`;

  function push(event, data) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(chunk);
  }

  function announce(round, open) {
    if (!open) return;
    if (clients.size) return notify("decide", words(round.spec.lang).newRound(round.title));
    // A tab left from an earlier daemon on this port reconnects within ~1.5 s.
    const grace = Date.now() - startedAt < 5_000 ? 1_600 : 0;
    setTimeout(() => {
      if (!clients.size && round.status === "pending") openBrowser(pageUrl(round.id));
    }, grace);
  }

  const routes = {
    "GET /api/ping": (req, res) => reply(res, 200, { ok: true, version: VERSION, pid: process.pid }),
    "GET /api/state": (req, res) => reply(res, 200, { version: VERSION, ...store.summary() }),
    "GET /api/journal": (req, res, url) =>
      reply(res, 200, { entries: readJournal(dir, { limit: Number(url.searchParams.get("limit")) || 20, query: url.searchParams.get("q") || "" }) }),
    "GET /api/events": (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`retry: 1500\nevent: state\ndata: ${JSON.stringify(store.summary())}\n\n`);
      clients.add(res);
      const beat = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(beat);
        clients.delete(res);
      });
    },
    "POST /api/rounds": async (req, res) => {
      const body = await readJson(req);
      if (!body?.spec?.questions?.length || !body.outPath) return reply(res, 400, { error: "spec and outPath required" });
      const round = store.create({ spec: body.spec, outPath: resolve(body.outPath), source: String(body.source || ""), live: body.live === true });
      announce(round, body.open !== false);
      reply(res, 200, { id: round.id, url: pageUrl(round.id) });
    },
    "POST /api/shutdown": (req, res) => {
      reply(res, 200, { ok: true });
      setTimeout(stop, 50);
    },
    "POST /submit": async (req, res) => legacy(req, res, false),
    "POST /cancel": async (req, res) => legacy(req, res, true),
  };

  async function legacy(req, res, cancelled) {
    const round = store.newestPending();
    if (!round) return reply(res, 404, { error: "no pending round" });
    const body = cancelled ? {} : await readJson(req);
    store.finish(round, cancelled ? { cancelled: true } : body || {});
    reply(res, 200, { ok: true });
  }

  async function roundRoute(req, res, url, round, action) {
    const key = `${req.method} ${action}`;
    if (key === "GET ") {
      const { id, status, spec, draft, result, live, delivered } = round;
      return reply(res, 200, { id, status, spec, draft, result, live, delivered, listening: store.listening(round), dialog: store.publicDialog(round) });
    }
    if (key === "GET wait") {
      const timeoutMs = Number(url.searchParams.get("timeout")) || WAIT_MS;
      return store.wait(round, req, res, { events: url.searchParams.get("events") === "1", timeoutMs });
    }
    if (round.status !== "pending") return reply(res, 409, { error: `round is ${round.status}`, result: round.result });
    if (key === "PUT draft") {
      store.saveDraft(round, await readJson(req));
      return reply(res, 200, { ok: true });
    }
    if (key === "POST upload") {
      const buf = await readBody(req);
      const name = safeDecode(req.headers["x-file-name"]);
      return reply(res, 200, store.saveUpload(round, name, req.headers["content-type"] || "", buf));
    }
    if (key === "POST ask") {
      if (!round.live) return reply(res, 409, { error: "no agent is listening to this round" });
      const body = (await readJson(req)) || {};
      const entry = store.ask(round, { qid: String(body.question || ""), text: body.text });
      return reply(res, 200, { ok: true, id: entry.id });
    }
    if (key === "POST explain") {
      const body = (await readJson(req)) || {};
      const warnings = [];
      const media = collectMedia(body, "explain", { add: (l, w, m) => warnings.push(m), exists: existsSync, abs: (p) => resolve(p) });
      const entry = store.explain(round, { qid: String(body.question || ""), askId: body.askId, text: body.text, media: roots.publishNode(media) });
      return reply(res, 200, { ok: true, id: entry.id, warnings });
    }
    if (key === "POST submit") return reply(res, 200, { ok: true, result: store.finish(round, (await readJson(req)) || {}) });
    if (key === "POST cancel") return reply(res, 200, { ok: true, result: store.finish(round, { cancelled: true }) });
    reply(res, 404, { error: "not found" });
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (!hostAllowed(req.headers.host, actualPort)) return reply(res, 403, { error: "host not allowed" });
      if (!["GET", "HEAD"].includes(req.method) && req.headers["x-decide"] !== "1") {
        return reply(res, 403, { error: "missing x-decide header" });
      }
      if (url.pathname !== "/api/events") lastActivity = Date.now();
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

  function serveStatic(pathname, res) {
    const file = pathname === "/" ? join(UI_DIR, "index.html") : pathname.startsWith("/ui/") ? inside(UI_DIR, pathname.slice(4)) : roots.fileFor(pathname);
    if (!file) return reply(res, 404, { error: "not found" });
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      return reply(res, 404, { error: "not found" });
    }
    const headers = { "content-type": mimeOf(file), "cache-control": "no-store" };
    if (pathname.startsWith("/r/")) headers["content-security-policy"] = ASSET_CSP;
    res.writeHead(200, headers).end(buf);
  }

  function stop() {
    try {
      const info = JSON.parse(readFileSync(infoPath(dir), "utf8"));
      if (info.pid === process.pid) rmSync(infoPath(dir), { force: true });
    } catch {
      // no info file
    }
    for (const res of clients) res.end();
    server.close();
    if (!embedded) process.exit(0);
  }

  const sweeper = setInterval(() => {
    store.sweep(2 * 60 * 60_000);
    if (!store.pending().length && Date.now() - lastActivity > idleMs) stop();
  }, 10_000);
  sweeper.unref();

  return new Promise((resolveStart, reject) => {
    server.once("listening", () => {
      actualPort = server.address().port;
      if (!embedded) writeFileSync(infoPath(dir), JSON.stringify({ pid: process.pid, port: actualPort, version: VERSION, startedAt }));
      resolveStart({ port: actualPort, store, stop });
    });
    server.once("error", (e) => {
      if (e.code !== "EADDRINUSE" || !port) return reject(e);
      server.listen(0, "127.0.0.1");
    });
    server.listen(port, "127.0.0.1");
  });
}
