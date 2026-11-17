// versus — compare the options in pairs until one wins. Engine side: lib/registry/types/versus.mjs.
// A knockout: the options meet two by two in the order written, winners meet in the next round, an odd
// one out waits. n options need n-1 pairs (7 for 8), well under the 12 the card promises. The answer is
// { winner, order, pairs: [{a, b, pick}] }; the run is replayed from the pairs, so it needs no other state.

import { h, icon } from "../dom.js";
import { md, mdInline } from "../md.js";
import { joinParts, ownPart, optionLabel } from "./shared.js";

export const MAX_PAIRS = 12;

// Replay `pairs` over `ids`. Returns { done, next: [a, b] | null, winner, order, pairs } where pairs
// holds the valid prefix, and order is the winner first, then by rounds won, then as written.
export function run(ids, pairs = []) {
  const wins = new Map(ids.map((id) => [id, 0]));
  const kept = [];
  let round = [...ids];
  while (round.length > 1) {
    const upcoming = [];
    for (let i = 0; i < round.length; i += 2) {
      if (i + 1 >= round.length) {
        upcoming.push(round[i]);
        continue;
      }
      const [a, b] = [round[i], round[i + 1]];
      const p = pairs[kept.length];
      if (!p || (p.pick !== a && p.pick !== b)) return { done: false, next: [a, b], winner: null, order: null, pairs: kept };
      kept.push({ a, b, pick: p.pick });
      wins.set(p.pick, wins.get(p.pick) + 1);
      upcoming.push(p.pick);
    }
    round = upcoming;
  }
  const winner = round[0] ?? null;
  const order = [...ids].sort((x, y) => (x === winner ? -1 : y === winner ? 1 : wins.get(y) - wins.get(x) || ids.indexOf(x) - ids.indexOf(y)));
  return { done: winner != null && ids.length > 0, next: null, winner, order, pairs: kept };
}

const idsOf = (q) => q.options.map((o) => o.id);
const stateOf = (q, a) => run(idsOf(q), a.pairs);

export const emptyAnswer = () => ({ pairs: [] });
export const isAnswered = (q, a) => stateOf(q, a).done;
export function compact(q, a) {
  const s = stateOf(q, a);
  return s.done ? { winner: s.winner, order: s.order, pairs: s.pairs } : {};
}
export function check(q, raw, { warn }) {
  if (!Array.isArray(raw.pairs)) return {};
  const picks = raw.pairs.filter((p) => p && typeof p === "object").map((p) => ({ a: String(p.a), b: String(p.b), pick: String(p.pick) }));
  const s = run(idsOf(q), picks);
  if (s.pairs.length < picks.length) warn("pairs that do not follow the knockout were dropped");
  return s.done ? { winner: s.winner, order: s.order, pairs: s.pairs } : {};
}
export function describe(q, r, w) {
  if (!r.winner) return ownPart(r, w);
  const order = Array.isArray(r.order) ? ` (${r.order.map((id) => optionLabel(q, id)).join(" > ")}; ${r.pairs?.length ?? 0} pairs)` : "";
  return joinParts(ownPart(r, w), `winner: ${optionLabel(q, r.winner)}${order}`);
}
export const badge = (q, t) => t("badge.versus");
// The recommendation is a pick, not a duel: it does not fill the question in.
export const recommend = (q, a) => a;

// Number keys: 1 takes the left, 2 the right.
export const keys = {
  pick(q, n, ctx) {
    const next = stateOf(q, ctx.answers[q.id]).next;
    if (next && (n === 1 || n === 2)) choose(q, ctx, next[n - 1]);
  },
};

function choose(q, ctx, pick) {
  const s = stateOf(q, ctx.answers[q.id]);
  if (!s.next) return;
  ctx.set(q.id, { pairs: [...s.pairs, { a: s.next[0], b: s.next[1], pick }], touched: true, flag: null });
}

export function sync(card, q, a) {
  const root = card.querySelector(".versus");
  if (root) root._paint?.(a);
}

export function render(q, ctx) {
  const { t } = ctx;
  const byId = new Map(q.options.map((o) => [o.id, o]));
  const total = q.options.length - 1;
  const side = (oid, dir) => {
    const o = byId.get(oid);
    return h(
      "button.vs-side",
      { type: "button", dataset: { dir }, onclick: () => choose(q, ctx, oid) },
      h("span.vs-arrow", { html: icon(dir === "left" ? "left" : "right") }),
      h("span.vs-label", { html: mdInline(o.label, ctx.glossary) }),
      o.detail && h("span.vs-detail.rich", { html: md(o.detail, ctx.glossary) }),
    );
  };
  const root = h("div.versus", {
    role: "group",
    tabindex: "0",
    "aria-label": q.title,
    onkeydown: (e) => {
      const next = stateOf(q, ctx.answers[q.id]).next;
      if (e.altKey || e.metaKey || e.ctrlKey || !next) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        choose(q, ctx, next[e.key === "ArrowLeft" ? 0 : 1]);
      }
    },
  });
  root._paint = (a) => {
    const s = stateOf(q, a);
    const undo = s.pairs.length
      ? h("button.chip.ghost", { type: "button", html: `${icon("undo")}${t("versus.undo")}`, onclick: () => ctx.set(q.id, { pairs: s.pairs.slice(0, -1), flag: null }) })
      : null;
    if (s.done) {
      root.replaceChildren(
        h("p.vs-count", {}, t("versus.won", optionLabel(q, s.winner))),
        h("ol.vs-order", {}, s.order.map((id) => h("li", {}, optionLabel(q, id)))),
        undo,
      );
      return;
    }
    root.replaceChildren(
      h("p.vs-count", {}, t("versus.pair", s.pairs.length + 1, total)),
      h("div.vs-pair", {}, side(s.next[0], "left"), h("span.vs-or", {}, t("versus.or")), side(s.next[1], "right")),
      h("p.vs-hint", {}, t("versus.hint")),
      undo,
    );
  };
  return root;
}
