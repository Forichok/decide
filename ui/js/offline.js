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

export const getRound = async (id) => (id === round.id ? { ...round, draft: load()?.draft || null, status: result ? "submitted" : "pending", result } : fail("unknown round", { status: 404 }));

// The answers file: the round's result as the daemon would build it, plus who answered.
export async function submitRound(id, payload) {
  if (id !== round.id) return fail("unknown round", { status: 404 });
  const saved = load() || {};
  const name = String(payload.name || saved.name || "").trim().slice(0, 80);
  const out = {
    version: 2,
    exported: true,
    round: round.id,
    title: round.spec.title,
    ...(data.from ? { source: data.from } : {}),
    name,
    submittedAt: new Date().toISOString(),
    elapsedSec: Number.isFinite(payload.elapsedSec) ? payload.elapsedSec : undefined,
    answers: payload.answers || {},
    ...(payload.comment ? { comment: String(payload.comment) } : {}),
    ...(round.spec.leftOut?.length ? { leftOut: round.spec.leftOut } : {}),
  };
  out.digest = digest(round.spec, out);
  result = { ...out, file: answersFileName(name) };
  store({ ...saved, name, draft: saved.draft, sent: out.submittedAt });
  download();
  return { ok: true, result };
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

const noAgent = () => fail("no agent behind an exported file", { status: 409 });
export const swipeCard = noAgent;
export const digDeeper = noAgent;
export const askAgent = noAgent;

export const getJournal = async () => ({ entries: [] });

export function listen(onState, onStatus) {
  queueMicrotask(() => onStatus(true));
  return { close() {} };
}
