// main.js — page bootstrap: picks the round to show, follows the daemon over
// SSE (new rounds arrive in this same tab), wires keys, theme, file drops and
// the review → submit flow. Swipe rounds mount their own screen (swipe.js).

import { $, $$, icon } from "./dom.js";
import { lang, t } from "./i18n.js";
import * as net from "./net.js";
import { answererName, cancelRound, download, getRound, getState, listen, offline, reopen, submitRound } from "./net.js";
import { createStore } from "./store.js";
import { hideBar, mountRound } from "./round.js";
import { mountSwipe } from "./swipe/index.js";
import { mountReview } from "./review/index.js";
import { pasteLine, renderIdle, roundTabs, updatePresence } from "./header.js";
import { renderDone } from "./done.js";
import { createInbox, dismissRound, loadInbox, notifyNew } from "./inbox.js";
import { baseName, nextRound } from "./inbox-logic.js";
import { showStopped } from "./stopped.js";
import { renderJournal } from "./journal.js";
import { renderSettings } from "./settings.js";
import { bindKeys } from "./nav.js";
import { closeOverlays, confirmCancel, openHelp, openReview, toast } from "./overlays.js";
import { finalizeAnswers, isResolved, recommendedIds } from "./logic.js";
import { typeOf } from "./types/index.js";
import { badgeCount, registerShell, setBadge, wrongPort } from "./pwa.js";

// Answers, notes and flags of every round this page shows, saved one question at a time (store.js).
const store = createStore(net);

const app = {
  state: { rounds: [], history: [] },
  connected: false,
  view: "boot", // round | done | idle | journal
  round: null, // mounted round, see round.js
  done: null, // { id, result } while the done screen is shown
  seen: new Set(),
  sending: false,
  closing: null, // "failed" after a Close tab the browser refused, else null
  inbox: [], // the rail's rows, see inbox.js
  advance: null, // seconds until Done goes on to the next round, or null
  advanceAction: null, // "next" or "close" while the countdown runs
  advanceTimer: null,
  spec: null, // spec of the round on the done screen
  idleError: null, // why the idle screen shows, e.g. a round id that does not exist
};
let rail = null;
let settingsFrom = null;

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
function themeChoice() {
  return document.documentElement.dataset.theme || "system";
}
function setTheme(next) {
  try {
    if (next === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch {
    throw new Error(t("settings4.themeFailed"));
  }
  if (next === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  syncTheme();
}
function paintTheme() {
  for (const b of $$(".icon-btn.theme")) b.innerHTML = icon(isDark() ? "sun" : "moon");
}
function syncTheme(saved = true) {
  paintTheme();
  $("[data-theme-form]")?.dispatchEvent(new CustomEvent("decide-theme", { detail: { choice: themeChoice(), saved } }));
}
function toggleTheme() {
  const next = isDark() ? "light" : "dark";
  try { setTheme(next); }
  catch (e) {
    // The top bar still switches the current page when browser storage is blocked.
    document.documentElement.dataset.theme = next;
    syncTheme(false);
    toast(e.message);
  }
}

function env() {
  return {
    pending: app.state.rounds,
    currentId: app.round?.id ?? app.done?.id,
    project: app.projectDir,
    history: app.state.history,
    connected: app.connected,
    delivery: app.done && deliveryOf(app.done.id),
    closing: app.closing,
    idleError: app.view === "idle" ? app.idleError : null,
    closeTab,
    spec: app.spec,
    nextRound: app.view === "done" ? nextRound(app.inbox.length ? app.inbox : [], app.done?.id) : null,
    advance: app.advance,
    stay,
    inbox: { count: app.inbox.length, toggle: () => toggleRail() },
    copyNudge,
    help: openHelp,
    isDark,
    toggleTheme,
    themeChoice,
    setTheme,
    settings: offline ? null : openSettings,
    leaveSettings,
    switchTo: (id) => openRound(id),
    journal: offline ? null : () => (location.hash = "journal"),
    offline,
    download,
    reopen: () => app.done && (reopen(), openRound(app.done.id)),
    leaveJournal,
    finished: (id, result) => showDone(id, result),
    go,
    submit: review,
    cancel,
    nextOpen,
    store,
  };
}

// ---- views
async function openRound(id, fallback = false) {
  let data;
  try {
    data = await getRound(id);
  } catch {
    const next = fallback && app.state.rounds.find((r) => r.id !== id);
    if (next) return openRound(next.id, false);
    return showIdle(t("idle.badRound", id));
  }
  history.replaceState(null, "", `#r=${data.id}`);
  app.projectDir = data.project || app.projectDir;
  app.seen.add(data.id);
  if (data.status === "pending") showRound(data);
  else showDone(data.id, data.result || { cancelled: true }, data.spec);
}

function showRound(data) {
  disarmAdvance();
  app.round?.stop();
  app.view = "round";
  app.done = null;
  // The header draws the round's own buttons for the round being shown, before app.round names it.
  const e = { ...env(), currentId: data.id };
  app.round = data.mode === "swipe" ? mountSwipe(data, e) : data.mode === "review" ? mountReview(data, e) : mountRound(data, e);
  syncRail();
}

function showDone(id, result, spec = null) {
  const justFinished = app.round?.id === id;
  app.spec = spec || app.round?.spec || (app.done?.id === id ? app.spec : null);
  if (app.done?.id !== id) {
    disarmAdvance();
    app.closing = null;
    app.done = { id, justFinished };
  }
  // only the round being settled drops its queue: another pending round still reports what was seen
  app.round?.stop({ settled: app.round.id === id });
  app.round = null;
  app.view = "done";
  app.done.result = result;
  hideBar();
  renderDoneView();
  window.scrollTo({ top: 0 });
  syncRail();
  armAdvance();
}

// ---- after Done, leave time to read the result or stay on the page
const deliveryOf = (id) => app.state.history.find((e) => e.id === id) || { delivered: true };
const ADVANCE_SEC = 6;
const CLOSE_SEC = 10;

function advanceAction() {
  if (offline || !app.connected || !app.done || app.done.stay) return null;
  const { id, result, justFinished } = app.done;
  const delivered = app.state.history.find(row => row.id === id)?.delivered;
  if (!result?.cancelled && !result?.dismissed && !delivered) return null;
  if (nextRound(app.inbox, id)) return "next";
  if (justFinished && !nextRound(app.state.rounds, id)) return "close";
  return null;
}

function armAdvance() {
  const action = advanceAction();
  if (app.advanceAction === action) return;
  disarmAdvance();
  app.advanceAction = action;
  if (!action) return rerenderStatic();
  app.advance = action === "close" ? CLOSE_SEC : ADVANCE_SEC;
  rerenderStatic();
  app.advanceTimer = setInterval(() => {
    if (advanceAction() !== action) return armAdvance();
    app.advance -= 1;
    if (app.advance > 0) {
      const count = $(".next-count");
      if (count) count.textContent = t(action === "close" ? "done.closeIn" : "done.advance", app.advance);
      return;
    }
    if (action === "close") return closeTab();
    stay();
    openRound(nextRound(app.inbox, app.done.id).id);
  }, 1000);
}

function disarmAdvance() {
  clearInterval(app.advanceTimer);
  app.advanceTimer = null;
  app.advanceAction = null;
  app.advance = null;
}

function stay() {
  app.done.stay = true;
  disarmAdvance();
  for (const el of $$(".done-card .next-count, .done-card .next-count + button")) el.remove();
}

function closeTab() {
  const done = app.done;
  done.stay = true;
  disarmAdvance();
  window.close();
  setTimeout(() => {
    if (app.done !== done) return;
    app.closing = "failed";
    rerenderStatic();
  }, 400);
}

function copyNudge() {
  const line = pasteLine(app.done?.id || "");
  navigator.clipboard
    .writeText(line)
    .then(() => toast(t("done.copied")))
    .catch(() => toast(line));
}

function showIdle(message) {
  disarmAdvance();
  app.round?.stop();
  app.round = null;
  app.view = "idle";
  app.done = null;
  hideBar();
  $("#main").replaceChildren(renderIdle(((app.idleError = message || null), env())));
  document.title = "decide";
  syncRail();
  if (message) toast(message);
}

function showJournal() {
  if (app.round) app.journalFrom = app.round.id;
  disarmAdvance();
  app.round?.stop();
  app.round = null;
  app.view = "journal";
  app.done = null;
  hideBar();
  $("#main").replaceChildren(renderJournal(env()));
  document.title = `${t("journalPage.title")} — decide`;
  window.scrollTo({ top: 0 });
  syncRail();
}

function rememberSettingsFrom() {
  if (app.view === "settings" || app.view === "boot") return;
  const id = app.round?.id || app.done?.id;
  settingsFrom = { hash: id ? `#r=${id}` : app.view === "journal" ? "#journal" : "", scroll: window.scrollY };
}
function openSettings() {
  if (app.view === "settings") return;
  rememberSettingsFrom();
  location.hash = "settings";
}
async function leaveSettings() {
  net.holdReload("view", () => false);
  const back = settingsFrom || { hash: "", scroll: 0 };
  settingsFrom = null;
  history.replaceState(null, "", location.pathname + location.search + back.hash);
  if (back.hash === "#journal") showJournal();
  else if (back.hash.startsWith("#r=")) await openRound(back.hash.slice(3));
  else showIdle();
  requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: back.scroll, behavior: "instant" })));
}
function showSettings() {
  rememberSettingsFrom();
  disarmAdvance();
  app.round?.stop();
  app.round = null;
  app.view = "settings";
  app.done = null;
  hideBar();
  $("#main").replaceChildren(renderSettings(env()));
  document.title = `${t("settings.title")} — decide`;
  window.scrollTo({ top: 0 });
  syncRail();
}

function leaveJournal() {
  const back = app.state.rounds.find((r) => r.id === app.journalFrom) || app.state.rounds.at(-1);
  if (back) return openRound(back.id);
  history.replaceState(null, "", location.pathname + location.search);
  showIdle();
}

function refreshTabs() {
  const old = $(".round-tabs");
  const fresh = roundTabs(env());
  if (old && fresh) old.replaceWith(fresh);
  else if (old) old.remove();
  else if (fresh) $(".top .eyebrow")?.after(fresh);
}

// ---- the rail (inbox.js)
let railTimer = null;
function ensureRail() {
  if (rail || offline) return;
  rail = createInbox({
    open: (id) => {
      closeRail();
      if (id !== app.round?.id) openRound(id);
    },
    dismiss: (id) =>
      dismissRound(id)
        .then(() => refreshInbox())
        .catch(() => toast(t("inbox.dismissFailed"))),
    askNotify: () => Notification.requestPermission().then(() => rail.repaint()),
    close: closeRail,
  });
  const scrim = Object.assign(document.createElement("div"), { className: "rail-scrim", onclick: closeRail });
  $(".layout").prepend(rail.el);
  document.body.append(scrim);
  document.addEventListener("keydown", (e) => e.key === "Escape" && document.body.classList.contains("rail-open") && closeRail());
}

const toggleRail = () => document.body.classList.toggle("rail-open");
const closeRail = () => document.body.classList.remove("rail-open");

function syncRail() {
  if (offline) return;
  ensureRail();
  rail.setReview(app.view === "settings" || document.body.classList.contains("review-mode"));
  rail.set(app.inbox, app.round?.id ?? app.done?.id ?? null);
  // The header's "Rounds · n" button, where the rail is a drawer.
  for (const b of $$(".inbox-btn")) {
    b.textContent = t("inbox.button", app.inbox.length);
    b.hidden = app.inbox.length < 2;
  }
}

// Called on every state or inbox event: one fetch after a short pause, however many events came.
function refreshInbox() {
  if (offline) return Promise.resolve();
  clearTimeout(railTimer);
  return new Promise((resolve) => {
    railTimer = setTimeout(async () => {
      const rows = await loadInbox(app.state);
      if (rows) {
        const nextId = () => (app.view === "done" ? nextRound(app.inbox, app.done.id)?.id : null);
        const before = nextId();
        app.inbox = rows;
        setBadge(badgeCount(rows, app.state));
        syncRail();
        if (nextId() !== before) rerenderStatic();
        if (app.view === "done") armAdvance();
      }
      resolve();
    }, 80);
  });
}

// ---- daemon push
const rowOf = (r) => ({ id: r.id, title: r.title, projectName: baseName(r.project) });

function onState(st) {
  app.state = st;
  const fresh = st.rounds.filter((r) => !app.seen.has(r.id));
  fresh.forEach((r) => app.seen.add(r.id));
  refreshInbox();
  const announce = () => {
    for (const r of fresh) {
      toast(t("toast.newRound", r.title));
      notifyNew(rowOf(r));
    }
  };
  if (app.view === "round") {
    const current = st.rounds.find((r) => r.id === app.round.id);
    if (!current) return openRound(app.round.id, false);
    if (current.view !== undefined) app.round.setView?.(current.view);
    if (app.round.setListening) app.round.setListening(current.listening !== false);
    else updatePresence(current.listening !== false);
    refreshTabs();
    return announce();
  }
  // Sitting on the inbox (nothing open): the new round opens here. Elsewhere it joins the rail.
  if (fresh.length && (app.view === "idle" || app.view === "boot")) return openRound(fresh.at(-1).id);
  announce();
  if (app.view === "journal") return;
  rerenderStatic();
}

function onDialog(d) {
  if (app.view === "round" && app.round.id === d.round) app.round.setDialog(d.dialog);
}

function onDeck(d) {
  if (app.view === "round" && app.round.id === d.round && app.round.mode === "swipe") app.round.setDeck(d.deck, d.swipe, d.seq);
}

function onStatus(ok) {
  if (app.connected === ok) return;
  app.connected = ok;
  document.body.classList.toggle("offline", !ok);
  showStopped(!ok, app.state);
  if (app.view === "done") armAdvance();
  if (app.view !== "round") rerenderStatic();
}

function renderDoneView() {
  const { id, result } = app.done;
  $("#main").replaceChildren(renderDone(result, env()));
  const title = result?.cancelled ? "title.cancelled" : offline ? "title.file" : deliveryOf(id).delivered ? "title.sent" : "title.saved";
  document.title = `${t(title)} — decide`;
}

function rerenderStatic() {
  if (app.view === "done") renderDoneView();
  else if (app.view === "idle") $("#main").replaceChildren(renderIdle(env()));
}

// ---- review, submit, cancel
function review() {
  if (app.view !== "round" || app.sending) return;
  // A swipe deck and a code review have their own way to end.
  if (app.round.finish) return app.round.finish();
  // An answer marked "check" must be kept or answered again before the round can go.
  const unchecked = app.round.toCheck?.() || [];
  if (unchecked.length) {
    toast(t("check.refuse", unchecked.length));
    return app.round.openCheck();
  }
  const open = $("#overlay .review .btn.primary");
  if (open) return open.click();
  const r = app.round;
  openReview({ spec: r.spec, answers: r.answers, comment: r.comment().trim(), onSend: send, onJump: go, askName: offline ? { value: answererName() } : null });
}

async function send(fill = "recommend", name = "") {
  const r = app.round;
  if (!r || app.sending) return;
  app.sending = true;
  try {
    // A flag or an answer still on its way lands first: the server adds the flags to the answers it sends.
    await store.flush();
    const res = await submitRound(r.id, { ...r.payload(finalizeAnswers(r.spec, r.answers, { fill })), ...(offline ? { name } : {}) });
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

// A swipe deck and a code review draw their own screen: the question shortcuts are not theirs.
const swiping = () => app.round?.mode === "swipe" || app.round?.mode === "review";

function step(delta) {
  if (app.round?.step) return app.round.step(delta); // a review walks its chapters
  if (swiping()) return;
  const ids = visibleIds();
  if (!ids.length) return;
  const i = ids.indexOf(app.round.current());
  go(ids[i < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, i + delta))]);
}

function nextOpen() {
  const r = app.round;
  if (!r || swiping()) return;
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
  if (kind === "rec" && app.round?.toggleRead) return app.round.toggleRead(); // R in a review: the chapter is read
  if (swiping()) return;
  const q = currentQuestion();
  if (!q) return;
  const { ctx } = app.round;
  if (kind === "note") return ctx.openNote(q.id);
  if (kind === "delegate" && q.mine) return toast(t("toast.mine"));
  if (kind !== "rec") return ctx.toggleFlag(q.id, kind);
  if (recommendedIds(q).length || q.type === "rank") ctx.applyRecommended(q.id);
  else toast(t("toast.noRec"));
}

function pick(n) {
  if (swiping()) return;
  const q = currentQuestion();
  if (!q) return;
  // With nothing current yet, the first card is the one being answered; remember it so J moves on from it.
  if (!app.round.current()) app.round.setCurrent(q.id);
  typeOf(q).keys?.pick(q, n, app.round.ctx);
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
    if (app.view === "round" && !swiping()) mark(e.target.closest?.(".card") || $("#final"));
  });
  document.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) mark(null);
  });
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    mark(null);
    if (app.view !== "round" || swiping()) return;
    const qid = e.target.closest?.(".card")?.dataset.qid || null;
    [...e.dataTransfer.files].forEach((f) => app.round.ctx.attach(qid, f));
  });
}

// A click into a live mockup moves focus into its frame, and keys pressed there never reach this
// page: the swipe arrows and the question shortcuts stop. The first pointer move back on the page
// returns focus to the card around the frame.
function bindFrameFocus() {
  window.addEventListener("blur", () =>
    setTimeout(() => {
      const frame = document.activeElement;
      if (frame?.tagName !== "IFRAME") return;
      const back = () => {
        if (document.activeElement !== frame) return;
        const card = frame.closest(".sw-card, .card");
        if (card) card.focus({ preventScroll: true });
        else frame.blur();
      };
      document.addEventListener("pointermove", back, { once: true });
    }),
  );
}

// ---- skip link: first stop in the tab order
function skipLink() {
  const main = $("#main");
  main.setAttribute("tabindex", "-1");
  const a = document.createElement("a");
  a.className = "skip-link";
  a.href = "#main";
  a.textContent = t("a11y.skip");
  a.addEventListener("click", (e) => {
    e.preventDefault();
    main.focus();
    main.scrollIntoView();
  });
  document.body.prepend(a);
}

async function boot() {
  if (!offline) net.takeFileKeys();
  document.documentElement.lang = lang;
  skipLink();
  $("#toc").setAttribute("aria-label", t("toc"));
  $(".boot").textContent = t("boot");
  loadTheme();
  window.addEventListener("storage", (e) => {
    if (e.key !== THEME_KEY && e.key !== null) return;
    delete document.documentElement.dataset.theme;
    loadTheme();
    syncTheme();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintTheme);
  bindKeys({ submit: review, step: (d) => app.round && step(d), nextOpen, act, help: () => (app.round?.help ? app.round.help() : swiping() || openHelp()), pick });
  document.addEventListener("focusin", (e) => {
    if (app.done?.justFinished && e.target.closest("textarea, input, [contenteditable=true], [role=dialog]")) stay();
  });
  bindDrop();
  bindFrameFocus();
  try {
    app.state = await getState();
    app.connected = true;
  } catch {
    showIdle();
    showStopped(true, app.state);
  }
  app.state.rounds.forEach((r) => app.seen.add(r.id));
  if (app.connected && !offline) app.inbox = (await loadInbox(app.state)) || [];
  window.addEventListener("hashchange", () => {
    if (!offline) net.takeFileKeys();
    if (location.hash === "#journal") return app.view !== "journal" && (closeOverlays(), showJournal());
    if (location.hash === "#settings") return app.view !== "settings" && (closeOverlays(), showSettings());
    if (!location.hash && app.view === "settings") { settingsFrom = null; return showIdle(); }
    const id = new URLSearchParams(location.hash.slice(1)).get("r");
    if (id && id !== app.round?.id && id !== app.done?.id) {
      closeOverlays();
      openRound(id);
    }
  });
  const id = new URLSearchParams(location.hash.slice(1)).get("r");
  if (location.hash === "#journal") showJournal();
  else if (location.hash === "#settings") showSettings();
  else if (id) await openRound(id);
  else if (app.state.rounds.length) await openRound(app.state.rounds.at(-1).id);
  else if (app.view === "boot") showIdle();
  const es = listen(onState, onStatus, onDialog, onDeck);
  // 3.0 rounds that react: an agent patch, a restore or a keep moves the round's view (the store keeps answers only).
  net.onEvent("round", (d) => {
    if (d?.patch?.view !== undefined && app.view === "round" && app.round?.id === d.round) app.round.setView?.(d.patch.view);
    // A code review: a comment or a read mark saved (here or in another tab).
    if (d?.patch?.review && app.view === "round" && app.round?.id === d.round) app.round.setReview?.(d.patch.review, d.seq);
  });
  es.addEventListener?.("inbox", refreshInbox);
  syncRail();
  registerShell(); // installable page: offline shell, app badge, fallback-port note
  setBadge(badgeCount(app.inbox, app.state));
}

boot();
