// swipe/index.js — the swipe interview on screen: the deck in the middle (← → pick a side, ↑ skips,
// ↓ asks the agent to explain, Space folds the what/how/why answers, Enter types an own answer,
// Backspace takes the last answer back), the brief the agent keeps rewriting on the left, and its
// confidence on top. Answers go out one by one; the agent's pushes come back as "deck". At the end
// the user can leave a closing note or ask the agent to dig deeper.
//
// The parts: brief.js (the left column), deck.js (stack, keys), card.js (one card), end.js (no card
// left, the closing note). They share one state object `s` made here.

import { h, $ } from "../dom.js";
import { t } from "../i18n.js";
import { eyebrow } from "../header.js";
import { hideBar } from "../round.js";
import { modalOpen, openLightbox, openModal, openZoom, toast } from "../overlays.js";
import { askAgent, digDeeper, holdReload, keepAnswer, restoreItem, submitRound, swipeCard } from "../net.js";
import { resolve, sigOf, swipeQueues } from "../states.js";
import { createBrief } from "./brief.js";
import { createDeck } from "./deck.js";
import { confirmFinish } from "./end.js";

const SWIPE_KEYS = [
  ["←  →", "sw.helpPick"],
  ["↑", "sw.helpSkip"],
  ["↓", "sw.helpExplain"],
  ["␣", "sw.helpFacets"],
  ["↵", "sw.helpOwn"],
  ["⌫", "sw.helpUndo"],
  ["Esc", "sw.helpEnough"],
];

export function mountSwipe(round, env) {
  const s = {
    round,
    deck: round.spec,
    server: round.swipe || { answers: {}, fresh: [], thinking: false, batches: 0 },
    dialog: round.dialog || [],
    listening: round.listening !== false,
    // Answers sent but not yet confirmed by the daemon: card → {side} or {undo: true}.
    inflight: new Map(),
    pinned: null, // a card brought back by undo goes first
    asking: null, // card id with the "explain" box open
    writing: null, // card id with the "own answer" box open
    ownDraft: "",
    askDraft: "",
    note: "", // the closing note, shared by the done screen and the "Enough" dialog
    flying: false,
    finishing: false,
    digging: false, // a "Dig deeper" request is on its way
    facetsOpen: false,
    arrived: new Set(), // cards the agent just added: they slide into the stack
    media: { toast, lightbox: (images, i) => openLightbox(images, i), zoom: openZoom },
  };
  // Cards the user answered here, newest last: Backspace walks back through them.
  const trail = Object.entries(s.server.answers)
    .sort((a, b) => a[1].at - b[1].at)
    .map(([id]) => id);
  let deltaTimer = null;

  // ---- text that must survive a reload: the closing note, an own answer, a question to the agent
  const KEY = `decide.swipe.${round.id}`;
  const store = {
    read() {
      try {
        return JSON.parse(sessionStorage.getItem(KEY) || "{}");
      } catch {
        return {};
      }
    },
    write(v) {
      try {
        if (v) sessionStorage.setItem(KEY, JSON.stringify(v));
        else sessionStorage.removeItem(KEY);
      } catch {}
    },
  };
  s.persist = () => {
    const v = { note: s.note, own: s.ownDraft, ask: s.askDraft };
    store.write(Object.values(v).some((x) => x.trim()) ? v : null);
  };
  {
    const saved = store.read();
    s.note = saved.note || "";
    s.ownDraft = saved.own || "";
    s.askDraft = saved.ask || "";
  }
  // While one of these holds text, the page does not reload on its own; a reload by hand restores it above.
  holdReload("view", () => [s.note, s.ownDraft, s.askDraft].some((text) => text.trim()));

  // How long the front card has been read: only while the tab is visible and no ask or own-answer box is open.
  const reading = { card: null, ms: 0, since: null };
  const readTick = () => {
    const now = performance.now();
    if (reading.since !== null) reading.ms += now - reading.since;
    reading.since = !document.hidden && !s.asking && !s.writing ? now : null;
  };
  s.readFor = (id) => {
    if (reading.card === id) return readTick();
    Object.assign(reading, { card: id, ms: 0, since: null });
    readTick();
  };
  document.addEventListener("visibilitychange", readTick);

  s.answers = () => {
    const out = { ...s.server.answers };
    for (const [id, a] of s.inflight) {
      if (a.undo) delete out[id];
      else out[id] = a;
    }
    return out;
  };
  s.byId = () => new Map(s.deck.cards.map((c) => [c.id, c]));
  // Ghost cards (rules, the agent's push) leave the queue; answers to check come back at the end.
  s.react = { restored: new Set(), kept: new Map() };
  const norm = (a) => (a ? { side: a.side, text: a.text } : a);
  s.states = () => {
    const a = s.answers();
    const view = s.server.view || {};
    const dropped = Object.entries(s.deck.ghosts || {}).map(([id, reason]) => ({ id, reason }));
    const plain = Object.fromEntries(Object.entries(a).map(([id, v]) => [id, norm(v)]));
    return resolve(s.deck, plain, { ...view, ghosts: [...(view.ghosts || []), ...dropped] }, s.react);
  };
  s.isRecheck = (id) => Boolean(s.answers()[id]) && s.states().stale.has(id);
  s.queue = () => {
    const a = s.answers();
    const { open, recheck } = swipeQueues(s.deck, Object.fromEntries(Object.entries(a).map(([id, v]) => [id, norm(v)])), s.states());
    const i = s.pinned ? open.findIndex((c) => c.id === s.pinned) : -1;
    if (i > 0) open.unshift(...open.splice(i, 1));
    return [...open, ...recheck];
  };
  s.ghosts = () => swipeQueues(s.deck, {}, s.states()).ghosts.map((c) => ({ card: c, reason: s.states().ghosts.get(c.id) }));
  s.restore = (id) => {
    s.react.restored.add(id);
    restoreItem(round.id, id).catch(() => {});
    s.paint();
  };
  // Boxes the user left open before a reload come back on the card they were for.
  {
    const top = s.queue()[0];
    if (top && s.ownDraft.trim()) s.writing = top.id;
    else if (top && s.askDraft.trim() && round.live) s.asking = top.id;
  }

  // ---- layout
  document.body.classList.add("swipe-mode");
  hideBar();
  const brief = createBrief(s);
  const deckView = createDeck(s);
  const confFill = h("div.sw-conf-fill");
  const confNum = h("span.sw-conf-num");
  const counter = h("span.chip.static.sw-count");
  const presence = h("span.chip.static.presence");
  const status = h("div.sw-status", { "aria-live": "polite" });
  const delta = h("span.chip.static.sw-delta", { hidden: true, "aria-live": "polite" });
  const stage = h(
    "div.sw-stage",
    {},
    eyebrow({ ...env, help: openSwipeHelp }),
    h(
      "header.sw-top",
      {},
      h("h1.sw-title", {}, s.deck.title),
      h("div.sw-conf", { title: t("sw.confTitle") }, h("span.sw-conf-label", {}, t("sw.conf")), h("div.sw-conf-track", {}, confFill), confNum),
      h("div.meta-row.sw-meta", {}, counter, delta, presence, status),
    ),
    deckView.doneBanner,
    deckView.stack,
    deckView.keys,
    deckView.foot,
  );
  $("#main").replaceChildren(h("section.sw", {}, brief.el, stage));

  // ---- painting
  s.paint = function paint() {
    const a = s.answers();
    const { deck } = s;
    const live = deck.cards.filter((c) => !s.states().ghosts.has(c.id));
    counter.textContent = t("sw.count", live.filter((c) => a[c.id]).length, live.length);
    confFill.style.transform = `scaleX(${deck.confidence / 100})`;
    confFill.dataset.level = deck.confidence >= 80 ? "high" : deck.confidence >= 45 ? "mid" : "low";
    confNum.textContent = `${deck.confidence}%`;
    paintPresence();
    brief.paint(a);
    deckView.paint();
    document.title = `${s.queue().length ? `(${s.queue().length}) ` : "✓ "}${deck.title} — decide`;
  };

  function paintPresence() {
    presence.classList.toggle("live", s.listening);
    presence.classList.toggle("away", !s.listening);
    presence.textContent = t(s.listening ? "sw.live" : "sw.away");
    status.replaceChildren(...(s.server.thinking && s.listening ? [h("span.sw-think", {}, h("span.sw-dots", {}, h("i"), h("i"), h("i")), t("sw.thinking"))] : []));
  }

  // The front card's fold, unless the card is flying off.
  const frontFacets = () => {
    const card = !s.flying && $(".sw-card.front");
    return card && $(".sw-facets", card);
  };
  s.toggleFacets = () => {
    const grid = frontFacets();
    if (!grid) return;
    const card = grid.closest(".sw-card");
    s.facetsOpen = grid.hidden;
    grid.hidden = !s.facetsOpen;
    $(".sw-facets-toggle", card).setAttribute("aria-expanded", String(s.facetsOpen));
  };

  // New and dropped cards show for a moment next to the counter; new ones slide in behind the front card.
  function announce(added, removed) {
    s.arrived = new Set(added);
    const parts = [added.length && t("sw.added", added.length), removed && t("sw.removed", removed)].filter(Boolean);
    delta.textContent = parts.join(" · ");
    delta.classList.toggle("minus", !added.length);
    delta.hidden = false;
    delta.classList.remove("pop");
    void delta.offsetWidth;
    delta.classList.add("pop");
    clearTimeout(deltaTimer);
    deltaTimer = setTimeout(() => (delta.hidden = true), 4000);
  }

  // ---- actions
  s.answer = async function answer(side, text) {
    const c = s.queue()[0];
    if (!c || s.flying || s.finishing) return;
    readTick();
    const ms = reading.card === c.id ? Math.round(reading.ms) : undefined;
    reading.card = null;
    s.asking = null;
    s.askDraft = "";
    s.writing = null;
    s.ownDraft = "";
    s.persist();
    if (s.pinned === c.id) s.pinned = null;
    // An answer to check: the same side keeps it; another side takes the old answer back first.
    const old = s.isRecheck(c.id) ? s.answers()[c.id] : null;
    if (old && side === old.side && side !== "own") {
      s.react.kept.set(c.id, sigOf(norm(old)));
      keepAnswer(round.id, c.id).catch(() => {});
      await deckView.fly(side);
      return s.paint();
    }
    s.inflight.set(c.id, side === "own" ? { side, text, at: Date.now() } : { side, at: Date.now() });
    trail.push(c.id);
    const send = () => swipeCard(round.id, { card: c.id, side, ...(side === "own" ? { text } : {}), rev: c.rev || 0, ms });
    // Sent before the card flies off, so the daemon knows which card is on screen next as soon as possible.
    const sent = old ? swipeCard(round.id, { card: c.id, undo: true }).then(send) : send();
    sent.catch(() => {});
    await deckView.fly(side);
    s.paint();
    try {
      await sent;
    } catch (e) {
      s.inflight.delete(c.id);
      trail.pop();
      if (side === "own" && e.status !== 409 && !s.writing) {
        // Keep what the user typed: the card comes back with the box open.
        s.writing = s.queue()[0]?.id === c.id ? c.id : null;
        s.ownDraft = s.writing ? text : "";
        s.persist();
      }
      // 412: the agent rewrote the card mid-flight; 400: it removed it.
      toast(t(e.status === 409 ? "sw.closed" : e.status === 412 || e.status === 400 ? "sw.changed" : "sw.offline"));
      s.paint();
      return;
    }
    s.inflight.delete(c.id);
  };

  s.undo = async function undo() {
    if (s.flying || s.finishing) return;
    const a = s.answers();
    while (trail.length && !a[trail.at(-1)]) trail.pop();
    const id = trail.pop();
    if (!id) return toast(t("sw.nothingToUndo"));
    s.asking = null;
    s.writing = null;
    s.ownDraft = "";
    s.persist();
    s.pinned = id;
    s.inflight.set(id, { undo: true });
    s.paint();
    $(".sw-card.front", deckView.stack)?.classList.add("back-in");
    try {
      await swipeCard(round.id, { card: id, undo: true });
    } catch (e) {
      trail.push(id);
      s.pinned = null;
      toast(t(e.status === 409 ? "sw.closed" : "sw.offline"));
    }
    s.inflight.delete(id);
    s.paint();
  };

  s.openAsk = () => {
    const c = s.queue()[0];
    if (!c || !round.live) return;
    s.asking = s.asking === c.id ? null : c.id;
    s.writing = null;
    s.paint();
  };

  s.openOwn = () => {
    const c = s.queue()[0];
    if (!c || s.flying || s.finishing) return;
    s.writing = s.writing === c.id ? null : c.id;
    s.asking = null;
    s.paint();
  };

  s.sendAsk = async (qid, text) => {
    try {
      const res = await askAgent(round.id, qid, text);
      if (!s.dialog.some((d) => d.id === res.id)) s.dialog = [...s.dialog, { id: res.id, qid, ask: text, seen: false, reply: null }];
      s.asking = null;
      s.askDraft = "";
      s.persist();
      s.paint();
    } catch {
      toast(t("sw.askOffline"));
    }
  };

  // "Dig deeper": the deck stays open and the agent comes back with a stricter round of cards.
  s.dig = async () => {
    if (s.finishing || s.digging || s.server.digging) return;
    s.digging = true;
    s.paint();
    try {
      await digDeeper(round.id, s.note.trim());
      s.note = "";
      s.persist();
      toast(t("sw.deeperSent"));
    } catch (e) {
      toast(t(e.status === 409 ? "sw.closed" : "sw.offline"));
    }
    s.digging = false;
    s.paint();
  };

  s.finish = async () => {
    if (s.finishing) return;
    s.finishing = true;
    try {
      const res = await submitRound(round.id, s.note.trim() ? { note: s.note.trim() } : {});
      store.write(null);
      env.finished(round.id, res.result);
    } catch (e) {
      s.finishing = false;
      if (e.status === 409) env.switchTo(round.id);
      else toast(t("toast.sendFailed"));
    }
  };

  // ---- keys
  const onKey = (e) => {
    // ⌘↵ comes through main.js (finish below); the rest is ours.
    if (e.target.closest?.("input, textarea, [contenteditable]") || modalOpen() || e.altKey || e.metaKey || e.ctrlKey) return;
    // Space folds the answers, but leaves a focused button, link or video and pages without a fold alone.
    if (e.key === " ") {
      if (e.target.closest?.("button, a, video, audio, select, summary") || !frontFacets()) return;
      e.preventDefault();
      if (!e.repeat) s.toggleFacets();
      return;
    }
    const act = {
      ArrowLeft: () => s.answer("left"),
      ArrowRight: () => s.answer("right"),
      ArrowUp: () => s.answer("skip"),
      ArrowDown: () => s.openAsk(),
      Backspace: () => s.undo(),
      Escape: () => confirmFinish(s),
      Enter: () => (s.queue().length ? s.openOwn() : s.deck.done && s.finish()),
      "?": () => openSwipeHelp(),
    }[e.key];
    if (!act) return;
    e.preventDefault();
    if (!e.repeat) act();
  };
  document.addEventListener("keydown", onKey);

  s.paint();

  return {
    id: round.id,
    mode: "swipe",
    spec: s.deck,
    setDialog(next) {
      const had = new Set(s.dialog.filter((d) => d.reply).map((d) => d.id));
      s.dialog = next;
      const top = s.queue()[0];
      for (const d of next.filter((x) => x.reply && !had.has(x.id) && x.qid !== top?.id)) toast(t("toast.replied", s.byId().get(d.qid)?.title || d.qid));
      s.paint();
    },
    setDeck(next, view) {
      const a = s.answers();
      const shown = s.queue()[0]?.id;
      const before = new Set(s.deck.cards.map((c) => c.id));
      const after = new Set(next.cards.map((c) => c.id));
      const added = next.cards.filter((c) => !before.has(c.id)).map((c) => c.id);
      const removed = [...before].filter((id) => !after.has(id) && !a[id]).length;
      s.deck = next;
      s.server = view || s.server;
      // The card the user is reading stays in front, even if the push landed before the daemon heard the last answer.
      if (shown && s.queue().some((c) => c.id === shown) && s.queue()[0].id !== shown) s.pinned = shown;
      if (added.length || removed) announce(added, removed);
      if (!s.flying) s.paint(); // answer() repaints once the card has flown off
    },
    setListening(on) {
      s.listening = on;
      paintPresence();
      if (!s.queue().length) deckView.paint();
    },
    finish: () => (s.deck.done && !s.queue().length ? s.finish() : confirmFinish(s)),
    stop() {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", readTick);
      document.body.classList.remove("swipe-mode");
      deckView.stop();
    },
  };
}

function openSwipeHelp() {
  const close = openModal(
    h(
      "div.help",
      {},
      h("h2.modal-title", {}, t("keys.title")),
      h("dl.keys", {}, SWIPE_KEYS.map(([k, d]) => [h("dt", {}, h("kbd", {}, k)), h("dd", {}, t(d))])),
      h("p.sw-help-touch", {}, t("sw.helpTouch")),
      h("div.modal-actions", {}, h("button.btn.primary", { type: "button", onclick: () => close() }, t("keys.ok"))),
    ),
  );
}
