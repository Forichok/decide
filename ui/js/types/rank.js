// rank — put the options in order. Engine side: lib/registry/types/rank.mjs.

import { h, icon } from "../dom.js";
import { md, mdInline } from "../md.js";
import { joinParts, ownPart, optionLabel } from "./shared.js";

// The order starts with q.default, then the rest as written.
function orderFrom(q) {
  const ids = q.options.map((o) => o.id);
  const head = q.default.filter((id) => ids.includes(id));
  return [...head, ...ids.filter((id) => !head.includes(id))];
}

export const emptyAnswer = (q) => ({ selected: [], order: orderFrom(q) });
// An order the user did not look at is not an answer.
export const isAnswered = (q, a) => a.touched;
export const describe = (q, r, w) => joinParts(ownPart(r, w), r.order ? r.order.map((id) => optionLabel(q, id)).join(" > ") : "");
// The order is kept once the user looked at it or handed the question on.
export const compact = (q, a) => (a.touched || (a.flag && a.flag !== "skip") ? { order: [...a.order] } : {});
export const check = (q, raw, { ids }) => (Array.isArray(raw.order) ? { order: raw.order.filter((id) => ids.has(id)) } : {});
export const recommend = (q, a) => ({ ...a, touched: true });
export const badge = (q, t) => t("badge.rank");

export function sync(card, q, a) {
  const rank = card.querySelector(".rank");
  if (!rank) return;
  rank.classList.toggle("touched", a.touched);
  rank.querySelectorAll(".rank-item").forEach((li, i) => (li.querySelector(".pos").textContent = String(i + 1)));
}

export function render(q, ctx) {
  const { t } = ctx;
  const list = h("ol.rank", { "aria-label": q.title });
  const move = (oid, delta) => {
    const order = [...ctx.answers[q.id].order];
    const i = order.indexOf(oid);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    ctx.set(q.id, { order, touched: true, flag: null });
    paint();
    list.querySelector(`[data-oid="${CSS.escape(oid)}"]`)?.focus();
  };
  let dragging = null;
  function paint() {
    const byId = new Map(q.options.map((o) => [o.id, o]));
    list.replaceChildren(
      ...ctx.answers[q.id].order.map((oid, i) => {
        const o = byId.get(oid);
        return h(
          "li.rank-item",
          {
            draggable: "true",
            tabindex: "0",
            dataset: { oid },
            ondragstart: (e) => {
              dragging = oid;
              e.dataTransfer.effectAllowed = "move";
              e.currentTarget.classList.add("dragging");
            },
            ondragend: (e) => e.currentTarget.classList.remove("dragging"),
            ondragover: (e) => e.preventDefault(),
            ondrop: (e) => {
              e.preventDefault();
              if (!dragging || dragging === oid) return;
              const order = [...ctx.answers[q.id].order];
              const to = order.indexOf(oid);
              order.splice(order.indexOf(dragging), 1);
              order.splice(to, 0, dragging);
              ctx.set(q.id, { order, touched: true, flag: null });
              paint();
            },
            onkeydown: (e) => {
              if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                e.preventDefault();
                move(oid, e.key === "ArrowUp" ? -1 : 1);
              }
            },
          },
          h("span.grip", { html: icon("grip") }),
          h("span.pos", {}, String(i + 1)),
          h("div.rank-body", {}, h("div.opt-label", { html: mdInline(o.label, ctx.glossary) }), o.detail && h("div.opt-detail.rich", { html: md(o.detail, ctx.glossary) })),
          h("button.icon-btn", { type: "button", title: t("rank.upTitle"), "aria-label": t("rank.up"), html: icon("up"), onclick: () => move(oid, -1) }),
          h("button.icon-btn", { type: "button", title: t("rank.downTitle"), "aria-label": t("rank.down"), html: icon("down"), onclick: () => move(oid, 1) }),
        );
      }),
    );
    list.classList.toggle("touched", ctx.answers[q.id].touched);
  }
  paint();
  const keep = h("button.chip.ghost", {
    type: "button",
    html: `${icon("check")}${t("rank.ok")}`,
    onclick: () => {
      ctx.set(q.id, { touched: true, flag: null });
      paint();
    },
  });
  return h("div.rank-wrap", {}, list, keep);
}
