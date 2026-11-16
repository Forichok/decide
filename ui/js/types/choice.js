// choice.js — what single, multi and confirm share: the option cards, the
// click that picks one, and the digest line. Not a type itself.
// Imports only dom.js and md.js; the page's own strings and media renderer
// come in on ctx (ctx.t, ctx.renderMedia), so this loads under Node.

import { h, icon } from "../dom.js";
import { md, mdInline } from "../md.js";
import { defaultSelected, joinParts, ownPart, selectedPart } from "./shared.js";

export const emptyChoice = (q) => ({ selected: defaultSelected(q) });

export const describeChoice = (q, r, w) => joinParts(selectedPart(q, r, w), ownPart(r, w));

export function renderChoice(q, ctx) {
  const { t } = ctx;
  const g = ctx.glossary;
  const multi = q.type === "multi";
  const box = h(`div.opts.${q.type === "confirm" ? "confirm" : q.layout}`, {
    role: multi ? "group" : "radiogroup",
    "aria-label": q.title,
  });
  q.options.forEach((o, i) => {
    const opt = h(
      "div.opt",
      {
        role: multi ? "checkbox" : "radio",
        tabindex: "0",
        "aria-checked": "false",
        class: [o.danger && "danger", o.recommended && "rec", q.type === "confirm" && `c-${o.id}`].filter(Boolean).join(" "),
        dataset: { oid: o.id },
        onclick: (e) => {
          if (e.target.closest("a, button, iframe, .media-stop")) return;
          choose(q, o.id, ctx);
        },
        onkeydown: (e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            choose(q, o.id, ctx);
          } else if (!e.altKey && !e.metaKey && !e.ctrlKey && ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(e.key)) {
            // arrow keys move inside the option group, as in a native radio group
            const all = [...box.querySelectorAll(":scope > .opt")];
            const at = all.indexOf(e.currentTarget);
            const to = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : (at + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1) + all.length) % all.length;
            e.preventDefault();
            all[to]?.focus();
          }
        },
      },
      h("span.mark", { html: icon(multi ? "check" : "dot") }),
      h(
        "div.opt-body",
        {},
        h(
          "div.opt-top",
          {},
          h("span.opt-label", { html: mdInline(o.label, g) }),
          o.recommended && h("span.badge.rec", { html: `${icon("star")}${t("opt.rec")}` }),
          o.danger && h("span.badge.danger", { html: `${icon("alert")}${t("opt.danger")}` }),
          o.tags.map((tag) => h("span.badge.tag", {}, tag)),
        ),
        o.recommended && o.reason && h("div.opt-reason.rich", { html: mdInline(o.reason, g) }),
        o.detail && h("div.opt-detail.rich", { html: md(o.detail, g) }),
        o.then && h("div.opt-then.rich", { html: mdInline(o.then, g) }),
        prosCons(o, g),
        metrics(o, t),
        ctx.renderMedia(o, optCtx(q, o, ctx), q.id),
      ),
      i < 9 && h("kbd.opt-key", { "aria-hidden": "true" }, String(i + 1)),
    );
    box.append(opt);
  });
  return box;
}

export function choose(q, oid, ctx) {
  const a = ctx.answers[q.id];
  let selected;
  if (q.type === "multi") {
    const on = a.selected.includes(oid);
    if (!on && q.max && a.selected.length >= q.max) {
      ctx.toast(ctx.t("multi.max", q.max));
      ctx.shake(q.id);
      return;
    }
    selected = on ? a.selected.filter((x) => x !== oid) : [...a.selected, oid];
  } else {
    selected = a.selected[0] === oid ? [] : [oid];
  }
  const flag = a.flag === "explain" ? "explain" : null;
  ctx.set(q.id, { selected, flag, ...(q.type === "multi" ? {} : { other: "" }) });
  if (q.type === "confirm" && oid === "change" && selected.length) ctx.openNote(q.id);
}

// The number keys pick the n-th option.
export const keys = {
  pick(q, n, ctx) {
    const o = q.options[n - 1];
    if (o) choose(q, o.id, ctx);
  },
};

export function sync(card, q, a) {
  for (const el of card.querySelectorAll(".opt")) {
    const on = a.selected.includes(el.dataset.oid);
    el.classList.toggle("sel", on);
    el.setAttribute("aria-checked", String(on));
  }
}

function prosCons(o, g) {
  if (!o.pros.length && !o.cons.length) return null;
  const col = (items, cls, sign) =>
    items.length ? h(`ul.pc.${cls}`, {}, items.map((item) => h("li", {}, h("span.sign", {}, sign), h("span", { html: mdInline(item, g) })))) : null;
  return h("div.proscons", {}, col(o.pros, "pro", "+"), col(o.cons, "con", "−"));
}

function metrics(o, t) {
  if (!o.metrics.length) return null;
  return h(
    "div.metrics",
    {},
    o.metrics.map(({ label, value }) =>
      h(
        "span.metric",
        { title: typeof value === "number" ? t("metric.of5", label, value) : `${label}: ${value}` },
        h("span.m-label", {}, label),
        typeof value === "number"
          ? h("span.dots", {}, [1, 2, 3, 4, 5].map((n) => h(`i${n <= value ? ".on" : ""}`)))
          : h("span.m-val", {}, String(value)),
      ),
    ),
  );
}

// A picture of an option opens in the lightbox with "pick this one" for that option.
function optCtx(q, o, ctx) {
  if (!ctx.lightbox) return ctx;
  const c = Object.create(ctx);
  c.lightbox = (images, i, qid, opts = {}) =>
    ctx.lightbox(images, i, qid, {
      ...opts,
      pick: { label: o.label, selected: () => ctx.answers[q.id].selected.includes(o.id), on: () => ctx.answers[q.id].selected.includes(o.id) || choose(q, o.id, ctx) },
    });
  return c;
}
