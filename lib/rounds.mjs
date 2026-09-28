// rounds.mjs — in-memory store of decision rounds for one daemon. A round is
// one questions spec waiting for the user; the agent long-polls it. A live
// round also carries a dialog: the user asks about a question, the waiting
// agent gets the ask as an event and posts an explanation back.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { digest } from "../ui/js/logic.js";
import { reply } from "./http.mjs";

export const WAIT_MS = 240_000; // under undici's 300 s headers timeout
// Agents re-call wait in a loop (Codex every ~75 s); a gap shorter than this still counts as listening.
export const LISTEN_GRACE_MS = 90_000;
const HISTORY = 30;

export function createRounds({ roots, onChange, onDialog = () => {}, onFinish = () => {}, listenGraceMs = LISTEN_GRACE_MS }) {
  const rounds = new Map();
  const history = [];
  let seq = 0;

  function create({ spec, outPath, source, live = false }) {
    const id = `${(++seq).toString(36)}-${randomBytes(3).toString("hex")}`;
    const round = {
      id,
      seq,
      title: spec.title,
      spec: roots.publish(spec),
      outPath,
      source,
      live: Boolean(live),
      base: outPath.replace(/\.json$/i, ""),
      status: "pending",
      createdAt: Date.now(),
      draft: null,
      result: null,
      dialog: [],
      waiters: new Set(),
      lastWaiter: Date.now(),
      delivered: false,
    };
    rounds.set(id, round);
    onChange();
    return round;
  }

  const get = (id) => rounds.get(id);
  const pending = () => [...rounds.values()].filter((r) => r.status === "pending");
  const newestPending = () => pending().sort((a, b) => b.seq - a.seq)[0];
  const unknown = () => Object.assign(new Error("unknown question"), { status: 400 });

  function saveDraft(round, draft) {
    round.draft = draft;
    writeFileSync(`${round.base}.draft.json`, JSON.stringify(draft, null, 2));
  }

  function saveUpload(round, name, type, buf) {
    const dir = `${round.base}.files`;
    mkdirSync(dir, { recursive: true });
    const safe = basename(name || "file").replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(-80) || "file";
    const file = join(dir, `${Date.now().toString(36)}-${safe}`);
    writeFileSync(file, buf);
    return { path: file, url: roots.urlFor(file), name: safe, size: buf.length, type };
  }

  function finish(round, payload) {
    if (round.status !== "pending") return round.result;
    const base = { version: 2, round: round.id, source: round.source, title: round.title };
    const submittedAt = new Date().toISOString();
    const talk = round.dialog.filter((d) => d.reply).map((d) => ({ question: d.qid, ask: d.ask, answer: d.reply.text }));
    const result = payload.cancelled
      ? { ...base, submittedAt, cancelled: true }
      : {
          ...base,
          submittedAt,
          elapsedSec: Number.isFinite(payload.elapsedSec) ? payload.elapsedSec : undefined,
          answers: payload.answers || {},
          ...(payload.comment ? { comment: String(payload.comment) } : {}),
          ...(payload.attachments?.length ? { attachments: payload.attachments.map(String) } : {}),
          ...(talk.length ? { dialog: talk } : {}),
        };
    if (!result.cancelled) result.digest = digest(round.spec, result);
    writeFileSync(round.outPath, JSON.stringify(result, null, 2));
    rmSync(`${round.base}.draft.json`, { force: true });
    round.status = result.cancelled ? "cancelled" : "answered";
    round.result = result;
    round.delivered = round.waiters.size > 0;
    for (const w of round.waiters) settle(round, w, done(round));
    history.unshift({ id: round.id, title: round.title, status: round.status, at: submittedAt, digest: result.digest || "", delivered: round.delivered });
    history.length = Math.min(history.length, HISTORY);
    onFinish(round, result);
    onChange();
    return result;
  }

  // What a waiter gets: the saved result plus where it was saved.
  const done = (round) => ({ ...round.result, file: round.outPath });

  function settle(round, w, body) {
    clearTimeout(w.timer);
    round.waiters.delete(w);
    if (body) reply(w.res, 200, body);
    else w.res.writeHead(204).end();
  }

  // events: this waiter also takes the user's live questions, not only the result.
  function wait(round, req, res, { events = false, timeoutMs = WAIT_MS } = {}) {
    if (round.status !== "pending") {
      markDelivered(round);
      return reply(res, 200, done(round));
    }
    const queued = events && round.dialog.find((d) => !d.delivered);
    if (queued) return reply(res, 200, deliver(round, queued));
    const w = { res, events };
    w.timer = setTimeout(() => settle(round, w, null), Math.max(1_000, Math.min(timeoutMs, WAIT_MS)));
    round.waiters.add(w);
    round.lastWaiter = Date.now();
    req.on("close", () => {
      clearTimeout(w.timer);
      round.waiters.delete(w);
      round.lastWaiter = Date.now();
      onChange();
    });
    onChange();
  }

  // The agent came back for answers the user sent while nobody was waiting.
  function markDelivered(round) {
    if (round.delivered) return;
    round.delivered = true;
    const entry = history.find((h) => h.id === round.id);
    if (entry) entry.delivered = true;
    onChange();
  }

  const listening = (round) => round.waiters.size > 0 || Date.now() - round.lastWaiter < listenGraceMs;

  function deliver(round, entry) {
    entry.delivered = true;
    const q = round.spec.questions.find((x) => x.id === entry.qid);
    return { event: "ask", round: round.id, ask: { id: entry.id, question: entry.qid, title: q?.title || entry.qid, text: entry.ask } };
  }

  function ask(round, { qid, text }) {
    if (!round.spec.questions.some((q) => q.id === qid)) throw unknown();
    const entry = { id: randomBytes(3).toString("hex"), qid, ask: String(text || "").slice(0, 4000), askedAt: Date.now(), delivered: false, reply: null };
    round.dialog.push(entry);
    const w = [...round.waiters].find((x) => x.events);
    if (w) settle(round, w, deliver(round, entry));
    onDialog(round);
    onChange();
    return entry;
  }

  // The agent's explanation answers the open ask for that question, or starts a new entry.
  function explain(round, { qid, askId, text, media }) {
    let entry = round.dialog.find((d) => (askId ? d.id === askId : d.qid === qid && !d.reply));
    if (!entry) {
      if (!round.spec.questions.some((q) => q.id === qid)) throw unknown();
      entry = { id: randomBytes(3).toString("hex"), qid, ask: "", askedAt: Date.now(), delivered: true, reply: null };
      round.dialog.push(entry);
    }
    entry.reply = { text: String(text || ""), ...media };
    entry.repliedAt = Date.now();
    onDialog(round);
    return entry;
  }

  const publicDialog = (round) => round.dialog.map(({ delivered, ...d }) => ({ ...d, seen: delivered }));

  // Drop rounds whose agent stopped waiting long ago (client killed / session ended),
  // and tell the page when an agent stops or starts listening.
  const heard = new Map();
  function sweep(maxOrphanMs) {
    let changed = false;
    for (const r of rounds.values()) {
      if (r.status !== "pending" && (r.delivered || r.status !== "answered")) continue;
      const now = listening(r);
      if (heard.has(r.id) && heard.get(r.id) !== now) changed = true;
      heard.set(r.id, now);
    }
    if (changed) onChange();
    for (const r of pending()) {
      if (!r.waiters.size && Date.now() - r.lastWaiter > maxOrphanMs) {
        r.status = "abandoned";
        onChange();
      }
    }
  }

  const summary = () => ({
    rounds: pending()
      .sort((a, b) => a.seq - b.seq)
      .map((r) => ({ id: r.id, title: r.title, createdAt: r.createdAt, count: r.spec.questions.length, live: r.live, waiting: r.waiters.size > 0, listening: listening(r) })),
    // Answers not picked up yet: the page shows whether the agent is still around to take them.
    history: history.map((h) => (h.delivered || !rounds.has(h.id) ? h : { ...h, listening: listening(rounds.get(h.id)) })),
  });

  return { create, get, pending, newestPending, saveDraft, saveUpload, finish, wait, ask, explain, publicDialog, listening, sweep, summary };
}
