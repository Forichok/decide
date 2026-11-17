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

// One question at a time (see store.js): each resolves {seq} once the server has the event on disk.
const post = (path, body) => fetch(path, { method: "POST", headers: WRITE, body: JSON.stringify(body) }).then(json);
export const postAnswer = (id, qid, answer) => post(`/api/rounds/${id}/answer`, { qid, answer });
export const postNote = (id, qid, text) => post(`/api/rounds/${id}/note`, { qid, text });
export const postFlag = (id, qid, flag, extra = {}) => post(`/api/rounds/${id}/flag`, { qid, flag, ...extra });
// The round-level draft (closing comment, its files, time spent), through the store's retries.
export const putDraft = (id, draft) => fetch(`/api/rounds/${id}/draft`, { method: "PUT", headers: WRITE, body: JSON.stringify(draft) }).then(json);
export const getInbox = () => fetch("/api/inbox", { cache: "no-store" }).then(json);

// Stream events besides the ones listen() takes: "round", "inbox", "handover" (data parsed), and
// "reconnect" (the stream is back after a break: whatever was missed must be fetched again).
const handlers = new Map();
export function onEvent(name, fn) {
  if (!handlers.has(name)) handlers.set(name, new Set());
  handlers.get(name).add(fn);
  return () => handlers.get(name).delete(fn);
}
function dispatch(name, data) {
  for (const fn of handlers.get(name) || []) {
    try {
      fn(data);
    } catch (err) {
      console.error(err);
    }
  }
}

export const swipeCard = (id, body) =>
  fetch(`/api/rounds/${id}/swipe`, { method: "POST", headers: WRITE, body: JSON.stringify(body) }).then(json);

export const digDeeper = (id, note) =>
  fetch(`/api/rounds/${id}/deeper`, { method: "POST", headers: WRITE, body: JSON.stringify({ note }) }).then(json);

// Round messages are durable even when the current waiter takes no live events.
export const getThread = (id) => fetch(`/api/rounds/${id}/thread`, { cache: "no-store" }).then(json);
export const sendMessage = (id, body) => post(`/api/rounds/${id}/message`, body);
export const pickMessage = (id, body) => post(`/api/rounds/${id}/message-pick`, body);

export const askAgent = (id, question, text) =>
  fetch(`/api/rounds/${id}/ask`, { method: "POST", headers: WRITE, body: JSON.stringify({ question, text }) }).then(json);

export const getMap = (round = "", project = "") =>
  fetch(`/api/map?${new URLSearchParams({ ...(round && { round }), ...(project && { project }) })}`, { cache: "no-store" }).then(json);

export const getJournal = (q = "", limit = 30, { mode = "", status = "", project = "" } = {}) =>
  fetch(`/api/journal?${new URLSearchParams({ limit: String(limit), q, ...(mode && { mode }), ...(status && { status }), ...(project && { project }) })}`, { cache: "no-store" }).then(json);

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
  es.addEventListener("state", (e) => { const data = JSON.parse(e.data); onState(data); dispatch("state", data); });
  es.addEventListener("dialog", (e) => onDialog(JSON.parse(e.data)));
  es.addEventListener("deck", (e) => onDeck(JSON.parse(e.data)));
  for (const name of ["round", "inbox", "handover", "thread"]) es.addEventListener(name, (e) => dispatch(name, e.data ? JSON.parse(e.data) : null));
  let broken = false;
  es.onopen = () => {
    told = null;
    tellWatching();
    onStatus(true);
    if (broken) dispatch("reconnect", null);
    broken = false;
  };
  es.onerror = () => {
    broken = true;
    onStatus(false);
  };
  return es;
}

// Reactive rounds: bring a ghost back, keep a stale answer.
export const restoreItem = (id, item) => fetch(`/api/rounds/${id}/restore`, { method: "POST", headers: WRITE, body: JSON.stringify({ id: item }) }).then(json);
export const keepAnswer = (id, qid) => fetch(`/api/rounds/${id}/keep`, { method: "POST", headers: WRITE, body: JSON.stringify({ qid }) }).then(json);
// K8 "in words" on a tune question: {sent: true} when an agent listens, else {sent: false, note} (saved as its note).
export const sendWords = (id, qid, text) => fetch(`/api/rounds/${id}/words`, { method: "POST", headers: WRITE, body: JSON.stringify({ qid, text }) }).then(json);
// What the user has seen (questions that were in view, swipe cards shown): a patch then ghosts them, never drops them.
export const markSeen = (id, ids) => fetch(`/api/rounds/${id}/seen`, { method: "POST", headers: WRITE, body: JSON.stringify({ ids }) }).then(json);
// How much to ask, and the page's own buttons (settings.js, actions.js).
export const getSettings = (project) => fetch(`/api/settings?${new URLSearchParams(project ? { project } : {})}`, { cache: "no-store" }).then(json);
// Keep the old call signature for exported/offline pages; a patch adds scope and clear.
export const setLevel = (project, level) => post("/api/settings", typeof level === "string" ? { project, level } : { ...(project && { project }), ...level });
export const addRuleTo = (project, text, mode, question = "") => post("/api/rules", { project, text, mode, question });
export const removeRuleFrom = (project, id) => post("/api/rules", { project, remove: id });
export const exportRoundFile = (id) => post(`/api/rounds/${id}/export`, {});
export const saveRoundAdr = (id) => post(`/api/rounds/${id}/adr`, {});
export const fitRound = (id, minutes) => post(`/api/rounds/${id}/fit`, { minutes });

// A code review round (ui/js/review/): its diff a group at a time, one file whole, comments, read marks.
export const reviewPieces = (id, group) => fetch(`/api/rounds/${id}/pieces?${new URLSearchParams({ group })}`, { cache: "no-store" }).then(json);
export const reviewFile = (id, path, side) => fetch(`/api/rounds/${id}/file?${new URLSearchParams({ path, side })}`, { cache: "no-store" }).then(json);
export const reviewComment = (id, body) => post(`/api/rounds/${id}/comment`, body);
export const reviewUncomment = (id, comment) => post(`/api/rounds/${id}/uncomment`, { id: comment });
export const reviewRead = (id, chapter, read) => post(`/api/rounds/${id}/read`, { chapter, read });
// A question on a piece of the diff, on one of its lines when `line` is given: it goes to the agent at once.
export const reviewAsk = (id, body) => post(`/api/rounds/${id}/ask`, body);
