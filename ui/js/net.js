// net.js — API calls to the session daemon. The page proves itself by its Origin: the browser puts it on
// every fetch that is not a GET (POST and PUT here), and the daemon only takes a write whose Origin is its
// own. The page holds no token and makes no other kind of write.

const WRITE = { "content-type": "application/json" };

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

export const getState = () =>
  fetch("/api/state", { cache: "no-store" })
    .then(json)
    .then((state) => {
      // The server this page was loaded from: a later hello from another one means a restart.
      if (serverStart === null && state.startedAt !== undefined) serverStart = state.startedAt;
      return state;
    });
export const getRound = (id) => fetch(`/api/rounds/${id}`, { cache: "no-store" }).then(json);

// The server's start time, as the page's state load told it (or else the first hello): another one
// later means the server was restarted.
let serverStart = null;

export const submitRound = (id, payload) =>
  fetch(`/api/rounds/${id}/submit`, { method: "POST", headers: WRITE, body: JSON.stringify(payload) }).then(json);

export const cancelRound = (id) => fetch(`/api/rounds/${id}/cancel`, { method: "POST", headers: WRITE }).then(json);

export function uploadFile(id, file) {
  return fetch(`/api/rounds/${id}/upload`, {
    method: "POST",
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-file-name": encodeURIComponent(file.name || "screenshot.png"),
    },
    body: file,
  }).then(json);
}

// The last draft the server has not acknowledged (a 2xx): it is kept so that a restart cannot lose it.
// A 4xx is final (the round is unknown or finished): it is dropped, not sent again for ever.
let draftTimer = null;
let unsent = null;
function sendDraft() {
  clearTimeout(draftTimer);
  if (!unsent) return Promise.resolve(true);
  const sent = unsent;
  return fetch(`/api/rounds/${sent.id}/draft`, { method: "PUT", headers: WRITE, body: JSON.stringify(sent.draft) })
    .then((res) => {
      const final = res.ok || (res.status >= 400 && res.status < 500);
      if (final && unsent === sent) unsent = null;
      return final;
    })
    .catch(() => false);
}

// Text a view holds only in page memory (a note, an unsent question): the page never reloads while
// one of these says true. One check per view, keyed "view": the view on screen replaces the one before it.
const holders = new Map();
export const holdReload = (key, holds) => holders.set(key, holds);

// A restart seen: the page reloads once the server has every draft and no view holds unsent text.
let reloadPending = false;
let reloading = false;
async function reloadWhenSafe() {
  if (reloading) return;
  reloading = true;
  try {
    // Edits made while a PUT was in flight set `unsent` again: flush until nothing is left.
    for (let i = 0; i < 20 && unsent; i++) if (!(await sendDraft())) return;
    if (unsent || [...holders.values()].some((holds) => holds())) return;
    location.reload();
  } finally {
    reloading = false;
  }
}
setInterval(() => reloadPending && reloadWhenSafe(), 3_000);
export function saveDraft(id, draft) {
  unsent = { id, draft };
  clearTimeout(draftTimer);
  draftTimer = setTimeout(sendDraft, 400);
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
  es.addEventListener("hello", (e) => {
    const { startedAt } = JSON.parse(e.data);
    if (serverStart === null) serverStart = startedAt;
    // Restarted: what the user typed meanwhile goes to the new server first; the page keeps itself as it
    // is while a draft cannot be sent or a view holds unsent text, and tries again on the next hello.
    else if (serverStart !== startedAt) reloadPending = true;
    if (reloadPending) reloadWhenSafe();
  });
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

// Reactive rounds: bring a ghost back, keep a stale answer.
export const restoreItem = (id, item) => fetch(`/api/rounds/${id}/restore`, { method: "POST", headers: WRITE, body: JSON.stringify({ id: item }) }).then(json);
export const keepAnswer = (id, qid) => fetch(`/api/rounds/${id}/keep`, { method: "POST", headers: WRITE, body: JSON.stringify({ qid }) }).then(json);
