// net.js — API calls to the session daemon. Every write carries x-decide,
// which the daemon requires (cross-site pages cannot send it without CORS).

const WRITE = { "content-type": "application/json", "x-decide": "1" };

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

export const askAgent = (id, question, text) =>
  fetch(`/api/rounds/${id}/ask`, { method: "POST", headers: WRITE, body: JSON.stringify({ question, text }) }).then(json);

export const getJournal = (q = "", limit = 30) =>
  fetch(`/api/journal?limit=${limit}&q=${encodeURIComponent(q)}`, { cache: "no-store" }).then(json);

export function listen(onState, onStatus, onDialog) {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (e) => onState(JSON.parse(e.data)));
  es.addEventListener("dialog", (e) => onDialog(JSON.parse(e.data)));
  es.onopen = () => onStatus(true);
  es.onerror = () => onStatus(false);
  return es;
}
