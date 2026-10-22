// net.js — API calls to the session daemon. Every write carries x-decide,
// which the daemon requires (cross-site pages cannot send it without CORS).

const WRITE = { "content-type": "application/json", "x-decide": "1" };

// An exported file swaps this module for offline.js, which has the same exports.
export const offline = false;
export const download = () => {};
export const answererName = () => "";
export const reopen = () => {};

async function json(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

export const getState = () => fetch("/api/state", { cache: "no-store" }).then(json);
export const getRound = (id) => fetch(`/api/rounds/${id}`, { cache: "no-store" }).then(json);

export const submitRound = (id, payload) =>
  fetch(`/api/rounds/${id}/submit`, { method: "POST", headers: WRITE, body: JSON.stringify(payload) }).then(json);

export const cancelRound = (id) => fetch(`/api/rounds/${id}/cancel`, { method: "POST", headers: WRITE }).then(json);

export function uploadFile(id, file) {
  return fetch(`/api/rounds/${id}/upload`, {
    method: "POST",
    headers: {
      "x-decide": "1",
      "content-type": file.type || "application/octet-stream",
      "x-file-name": encodeURIComponent(file.name || "screenshot.png"),
    },
    body: file,
  }).then(json);
}

let draftTimer = null;
export function saveDraft(id, draft) {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    fetch(`/api/rounds/${id}/draft`, { method: "PUT", headers: WRITE, body: JSON.stringify(draft) }).catch(() => {});
  }, 400);
}

export const swipeCard = (id, body) =>
  fetch(`/api/rounds/${id}/swipe`, { method: "POST", headers: WRITE, body: JSON.stringify(body) }).then(json);

export const digDeeper = (id, note) =>
  fetch(`/api/rounds/${id}/deeper`, { method: "POST", headers: WRITE, body: JSON.stringify({ note }) }).then(json);

export const askAgent = (id, question, text) =>
  fetch(`/api/rounds/${id}/ask`, { method: "POST", headers: WRITE, body: JSON.stringify({ question, text }) }).then(json);

export const getJournal = (q = "", limit = 30, { mode = "", status = "" } = {}) =>
  fetch(`/api/journal?${new URLSearchParams({ limit: String(limit), q, ...(mode && { mode }), ...(status && { status }) })}`, { cache: "no-store" }).then(json);

// Whether the user is looking at this page: the daemon sends a system notification only when no page is.
const PAGE = Math.random().toString(36).slice(2, 10);
const watching = () => document.visibilityState === "visible" && document.hasFocus();
let told = null;
function tellWatching() {
  const now = watching();
  if (now === told) return;
  told = now;
  fetch("/api/watching", { method: "POST", headers: WRITE, body: JSON.stringify({ page: PAGE, watching: now }) }).catch(() => {});
}

export function listen(onState, onStatus, onDialog, onDeck) {
  // The stream opens with the current state; a reconnect sends it again.
  const es = new EventSource(`/api/events?page=${PAGE}&watching=${watching() ? 1 : 0}`);
  for (const ev of ["visibilitychange", "focus", "blur"]) (ev === "visibilitychange" ? document : window).addEventListener(ev, tellWatching);
  es.addEventListener("state", (e) => onState(JSON.parse(e.data)));
  es.addEventListener("dialog", (e) => onDialog(JSON.parse(e.data)));
  es.addEventListener("deck", (e) => onDeck(JSON.parse(e.data)));
  es.onopen = () => {
    told = null;
    tellWatching();
    onStatus(true);
  };
  es.onerror = () => onStatus(false);
  return es;
}
