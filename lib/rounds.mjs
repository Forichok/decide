// rounds.mjs — in-memory store of decision rounds for one daemon. A round is
// one questions spec waiting for the user; the agent long-polls it. A live
// round also carries a dialog: the user asks about a question, the waiting
// agent gets the ask as an event and posts an explanation back. A swipe round
// (mode "swipe") holds a deck of two-sided cards instead of questions: the
// user's answers reach the agent in batches, and the agent pushes back the
// brief and new cards while the user keeps going.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { digest } from "../ui/js/logic.js";
import { reply } from "./http.mjs";
import { applyPatch, batchDigest, briefMarkdown, deckStats, finalDigest, LOW_WATER, OWN_MAX, sideLabel } from "./swipe.mjs";

export const WAIT_MS = 240_000; // under undici's 300 s headers timeout
// Agents re-call wait in a loop (Codex every ~75 s); a gap shorter than this still counts as listening.
export const LISTEN_GRACE_MS = 90_000;
const HISTORY = 30;

// The things a user can ask about: questions, or cards in a swipe round.
const items = (round) => (round.mode === "swipe" ? round.spec.cards : round.spec.questions);

export function createRounds({ roots, onChange, onDialog = () => {}, onDeck = () => {}, onFinish = () => {}, listenGraceMs = LISTEN_GRACE_MS }) {
  const rounds = new Map();
  const history = [];
  let seq = 0;

  const publishCard = (c) => ({ ...roots.publishNode(c), left: roots.publishNode(c.left), right: roots.publishNode(c.right) });

  function create({ spec, outPath, source, live = false, mode = "questions" }) {
    const id = `${(++seq).toString(36)}-${randomBytes(3).toString("hex")}`;
    const swipe = mode === "swipe";
    const round = {
      id,
      seq,
      mode: swipe ? "swipe" : "questions",
      title: spec.title,
      spec: swipe ? { ...spec, cards: spec.cards.map(publishCard) } : roots.publish(spec),
      // answers: card → {side, at}; log: every move in order; sent: how much of the log the agent has seen.
      swipe: swipe ? { answers: {}, log: [], sent: 0, seen: {}, batches: 0, thinking: false, briefAt: 0, pinned: null, lowSent: false } : null,
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
    if (round.mode === "swipe") return finishSwipe(round, payload);
    return settleResult(round, buildResult(round, payload));
  }

  function buildResult(round, payload) {
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
    return result;
  }

  // The swipe result: every answer, the agent's brief, and the brief as markdown next to the answers.
  function finishSwipe(round, payload) {
    const deck = round.spec;
    const { answers } = round.swipe;
    const base = { version: 2, mode: "swipe", round: round.id, source: round.source, title: round.title, submittedAt: new Date().toISOString() };
    if (payload.cancelled) return settleResult(round, { ...base, cancelled: true });
    const briefFile = round.outPath.replace(/(\.answers)?\.json$/i, "") + ".brief.md";
    writeFileSync(briefFile, briefMarkdown(deck, answers));
    const talk = round.dialog.filter((d) => d.reply).map((d) => ({ question: d.qid, ask: d.ask, answer: d.reply.text }));
    const unread = pendingEntries(round);
    return settleResult(round, {
      ...base,
      goal: deck.goal,
      stoppedBy: deck.done ? "agent" : "user",
      stats: deckStats(deck, answers),
      confidence: deck.confidence,
      answers: Object.fromEntries(deck.cards.filter((c) => answers[c.id]).map((c) => [c.id, { side: answers[c.id].side, label: sideLabel(c, answers[c.id].side, answers[c.id].text) }])),
      brief: deck.brief,
      briefFile,
      ...(unread.length ? { unread: batchDigest(deck, unread) } : {}),
      ...(talk.length ? { dialog: talk } : {}),
      digest: finalDigest(deck, answers),
    });
  }

  function settleResult(round, result) {
    writeFileSync(round.outPath, JSON.stringify(result, null, 2));
    rmSync(`${round.base}.draft.json`, { force: true });
    round.status = result.cancelled ? "cancelled" : "answered";
    round.result = result;
    round.delivered = round.waiters.size > 0;
    for (const w of round.waiters) settle(round, w, done(round));
    history.unshift({ id: round.id, title: round.title, status: round.status, at: result.submittedAt, digest: result.digest || "", delivered: round.delivered });
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
    if (events && batchReady(round)) return reply(res, 200, deliverBatch(round));
    if (round.swipe?.thinking) {
      round.swipe.thinking = false;
      onDeck(round);
    }
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
    const q = items(round).find((x) => x.id === entry.qid);
    return { event: "ask", round: round.id, ask: { id: entry.id, question: entry.qid, title: q?.title || entry.qid, text: entry.ask } };
  }

  function ask(round, { qid, text }) {
    if (!items(round).some((q) => q.id === qid)) throw unknown();
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
      if (!items(round).some((q) => q.id === qid)) throw unknown();
      entry = { id: randomBytes(3).toString("hex"), qid, ask: "", askedAt: Date.now(), delivered: true, reply: null };
      round.dialog.push(entry);
    }
    entry.reply = { text: String(text || ""), ...media };
    entry.repliedAt = Date.now();
    onDialog(round);
    return entry;
  }

  // ---- swipe: answers in, batches out, pushes back in

  // The moves since the last batch, one per card (its latest), minus the ones that undo nothing the agent saw.
  function pendingEntries(round) {
    const { log, sent, seen } = round.swipe;
    const last = new Map();
    for (const e of log.slice(sent)) {
      last.delete(e.card);
      last.set(e.card, e);
    }
    return [...last.values()].filter((e) => (e.undo ? Boolean(seen[e.card]) : seen[e.card] !== seenKey(e)));
  }

  // What the agent saw for a card: the side, and for an own answer its text too.
  const seenKey = (e) => (e.side === "own" ? `own:${e.text}` : e.side);

  function batchReady(round) {
    if (round.mode !== "swipe" || round.status !== "pending") return false;
    const n = pendingEntries(round).length;
    if (n === 0) return false;
    const left = deckStats(round.spec, round.swipe.answers).left;
    // Running low: one early batch, so the agent can refill the deck in time; again only after it adds cards.
    const low = left <= LOW_WATER && !round.spec.done && !round.swipe.lowSent;
    return n >= round.spec.batch || left === 0 || low;
  }

  function deliverBatch(round) {
    const s = round.swipe;
    const entries = pendingEntries(round);
    s.sent = s.log.length;
    for (const e of entries) {
      if (e.undo) delete s.seen[e.card];
      else s.seen[e.card] = seenKey(e);
    }
    s.batches += 1;
    s.thinking = true;
    const stats = deckStats(round.spec, s.answers);
    if (stats.left <= LOW_WATER) s.lowSent = true;
    onDeck(round);
    return {
      event: "batch",
      round: round.id,
      batch: s.batches,
      entries: entries.map((e) => ({ card: e.card, side: e.undo ? null : e.side, ...(e.side === "own" ? { text: e.text } : {}), undo: Boolean(e.undo) })),
      digest: batchDigest(round.spec, entries),
      stats,
      done: round.spec.done,
      confidence: round.spec.confidence,
    };
  }

  function offerBatch(round) {
    if (!batchReady(round)) return;
    // The newest waiter: an older one may belong to a wait call the agent abandoned.
    const w = [...round.waiters].findLast((x) => x.events);
    if (w) settle(round, w, deliverBatch(round));
  }

  // The card on the user's screen, as the page picks it: one brought back by undo, else the first open one.
  function frontCard(round) {
    const { answers, pinned } = round.swipe;
    if (pinned && !answers[pinned] && round.spec.cards.some((c) => c.id === pinned)) return pinned;
    return round.spec.cards.find((c) => !answers[c.id])?.id ?? null;
  }

  const swipeError = (message) => Object.assign(new Error(message), { status: 400 });

  // side: "left" | "right" | "skip" | "own" (with text: the user's own answer); undo: true takes the card's answer back.
  // rev: the card revision the page showed; a push may have rewritten the card since.
  function swipeAnswer(round, { card, side, text, undo = false, rev }) {
    const shown = round.spec.cards.find((c) => c.id === card);
    if (!shown) throw swipeError("unknown card");
    if (!undo && rev !== undefined && (shown.rev || 0) !== rev) throw Object.assign(new Error("the card changed"), { status: 412 });
    const { answers, log } = round.swipe;
    if (undo) {
      if (!answers[card]) throw swipeError("that card has no answer to take back");
      delete answers[card];
      round.swipe.pinned = card; // the page brings it back to the front
      log.push({ card, undo: true, at: Date.now() });
    } else {
      if (!["left", "right", "skip", "own"].includes(side)) throw swipeError("side must be left, right, skip or own");
      const own = side === "own" ? String(text ?? "").trim().slice(0, OWN_MAX) : "";
      if (side === "own" && !own) throw swipeError("an own answer needs text");
      const extra = side === "own" ? { text: own } : {};
      answers[card] = { side, ...extra, at: Date.now() };
      if (round.swipe.pinned === card) round.swipe.pinned = null;
      log.push({ card, side, ...extra, at: Date.now() });
    }
    onDeck(round);
    offerBatch(round);
    onChange();
    return answers;
  }

  // patch: normalized (see swipe.mjs normalizePatch); its local media gets published here.
  function push(round, patch) {
    const s = round.swipe;
    const arr = (v) => (Array.isArray(v) ? v : []);
    const published = { ...patch, add: arr(patch.add).map(publishCard), replace: arr(patch.replace).map(publishCard), remove: arr(patch.remove).map(String) };
    if (patch.brief !== undefined && !Array.isArray(patch.brief)) delete published.brief;
    const { deck, issues, added } = applyPatch(round.spec, new Set(Object.keys(s.answers)), published, { front: frontCard(round) });
    round.spec = deck;
    round.title = deck.title;
    if (patch.brief) s.briefAt = s.sent;
    if (added) s.lowSent = false;
    s.thinking = false;
    onDeck(round);
    onChange();
    return { issues, added, stats: deckStats(deck, s.answers) };
  }

  // What the page needs to draw the deck and the brief.
  const swipeView = (round) =>
    round.mode === "swipe"
      ? {
          answers: round.swipe.answers,
          // Answers the brief doesn't cover yet: the page shows them raw until the agent rewrites the brief.
          fresh: [...new Set(round.swipe.log.slice(round.swipe.briefAt).filter((e) => !e.undo).map((e) => e.card))].filter((c) => round.swipe.answers[c]),
          thinking: round.swipe.thinking,
          batches: round.swipe.batches,
        }
      : null;

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
      .map((r) => ({ id: r.id, title: r.title, mode: r.mode, createdAt: r.createdAt, count: items(r).length, live: r.live, waiting: r.waiters.size > 0, listening: listening(r) })),
    // Answers not picked up yet: the page shows whether the agent is still around to take them.
    history: history.map((h) => (h.delivered || !rounds.has(h.id) ? h : { ...h, listening: listening(rounds.get(h.id)) })),
  });

  return { create, get, pending, newestPending, saveDraft, saveUpload, finish, wait, ask, explain, swipeAnswer, push, swipeView, publicDialog, listening, sweep, summary };
}
