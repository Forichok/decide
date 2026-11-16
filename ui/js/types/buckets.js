// buckets — sort the options into named buckets. Engine side: lib/registry/types/buckets.mjs.
// The answer is { buckets: { <id>: [option ids] } }; an option sits in at most one bucket.

import { h, icon } from "../dom.js";
import { mdInline } from "../md.js";
import { joinParts, ownPart, optionLabel } from "./shared.js";

const blank = (q) => Object.fromEntries(q.buckets.map((b) => [b.id, []]));

// The answer with every bucket present and every option at most once.
export function normalise(q, raw) {
  const out = blank(q);
  const seen = new Set();
  const ids = new Set(q.options.map((o) => o.id));
  for (const b of q.buckets) {
    for (const id of Array.isArray(raw?.[b.id]) ? raw[b.id] : []) {
      if (ids.has(id) && !seen.has(id)) {
        seen.add(id);
        out[b.id].push(id);
      }
    }
  }
  return out;
}

export const placedIds = (q, a) => new Set(Object.values(normalise(q, a.buckets)).flat());
export const unplaced = (q, a) => {
  const placed = placedIds(q, a);
  return q.options.filter((o) => !placed.has(o.id)).map((o) => o.id);
};

// Put an option into a bucket (null: back to the pool); returns the new buckets map.
export function place(q, a, oid, bucket) {
  const out = normalise(q, a.buckets);
  for (const id of Object.keys(out)) out[id] = out[id].filter((x) => x !== oid);
  if (bucket != null && out[bucket]) out[bucket].push(oid);
  return out;
}

export const emptyAnswer = (q) => ({ buckets: blank(q) });
// Every option has to land somewhere.
export const isAnswered = (q, a) => q.options.length > 0 && unplaced(q, a).length === 0;
export const compact = (q, a) => {
  const placed = placedIds(q, a);
  return placed.size || a.touched ? { buckets: normalise(q, a.buckets) } : {};
};
export function check(q, raw, { warn }) {
  if (!raw.buckets || typeof raw.buckets !== "object" || Array.isArray(raw.buckets)) return {};
  const known = new Set(q.buckets.map((b) => b.id));
  const bad = Object.keys(raw.buckets).filter((k) => !known.has(k));
  if (bad.length) warn(`unknown bucket ${bad.map((b) => `"${b}"`).join(", ")} dropped`);
  return { buckets: normalise(q, raw.buckets) };
}
export function describe(q, r, w) {
  const own = ownPart(r, w);
  if (!r.buckets) return own;
  const b = normalise(q, r.buckets);
  const parts = q.buckets.filter((k) => b[k.id].length).map((k) => `${k.label}: ${b[k.id].map((id) => optionLabel(q, id)).join(", ")}`);
  const left = q.options.length - Object.values(b).flat().length;
  if (left) parts.push(`${left} unsorted`);
  return joinParts(own, parts.join("; "));
}
export const badge = (q, t) => t("badge.buckets");

// The option the number keys act on: the one last picked, else the first still in the pool.
const current = new Map();
function target(q, a) {
  const c = current.get(q.id);
  return c && q.options.some((o) => o.id === c) ? c : unplaced(q, a)[0];
}
function put(q, ctx, oid, bucket) {
  const a = ctx.answers[q.id];
  if (!oid) return;
  const buckets = place(q, a, oid, bucket);
  const next = unplaced(q, { buckets })[0];
  current.set(q.id, next ?? oid);
  ctx.set(q.id, { buckets, touched: true, flag: null });
}

// Number keys: the n-th bucket gets the current option.
export const keys = {
  pick(q, n, ctx) {
    const b = q.buckets[n - 1];
    if (b) put(q, ctx, target(q, ctx.answers[q.id]), b.id);
  },
};

export function sync(card, q, a) {
  const root = card.querySelector(".buckets");
  if (root) root._paint?.(a);
}

export function render(q, ctx) {
  const { t } = ctx;
  const byId = new Map(q.options.map((o) => [o.id, o]));
  let dragging = null;
  const chip = (oid, a) => {
    const o = byId.get(oid);
    return h(
      "button.bk-item",
      {
        type: "button",
        draggable: "true",
        dataset: { oid },
        "aria-pressed": String(target(q, a) === oid),
        ondragstart: (e) => {
          dragging = oid;
          e.dataTransfer.effectAllowed = "move";
        },
        ondragend: () => (dragging = null),
        onclick: () => {
          current.set(q.id, oid);
          paint(ctx.answers[q.id]);
        },
      },
      h("span.bk-label", { html: mdInline(o.label, ctx.glossary) }),
    );
  };
  const drop = (bucket) => ({
    ondragover: (e) => e.preventDefault(),
    ondrop: (e) => {
      e.preventDefault();
      if (dragging) put(q, ctx, dragging, bucket);
      dragging = null;
    },
  });
  const pool = h("div.bk-pool", { "aria-label": t("buckets.pool"), ...drop(null) });
  const cols = q.buckets.map((b, i) => {
    const list = h("div.bk-list", { dataset: { bucket: b.id } });
    const col = h(
      "div.bk-col",
      { ...drop(b.id) },
      h("button.bk-head", { type: "button", title: t("buckets.putHere", i + 1), onclick: () => put(q, ctx, target(q, ctx.answers[q.id]), b.id) }, h("span.bk-key", {}, String(i + 1)), h("span.bk-name", {}, b.label)),
      list,
    );
    col._list = list;
    return col;
  });
  const root = h("div.buckets", { role: "group", "aria-label": q.title }, pool, h("div.bk-cols", { style: `--n:${cols.length}` }, cols));
  function paint(a) {
    const b = normalise(q, a.buckets);
    const loose = unplaced(q, a);
    pool.replaceChildren(...(loose.length ? loose.map((id) => chip(id, a)) : [h("span.bk-done", {}, t("buckets.allSorted"))]));
    cols.forEach((col, i) => {
      const ids = b[q.buckets[i].id];
      col._list.replaceChildren(
        ...(ids.length
          ? ids.map((id) => h("div.bk-placed", {}, chip(id, a), h("button.icon-btn", { type: "button", title: t("buckets.back"), "aria-label": t("buckets.back"), html: icon("x"), onclick: () => put(q, ctx, id, null) })))
          : [h("span.bk-empty", {}, t("buckets.drop"))]),
      );
    });
  }
  root._paint = paint;
  return root;
}
