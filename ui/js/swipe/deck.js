// deck.js — the deck in the middle: the stack of cards (the front one, the next two peeking out
// behind it), the key strip under it and the "enough" button. When no card is left the stack shows
// the end card (end.js) and the strip goes away: the end card carries its own controls.

import { h, icon, $ } from "../dom.js";
import { t } from "../i18n.js";
import { FACETS } from "../question.js";
import { backCard, frontCard } from "./card.js";
import { confirmFinish, endCard } from "./end.js";

const FLY_MS = 320;
const PRELOAD = 2; // cards behind the front one whose media loads ahead
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

// A key of the strip: its keyboard key, its label, and a picture for touch screens, where the key means nothing.
function keyBtn(cls, key, label, onclick, pic) {
  return h(`button.sw-key.${cls}`, { type: "button", onclick, title: label, "aria-label": label }, h("kbd", {}, key), pic && h("i.sw-key-ic", { html: icon(pic) }), h("span", {}, label));
}

export function createDeck(s) {
  const stack = h("div.sw-stack");
  const keys = h(
    "div.sw-keys",
    {},
    keyBtn("left", "←", t("sw.keyLeft"), () => s.answer("left")),
    keyBtn("up", "↑", t("sw.keySkip"), () => s.answer("skip"), "skip"),
    keyBtn("down", "↓", t("sw.keyExplain"), () => s.openAsk(), "help"),
    keyBtn("fold", "␣", t("sw.keyFacets"), () => s.toggleFacets(), "chevron"),
    keyBtn("own", "↵", t("sw.keyOwn"), () => s.openOwn(), "pen"),
    keyBtn("undo", "⌫", t("sw.keyUndo"), () => s.undo(), "undo"),
    keyBtn("right", "→", t("sw.keyRight"), () => s.answer("right")),
  );
  const foot = h("div.sw-foot");
  const stopBtn = h("button.btn.ghost.sw-stop", { type: "button", onclick: () => confirmFinish(s), html: `${t("sw.enough")}<kbd>Esc</kbd>` });
  const doneBanner = h("div.sw-banner", { hidden: true });
  let frontSig = null; // the front card is rebuilt only when what it shows changes
  let endSig = null; // the same for the end-of-deck card

  // The key strip stays on one line: while it wraps, it drops labels a step at a time.
  function fitKeys() {
    const shown = [...keys.children].filter((k) => !k.hidden);
    const wraps = () => new Set(shown.map((k) => k.offsetTop)).size > 1;
    keys.classList.remove("tight-1", "tight-2");
    if (wraps()) keys.classList.add("tight-1");
    if (wraps()) keys.classList.add("tight-2");
  }
  const keysFit = new ResizeObserver(() => fitKeys());
  keysFit.observe(stack);

  function paint() {
    const { deck } = s;
    const q = s.queue();
    const top = q[0];
    doneBanner.hidden = !(deck.done && top);
    if (deck.done && top) doneBanner.replaceChildren(h("span", {}, t("sw.doneEarly")), h("button.btn.primary.sm", { type: "button", onclick: () => confirmFinish(s) }, t("sw.finish")));
    keys.hidden = !top;
    $(".sw-key.fold", keys).hidden = !(top && FACETS.some(([k]) => top[k]));
    fitKeys();
    foot.replaceChildren(...(top ? [stopBtn] : []));
    if (!top) {
      frontSig = null;
      // Rebuilt only when what it says changes: the note box keeps focus and caret while the user types.
      const sig = JSON.stringify([deck.done, s.server.digging || s.digging, s.server.thinking, s.listening]);
      if (sig === endSig && $(".sw-end", stack)) return;
      endSig = sig;
      return stack.replaceChildren(endCard(s));
    }
    endSig = null;
    s.readFor(top.id);
    const back = q.slice(1, 3).map((c, i) => backCard(c, i + 1, s.arrived.has(c.id)));
    const recheck = s.isRecheck(top.id);
    const sig = JSON.stringify([top, s.dialog.filter((d) => d.qid === top.id), s.asking === top.id, s.writing === top.id, deck.glossary, recheck]);
    const old = $(".sw-card.front", stack);
    let front = old;
    if (!old || sig !== frontSig || old.dataset.card !== top.id || old.matches(".fly-left, .fly-right, .fly-up")) {
      front = frontCard(s, top);
      if (old?.dataset.card !== top.id) front.classList.add("enter");
    }
    frontSig = sig;
    if (recheck && !front.classList.contains("recheck")) {
      front.classList.add("recheck");
      front.dataset.pre = s.answers()[top.id]?.side || "";
      const q = $(".sw-q", front);
      if (q) q.dataset.recheck = t("sw.recheck");
      // Why it came back, and one click to keep the earlier pick (the same arrow keeps it too).
      const why = s.states().stale.get(top.id);
      const old = s.answers()[top.id];
      q?.after(
        h(
          "div.sw-recheck",
          { role: "status" },
          why && h("span.state-reason", {}, why),
          old && h("button.chip.ghost.state-act", { type: "button", dataset: { act: "keep" }, onclick: () => s.answer(old.side, old.text) }, t("state.keep")),
        ),
      );
    }
    const left = $(".sw-left-n", front);
    left.textContent = t("sw.leftN", q.length);
    if (s.arrived.size) {
      left.classList.remove("bump");
      void left.offsetWidth;
      left.classList.add("bump");
      s.arrived = new Set(); // slide in once, not on every repaint
    }
    stack.replaceChildren(...back.reverse(), front);
    preload(q.slice(1, 1 + PRELOAD));
  }

  // The next cards' pictures and clips load while the user reads the front one.
  const loaded = new Set();
  const keep = []; // video elements stay referenced, or the browser drops the download
  function preload(cards) {
    for (const node of cards.flatMap((c) => [c, c.left, c.right])) {
      const imgs = [...(node.images || []).map((i) => i.src), ...(node.compare && !node.compare.live ? [node.compare.before.src, node.compare.after.src] : []), ...(node.video || []).filter((v) => v.gif).map((v) => v.src)];
      for (const src of imgs.filter((x) => x && !loaded.has(x))) {
        loaded.add(src);
        Object.assign(new Image(), { decoding: "async", referrerPolicy: "no-referrer" }).src = src;
      }
      for (const v of (node.video || []).filter((x) => !x.gif && !loaded.has(x.src))) {
        loaded.add(v.src);
        const el = Object.assign(document.createElement("video"), { preload: "auto", muted: true, referrerPolicy: "no-referrer", src: v.src });
        keep.push(el);
        if (keep.length > 6) keep.shift().removeAttribute("src");
      }
      if (node.preview && !loaded.has(node.preview.src)) {
        loaded.add(node.preview.src);
        document.head.append(h("link", { rel: "prefetch", referrerpolicy: "no-referrer", href: node.preview.src }));
      }
    }
  }

  function fly(side) {
    const card = $(".sw-card.front", stack);
    if (!card || reduced.matches) return Promise.resolve();
    s.flying = true;
    card.classList.add(`fly-${side === "skip" || side === "own" ? "up" : side}`);
    return new Promise((resolve) =>
      setTimeout(() => {
        s.flying = false;
        resolve();
      }, FLY_MS),
    );
  }

  return { stack, keys, foot, doneBanner, paint, fly, stop: () => keysFit.disconnect() };
}
