// swipe.js — the swipe interview on screen: the deck in the middle (← → pick a
// side, ↑ skips, ↓ asks the agent to explain, Enter types an own answer,
// Backspace takes the last answer back), the brief the agent keeps rewriting on the left, and its confidence
// on top. Answers go out one by one; the agent's pushes come back as "deck". Each side tile shows its
// own media; at the end the user can leave a closing note or ask the agent to dig deeper.

import { h, icon, $ } from "./dom.js";
import { t } from "./i18n.js";
import { md } from "./md.js";
import { renderMedia } from "./media.js";
import { eyebrow } from "./header.js";
import { hideBar } from "./round.js";
import { modalOpen, openLightbox, openModal, openZoom, toast } from "./overlays.js";
import { askAgent, digDeeper, submitRound, swipeCard } from "./net.js";

const KINDS = ["decision", "risk", "problem", "open", "note"];
const KIND_ICON = { decision: "check", risk: "alert", problem: "x", open: "help", note: "note" };
const FLY_MS = 320;
const DRAG_PICK = 110;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const PRELOAD = 2; // cards behind the front one whose media loads ahead

export function mountSwipe(round, env) {
  let deck = round.spec;
  let server = round.swipe || { answers: {}, fresh: [], thinking: false, batches: 0 };
  let dialog = round.dialog || [];
  let listening = round.listening !== false;
  // Answers sent but not yet confirmed by the daemon: card → {side} or {undo: true}.
  const inflight = new Map();
  // Cards the user answered here, newest last: Backspace walks back through them.
  const trail = Object.entries(server.answers)
    .sort((a, b) => a[1].at - b[1].at)
    .map(([id]) => id);
  let pinned = null; // a card brought back by undo goes first
  let asking = null; // card id with the "explain" box open
  let writing = null; // card id with the "own answer" box open
  let ownDraft = "";
  let flying = false;
  let finishing = false;
  const shownBrief = new Set();
  let firstPaint = true;
  let frontSig = null; // the front card is rebuilt only when what it shows changes
  let endSig = null; // the same for the end-of-deck card
  let askDraft = "";
  let arrived = new Set(); // cards the agent just added: they slide into the stack
  let deltaTimer = null;
  let note = ""; // the closing note, shared by the done screen and the "Enough" dialog
  let digging = false; // a "Dig deeper" request is on its way
  const media = { toast, lightbox: (images, i) => openLightbox(images, i), zoom: openZoom };

  const answers = () => {
    const out = { ...server.answers };
    for (const [id, a] of inflight) {
      if (a.undo) delete out[id];
      else out[id] = a;
    }
    return out;
  };
  const byId = () => new Map(deck.cards.map((c) => [c.id, c]));
  const queue = () => {
    const a = answers();
    const open = deck.cards.filter((c) => !a[c.id]);
    const i = pinned ? open.findIndex((c) => c.id === pinned) : -1;
    if (i > 0) open.unshift(...open.splice(i, 1));
    return open;
  };

  // ---- layout
  document.body.classList.add("swipe-mode");
  hideBar();
  const briefBox = h("div.sw-brief-body");
  const briefToggle = h("button.sw-brief-toggle", { type: "button", onclick: () => aside.classList.toggle("open") });
  const aside = h("aside.sw-brief", { "aria-label": t("sw.brief") }, briefToggle, briefBox);
  const confFill = h("div.sw-conf-fill");
  const confNum = h("span.sw-conf-num");
  const counter = h("span.chip.static.sw-count");
  const presence = h("span.chip.static.presence");
  const status = h("div.sw-status", { "aria-live": "polite" });
  const delta = h("span.chip.static.sw-delta", { hidden: true, "aria-live": "polite" });
  const stack = h("div.sw-stack");
  const doneBanner = h("div.sw-banner", { hidden: true });
  const keys = h(
    "div.sw-keys",
    {},
    keyBtn("left", "←", t("sw.keyLeft"), () => answer("left")),
    keyBtn("up", "↑", t("sw.keySkip"), () => answer("skip")),
    keyBtn("down", "↓", t("sw.keyExplain"), () => openAsk()),
    keyBtn("own", "↵", t("sw.keyOwn"), () => openOwn()),
    keyBtn("undo", "⌫", t("sw.keyUndo"), () => undo()),
    keyBtn("right", "→", t("sw.keyRight"), () => answer("right")),
  );
  const foot = h("div.sw-foot");
  const stopBtn = h("button.btn.ghost.sw-stop", { type: "button", onclick: () => confirmFinish(), html: `${t("sw.enough")}<kbd>Esc</kbd>` });
  const stage = h(
    "div.sw-stage",
    {},
    eyebrow({ ...env, help: openSwipeHelp }),
    h(
      "header.sw-top",
      {},
      h("h1.sw-title", {}, deck.title),
      h("div.sw-conf", { title: t("sw.confTitle") }, h("span.sw-conf-label", {}, t("sw.conf")), h("div.sw-conf-track", {}, confFill), confNum),
      h("div.meta-row.sw-meta", {}, counter, delta, presence, status),
    ),
    doneBanner,
    stack,
    keys,
    foot,
  );
  $("#main").replaceChildren(h("section.sw", {}, aside, stage));

  // ---- painting
  function paint() {
    const a = answers();
    const total = deck.cards.length;
    const answered = deck.cards.filter((c) => a[c.id]).length;
    counter.textContent = t("sw.count", answered, total);
    confFill.style.transform = `scaleX(${deck.confidence / 100})`;
    confFill.dataset.level = deck.confidence >= 80 ? "high" : deck.confidence >= 45 ? "mid" : "low";
    confNum.textContent = `${deck.confidence}%`;
    paintPresence();
    paintBrief(a);
    paintDeck();
    document.title = `${queue().length ? `(${queue().length}) ` : "✓ "}${deck.title} — decide`;
  }

  function paintPresence() {
    presence.classList.toggle("live", listening);
    presence.classList.toggle("away", !listening);
    presence.textContent = t(listening ? "sw.live" : "sw.away");
    status.replaceChildren(...(server.thinking && listening ? [h("span.sw-think", {}, h("span.sw-dots", {}, h("i"), h("i"), h("i")), t("sw.thinking"))] : []));
  }

  function paintBrief(a) {
    const cards = byId();
    const groups = KINDS.map((kind) => {
      const items = deck.brief.filter((b) => b.kind === kind);
      if (!items.length) return null;
      return h(
        `section.sw-group.k-${kind}`,
        {},
        h("h3.sw-group-h", { html: `${icon(KIND_ICON[kind])}${t(`sw.kind.${kind}`)}<span class="n">${items.length}</span>` }),
        h("ul", {}, items.map((b) => briefItem(b, kind))),
      );
    });
    const freshIds = [...new Set([...server.fresh, ...[...inflight.keys()].filter((id) => !inflight.get(id).undo)])].filter((id) => a[id]);
    const fresh = freshIds.length
      ? h(
          "section.sw-group.k-fresh",
          {},
          h("h3.sw-group-h", { html: `${icon("spark")}${t("sw.fresh")}<span class="n">${freshIds.length}</span>` }),
          h(
            "ul",
            {},
            freshIds.map((id) => {
              const c = cards.get(id);
              return h("li.sw-item.raw", {}, h("span.t", {}, c?.title || id), h("span.ans", {}, answerText(c, a[id])));
            }),
          ),
        )
      : null;
    const empty = !deck.brief.length && !fresh;
    briefBox.replaceChildren(
      ...[
        h("div.sw-brief-head", {}, h("div.sw-brief-label", {}, t("sw.brief")), deck.goal && h("h2.sw-goal", {}, deck.goal)),
        ...groups,
        fresh,
        empty && h("p.sw-brief-empty", {}, t("sw.briefEmpty")),
      ].filter(Boolean),
    );
    const count = deck.brief.length;
    briefToggle.innerHTML = `${icon("note")}<span>${t("sw.brief")}</span><span class="n">${count}</span>${icon("chevron", "chev")}`;
    firstPaint = false;
  }

  function briefItem(b, kind) {
    const key = `${kind}:${b.text}`;
    const isNew = !firstPaint && !shownBrief.has(key);
    shownBrief.add(key);
    return h(`li.sw-item${isNew ? ".new" : ""}`, { html: md(b.text, deck.glossary) });
  }

  function paintDeck() {
    const q = queue();
    const top = q[0];
    doneBanner.hidden = !(deck.done && top);
    if (deck.done && top) doneBanner.replaceChildren(h("span", {}, t("sw.doneEarly")), h("button.btn.primary.sm", { type: "button", onclick: () => confirmFinish() }, t("sw.finish")));
    keys.classList.toggle("off", !top);
    foot.replaceChildren(...(deck.done && !top ? [] : [stopBtn]));
    if (!top) {
      frontSig = null;
      // Rebuilt only when what it says changes: the note box keeps focus and caret while the user types.
      const sig = JSON.stringify([deck.done, server.digging || digging, server.thinking, listening, deck.confidence]);
      if (sig === endSig && $(".sw-end", stack)) return;
      endSig = sig;
      return stack.replaceChildren(endCard());
    }
    endSig = null;
    const back = q.slice(1, 3).map((c, i) => h(`div.sw-card.back.b${i + 1}${arrived.has(c.id) ? ".arrive" : ""}`, { "aria-hidden": "true" }, h("div.sw-q", {}, c.title)));
    const sig = JSON.stringify([top, dialog.filter((d) => d.qid === top.id), asking === top.id, writing === top.id, deck.glossary]);
    const old = $(".sw-card.front", stack);
    let front = old;
    if (!old || sig !== frontSig || old.dataset.card !== top.id || old.matches(".fly-left, .fly-right, .fly-up")) {
      front = frontCard(top);
      if (old?.dataset.card !== top.id) front.classList.add("enter");
    }
    frontSig = sig;
    const left = $(".sw-left-n", front);
    left.textContent = t("sw.leftN", q.length);
    if (arrived.size) {
      left.classList.remove("bump");
      void left.offsetWidth;
      left.classList.add("bump");
      arrived = new Set(); // slide in once, not on every repaint
    }
    stack.replaceChildren(...back.reverse(), front);
    preload(q.slice(1, 1 + PRELOAD));
  }

  // The next cards' pictures and clips load while the user reads the front one.
  const loaded = new Set();
  const keep = []; // video elements stay referenced, or the browser drops the download
  function preload(cards) {
    for (const node of cards.flatMap((c) => [c, c.left, c.right])) {
      const imgs = [...(node.images || []).map((i) => i.src), node.compare?.before?.src, node.compare?.after?.src, ...(node.video || []).filter((v) => v.gif).map((v) => v.src)];
      for (const src of imgs.filter((x) => x && !loaded.has(x))) {
        loaded.add(src);
        Object.assign(new Image(), { decoding: "async" }).src = src;
      }
      for (const v of (node.video || []).filter((x) => !x.gif && !loaded.has(x.src))) {
        loaded.add(v.src);
        const el = Object.assign(document.createElement("video"), { preload: "auto", muted: true, src: v.src });
        keep.push(el);
        if (keep.length > 6) keep.shift().removeAttribute("src");
      }
      if (node.preview && !loaded.has(node.preview.src)) {
        loaded.add(node.preview.src);
        document.head.append(h("link", { rel: "prefetch", href: node.preview.src }));
      }
    }
  }

  function endCard() {
    if (deck.done) {
      return h(
        "div.sw-end.done",
        {},
        h("div.ring", { html: icon("check") }),
        h("h2", {}, t("sw.doneTitle")),
        h("p", {}, t("sw.doneSub", deck.confidence)),
        noteBox(),
        h(
          "div.sw-end-actions",
          {},
          deeperBtn(),
          h("button.btn.primary", { type: "button", "data-autofocus": "", onclick: () => finish(), html: `${t("sw.finish")}<kbd>↵</kbd>` }),
        ),
      );
    }
    if (server.digging || digging) {
      return h("div.sw-end", {}, h("div.sw-spinner"), h("h2", {}, t(listening ? "sw.digTitle" : "sw.digQueued")), h("p", {}, t(listening ? "sw.digSub" : "sw.digQueuedSub")));
    }
    if (server.thinking) {
      return h("div.sw-end", {}, h("div.sw-spinner"), h("h2", {}, t("sw.waitTitle")), h("p", {}, t("sw.waitSub")));
    }
    return h(
      "div.sw-end",
      {},
      h("div.ring.away", { html: icon("history") }),
      h("h2", {}, t("sw.emptyTitle")),
      h("p", {}, t(listening ? "sw.emptySub" : "sw.emptyAway")),
      h("button.btn.ghost", { type: "button", onclick: () => confirmFinish() }, t("sw.enough")),
    );
  }

  // The closing note: free text that goes into the result and the brief, or with "Dig deeper" tells the agent where to dig.
  function noteBox() {
    const input = h("textarea.sw-ask-input.sw-note-input", { rows: 2, maxlength: 4000, placeholder: t("sw.notePlaceholder"), "aria-label": t("sw.note"), oninput: () => (note = input.value) });
    input.value = note;
    return h("label.sw-note", {}, h("span.sw-note-label", { html: `${icon("note")}${t("sw.note")}` }), input, h("span.sw-ask-hint", {}, t("sw.noteHint")));
  }

  const deeperBtn = (after) =>
    h("button.btn.ghost.sw-deeper", { type: "button", title: t("sw.deeperTitle"), onclick: () => (after?.(), dig()), html: `${icon("spark")}${t("sw.deeper")}` });

  function frontCard(c) {
    const ctx = media;
    const replies = dialog.filter((d) => d.qid === c.id);
    const waitingReply = replies.some((d) => !d.reply);
    const card = h(
      `article.sw-card.front${c.stakes === "high" ? ".high" : ""}`,
      { dataset: { card: c.id }, tabindex: "-1" },
      h("div.sw-stamp.l", {}, c.left.label),
      h("div.sw-stamp.r", {}, c.right.label),
      h("div.sw-stamp.u", {}, t("sw.skipped")),
      h(
        "div.sw-card-top",
        {},
        c.section && h("span.sw-sec", {}, c.section),
        c.stakes === "high" && h("span.badge.warn", { html: `${icon("alert")}${t("sw.high")}` }),
        h("span.sw-left-n", {}, t("sw.leftN", queue().length)),
      ),
      fromLine(c),
      h("h2.sw-q", { html: md(c.title, deck.glossary).replace(/^<p>|<\/p>$/g, "") }),
      c.tldr && h("div.sw-tldr.rich", { html: md(c.tldr, deck.glossary) }),
      c.body && h("div.sw-body.rich", { html: md(c.body, deck.glossary) }),
      renderMedia(c, ctx, c.id),
      replies.filter((d) => d.reply).map((d) => explainBox(d)),
      waitingReply && h("div.sw-explain.wait", {}, h("span.sw-dots", {}, h("i"), h("i"), h("i")), t("sw.explaining")),
      asking === c.id && askBox(c),
      h("div.sw-sides", {}, sideTile(c, "left"), sideTile(c, "right")),
      writing === c.id
        ? ownBox(c)
        : h("button.sw-own", { type: "button", onclick: () => openOwn() }, h("span", { html: icon("note") }), h("span", {}, t("sw.own")), h("kbd", {}, "↵")),
      c.recommended && c.reason && h("div.sw-reason", { html: `${icon("star")}${md(c.reason, deck.glossary).replace(/^<p>|<\/p>$/g, "")}` }),
    );
    bindDrag(card);
    return card;
  }

  // A follow-up says which answer brought it up.
  function fromLine(c) {
    const src = c.from && byId().get(c.from);
    const a = src && answers()[src.id];
    if (!a || a.side === "skip") return null;
    return h("div.sw-from", {}, h("span.arr", {}, "↳"), h("span", {}, t("sw.from")), h("b", {}, answerText(src, a)));
  }

  // How an answer reads back: a side's label, the user's own words, or "skipped".
  function answerText(c, a) {
    if (a.side === "skip") return t("sw.skipped");
    if (a.side === "own") return `«${a.text}»`;
    return c?.[a.side]?.label;
  }

  // New and dropped cards show for a moment next to the counter; new ones slide in behind the front card.
  function announce(added, removed) {
    arrived = new Set(added);
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

  // A side tile: the pick button on top, the side's own media below it. A click on the tile picks
  // the side; a click on its media zooms or plays it instead.
  function sideTile(c, side) {
    const s = c[side];
    const rec = c.recommended === side;
    const shown = renderMedia(s, media, c.id, { compact: true });
    return h(
      `div.sw-side.${side}${rec ? ".rec" : ""}${shown ? ".with-media" : ""}`,
      { onclick: (e) => !e.target.closest(".media-stop, a, button, video") && answer(side) },
      h(
        "button.sw-side-pick",
        { type: "button", onclick: () => answer(side) },
        h("span.sw-side-key", {}, side === "left" ? "←" : "→"),
        h("span.sw-side-label", {}, s.label),
        s.detail && h("span.sw-side-detail.rich", { html: md(s.detail, deck.glossary).replace(/^<p>|<\/p>$/g, "") }),
      ),
      shown,
      rec && h("span.sw-side-rec", { title: c.reason || t("sw.rec"), html: icon("star") }),
    );
  }

  function explainBox(d) {
    const r = d.reply;
    return h(
      "div.sw-explain",
      {},
      d.ask && h("div.sw-explain-q", {}, d.ask),
      h("div.rich", { html: md(r.text, deck.glossary) }),
      renderMedia(r, media, d.qid),
    );
  }

  function askBox(c) {
    const input = h("textarea.sw-ask-input", { rows: 2, placeholder: t("sw.askPlaceholder"), oninput: () => (askDraft = input.value) });
    input.value = askDraft;
    const send = () => sendAsk(c.id, input.value.trim());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        asking = null;
        paint();
      }
    });
    requestAnimationFrame(() => input.focus());
    return h(
      "div.sw-ask",
      {},
      input,
      h(
        "div.sw-ask-row",
        {},
        h("span.sw-ask-hint", {}, t("sw.askHint")),
        h("button.btn.primary.sm", { type: "button", onclick: send }, t("sw.askSend")),
      ),
    );
  }

  // The user's own answer when neither side fits: Enter sends, Shift+Enter breaks the line, Esc closes.
  function ownBox(c) {
    const input = h("textarea.sw-ask-input.sw-own-input", { rows: 2, maxlength: 2000, placeholder: t("sw.ownPlaceholder"), oninput: () => (ownDraft = input.value) });
    input.value = ownDraft;
    const send = () => {
      const text = input.value.trim();
      if (!text) return input.focus();
      answer("own", text);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        writing = null;
        paint();
      }
    });
    requestAnimationFrame(() => input.focus());
    return h(
      "div.sw-ask.sw-own-box",
      {},
      input,
      h("div.sw-ask-row", {}, h("span.sw-ask-hint", {}, t("sw.ownHint")), h("button.btn.primary.sm", { type: "button", onclick: send }, t("sw.ownSend"))),
    );
  }

  // ---- actions
  async function answer(side, text) {
    const c = queue()[0];
    if (!c || flying || finishing) return;
    asking = null;
    askDraft = "";
    writing = null;
    ownDraft = "";
    if (pinned === c.id) pinned = null;
    inflight.set(c.id, side === "own" ? { side, text, at: Date.now() } : { side, at: Date.now() });
    trail.push(c.id);
    // Sent before the card flies off, so the daemon knows which card is on screen next as soon as possible.
    const sent = swipeCard(round.id, { card: c.id, side, ...(side === "own" ? { text } : {}), rev: c.rev || 0 });
    sent.catch(() => {});
    await fly(side);
    paint();
    try {
      await sent;
    } catch (e) {
      inflight.delete(c.id);
      trail.pop();
      if (side === "own" && e.status !== 409 && !writing) {
        // Keep what the user typed: the card comes back with the box open.
        writing = queue()[0]?.id === c.id ? c.id : null;
        ownDraft = writing ? text : "";
      }
      // 412: the agent rewrote the card mid-flight; 400: it removed it.
      toast(t(e.status === 409 ? "sw.closed" : e.status === 412 || e.status === 400 ? "sw.changed" : "sw.offline"));
      paint();
      return;
    }
    inflight.delete(c.id);
  }

  async function undo() {
    if (flying || finishing) return;
    const a = answers();
    while (trail.length && !a[trail.at(-1)]) trail.pop();
    const id = trail.pop();
    if (!id) return toast(t("sw.nothingToUndo"));
    asking = null;
    writing = null;
    ownDraft = "";
    pinned = id;
    inflight.set(id, { undo: true });
    paint();
    $(".sw-card.front", stack)?.classList.add("back-in");
    try {
      await swipeCard(round.id, { card: id, undo: true });
    } catch (e) {
      trail.push(id);
      pinned = null;
      toast(t(e.status === 409 ? "sw.closed" : "sw.offline"));
    }
    inflight.delete(id);
    paint();
  }

  function openAsk() {
    const c = queue()[0];
    if (!c || !round.live) return;
    asking = asking === c.id ? null : c.id;
    writing = null;
    paint();
  }

  function openOwn() {
    const c = queue()[0];
    if (!c || flying || finishing) return;
    writing = writing === c.id ? null : c.id;
    asking = null;
    paint();
  }

  async function sendAsk(qid, text) {
    try {
      const res = await askAgent(round.id, qid, text);
      if (!dialog.some((d) => d.id === res.id)) dialog = [...dialog, { id: res.id, qid, ask: text, seen: false, reply: null }];
      asking = null;
      askDraft = "";
      paint();
    } catch {
      toast(t("sw.askOffline"));
    }
  }

  function fly(side) {
    const card = $(".sw-card.front", stack);
    if (!card || reduced.matches) return Promise.resolve();
    flying = true;
    card.classList.add(`fly-${side === "skip" || side === "own" ? "up" : side}`);
    return new Promise((resolve) =>
      setTimeout(() => {
        flying = false;
        resolve();
      }, FLY_MS),
    );
  }

  function confirmFinish() {
    if (finishing) return;
    const a = answers();
    const n = deck.cards.filter((c) => a[c.id]).length;
    const close = openModal(
      h(
        "div.sw-finish",
        {},
        h("h2.modal-title", {}, t("sw.finishTitle")),
        h("p", {}, t("sw.finishSub", n, queue().length)),
        noteBox(),
        h(
          "div.modal-actions",
          {},
          h("button.btn.ghost", { type: "button", onclick: () => close() }, t("sw.keepGoing")),
          deeperBtn(() => close()),
          h("button.btn.primary", { type: "button", "data-autofocus": "", onclick: () => (close(), finish()) }, t("sw.finish")),
        ),
      ),
      { wide: true },
    );
  }

  // "Dig deeper": the deck stays open and the agent comes back with a stricter round of cards.
  async function dig() {
    if (finishing || digging) return;
    digging = true;
    paint();
    try {
      await digDeeper(round.id, note.trim());
      note = "";
      toast(t("sw.deeperSent"));
    } catch (e) {
      toast(t(e.status === 409 ? "sw.closed" : "sw.offline"));
    }
    digging = false;
    paint();
  }

  async function finish() {
    if (finishing) return;
    finishing = true;
    try {
      const res = await submitRound(round.id, note.trim() ? { note: note.trim() } : {});
      env.finished(round.id, res.result);
    } catch (e) {
      finishing = false;
      if (e.status === 409) env.switchTo(round.id);
      else toast(t("toast.sendFailed"));
    }
  }

  // ---- drag: left / right picks a side, up skips
  function bindDrag(card) {
    let start = null;
    card.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button, a, textarea, input, .media-stop, .sw-explain")) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      card.setPointerCapture(e.pointerId);
      card.classList.add("dragging");
    });
    card.addEventListener("pointermove", (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = Math.min(0, e.clientY - start.y);
      card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
      card.style.setProperty("--l", String(Math.min(1, Math.max(0, -dx / DRAG_PICK))));
      card.style.setProperty("--r", String(Math.min(1, Math.max(0, dx / DRAG_PICK))));
      card.style.setProperty("--u", String(Math.abs(dx) < DRAG_PICK / 2 ? Math.min(1, Math.max(0, -dy / DRAG_PICK)) : 0));
    });
    const end = (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      start = null;
      card.classList.remove("dragging");
      card.style.transform = "";
      for (const v of ["--l", "--r", "--u"]) card.style.removeProperty(v);
      if (dx <= -DRAG_PICK) answer("left");
      else if (dx >= DRAG_PICK) answer("right");
      else if (dy <= -DRAG_PICK && Math.abs(dx) < DRAG_PICK / 2) answer("skip");
    };
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", end);
  }

  // ---- keys
  const onKey = (e) => {
    // ⌘↵ comes through main.js (finish below); the rest is ours.
    if (e.target.closest?.("input, textarea, [contenteditable]") || modalOpen() || e.altKey || e.metaKey || e.ctrlKey) return;
    const act = {
      ArrowLeft: () => answer("left"),
      ArrowRight: () => answer("right"),
      ArrowUp: () => answer("skip"),
      ArrowDown: () => openAsk(),
      Backspace: () => undo(),
      Escape: () => confirmFinish(),
      Enter: () => (queue().length ? openOwn() : deck.done && finish()),
      "?": () => openSwipeHelp(),
    }[e.key];
    if (!act) return;
    e.preventDefault();
    if (!e.repeat) act();
  };
  document.addEventListener("keydown", onKey);

  paint();

  return {
    id: round.id,
    mode: "swipe",
    spec: deck,
    setDialog(next) {
      const had = new Set(dialog.filter((d) => d.reply).map((d) => d.id));
      dialog = next;
      const top = queue()[0];
      for (const d of next.filter((x) => x.reply && !had.has(x.id) && x.qid !== top?.id)) toast(t("toast.replied", byId().get(d.qid)?.title || d.qid));
      paint();
    },
    setDeck(next, view) {
      const a = answers();
      const shown = queue()[0]?.id;
      const before = new Set(deck.cards.map((c) => c.id));
      const after = new Set(next.cards.map((c) => c.id));
      const added = next.cards.filter((c) => !before.has(c.id)).map((c) => c.id);
      const removed = [...before].filter((id) => !after.has(id) && !a[id]).length;
      deck = next;
      server = view || server;
      // The card the user is reading stays in front, even if the push landed before the daemon heard the last answer.
      if (shown && queue().some((c) => c.id === shown) && queue()[0].id !== shown) pinned = shown;
      if (added.length || removed) announce(added, removed);
      if (!flying) paint(); // answer() repaints once the card has flown off
    },
    setListening(on) {
      listening = on;
      paintPresence();
      if (!queue().length) paintDeck();
    },
    finish: () => (deck.done && !queue().length ? finish() : confirmFinish()),
    stop() {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("swipe-mode");
    },
  };
}

function keyBtn(cls, key, label, onclick) {
  return h(`button.sw-key.${cls}`, { type: "button", onclick, title: label }, h("kbd", {}, key), h("span", {}, label));
}

const SWIPE_KEYS = [
  ["←  →", "sw.helpPick"],
  ["↑", "sw.helpSkip"],
  ["↓", "sw.helpExplain"],
  ["↵", "sw.helpOwn"],
  ["⌫", "sw.helpUndo"],
  ["Esc", "sw.helpEnough"],
];

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
