// inputs.js — answer controls per question type and their in-place sync.

import { h, icon, $$ } from "./dom.js";
import { t } from "./i18n.js";
import { md, mdInline } from "./md.js";
import { renderMedia } from "./media.js";

export function renderInput(q, ctx) {
  if (q.type === "rank") return renderRank(q, ctx);
  if (q.type === "scale") return renderScale(q, ctx);
  if (q.type === "text") return renderText(q, ctx);
  return renderChoice(q, ctx);
}

export function syncInput(card, q, a) {
  for (const el of $$(".opt, .seg", card)) {
    const on = el.dataset.oid ? a.selected.includes(el.dataset.oid) : Number(el.dataset.v) === a.value;
    el.classList.toggle("sel", on);
    el.setAttribute("aria-checked", String(on));
  }
  const rank = card.querySelector(".rank");
  if (rank) {
    rank.classList.toggle("touched", a.touched);
    $$(".rank-item", rank).forEach((li, i) => (li.querySelector(".pos").textContent = String(i + 1)));
  }
}

function renderChoice(q, ctx) {
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
          o.tags.map((t) => h("span.badge.tag", {}, t)),
        ),
        o.recommended && o.reason && h("div.opt-reason.rich", { html: mdInline(o.reason, g) }),
        o.detail && h("div.opt-detail.rich", { html: md(o.detail, g) }),
        prosCons(o, g),
        metrics(o),
        renderMedia(o, ctx, q.id),
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
      ctx.toast(t("multi.max", q.max));
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

function prosCons(o, g) {
  if (!o.pros.length && !o.cons.length) return null;
  const col = (items, cls, sign) =>
    items.length ? h(`ul.pc.${cls}`, {}, items.map((t) => h("li", {}, h("span.sign", {}, sign), h("span", { html: mdInline(t, g) })))) : null;
  return h("div.proscons", {}, col(o.pros, "pro", "+"), col(o.cons, "con", "−"));
}

function metrics(o) {
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

function renderRank(q, ctx) {
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

function renderScale(q, ctx) {
  const { min, max, labels } = q.scale;
  const segs = [];
  for (let v = min; v <= max; v += 1) {
    segs.push(
      h(
        "button.seg",
        {
          type: "button",
          role: "radio",
          "aria-checked": "false",
          dataset: { v: String(v) },
          onclick: () => {
            const a = ctx.answers[q.id];
            ctx.set(q.id, { value: a.value === v ? null : v, flag: a.flag === "explain" ? "explain" : null });
          },
        },
        h("span.seg-n", {}, String(v)),
        labels[v] && h("span.seg-l", {}, labels[v]),
      ),
    );
  }
  return h("div.scale", { role: "radiogroup", "aria-label": q.title, style: `--n:${segs.length}` }, segs);
}

function renderText(q, ctx) {
  const ta = h("textarea.answer-text", {
    rows: "3",
    placeholder: q.placeholder || t("text.placeholder"),
    "aria-label": q.title,
    oninput: (e) => {
      autosize(e.target);
      ctx.set(q.id, { text: e.target.value, flag: null }, { quiet: true });
    },
  });
  ta.value = ctx.answers[q.id].text;
  requestAnimationFrame(() => autosize(ta));
  return ta;
}

export function autosize(ta) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight + 2, 480)}px`;
}
