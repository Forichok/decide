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
import { viewOf } from "./view.mjs";

export const EVENTS = ["opened", "draft", "answer", "note", "flag", "upload", "ask", "reply", "swipe", "push", "deeper", "batch", "request", "acked", "sent", "cancelled", "dismissed", "imported", "patch", "restore", "keep", "seen"];

// 3.0 rounds that react: the events view.mjs reads to build the round's view (the answers, the agent's
// patches, the user's restores and keeps). state.trail holds them in order; viewOf(spec, trail) is the view.
// patch     ops, reason?, override?, keepAnswers?   trail += event (the agent changed the round)        -
// restore   id                                      trail += event (the user brought a ghost back)     -
// keep      qid                                     trail += event (the user kept a stale answer)      -
// seen      ids                                     trail += event (the page showed these items)       -
// A swipe round's swipe events go into the trail too (its answers, for the view), and a patch or restore
// there rebuilds swipe.deck from the view (see deckOf): a push is sent as a patch with a `deck` field.
// patch     ops, reason?, keepAnswers?, override?,  swipe: deck rebuilt; thinking and digging end;     -
//           deck? {goal, confidence, batch, done}   briefAt and lowSent as a push moved them
const TRAIL = new Set(["draft", "answer", "patch", "restore", "keep", "seen", "swipe"]);

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
    // base: the deck as opened plus 2.x push events (swipe.mjs applyPatch); deck: base with the view's patches on it.
    swipe: swipe ? { base: spec, deck: spec, answers: {}, log: [], sent: 0, seen: {}, batches: 0, thinking: false, digging: false, briefAt: 0, pinned: null, lowSent: false, deeper: [] } : null,
    // live: a questions round whose spec says `live: true` hands the agent batches of answers (R7).
    // sent: qid → the answer as the agent saw it (JSON); lastAt: when the user last changed the draft.
    live: !swipe && spec?.live === true ? { sent: {}, batches: 0, lastAt: 0 } : null,
    outbox: [],
    trail: [],
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
  const after = STEPS[event.type](next, event);
  const trailed = TRAIL.has(event.type) ? { ...after, trail: [...(after.trail ?? []), event] } : after;
  return trailed.swipe && DECK_EVENTS.has(event.type) ? withDeck(trailed) : trailed;
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

// A push applied to the deck: {deck, issues, added}. The replay of an old push event calls it.
export function patchDeck(state, patch) {
  const sw = state.swipe;
  const arr = (v) => (Array.isArray(v) ? v : []);
  const clean = { ...patch, add: arr(patch.add), replace: arr(patch.replace), remove: arr(patch.remove).map(String) };
  if (patch.brief !== undefined && !Array.isArray(patch.brief)) delete clean.brief;
  // The cards behind the front one show in the stack: the user has seen them. Only old push events come
  // here, so the front card is picked as 3.0.0 picked it (ghosts not skipped): the replay gives the same deck.
  const { answers, pinned } = sw;
  const front = pinned && !answers[pinned] && sw.deck.cards.some((c) => c.id === pinned) ? pinned : (sw.deck.cards.find((c) => !answers[c.id])?.id ?? null);
  const seen = new Set(sw.deck.cards.filter((c) => !sw.answers[c.id] && c.id !== front).slice(0, 2).map((c) => c.id));
  return applyPatch(sw.base ?? sw.deck, new Set(Object.keys(sw.answers)), clean, { front, seen });
}

// The cards on the user's screen: the front one and the two behind it in the stack. A patch counts them
// as seen (the store logs a seen event for them first), so dropping one leaves a ghost.
export function stackCards(state) {
  const sw = state.swipe;
  if (!sw) return [];
  const front = frontCard(state);
  const ghost = (id) => Boolean(sw.deck.ghosts && Object.hasOwn(sw.deck.ghosts, id));
  const behind = sw.deck.cards.filter((c) => !sw.answers[c.id] && !ghost(c.id) && c.id !== front).slice(0, 2).map((c) => c.id);
  return front ? [front, ...behind] : behind;
}

// 3.0: push is the swipe-shaped form of patch. pushAsPatch(state, push) → { patch, issues, added }:
// push's fields (normalized: swipe.mjs normalizePatch) as patch ops on the deck now. replace → set
// (an answered card's answer goes stale unless keepAnswers), remove → remove (a card the user saw or
// answered stays as a ghost with the reason), add → add before / after the front card, brief → brief;
// goal, confidence, batch and done ride in patch.deck. The card on the user's screen is not rewritten
// or dropped under him, as in 2.x: that part is a warning.
export function pushAsPatch(state, push = {}) {
  const sw = state.swipe;
  const issues = [];
  const warn = (message) => issues.push({ level: "warn", where: "push", message });
  const arr = (v) => (Array.isArray(v) ? v : []);
  const { deck, answers } = sw;
  const ids = new Set(deck.cards.map((c) => c.id));
  const ghost = (id) => Boolean(deck.ghosts && Object.hasOwn(deck.ghosts, id));
  const front = frontCard(state);
  const ops = [];
  for (const card of arr(push.replace)) {
    if (!ids.has(card.id)) warn(`replace: no card "${card.id}" — use add`);
    else if (card.id === front) warn(`replace: "${card.id}" is on the user's screen right now — add a follow-up card instead`);
    else ops.push({ set: { ...card } });
  }
  for (const raw of arr(push.remove)) {
    const id = String(raw);
    if (!ids.has(id)) warn(`remove: no card "${id}"`);
    else if (id === front) warn(`remove: "${id}" is on the user's screen right now`);
    else {
      if (answers[id] && !ghost(id)) warn(`remove: "${id}" is already answered — it stays as a ghost the user can bring back; its answer is left out`);
      ops.push({ remove: [id] });
    }
  }
  // "next": right behind the front card, else before the first open card; "end": after the last.
  const open = deck.cards.find((c) => !answers[c.id] && !ghost(c.id))?.id;
  let anchor = push.position === "next" ? (front && !answers[front] ? { after: front } : open ? { before: open } : {}) : {};
  let added = 0;
  for (const card of arr(push.add)) {
    if (ids.has(card.id)) {
      warn(`add: card "${card.id}" exists — use replace, or pick a new id`);
      continue;
    }
    ids.add(card.id);
    ops.push({ add: { item: card, ...anchor } });
    if (push.position === "next") anchor = { after: card.id };
    added++;
  }
  if (Array.isArray(push.brief)) ops.push({ brief: push.brief });
  const meta = Object.fromEntries(DECK_META.filter((k) => push[k] !== undefined && push[k] !== null).map((k) => [k, push[k]]));
  const patch = { ops, ...(push.reason ? { reason: String(push.reason) } : {}), ...(push.keepAnswers === true ? { keepAnswers: true } : {}), ...(Object.keys(meta).length ? { deck: meta } : {}) };
  return { patch, issues, added };
}

// A push event (2.x and early 3.0 logs): it changes the base deck; withDeck lays the view's patches on it.
function applyPush(state, sw, e) {
  const patch = e.patch ?? {};
  const { deck, added } = patchDeck(state, patch);
  const next = withSwipe(state, { base: deck, briefAt: patch.brief ? sw.sent : sw.briefAt, lowSent: added ? false : sw.lowSent, thinking: false, digging: false });
  return { ...next, title: deck.title };
}

// The card on the user's screen, as the page picks it: one brought back by undo, else the first open one.
export function frontCard(state) {
  if (!state.swipe) return null;
  const { deck, answers, pinned } = state.swipe;
  const ghost = (id) => Boolean(deck.ghosts && Object.hasOwn(deck.ghosts, id));
  if (pinned && !answers[pinned] && !ghost(pinned) && deck.cards.some((c) => c.id === pinned)) return pinned;
  return deck.cards.find((c) => !answers[c.id] && !ghost(c.id))?.id ?? null;
}

// What the page needs to draw the deck and the brief (2.1's shape).
export function swipeView(state) {
  const sw = state.swipe;
  if (!sw) return null;
  // Answers the brief doesn't cover yet: the page shows them raw until the agent rewrites the brief.
  // A ghost's answer is left out of what the agent acts on, so it is not waiting for the brief either.
  const ghost = (c) => Boolean(sw.deck.ghosts && Object.hasOwn(sw.deck.ghosts, c));
  const fresh = [...new Set(sw.log.slice(sw.briefAt).filter((e) => !e.undo).map((e) => e.card))].filter((c) => sw.answers[c] && !ghost(c));
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
  // 3.0: kept in state.trail by apply; nothing else changes.
  patch: (state, e) => (state.swipe ? byAgent(applySwipePatch)(state, e) : state),
  restore: (state) => state,
  keep: (state) => state,
  seen: (state) => state,
};

// ---- K8: "in words" on a tune question ("make it calmer"), for an agent that listens.
// words     qid, title, text, values               none                                             words {event:"words", round, words:{qid, title, text, values}}
// The agent answers with a `knobs` patch (patch.mjs). Like a request, only a waiter that takes events gets it.
EVENTS.push("words");
EVENT_KINDS.add("words");
STEPS.words = (state, e) => addItem(state, e, "words", { event: "words", round: state.id, words: { qid: e.qid, title: e.title || e.qid, text: String(e.text ?? ""), values: e.values && typeof e.values === "object" ? e.values : {} } });
// ---- 3.0 swipe: the deck through the patch engine (R6)

const DECK_EVENTS = new Set(["patch", "restore", "push"]);
const DECK_META = ["goal", "confidence", "batch", "done"];
const opsOf = (e) => (Array.isArray(e.ops) ? e.ops : []).filter((op) => op && typeof op === "object");
const addsCards = (e) => opsOf(e).some((op) => op.add);

// The agent answered with a patch (a push sends one): as a push did, it ends thinking and digging.
function applySwipePatch(state, e) {
  const sw = state.swipe;
  const brief = opsOf(e).some((op) => "brief" in op);
  return withSwipe(state, { briefAt: brief ? sw.sent : sw.briefAt, lowSent: addsCards(e) ? false : sw.lowSent, thinking: false, digging: false });
}

// The deck's view (view.mjs): the base deck, its early-3.0 ghosts first, then the trail (answers,
// patches, restores, keeps, seen). view.stale: answers to check; view.ghosts: cards the deck skips.
export function deckView(state) {
  const sw = state.swipe;
  if (!sw) return null;
  const { ghosts = {}, ...base } = sw.base ?? sw.deck;
  const old = Object.entries(ghosts).map(([id, reason]) => ({ type: "patch", seq: 0, ops: [{ ghost: [id], reason }] }));
  return viewOf(base, [...old, ...(state.trail ?? [])]);
}

const sansRev = ({ rev, ...card }) => JSON.stringify(card);

// swipe.deck from the view: cards in the view's order (ghosts stay, named in deck.ghosts), a card the
// view changed gets the next rev (the page's answer to the old text is refused), the brief and the
// deck fields the patches set. A round with no patch or restore keeps its base deck as it is.
export function deckOf(state) {
  const sw = state.swipe;
  const base = sw.base ?? sw.deck;
  if (!(state.trail ?? []).some((e) => e.type === "patch" || e.type === "restore")) return base;
  const view = deckView(state);
  const prev = new Map(sw.deck.cards.map((c) => [c.id, c]));
  const cards = view.items.map((e) => {
    const p = prev.get(e.id);
    if (!p) return e.item;
    return sansRev(p) === sansRev(e.item) ? p : { ...e.item, rev: (p.rev || 0) + 1 };
  });
  const meta = Object.fromEntries(DECK_META.map((k) => [k, base[k]]));
  for (const e of state.trail) {
    if (e.type !== "patch") continue;
    // New cards reopen a deck the agent called done, unless the same patch says done again.
    if (addsCards(e) && e.deck?.done !== true) meta.done = false;
    for (const k of DECK_META) if (e.deck?.[k] !== undefined && e.deck[k] !== null) meta[k] = e.deck[k];
  }
  const { ghosts: _old, ...rest } = base;
  const deck = { ...rest, ...meta, brief: Array.isArray(view.brief) ? view.brief : base.brief, cards };
  if (view.ghosts.length) deck.ghosts = Object.fromEntries(view.ghosts.map((g) => [g.id, g.reason]));
  return deck;
}

function withDeck(state) {
  const deck = deckOf(state);
  return deck === state.swipe.deck ? state : { ...withSwipe(state, { deck }), title: deck.title };
}
