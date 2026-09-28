// main.js — page bootstrap: picks the round to show, follows the daemon over
// SSE (new rounds arrive in this same tab), wires keys, theme, file drops and
// the review → submit flow.

import { $, $$, icon } from "./dom.js";
import { lang, t } from "./i18n.js";
import { cancelRound, getRound, getState, listen, submitRound } from "./net.js";
import { hideBar, mountRound } from "./round.js";
import { renderDone, renderIdle, roundTabs, updatePresence } from "./header.js";
import { bindKeys } from "./nav.js";
import { confirmCancel, openHelp, openReview, toast } from "./overlays.js";
import { finalizeAnswers, isResolved, recommendedIds } from "./logic.js";
import { choose } from "./inputs.js";

const app = {
  state: { rounds: [], history: [] },
  connected: false,
  view: "boot", // round | done | idle
  round: null, // mounted round, see round.js
  done: null, // { id, result } while the done screen is shown
  seen: new Set(),
  sending: false,
  closing: null, // seconds until the tab closes itself, "failed", or null
  closeFor: null, // the done round the countdown already ran for
  closeTimer: null,
};

// ---- theme (per-viewer convenience; storage may be unavailable)
const THEME_KEY = "decide-theme";
function loadTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch {}
}
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};
function toggleTheme() {
  const next = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {}
  for (const b of $$(".icon-btn.theme")) b.innerHTML = icon(next === "dark" ? "sun" : "moon");
}

function env() {
  return {
    pending: app.state.rounds,
    currentId: app.round?.id ?? app.done?.id,
    history: app.state.history,
    connected: app.connected,
    delivery: app.done && deliveryOf(app.done.id),
    closing: app.closing,
    keepOpen,
    closeTab,
    copyNudge,
    help: openHelp,
    isDark,
    toggleTheme,
    switchTo: (id) => openRound(id),
    go,
    submit: review,
    cancel,
    nextOpen,
  };
}

// ---- views
async function openRound(id, fallback = true) {
  let data;
  try {
    data = await getRound(id);
  } catch {
    const next = fallback && app.state.rounds.find((r) => r.id !== id);
    if (next) return openRound(next.id, false);
    return showIdle(t("idle.inactive"));
  }
  history.replaceState(null, "", `#r=${data.id}`);
  app.seen.add(data.id);
  if (data.status === "pending") showRound(data);
  else showDone(data.id, data.result || { cancelled: true });
}

function showRound(data) {
  disarmClose();
  app.round?.stop();
  app.view = "round";
  app.done = null;
  app.round = mountRound(data, env());
  window.scrollTo({ top: 0 });
}

function showDone(id, result) {
  app.round?.stop();
  app.round = null;
  app.view = "done";
  app.done = { id, result };
  hideBar();
  renderDoneView();
  window.scrollTo({ top: 0 });
  armClose();
}

// ---- after the answers reach the agent the tab closes itself, unless more rounds wait
const deliveryOf = (id) => app.state.history.find((e) => e.id === id) || { delivered: true };

function armClose() {
  const { id, result } = app.done;
  if (result?.cancelled || !deliveryOf(id).delivered || app.closeFor === id || app.state.rounds.some((r) => r.id !== id)) return;
  app.closeFor = id;
  app.closing = 5;
  rerenderStatic();
  app.closeTimer = setInterval(() => {
    app.closing -= 1;
    if (app.closing > 0) {
      const count = $(".close-count");
      if (count) count.textContent = t("done.closeIn", app.closing);
      return;
    }
    closeTab();
  }, 1000);
}

function disarmClose() {
  clearInterval(app.closeTimer);
  app.closeTimer = null;
  app.closing = null;
}

function keepOpen() {
  disarmClose();
  rerenderStatic();
}

// Browsers let a page close only a tab that scripts opened or that has one history entry.
function closeTab() {
  disarmClose();
  window.close();
  setTimeout(() => {
    app.closing = "failed";
    rerenderStatic();
  }, 400);
}

function copyNudge() {
  navigator.clipboard
    .writeText(t("done.nudge"))
    .then(() => toast(t("done.copied")))
    .catch(() => toast(t("done.nudge")));
}

function showIdle(message) {
  disarmClose();
  app.round?.stop();
  app.round = null;
  app.view = "idle";
  app.done = null;
  hideBar();
  $("#main").replaceChildren(renderIdle(env()));
  document.title = "decide";
  if (message) toast(message);
}

function refreshTabs() {
  const old = $(".round-tabs");
  const fresh = roundTabs(env());
  if (old && fresh) old.replaceWith(fresh);
  else if (old) old.remove();
  else if (fresh) $(".top .eyebrow")?.after(fresh);
}

// ---- daemon push
function onState(st) {
  app.state = st;
  const fresh = st.rounds.filter((r) => !app.seen.has(r.id));
  fresh.forEach((r) => app.seen.add(r.id));
  if (app.view === "round") {
    const current = st.rounds.find((r) => r.id === app.round.id);
    if (!current) return openRound(app.round.id, false);
    updatePresence(current.listening !== false);
    refreshTabs();
    for (const r of fresh) toast(t("toast.newRound", r.title));
    return;
  }
  if (fresh.length) return openRound(fresh.at(-1).id);
  rerenderStatic();
  if (app.view === "done") armClose();
}

function onDialog(d) {
  if (app.view === "round" && app.round.id === d.round) app.round.setDialog(d.dialog);
}

function onStatus(ok) {
  if (app.connected === ok) return;
  app.connected = ok;
  document.body.classList.toggle("offline", !ok);
  if (app.view !== "round") rerenderStatic();
}

function renderDoneView() {
  const { id, result } = app.done;
  $("#main").replaceChildren(renderDone(result, env()));
  const title = result?.cancelled ? "title.cancelled" : deliveryOf(id).delivered ? "title.sent" : "title.saved";
  document.title = `${t(title)} — decide`;
}

function rerenderStatic() {
  if (app.view === "done") renderDoneView();
  else if (app.view === "idle") $("#main").replaceChildren(renderIdle(env()));
}

// ---- review, submit, cancel
function review() {
  if (app.view !== "round" || app.sending) return;
  const open = $("#overlay .review .btn.primary");
  if (open) return open.click();
  const r = app.round;
  openReview({ spec: r.spec, answers: r.answers, comment: r.comment().trim(), onSend: send, onJump: go });
}

async function send() {
  const r = app.round;
  if (!r || app.sending) return;
  app.sending = true;
  try {
    const res = await submitRound(r.id, r.payload(finalizeAnswers(r.spec, r.answers, { fill: true })));
    showDone(r.id, res.result);
  } catch (e) {
    if (e.status === 409) openRound(r.id, false);
    else toast(t("toast.sendFailed"));
  } finally {
    app.sending = false;
  }
}

function cancel() {
  if (app.view !== "round") return;
  const { id } = app.round;
  confirmCancel(async () => {
    try {
      const res = await cancelRound(id);
      showDone(id, res.result || { cancelled: true });
    } catch (e) {
      if (e.status === 409) openRound(id, false);
      else toast(t("toast.cancelFailed"));
    }
  });
}

// ---- navigation between questions
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const visibleIds = () => (app.round ? app.round.spec.questions.filter((q) => !app.round.card(q.id)?.hidden).map((q) => q.id) : []);

function go(qid) {
  const c = app.round?.card(qid);
  if (!c || c.hidden) return;
  c.scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "start" });
  c.focus({ preventScroll: true });
  app.round.setCurrent(qid);
  c.classList.remove("flash");
  void c.offsetWidth;
  c.classList.add("flash");
}

function step(delta) {
  const ids = visibleIds();
  if (!ids.length) return;
  const i = ids.indexOf(app.round.current());
  go(ids[i < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, i + delta))]);
}

function nextOpen() {
  const r = app.round;
  if (!r) return;
  const ids = visibleIds();
  const i = ids.indexOf(r.current());
  const next = [...ids.slice(i + 1), ...ids.slice(0, i + 1)].find((id) => !isResolved(r.question(id), r.answers[id]));
  if (next) go(next);
  else toast(t("toast.allDone"));
}

function currentQuestion() {
  const r = app.round;
  const qid = r && (r.current() || visibleIds()[0]);
  return qid ? r.question(qid) : null;
}

function act(kind) {
  const q = currentQuestion();
  if (!q) return;
  const { ctx } = app.round;
  if (kind === "note") return ctx.openNote(q.id);
  if (kind !== "rec") return ctx.toggleFlag(q.id, kind);
  if (recommendedIds(q).length || q.type === "rank") ctx.applyRecommended(q.id);
  else toast(t("toast.noRec"));
}

function pick(n) {
  const q = currentQuestion();
  if (!q) return;
  const { ctx, answers } = app.round;
  if (["single", "multi", "confirm"].includes(q.type)) {
    const o = q.options[n - 1];
    if (o) choose(q, o.id, ctx);
  } else if (q.type === "scale") {
    const v = q.scale.min + n - 1;
    if (v > q.scale.max) return;
    const a = answers[q.id];
    ctx.set(q.id, { value: a.value === v ? null : v, flag: a.flag === "explain" ? "explain" : null });
  }
}

// ---- files dropped anywhere: onto a card → that question, elsewhere → comment
function bindDrop() {
  let target = null;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  const mark = (el) => {
    if (target === el) return;
    target?.classList.remove("drop-target");
    target = el;
    target?.classList.add("drop-target");
  };
  document.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (app.view === "round") mark(e.target.closest?.(".card") || $("#final"));
  });
  document.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) mark(null);
  });
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    mark(null);
    if (app.view !== "round") return;
    const qid = e.target.closest?.(".card")?.dataset.qid || null;
    [...e.dataTransfer.files].forEach((f) => app.round.ctx.attach(qid, f));
  });
}

async function boot() {
  document.documentElement.lang = lang;
  $("#toc").setAttribute("aria-label", t("toc"));
  $(".boot").textContent = t("boot");
  loadTheme();
  bindKeys({ submit: review, step: (d) => app.round && step(d), nextOpen, act, help: openHelp, pick });
  bindDrop();
  try {
    app.state = await getState();
    app.connected = true;
  } catch {
    showIdle();
  }
  app.state.rounds.forEach((r) => app.seen.add(r.id));
  const id = new URLSearchParams(location.hash.slice(1)).get("r");
  if (id) await openRound(id);
  else if (app.state.rounds.length) await openRound(app.state.rounds.at(-1).id);
  else if (app.view === "boot") showIdle();
  listen(onState, onStatus, onDialog);
}

boot();
