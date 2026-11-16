// state.mjs — a round's state as a pure replay of its event log: meta + spec +
// events → RoundState, including the outbox of what is meant for the agent.
// No I/O, no clock, no randomness: everything replay needs is in the event,
// and its `at` gives the times. The store validates input, builds a payload
// with the helpers below, appends the event, then applies it. State shares
// objects with the events it came from; treat both as read-only.
//
// Events as store/log.mjs writes them: { seq, at, type, ...fields }; the log
// owns those three names, so no field may use them (an upload's MIME type is
// `mime`). "time" below is Date.parse(at), in ms as 2.1 kept it (the page
// sorts answers by it).
//
// type      fields                                effect on state                                  outbox item (payload)
// opened    -                                     none: replay starts from meta + spec             -
// draft     draft                                 draft; a draft with `answers` (a page before 3.0 -
//                                                 sent every answer at once) replaces answers
// answer    qid, answer (object | null)           answers[qid] = answer; null removes it           -
// note      qid, text                             notes[qid] = text; "" removes it                 -
// flag      qid, flag ("none"|"later"|null),      flags[qid] = {flag, revisit?, note?}; null       -
//           revisit?, note?                       removes it
// upload    path, name, size, mime                uploads += path; files[path] = {name, mime}      -
// ask       id, qid, title, text                  dialog += {id, qid, ask: text, askedAt: time}    ask {event:"ask", round, ask:{id, question: qid, title, text}}
// reply     id, qid, askId?, text, media?         reply {text, ...media} on entry askId, else on   -
//                                                 the open ask of qid, else a new entry `id` that
//                                                 the agent has seen from the start; repliedAt
// swipe     card, side | undo: true, text?,       answers, log, pinned as 2.1's swipeAnswer        -
//           hesitated?  (= swipePayload)
// push      patch (normalized, unpublished)       deck, title, briefAt, lowSent; thinking and      -
//                                                 digging end
// deeper    = deeperPayload: note, deeper,        deeper += {note, at: time}; deck reopens;        deeper {event:"deeper", round, deeper, note, entries, digest, stats, confidence}
//           entries, digest, stats, confidence    digging, thinking; lowSent off; entries seen
// batch     = batchPayload: batch, entries,       entries seen, sent = log length, batches + 1,    batch {event:"batch", round, batch, entries, digest, stats, done, confidence}
//           digest, stats, done, confidence       thinking; lowSent when stats.left <= LOW_WATER
// request   qid, title, note                      none                                             request {event:"request", round, request:{qid, title, note}}
// acked     upTo, waiter                          acked = max(acked, upTo)                         -
// sent      result                                status "answered", result                        final (result)
// imported  result                                status "answered", result                        final (result)
// cancelled result                                status "cancelled", result                       cancel (result)
// dismissed result?                               status "dismissed", result or null               -
//
// answer, note and flag are per question: two pages writing different questions never touch each
// other's, and the same question is last write wins. `patchSeq` is the seq of the last of them (or of a
// draft with answers); the page uses it to tell a missed change from one it holds. `agentAt` is the time
// of the last event the agent caused (opened, reply, push, acked): the inbox's "older" group reads it.
//
// After "answered", "cancelled" or "dismissed" only acked still applies. An
// unknown type (a newer server wrote it) changes nothing but lastSeq; an event
// at or below lastSeq was applied already and changes nothing at all.
//
// For the store's author: `thinking` is cleared only by push, and the store
// never changes state outside apply. The page's `thinking` is
// `state.swipe.thinking && !idle`, where `idle` is the store's volatile
// per-round flag: set when an events waiter arrives with nothing pending,
// cleared when a batch or deeper event is appended. Outbox payloads and deck
// cards are the same objects as the state's (and the events'): the store
// copies them before it publishes media or adds fields.

import { applyPatch, batchDigest, deckStats, hesitationMs, LOW_WATER, NOTE_MAX, OWN_MAX } from "../swipe.mjs";

export const EVENTS = ["opened", "draft", "answer", "note", "flag", "upload", "ask", "reply", "swipe", "push", "deeper", "batch", "request", "acked", "sent", "cancelled", "dismissed", "imported"];

const TERMINAL = new Set(["answered", "cancelled", "dismissed"]);
// Items only a waiter that takes events gets, as in 2.1 (lib/rounds.mjs:173-176).
const EVENT_KINDS = new Set(["ask", "batch", "deeper", "request"]);

const time = (e) => Date.parse(e.at);
const refuse = (message, status = 400) => Object.assign(new Error(message), { status });

function initial(meta, spec) {
  const swipe = meta.mode === "swipe";
  return {
    id: meta.id,
    mode: swipe ? "swipe" : "questions",
    title: meta.title ?? spec?.title ?? "",
    status: "pending",
    draft: null,
    answers: {},
    notes: {},
    flags: {},
    patchSeq: 0,
    agentAt: 0,
    uploads: [],
    files: {},
    dialog: [],
    // deck: the deck after every push. answers: card → {side, text?, hesitated?, at}; log: every
    // move in order; sent: how much of the log went out; seen: what the agent saw per card;
    // briefAt: the log length the brief covers; pinned: a card undo brought back to the front;
    // lowSent: the early "running low" batch went out; deeper: every "Dig deeper" press.
    swipe: swipe ? { deck: spec, answers: {}, log: [], sent: 0, seen: {}, batches: 0, thinking: false, digging: false, briefAt: 0, pinned: null, lowSent: false, deeper: [] } : null,
    // live: a questions round whose spec says `live: true` hands the agent batches of answers (R7).
    // sent: qid → the answer as the agent saw it (JSON); lastAt: when the user last changed the draft.
    live: !swipe && spec?.live === true ? { sent: {}, batches: 0, lastAt: 0 } : null,
    outbox: [],
    acked: 0,
    result: null,
    lastSeq: 0,
  };
}

export const replay = (meta, spec, events) => events.reduce((state, e) => apply(state, e), initial(meta, spec));

export function apply(state, event) {
  if (!event || !Number.isInteger(event.seq) || event.seq <= state.lastSeq) return state;
  const next = { ...state, lastSeq: event.seq };
  if (event.type === "acked") return { ...next, acked: Math.max(state.acked, Number(event.upTo) || 0), agentAt: Math.max(state.agentAt, time(event) || 0) };
  if (TERMINAL.has(state.status) || !Object.hasOwn(STEPS, event.type)) return next;
  return STEPS[event.type](next, event);
}

// What a waiter gets next: items after the last acknowledged one. A finished round hands out only
// its final or cancel item, as 2.1's wait did: an ask nobody collected would send the agent to
// explain into a closed round.
export function pendingItems(state, { events = false } = {}) {
  const done = TERMINAL.has(state.status);
  return state.outbox.filter((i) => i.seq > state.acked && (done ? !EVENT_KINDS.has(i.kind) : events || !EVENT_KINDS.has(i.kind)));
}

const addItem = (state, event, kind, payload) => ({ ...state, outbox: [...state.outbox, { seq: event.seq, kind, payload }] });
const withSwipe = (state, changes) => ({ ...state, swipe: { ...state.swipe, ...changes } });
const swiped = (fn) => (state, e) => (state.swipe ? fn(state, state.swipe, e) : state);
const end = (status, kind) => (state, e) => {
  const next = { ...state, status, result: e.result ?? null };
  return kind ? addItem(next, e, kind, e.result ?? null) : next;
};

// ---- dialog

function applyAsk(state, e) {
  const entry = { id: e.id, qid: e.qid, ask: String(e.text ?? ""), askedAt: time(e), reply: null, askSeq: e.seq };
  const payload = { event: "ask", round: state.id, ask: { id: e.id, question: e.qid, title: e.title || e.qid, text: entry.ask } };
  return addItem({ ...state, dialog: [...state.dialog, entry] }, e, "ask", payload);
}

// The entry an explanation lands on: the ask it names, else the open ask of that question.
export function dialogEntry(state, { qid, askId }) {
  return state.dialog.find((d) => (askId ? d.id === askId : d.qid === qid && !d.reply)) ?? null;
}

function applyReply(state, e) {
  const found = dialogEntry(state, e);
  const entry = found ?? { id: e.id, qid: e.qid, ask: "", askedAt: time(e), reply: null, askSeq: null };
  const replied = { ...entry, reply: { text: String(e.text ?? ""), ...e.media }, repliedAt: time(e) };
  return { ...state, dialog: found ? state.dialog.map((d) => (d === found ? replied : d)) : [...state.dialog, replied] };
}

// seen (ruling 4): the agent acknowledged the ask; an entry it started itself is seen from the start.
export const publicDialog = (state) => state.dialog.map(({ askSeq, ...d }) => ({ ...d, seen: askSeq === null || askSeq <= state.acked }));

// ---- swipe: answers in, batches out, pushes back in

// The swipe event for an answer from the page, or a status 400 / 412 error, as 2.1's swipeAnswer.
// side: "left" | "right" | "skip" | "own" (with text); undo takes the answer back; rev: the card
// revision the page showed; ms: how long the card was on screen, for the hesitation mark.
export function swipePayload(state, { card, side, text, undo = false, rev, ms } = {}) {
  const sw = state.swipe;
  if (!sw) throw refuse("not a swipe round");
  const shown = sw.deck.cards.find((c) => c.id === card);
  if (!shown) throw refuse("unknown card");
  if (undo) {
    if (!sw.answers[card]) throw refuse("that card has no answer to take back");
    return { card, undo: true };
  }
  if (rev !== undefined && (shown.rev || 0) !== rev) throw refuse("the card changed", 412);
  if (!["left", "right", "skip", "own"].includes(side)) throw refuse("side must be left, right, skip or own");
  const own = side === "own" ? String(text ?? "").trim().slice(0, OWN_MAX) : "";
  if (side === "own" && !own) throw refuse("an own answer needs text");
  const retaken = sw.log.some((e) => e.card === card && e.undo);
  const hesitated = retaken || (Number.isFinite(ms) && ms > hesitationMs(shown));
  return { card, side, ...(side === "own" ? { text: own } : {}), ...(hesitated ? { hesitated: true } : {}) };
}

function applySwipe(state, sw, e) {
  const { card } = e;
  if (!sw.deck.cards.some((c) => c.id === card)) return state;
  const answers = { ...sw.answers };
  if (e.undo) {
    if (!answers[card]) return state;
    delete answers[card];
    return withSwipe(state, { answers, pinned: card, log: [...sw.log, { card, undo: true, at: time(e) }] });
  }
  const extra = { ...(e.side === "own" ? { text: e.text } : {}), ...(e.hesitated ? { hesitated: true } : {}) };
  answers[card] = { side: e.side, ...extra, at: time(e) };
  return withSwipe(state, { answers, pinned: sw.pinned === card ? null : sw.pinned, log: [...sw.log, { card, side: e.side, ...extra, at: time(e) }] });
}

// What the agent saw for a card: the side, for an own answer its text too, and whether the user hesitated.
const seenKey = (e) => `${e.side === "own" ? `own:${e.text}` : e.side}${e.hesitated ? "?" : ""}`;

// The moves since the last batch, one per card (its latest), minus the ones that undo nothing the agent saw.
export function pendingEntries(state) {
  const sw = state.swipe;
  if (!sw) return [];
  const last = new Map();
  for (const e of sw.log.slice(sw.sent)) {
    last.delete(e.card);
    last.set(e.card, e);
  }
  return [...last.values()].filter((e) => (e.undo ? Boolean(sw.seen[e.card]) : sw.seen[e.card] !== seenKey(e)));
}

// ---- live questions rounds: answers in batches (R7)

// A draft answer counts once it holds something: a pick, a text, a number, a rank, a flag.
const filled = (a) => Boolean(a) && typeof a === "object" && Object.values(a).some((v) => (Array.isArray(v) ? v.length : v !== "" && v !== null && v !== undefined && v !== false));

// The answers the agent has not seen: qid → answer, from the draft, minus what a batch already carried.
export function pendingAnswers(state) {
  const live = state.live;
  if (!live) return {};
  const out = {};
  for (const [qid, a] of Object.entries(state.answers ?? {})) if (filled(a) && live.sent[qid] !== JSON.stringify(a)) out[qid] = a;
  return out;
}

// Due after `count` new answers, or after `pauseMs` of quiet since the last change with something new.
// Returns "now", or the ms still to wait, or null when nothing is new.
export function liveDue(state, nowMs, { count, pauseMs }) {
  if (!state.live || state.status !== "pending") return null;
  const n = Object.keys(pendingAnswers(state)).length;
  if (!n) return null;
  if (n >= count) return 0;
  return Math.max(0, state.live.lastAt + pauseMs - nowMs);
}

function applyLiveBatch(state, e) {
  const sent = { ...state.live.sent };
  for (const [qid, a] of Object.entries(e.answers ?? {})) sent[qid] = JSON.stringify(a);
  const batches = state.live.batches + 1;
  return addItem({ ...state, live: { ...state.live, sent, batches } }, e, "batch", { event: "batch", round: state.id, live: true, batch: batches, answers: e.answers, digest: e.digest, answered: e.answered, total: e.total });
}

// 2.1's rule for when a batch is worth sending; the store cuts it only when a waiter takes events.
export function batchReady(state) {
  if (state.mode !== "swipe" || state.status !== "pending") return false;
  const n = pendingEntries(state).length;
  if (n === 0) return false;
  const { deck, answers, lowSent } = state.swipe;
  const left = deckStats(deck, answers).left;
  // Running low: one early batch, so the agent can refill the deck in time; again only after it adds cards.
  const low = left <= LOW_WATER && !deck.done && !lowSent;
  return n >= deck.batch || left === 0 || low;
}

const entryOut = (e) => ({ card: e.card, side: e.undo ? null : e.side, ...(e.side === "own" ? { text: e.text } : {}), ...(e.hesitated ? { hesitated: true } : {}), undo: Boolean(e.undo) });

// The fields of a batch event: every move since the last batch, as the agent reads it.
export function batchPayload(state) {
  const { deck, answers, batches } = state.swipe;
  const entries = pendingEntries(state);
  return { batch: batches + 1, entries: entries.map(entryOut), digest: batchDigest(deck, entries), stats: deckStats(deck, answers), done: deck.done, confidence: deck.confidence };
}

// The fields of a deeper event: the press and its note; answers the agent hasn't seen ride along.
export function deeperPayload(state, note) {
  const { deck, answers, deeper } = state.swipe;
  const entries = pendingEntries(state);
  return {
    note: String(note ?? "").trim().slice(0, NOTE_MAX),
    deeper: deeper.length + 1,
    entries: entries.map(entryOut),
    digest: entries.length ? batchDigest(deck, entries) : "",
    stats: deckStats(deck, answers),
    confidence: deck.confidence,
  };
}

// Entries handed to the agent are marked seen, and the log up to here counts as sent.
function taken(sw, entries) {
  const seen = { ...sw.seen };
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e.undo) delete seen[e.card];
    else seen[e.card] = seenKey(e);
  }
  return { seen, sent: sw.log.length };
}

function applyBatch(state, sw, e) {
  const lowSent = sw.lowSent || e.stats?.left <= LOW_WATER;
  const next = withSwipe(state, { ...taken(sw, e.entries), batches: sw.batches + 1, thinking: true, lowSent });
  const { batch, entries, digest, stats, done, confidence } = e;
  return addItem(next, e, "batch", { event: "batch", round: state.id, batch, entries, digest, stats, done, confidence });
}

// "Dig deeper": the deck reopens at once and the page shows the agent preparing harder questions.
function applyDeeper(state, sw, e) {
  const press = { note: String(e.note ?? ""), at: time(e) };
  const next = withSwipe(state, { ...taken(sw, e.entries), deck: { ...sw.deck, done: false }, deeper: [...sw.deeper, press], digging: true, thinking: true, lowSent: false });
  const { deeper, entries, digest, stats, confidence } = e;
  return addItem(next, e, "deeper", { event: "deeper", round: state.id, deeper, note: press.note, entries, digest, stats, confidence });
}

// A push applied to the deck: {deck, issues, added}. The store calls it for the reply to push.
export function patchDeck(state, patch) {
  const sw = state.swipe;
  const arr = (v) => (Array.isArray(v) ? v : []);
  const clean = { ...patch, add: arr(patch.add), replace: arr(patch.replace), remove: arr(patch.remove).map(String) };
  if (patch.brief !== undefined && !Array.isArray(patch.brief)) delete clean.brief;
  // The cards behind the front one show in the stack: the user has seen them.
  const front = frontCard(state);
  const seen = new Set(sw.deck.cards.filter((c) => !sw.answers[c.id] && c.id !== front).slice(0, 2).map((c) => c.id));
  return applyPatch(sw.deck, new Set(Object.keys(sw.answers)), clean, { front, seen });
}

function applyPush(state, sw, e) {
  const patch = e.patch ?? {};
  const { deck, added } = patchDeck(state, patch);
  const next = withSwipe(state, { deck, briefAt: patch.brief ? sw.sent : sw.briefAt, lowSent: added ? false : sw.lowSent, thinking: false, digging: false });
  return { ...next, title: deck.title };
}

// The card on the user's screen, as the page picks it: one brought back by undo, else the first open one.
export function frontCard(state) {
  if (!state.swipe) return null;
  const { deck, answers, pinned } = state.swipe;
  if (pinned && !answers[pinned] && deck.cards.some((c) => c.id === pinned)) return pinned;
  return deck.cards.find((c) => !answers[c.id])?.id ?? null;
}

// What the page needs to draw the deck and the brief (2.1's shape).
export function swipeView(state) {
  const sw = state.swipe;
  if (!sw) return null;
  // Answers the brief doesn't cover yet: the page shows them raw until the agent rewrites the brief.
  const fresh = [...new Set(sw.log.slice(sw.briefAt).filter((e) => !e.undo).map((e) => e.card))].filter((c) => sw.answers[c]);
  return { answers: sw.answers, fresh, thinking: sw.thinking, digging: sw.digging, deeper: sw.deeper.length, batches: sw.batches };
}

// ---- answers, notes and flags of a questions round, one question at a time

export const FLAG_VALUES = ["none", "later"];
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const without = (map, key) => {
  const out = { ...map };
  delete out[key];
  return out;
};

// What the page hears for one of these events: the changed question under answers, notes or flags.
export function patchOf(event) {
  if (event.type === "answer") return { answers: { [event.qid]: event.answer ?? null } };
  if (event.type === "note") return { notes: { [event.qid]: String(event.text ?? "") } };
  if (event.type === "flag") return { flags: { [event.qid]: flagOf(event) } };
  return null;
}

// The flag entry an event leaves, or null when it clears the flag.
export function flagOf(e) {
  if (!FLAG_VALUES.includes(e.flag)) return null;
  return { flag: e.flag, ...(typeof e.revisit === "string" && e.revisit ? { revisit: e.revisit } : {}), ...(typeof e.note === "string" && e.note ? { note: e.note } : {}) };
}

function applyDraft(state, e) {
  const draft = e.draft ?? null;
  if (!isObject(draft?.answers)) return { ...state, draft };
  return { ...state, draft, answers: { ...draft.answers }, patchSeq: e.seq };
}

function applyAnswer(state, e) {
  const qid = String(e.qid ?? "");
  const answers = isObject(e.answer) ? { ...state.answers, [qid]: e.answer } : without(state.answers, qid);
  return { ...state, answers, patchSeq: e.seq };
}

function applyNote(state, e) {
  const qid = String(e.qid ?? "");
  const text = String(e.text ?? "");
  return { ...state, notes: text ? { ...state.notes, [qid]: text } : without(state.notes, qid), patchSeq: e.seq };
}

function applyFlag(state, e) {
  const qid = String(e.qid ?? "");
  const flag = flagOf(e);
  return { ...state, flags: flag ? { ...state.flags, [qid]: flag } : without(state.flags, qid), patchSeq: e.seq };
}

const byAgent = (step) => (state, e) => step({ ...state, agentAt: Math.max(state.agentAt, time(e) || 0) }, e);

const STEPS = {
  opened: byAgent((state) => state),
  draft: (state, e) => ({ ...applyDraft(state, e), live: state.live ? { ...state.live, lastAt: time(e) } : null }),
  answer: (state, e) => ({ ...applyAnswer(state, e), live: state.live ? { ...state.live, lastAt: time(e) } : null }),
  note: applyNote,
  flag: applyFlag,
  upload: (state, e) => ({ ...state, uploads: [...state.uploads, e.path], files: { ...state.files, [e.path]: { name: String(e.name ?? ""), mime: String(e.mime ?? "") } } }),
  ask: applyAsk,
  reply: byAgent(applyReply),
  swipe: swiped(applySwipe),
  push: byAgent(swiped(applyPush)),
  deeper: swiped(applyDeeper),
  // "None, suggest others": the user wants other options; only an agent that listens gets it (R8).
  request: (state, e) => addItem(state, e, "request", { event: "request", round: state.id, request: { qid: e.qid, title: e.title || e.qid, note: String(e.note ?? "") } }),
  batch: (state, e) => (state.swipe ? applyBatch(state, state.swipe, e) : state.live ? applyLiveBatch(state, e) : state),
  sent: end("answered", "final"),
  imported: end("answered", "final"),
  cancelled: end("cancelled", "cancel"),
  dismissed: end("dismissed", null),
};
