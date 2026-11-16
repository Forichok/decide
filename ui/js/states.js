// states.js — the states of a round's items: normal, changed, new, ghost, and an answer that is
// stale. The pure part merges the page's own rules (rules.js, run on every answer change) with
// the server's `view`; the DOM part paints one card's state strip. No imports that touch the DOM at
// import; strings come in through `t`.

import { evaluate, hasAnswer, itemsOf, selectedOf } from "./rules.js";

const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const reasonOf = (r) => (typeof r === "string" ? r : r && typeof r === "object" ? String(r.reason || "") : "");

// What an answer looked like when judged: a kept answer stays kept only while it stays the same.
export const sigOf = (a) => JSON.stringify(a ?? null);

// resolve(spec, answers, view, local) → {
//   ghosts: Map<id, reason>, removed: Map<qid, Set<optionId>>,
//   items: Map<id, {state, reason, was}>   (changed / new only; ghosts are in `ghosts`)
//   stale: Map<qid, reason>                (answers still to check, kept ones left out)
// }
// view: the server's { items, stale, staleReasons, ghosts } or null.
// local: { restored: Set<id>, kept: Map<qid, sig>, viewSig: Map<qid, sig> }
export function resolve(spec, answers = {}, view = null, local = {}) {
  const restored = local.restored ?? new Set();
  const kept = local.kept ?? new Map();
  const viewSig = local.viewSig ?? new Map();
  const serverGhosts = new Map();
  for (const g of list(view?.ghosts)) {
    const id = typeof g === "string" ? g : g?.id;
    if (id != null) serverGhosts.set(String(id), reasonOf(g));
  }
  for (const it of list(view?.items)) if (it?.state === "ghost" && !serverGhosts.has(String(it.id))) serverGhosts.set(String(it.id), reasonOf(it));
  const forced = new Map([...restored].map((id) => [id, "shown"]));
  const ev = evaluate(spec, answers, { ghosted: [...serverGhosts.keys()].filter((id) => !restored.has(id)), forced });
  const ghosts = new Map();
  for (const [id, why] of ev.ghosts) ghosts.set(id, why);
  for (const [id, why] of serverGhosts) if (!restored.has(id) && !ghosts.has(id)) ghosts.set(id, why);

  const items = new Map();
  for (const it of list(view?.items)) {
    if (!it || (it.state !== "changed" && it.state !== "new")) continue;
    items.set(String(it.id), { state: it.state, reason: reasonOf(it), was: it.was ?? null });
  }

  const staleReasons = view?.staleReasons instanceof Map ? Object.fromEntries(view.staleReasons) : view?.staleReasons || {};
  const candidates = new Map();
  for (const qid of ev.stale) candidates.set(qid, ev.reasons?.get(qid) || "");
  for (const qid of list(view?.stale).map(String)) {
    // The agent's mark holds only for the answer the page saw with it: answering again clears it.
    if (viewSig.has(qid) && viewSig.get(qid) !== sigOf(answers[qid])) continue;
    if (!candidates.has(qid)) candidates.set(qid, reasonOf(staleReasons[qid]));
  }
  const stale = new Map();
  for (const [qid, why] of candidates) {
    if (ghosts.has(qid) || !hasAnswer(answers[qid])) continue;
    if (kept.get(qid) === sigOf(answers[qid])) continue;
    stale.set(qid, why);
  }
  return { ghosts, removed: ev.removed, items, stale };
}

// Items that count for progress and the final answers: everything but ghosts.
export const liveItems = (spec, st) => itemsOf(spec).filter((q, i) => !st.ghosts.has(q.id ?? `q${i + 1}`));

// Swipe: ghost cards leave the queue; stale answers come back at the end, old answer preselected.
export function swipeQueues(deck, answers, st) {
  const cards = itemsOf(deck);
  const open = cards.filter((c) => !answers[c.id] && !st.ghosts.has(c.id));
  const recheck = cards.filter((c) => answers[c.id] && st.stale.has(c.id) && selectedOf(answers[c.id]).length);
  return { open, recheck, ghosts: cards.filter((c) => st.ghosts.has(c.id)) };
}

// ---- DOM

// Paints (or clears) the state strip of one question card. The card's body is not touched, so the
// item being typed in keeps its caret; there the strip says "updated" instead of repainting.
export function paintState(card, q, st, ctx, h, t) {
  const ghost = st.ghosts.has(q.id);
  const item = st.items.get(q.id);
  const stale = st.stale.has(q.id);
  const kind = ghost ? "ghost" : item?.state || "normal";
  card.classList.toggle("st-ghost", ghost);
  card.classList.toggle("st-changed", kind === "changed");
  card.classList.toggle("st-new", kind === "new");
  card.classList.toggle("st-stale", stale && !ghost);
  const sig = JSON.stringify([kind, ghost ? st.ghosts.get(q.id) : item?.reason, item?.was, stale && !ghost ? st.stale.get(q.id) : null]);
  let strip = card.querySelector(":scope > .q-state");
  if (kind === "normal" && !stale) {
    strip?.remove();
    return;
  }
  if (strip?.dataset.sig === sig) return;
  const typing = strip && card.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (typing && kind === "changed") {
    strip.dataset.sig = sig;
    strip.replaceChildren(h("span.state-note", {}, t("state.updatedHere")));
    return;
  }
  const parts = [];
  if (ghost) {
    parts.push(
      h("span.state-badge.ghost", {}, t("state.ghost")),
      h("span.state-reason", {}, st.ghosts.get(q.id) ? t("state.notRelevant", st.ghosts.get(q.id)) : t("state.notRelevantBare")),
      h("button.chip.ghost.state-act", { type: "button", dataset: { act: "restore" }, onclick: () => ctx.restore(q.id) }, t("state.restore")),
    );
  } else {
    if (kind === "changed") {
      const was = item.was == null ? "" : typeof item.was === "string" ? item.was : item.was.title || JSON.stringify(item.was);
      const wasBox = was && h("div.state-was", { hidden: true }, was);
      parts.push(h("span.state-badge.changed", {}, t("state.changed")), item.reason && h("span.state-reason", {}, item.reason));
      if (wasBox)
        parts.push(
          h("button.chip.ghost.state-act", {
            type: "button",
            "aria-expanded": "false",
            dataset: { act: "was" },
            onclick: (e) => {
              wasBox.hidden = !wasBox.hidden;
              e.currentTarget.setAttribute("aria-expanded", String(!wasBox.hidden));
              e.currentTarget.textContent = t(wasBox.hidden ? "state.was" : "state.wasHide");
            },
          }, t("state.was")),
          wasBox,
        );
    }
    if (kind === "new") parts.push(h("span.state-badge.new", {}, t("state.new")), item.reason && h("span.state-reason", {}, item.reason));
    if (stale)
      parts.push(
        h("span.state-badge.stale", {}, t("state.check")),
        h("span.state-reason", {}, st.stale.get(q.id) || t("state.checkBare")),
        h("button.chip.ghost.state-act", { type: "button", dataset: { act: "keep" }, onclick: () => ctx.keep(q.id) }, t("state.keep")),
        h("button.chip.ghost.state-act", { type: "button", dataset: { act: "again" }, onclick: () => ctx.answerAgain(q.id) }, t("state.again")),
      );
  }
  const next = h("div.q-state", { dataset: { sig }, role: "status" }, parts);
  if (strip) strip.replaceWith(next);
  else card.querySelector(":scope > .q-head")?.after(next);
}

// Options a rule or the agent took away: hidden when not picked, struck through when picked.
export function paintRemoved(card, q, st, answers) {
  const gone = st.removed.get(q.id) ?? new Set();
  const picked = new Set(selectedOf(answers[q.id]));
  for (const el of card.querySelectorAll("[data-oid]")) {
    const out = gone.has(el.dataset.oid);
    el.hidden = out && !picked.has(el.dataset.oid);
    el.classList.toggle("opt-removed", out && picked.has(el.dataset.oid));
  }
}
