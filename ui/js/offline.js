// offline.js — net.js inside an exported file (see lib/export.mjs). There is
// no daemon: the round comes from the page itself, the draft lives in this
// browser, and Done downloads an answers JSON that the agent imports back.

import { digest } from "./logic.js";

export const offline = true;

const data = JSON.parse(document.getElementById("decide-export").textContent);
const round = data.round;
const KEY = `decide-export:${round.id}`;
let result = null;

const load = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    return null;
  }
};
const store = (value) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {}
};

const fail = (message, extra = {}) => Promise.reject(Object.assign(new Error(message), extra));

export const getState = async () => ({
  rounds: result ? [] : [{ id: round.id, title: round.spec.title, mode: "questions", count: round.spec.questions.length, live: false, listening: false }],
  history: result ? [{ id: round.id, delivered: true }] : [],
});

// answers, notes, flags: per question, as the server keeps them; a browser that kept a draft with every answer
// (before 3.0) gets those back.
export const getRound = async (id) => {
  if (id !== round.id) return fail("unknown round", { status: 404 });
  const saved = load() || {};
  return { ...round, draft: saved.draft || null, seq: saved.seq || 0, answers: saved.answers || saved.draft?.answers || {}, notes: saved.notes || {}, flags: saved.flags || {}, files: {}, status: result ? "submitted" : "pending", result };
};

// The answers file: the round's result as the daemon would build it, plus who answered.
export async function submitRound(id, payload) {
  if (id !== round.id) return fail("unknown round", { status: 404 });
  const saved = load() || {};
  const name = String(payload.name || saved.name || "").trim().slice(0, 80);
  const out = {
    version: 2,
    format: 3,
    exported: true,
    round: round.id,
    title: round.spec.title,
    ...(data.from ? { source: data.from } : {}),
    name,
    submittedAt: new Date().toISOString(),
    elapsedSec: Number.isFinite(payload.elapsedSec) ? payload.elapsedSec : undefined,
    answers: withFlags(payload.answers || {}, saved),
    ...(payload.comment ? { comment: String(payload.comment) } : {}),
    ...(round.spec.leftOut?.length ? { leftOut: round.spec.leftOut } : {}),
  };
  out.digest = digest(round.spec, out);
  result = { ...out, file: answersFileName(name) };
  store({ ...saved, name, draft: saved.draft, sent: out.submittedAt });
  download();
  return { ok: true, result };
}

// As the server does (lib/store/rounds.mjs withFlags): flags kept beside the answers go into each entry,
// replacing an answer the page filled in itself; a "Yes, but…" condition is kept.
function withFlags(answers, saved) {
  const out = { ...answers };
  for (const [qid, f] of Object.entries(saved.flags || {})) {
    if (!f?.flag || !round.spec.questions.some((q) => q.id === qid)) continue;
    const base = out[qid] && !out[qid].auto ? out[qid] : {};
    const note = [base.note, f.note].filter(Boolean).join("\n");
    out[qid] = { ...base, flag: f.flag, ...(f.revisit ? { revisit: f.revisit } : {}), ...(note ? { note } : {}) };
  }
  for (const [qid, a] of Object.entries(saved.answers || {})) {
    const condition = typeof a?.condition === "string" ? a.condition.trim() : "";
    if (condition && out[qid] && !out[qid].auto && !out[qid].condition) out[qid] = { ...out[qid], condition };
  }
  return out;
}

export function answersFileName(name = load()?.name || "") {
  const slug = (s) =>
    String(s)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  return `${slug(round.spec.title) || "decide"}${name ? `.${slug(name)}` : ""}.answers.json`;
}

// Downloads the answers again (the done screen offers it in case the first one got lost).
export function download() {
  if (!result) return;
  const { file, ...body } = result;
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: file });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const answererName = () => load()?.name || "";
export const holdReload = () => {}; // an exported file has no server to restart

// "Change answers" on the done screen: the round opens again with the draft.
export const reopen = () => {
  result = null;
};

export const cancelRound = async () => ({ ok: true, result: { cancelled: true } });

export const uploadFile = () => fail("attachments need the agent's page", { offline: true });

let draftTimer = null;
export function saveDraft(id, draft) {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => store({ ...(load() || {}), draft }), 300);
}

// The store's writes (store.js), kept in this browser: one question at a time, numbered like the server's.
function keep(id, field, qid, value) {
  if (id !== round.id) return fail("unknown round", { status: 404 });
  const saved = load() || {};
  const map = { ...(saved[field] || (field === "answers" ? saved.draft?.answers : null) || {}) };
  if (value === null || value === undefined || value === "") delete map[qid];
  else map[qid] = value;
  const seq = (saved.seq || 0) + 1;
  store({ ...saved, [field]: map, seq });
  return Promise.resolve({ seq });
}
export const postAnswer = (id, qid, answer) => keep(id, "answers", qid, answer);
export const postNote = (id, qid, text) => keep(id, "notes", qid, String(text ?? ""));
export const postFlag = (id, qid, flag, extra = {}) => keep(id, "flags", qid, flag ? { flag, ...(extra.revisit ? { revisit: extra.revisit } : {}), ...(extra.note ? { note: extra.note } : {}) } : null);
export const putDraft = (id, draft) => {
  if (id !== round.id) return fail("unknown round", { status: 404 });
  store({ ...(load() || {}), draft });
  return Promise.resolve({ ok: true });
};
export const getInbox = async () => ({ rounds: [] });
export const onEvent = () => () => {};

const noAgent = () => fail("no agent behind an exported file", { status: 409 });
export const swipeCard = noAgent;
export const digDeeper = noAgent;
export const askAgent = noAgent;

export const getJournal = async () => ({ entries: [] });
export const getMap = async () => ({ nodes: [], edges: [], mermaid: "", projects: [], rounds: [] });

export function listen(onState, onStatus) {
  queueMicrotask(() => onStatus(true));
  return { close() {} };
}

// Reactive rounds need a daemon: in an exported file the page keeps these to itself.
export const restoreItem = async () => ({});
export const keepAnswer = async () => ({});
// K8 "in words": no agent behind an exported file, so the page keeps the words as the question's note.
export const sendWords = async () => ({ sent: false });
export const markSeen = async () => ({});
// The daemon's own buttons have no daemon here.
const gone = () => fail("not available in an exported file");
export const getSettings = gone;
export const setLevel = gone;
export const addRuleTo = gone;
export const removeRuleFrom = gone;
export const exportRoundFile = gone;
export const saveRoundAdr = gone;
export const fitRound = gone;
// A code review reads a repository through the daemon: there is none in an exported file.
export const visualAction = gone;
export const reviewPieces = gone;
export const reviewFile = gone;
export const reviewComment = gone;
export const reviewUncomment = gone;
export const reviewRead = gone;
export const reviewAsk = noAgent;

// Exported pages never mount the round conversation button.
export const getThread = async () => ({ thread: [], listening: false });
export const sendMessage = () => fail("No agent in an exported page");
export const pickMessage = () => fail("No agent in an exported page");
