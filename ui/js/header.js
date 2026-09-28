// header.js — round header (title, meta, intro, recap, context), tabs for
// parallel rounds, the project's decision journal, and the done / idle screens.

import { h, icon } from "./dom.js";
import { lang, t } from "./i18n.js";
import { md } from "./md.js";
import { getJournal } from "./net.js";

const REPO = "https://github.com/Forichok/decide";
const out = { target: "_blank", rel: "noopener" };

export function renderHeader(spec, env) {
  const g = spec.glossary;
  const n = spec.questions.length;
  const high = spec.questions.filter((q) => q.stakes === "high").length;
  const meta = [
    [t("meta.questions", n)],
    [t("meta.minutes", spec.estimateMin)],
    spec.sections.length && [t("meta.sections", spec.sections.length)],
    high && [t("meta.high", high), ".warn"],
    env.live && [t(env.listening === false ? "meta.away" : "meta.live"), `.presence${env.listening === false ? ".away" : ".live"}`],
  ].filter(Boolean);
  return h(
    "header.top",
    {},
    eyebrow(env),
    roundTabs(env),
    h("h1.title", {}, spec.title),
    h("div.meta-row", {}, meta.map(([text, cls = ""]) => h(`span.chip.static${cls}`, {}, text))),
    spec.intro && h("div.intro.rich", { html: md(spec.intro, g) }),
    spec.recap && h("div.panel.recap", {}, h("div.panel-h", { html: `${icon("spark")}${t("recap")}` }), h("div.rich", { html: md(spec.recap, g) })),
    spec.context && h("details.panel.context", {}, h("summary", {}, h("div.panel-h", { html: `${icon("chevron", "chev")}${t("context")}` })), h("div.rich", { html: md(spec.context, g) })),
    journalPanel(),
  );
}

// The live chip follows the agent: it comes and goes between its wait calls.
export function updatePresence(listening) {
  const chip = document.querySelector(".meta-row .presence");
  if (!chip) return;
  chip.classList.toggle("live", listening);
  chip.classList.toggle("away", !listening);
  chip.textContent = t(listening ? "meta.live" : "meta.away");
}

export function eyebrow(env) {
  return h(
    "div.eyebrow",
    {},
    h("a.brand", { href: REPO, ...out, title: t("brand.title") }, h("span.logo", { html: icon("check") }), h("span", {}, "decide")),
    h("span.conn", { title: t("conn") }),
    h("span.spacer"),
    h("a.icon-btn.gh", { href: REPO, ...out, title: t("brand.title"), "aria-label": t("brand.title"), html: icon("github") }),
    h("button.icon-btn.keys-btn", { type: "button", title: t("keys.button"), "aria-label": t("keys.label"), html: icon("keyboard"), onclick: env.help }),
    h("button.icon-btn.theme", { type: "button", title: t("theme.button"), "aria-label": t("theme.label"), html: icon(env.isDark() ? "sun" : "moon"), onclick: env.toggleTheme }),
  );
}

export function roundTabs(env) {
  if (!env.pending || env.pending.length < 2) return null;
  return h(
    "div.round-tabs",
    { role: "tablist" },
    env.pending.map((r) =>
      h(
        "button.round-tab",
        { type: "button", role: "tab", "aria-selected": String(r.id === env.currentId), onclick: () => env.switchTo(r.id) },
        h("span.rt-title", {}, r.title),
        h("span.rt-count", {}, String(r.count)),
      ),
    ),
  );
}

// Answered rounds of this project, newest first, minus the one on screen; hidden while empty.
export function journalPanel({ open = false, skip = null } = {}) {
  const list = h("div.jr-list");
  const search = h("input.jr-search", { type: "search", placeholder: t("journal.search"), "aria-label": t("journal.searchLabel") });
  const head = h("div.panel-h", { html: `${icon("history")}${t("journal.title")}` });
  const box = h("details.panel.history", { hidden: true, open }, h("summary", {}, head), search, list);
  let timer = null;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  });
  async function load() {
    const q = search.value.trim();
    try {
      const entries = (await getJournal(q)).entries.filter((e) => e.round !== skip);
      if (!q) {
        box.hidden = !entries.length;
        head.innerHTML = `${icon("history")}${t("journal.title")} · ${entries.length >= 30 ? "30+" : entries.length}`;
      }
      list.replaceChildren(...(entries.length ? entries.map(journalItem) : [h("p.jr-empty", {}, t("journal.empty"))]));
    } catch {
      box.hidden = true;
    }
  }
  load();
  return box;
}

function journalItem(item) {
  return h(
    "div.hist-item",
    {},
    h("div.hist-title", {}, item.title, h("span.hist-when", {}, when(item.at))),
    item.digest && h("pre.hist-digest", {}, item.digest),
  );
}

export function credit() {
  return h("p.credit", {}, h("span", {}, t("credit.text")), h("a", { href: REPO, ...out, html: `${icon("star")}${t("credit.star")}` }));
}

// delivery: { delivered, listening } of the answers on screen; closing: seconds left, "failed" or null.
export function renderDone(result, env) {
  const cancelled = result?.cancelled;
  const others = (env.pending || []).filter((r) => r.id !== env.currentId);
  const { delivered = true, listening = false } = env.delivery || {};
  const state = cancelled ? "cancelled" : delivered ? "sent" : listening ? "handing" : "saved";
  const ring = { cancelled: ".cancel", sent: "", handing: ".handing", saved: ".saved" }[state];
  const next = others.length
    ? h("button.btn.primary", { type: "button", onclick: () => env.switchTo(others[0].id), html: `${t("done.more", others.length)}${icon("arrow")}` })
    : state === "saved"
      ? h("button.btn.primary", { type: "button", onclick: env.copyNudge, html: `${icon("clip")}${t("done.copy")}` })
      : state === "handing"
        ? h("div.waiting", {}, h("span.pulse"), t("done.handingWait"))
        : closer(env);
  return h(
    "section.done-view",
    {},
    eyebrow(env),
    h(
      "div.done-card",
      {},
      h(`div.ring${ring}`, { html: icon(cancelled ? "x" : state === "sent" ? "check" : state === "saved" ? "alert" : "arrow") }),
      h("h2", {}, t(`done.${state}`)),
      h("p.done-sub", {}, t(`done.${state}Sub`)),
      next,
      result?.digest && h("pre.done-digest", {}, result.digest),
    ),
    journalPanel({ skip: env.currentId }),
    credit(),
  );
}

function closer(env) {
  if (!env.connected) return h("div.waiting", {}, t("done.gone"));
  if (typeof env.closing === "number") {
    return h(
      "div.waiting.closing",
      {},
      h("span.close-count", {}, t("done.closeIn", env.closing)),
      h("button.link-btn", { type: "button", onclick: env.keepOpen }, t("done.keep")),
    );
  }
  return h(
    "div.close-row",
    {},
    h("div.waiting", {}, h("span.pulse"), env.closing === "failed" ? t("done.closeFailed") : t("done.waiting")),
    h("button.btn", { type: "button", onclick: env.closeTab, html: `${icon("x")}${t("done.close")}` }),
  );
}

export function renderIdle(env) {
  return h(
    "section.done-view",
    {},
    eyebrow(env),
    h(
      "div.done-card",
      {},
      h("div.ring.idle", { html: icon("spark") }),
      h("h2", {}, t("idle.title")),
      h("p.done-sub", {}, env.connected ? t("idle.sub") : t("idle.ended")),
    ),
    journalPanel({ open: true }),
    credit(),
  );
}

function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = d.toDateString() === new Date().toDateString();
  const opts = today ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  return d.toLocaleString(lang === "ru" ? "ru-RU" : undefined, opts);
}
