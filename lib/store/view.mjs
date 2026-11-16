// view.mjs — what a round looks like now, computed from the spec as opened and
// the round's events. Pure: the same spec and events always give the same view.
//
// Who wins, strongest first: the user's own restore, an agent patch sent with
// override, the rules, ordinary agent patches, the spec. So the view is built
// in the opposite order: the spec, ordinary patches as they arrived, the rules
// over the current answers, override patches as they arrived, the user's
// restores. A rule keeps applying after a patch touched the same item; an
// agent that means to undo a rule says override.
//
// Events read (others are ignored):
//   { type: "answer", qid, answer }      the user's answer to one item; answer null clears it
//   { type: "draft", draft: { answers } } a round from before answer events: the last draft's
//                                        answers are the answers, read only when the log has no
//                                        answer event at all
//   { type: "patch", ops, reason?, override?, keepAnswers? }  see patch.mjs
//   { type: "restore", id }              the user brought a ghost back; it stays back
//   { type: "keep", qid }                the user confirmed an answer marked for checking
//   { type: "swipe", card, side | undo }  a swipe deck's answer: { side, text? } on the card; undo clears it
//   { type: "seen", ids }                the user has seen these items: a patch after it can only ghost them
// Each event's seq orders it; an event without one takes its place in the list.
//
// A stale mark holds until the user answers that item again or keeps the answer: a mark made
// after his last answer or keep shows, an earlier one does not. A rule's mark counts from the
// answer that made the rule hold (as long as it has held since).

import { evaluate, hasAnswer, itemsOf } from "../../ui/js/rules.js";
import { applyPatch, entryOf } from "./patch.mjs";

const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const pick = (obj, keep) => Object.fromEntries(Object.entries(obj).filter(([id]) => keep(id)));

// The answers now, when each item was last answered or kept, every answered item, and the answers
// after each change (for when a rule began to hold).
export function answersOf(log) {
  const confirmedAt = {};
  const ever = new Set();
  const history = [{ seq: 0, answers: {} }];
  let answers = {};
  const direct = log.some((e) => e.type === "answer" || e.type === "swipe");
  const confirm = (qid, seq) => {
    confirmedAt[qid] = Math.max(confirmedAt[qid] ?? -Infinity, seq);
  };
  for (const e of log) {
    if (e.type === "keep" && e.qid != null) confirm(String(e.qid), e.seq);
    else if (e.type === "swipe" && e.card != null) {
      // A swipe card answered (a skip too) has been on screen: seen, whatever the side.
      const qid = String(e.card);
      const answer = e.undo ? null : { side: e.side, ...(e.side === "own" ? { text: e.text } : {}) };
      answers = { ...answers };
      if (answer == null) delete answers[qid];
      else answers[qid] = answer;
      confirm(qid, e.seq);
      if (answer) ever.add(qid);
      history.push({ seq: e.seq, answers });
    } else if (direct && e.type === "answer" && e.qid != null) {
      const qid = String(e.qid);
      answers = { ...answers };
      if (e.answer == null) delete answers[qid];
      else answers[qid] = e.answer;
      confirm(qid, e.seq);
      if (hasAnswer(e.answer)) ever.add(qid);
      history.push({ seq: e.seq, answers });
    } else if (!direct && e.type === "draft" && isObject(e.draft?.answers)) {
      const next = e.draft.answers;
      for (const qid of new Set([...Object.keys(answers), ...Object.keys(next)])) {
        if (same(answers[qid], next[qid])) continue;
        confirm(qid, e.seq);
        if (hasAnswer(next[qid])) ever.add(qid);
      }
      answers = { ...next };
      history.push({ seq: e.seq, answers });
    }
  }
  return { answers, confirmedAt, ever, history };
}

// For each item a rule marks stale now: the seq since which the rules have marked it without a break.
function staleSince(spec, history, opts, now) {
  const since = new Map();
  let open = new Set(now);
  for (let i = history.length - 1; i >= 0 && open.size; i--) {
    const marked = i === history.length - 1 ? now : evaluate(spec, history[i].answers, opts).stale;
    for (const id of [...open]) {
      if (marked.has(id)) since.set(id, history[i].seq);
      else open.delete(id);
    }
  }
  return since;
}

const asPatch = (e) => ({ ops: list(e.ops), reason: e.reason, keepAnswers: e.keepAnswers === true, override: e.override === true, seq: e.seq });

// viewOf(spec, events, { seen? }) →
//   { items: [{ id, state: "normal" | "changed" | "new" | "ghost", reason, was, item, ... }],
//     answers, ghostAnswers, stale: [id], staleReasons, brief, ghosts: [{ id, reason }],
//     seen, confirmedAt, settled }
// spec: the spec as opened (questions, or a swipe deck's cards; rules; brief).
// seen: ids the user has seen; an answered item counts as seen. A patch may drop only an unseen item.
// answers leaves ghosts out: their answers are in ghostAnswers. The returned view can be handed to
// applyPatch to see what a patch would do.
export function viewOf(spec, events = [], { seen = [] } = {}) {
  const log = list(events)
    .filter(isObject)
    .map((e, i) => (Number.isFinite(e.seq) ? e : { ...e, seq: i + 1 }));
  const { answers, confirmedAt, ever, history } = answersOf(log);
  const patches = log.filter((e) => e.type === "patch");
  const ordinary = patches.filter((e) => e.override !== true);
  const overrides = patches.filter((e) => e.override === true);
  const restores = log.filter((e) => e.type === "restore" && e.id != null);
  // What the user had seen when a patch came: a seen event after the patch does not turn its drop into a ghost.
  const seenEvents = log.filter((e) => e.type === "seen");
  const seenBase = [...new Set([...list(seen).map(String), ...ever])];
  const seenBy = (seq) => [...new Set([...seenBase, ...seenEvents.filter((e) => e.seq < seq).flatMap((e) => list(e.ids).map(String))])];

  // 1. The spec as opened.
  let view = {
    items: itemsOf(spec).map((q) => entryOf(q)),
    answers: { ...answers },
    ghostAnswers: {},
    stale: [],
    staleReasons: {},
    brief: spec?.brief ?? null,
    seen: seenBase,
    confirmedAt,
  };

  // 2. Ordinary patches, in the order they arrived.
  for (const e of ordinary) view = applyPatch({ ...view, seen: seenBy(e.seq) }, asPatch(e));

  // 3. The rules over the current answers. What an override or the user decides is fixed for them:
  // an item they ghost has no answer for any condition, one they bring back always has its answer.
  const forced = new Map();
  for (const e of overrides) {
    for (const op of list(e.ops)) {
      if (!isObject(op)) continue;
      for (const id of list(op.ghost ?? op.remove)) forced.set(String(id), "ghost");
      for (const id of list(op.restore)) forced.set(String(id), "shown");
    }
  }
  for (const e of restores) forced.set(String(e.id), "shown");
  const key = Array.isArray(spec?.questions) || !Array.isArray(spec?.cards) ? "questions" : "cards";
  const ruleSpec = { ...spec, [key]: view.items.map((e) => e.item) };
  const opts = { ghosted: view.items.filter((e) => e.ghosted).map((e) => e.id), forced };
  const rules = evaluate(ruleSpec, { ...view.answers, ...view.ghostAnswers }, opts);
  const ops = [
    ...[...rules.ghosts].map(([id, reason]) => ({ ghost: [id], reason })),
    ...[...rules.restored].map(([id, reason]) => ({ restore: [id], reason })),
    ...[...rules.removed].map(([question, gone]) => ({ removeOptions: { question, options: [...gone] }, reason: rules.removedReasons.get(question) ?? "" })),
  ];
  // The rules' own stale marks come below, dated; their removals mark nothing twice.
  if (ops.length) view = applyPatch(view, { ops, keepAnswers: true });
  if (rules.stale.size) {
    const since = staleSince(ruleSpec, history, opts, rules.stale);
    for (const id of rules.stale) view = applyPatch(view, { ops: [{ stale: [id], reason: rules.reasons.get(id) ?? "" }], seq: since.get(id) ?? 0 });
  }

  // 4. Override patches, in the order they arrived.
  for (const e of overrides) view = applyPatch({ ...view, seen: seenBy(e.seq) }, asPatch(e));

  // 5. The user's own restores.
  for (const e of restores) view = applyPatch(view, { ops: [{ restore: [String(e.id)] }], seq: e.seq });

  const present = new Set(view.items.map((e) => e.id));
  const live = pick(view.answers, (id) => present.has(id));
  const stale = view.stale.filter((id) => present.has(id) && hasAnswer(live[id]));
  return {
    items: view.items,
    answers: live,
    ghostAnswers: pick(view.ghostAnswers, (id) => present.has(id)),
    stale,
    staleReasons: pick(view.staleReasons, (id) => stale.includes(id)),
    brief: view.brief,
    ghosts: view.items.filter((e) => e.ghosted).map((e) => ({ id: e.id, reason: e.ghostReason ?? "" })),
    seen: seenBy(Infinity),
    confirmedAt,
    settled: rules.settled,
  };
}
