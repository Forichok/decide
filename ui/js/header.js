// header.js — round header (title, meta, intro, recap, context), tabs for
// parallel rounds, the project's decision journal, and the done / idle screens.

import { h, icon } from "./dom.js";
import { lang, t } from "./i18n.js";
import { md, mdInline } from "./md.js";
import { getJournal } from "./net.js";
import { progressOf } from "./logic.js";

const REPO = "https://github.com/Forichok/decide";
const out = { target: "_blank", rel: "noopener" };

export function renderHeader(spec, env) {
  const g = spec.glossary;
  const high = spec.questions.filter((q) => q.stakes === "high").length;
  const count = progressOf(spec, env.answers || {});
  const meta = [
    [t("progress.count", count.answered, count.total), ".count"],
    [spec.budget ? t("meta.budget", spec.estimateMin, spec.budget) : t("meta.minutes", spec.estimateMin)],
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
    presenceNote(env.listening !== false),
    spec.intro && h("div.intro.rich", { html: md(spec.intro, g) }),
    spec.recap && h("div.panel.recap", {}, h("div.panel-h", { html: `${icon("spark")}${t("recap")}` }), h("div.rich", { html: md(spec.recap, g) })),
    spec.leftOut?.length > 0 &&
      h(
        "details.panel.left-out",
        {},
        h("summary", {}, h("div.panel-h", { html: `${icon("chevron", "chev")}${t("budget.leftOut", spec.budget)} · ${spec.leftOut.length}` })),
        h("p.left-out-sub", {}, t("budget.sub")),
        h("ul.left-out-list", {}, spec.leftOut.map((q) => h("li", { html: mdInline(q.title, g) }))),
      ),
    spec.context && h("details.panel.context", {}, h("summary", {}, h("div.panel-h", { html: `${icon("chevron", "chev")}${t("context")}` })), h("div.rich", { html: md(spec.context, g) })),
    journalPanel(),
  );
}

// The live chip follows the agent: it comes and goes between its wait calls.
export function updatePresence(listening) {
  paintPresenceNote(document.querySelector(".presence-note"), listening);
  const chip = document.querySelector(".meta-row .presence");
  if (!chip) return;
  chip.classList.toggle("live", listening);
  chip.classList.toggle("away", !listening);
  chip.textContent = t(listening ? "meta.live" : "meta.away");
}

// The line a user pastes into the agent's chat so it collects the answers (the same call the session-start notice names).
export const roundIdOnPage = () => new URLSearchParams(location.hash.slice(1)).get("r") || "";
export const pasteLine = (id) => t("listen.line", id);

// "The agent is waiting", or, when nobody is listening, that the answers are saved and what to paste.
export function presenceNote(listening) {
  const box = h("div.presence-note");
  paintPresenceNote(box, listening);
  return box;
}

function paintPresenceNote(box, listening) {
  if (!box) return;
  box.classList.toggle("live", listening);
  if (listening) return box.replaceChildren(h("span.pn-dot"), h("span", {}, t("listen.waiting")));
  const line = pasteLine(roundIdOnPage());
  box.replaceChildren(
    h("span.pn-dot"),
    h(
      "div.pn-body",
      {},
      h("p", {}, t("listen.away")),
      h("div.paste-line", {}, h("code", {}, line), h("button.link-btn", { type: "button", onclick: () => navigator.clipboard?.writeText(line).catch(() => {}) }, t("listen.copy"))),
    ),
  );
}

// The mark: a dot and a stem make a "d". The dot takes the accent, the stem the text color.
const LOGO = `<svg viewBox="0 0 64 64"><circle cx="27" cy="40" r="17" fill="currentColor" class="dot"/><rect x="40" y="6" width="11" height="51" rx="5.5" fill="currentColor"/></svg>`;

export function eyebrow(env) {
  return h(
    "div.eyebrow",
    {},
    h("a.brand", { href: REPO, ...out, title: t("brand.title") }, h("span.logo", { "aria-hidden": "true", html: LOGO }), h("span", {}, "decide")),
    h("span.conn", { title: t("conn") }),
    h("span.spacer"),
    env.inbox && h("button.chip.ghost.inbox-btn", { type: "button", hidden: env.inbox.count < 2, "aria-label": t("inbox.open"), onclick: env.inbox.toggle }, t("inbox.button", env.inbox.count)),
    env.journal && h("button.icon-btn.jr-btn", { type: "button", title: t("journal.open"), "aria-label": t("journal.open"), html: icon("history"), onclick: env.journal }),
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
  const all = h("button.link-btn.jr-all", { type: "button", onclick: () => (location.hash = "journal") }, t("journal.open"));
  const box = h("details.panel.history", { hidden: true, open }, h("summary", {}, head), search, list, all);
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

export function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = d.toDateString() === new Date().toDateString();
  const opts = today ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  return d.toLocaleString(lang === "ru" ? "ru-RU" : undefined, opts);
}
