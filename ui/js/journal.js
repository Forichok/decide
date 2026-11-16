// journal.js — the #journal page: every decision of this project, newest
// first, with search and filters (questions / swipe, live / superseded).

import { h, icon } from "./dom.js";
import { t } from "./i18n.js";
import { getJournal } from "./net.js";
import { credit, eyebrow, when } from "./header.js";
import { paintMap } from "./map.js";

const FILTERS = {
  mode: ["", "questions", "swipe"],
  status: ["all", "live", "superseded"],
};

export function renderJournal(env) {
  const state = { q: "", mode: "", status: "all", view: "list" };
  const mapBox = h("div.jp-map", { hidden: true });
  const views = h(
    "div.jp-filter",
    { role: "group", "aria-label": t("journalPage.view") },
    ["list", "map"].map((v) =>
      h("button.chip", {
        type: "button",
        "aria-pressed": String(state.view === v),
        onclick: (e) => {
          state.view = v;
          for (const b of e.currentTarget.parentNode.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
          list.hidden = v === "map";
          mapBox.hidden = v === "list";
          if (v === "map") paintMap(mapBox);
        },
      }, t(`journalPage.view.${v}`)),
    ),
  );
  const list = h("div.jp-list", { "aria-live": "polite" });
  const count = h("span.jp-count");
  const search = h("input.jr-search.jp-search", { type: "search", placeholder: t("journal.search"), "aria-label": t("journal.searchLabel") });
  let timer = null;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = search.value.trim();
      load();
    }, 250);
  });

  const group = (key) =>
    h(
      "div.jp-filter",
      { role: "group", "aria-label": t(`journalPage.${key}`) },
      FILTERS[key].map((value) =>
        h(
          "button.chip",
          {
            type: "button",
            "aria-pressed": String(state[key] === value),
            onclick: (e) => {
              state[key] = value;
              for (const b of e.currentTarget.parentNode.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
              load();
            },
          },
          t(`journalPage.${key}.${value || "all"}`),
        ),
      ),
    );

  let seq = 0;
  async function load() {
    const mine = ++seq;
    try {
      const { entries } = await getJournal(state.q, 200, { mode: state.mode, status: state.status });
      if (mine !== seq) return;
      count.textContent = t("journalPage.count", entries.length);
      list.replaceChildren(...(entries.length ? byDay(entries) : [h("p.jr-empty", {}, t(state.q || state.mode || state.status !== "all" ? "journal.empty" : "journalPage.none"))]));
    } catch {
      if (mine === seq) list.replaceChildren(h("p.jr-empty", {}, t("journalPage.failed")));
    }
  }
  load();

  return h(
    "section.journal-view",
    {},
    eyebrow(env),
    h("button.link-btn.jp-back", { type: "button", onclick: env.leaveJournal, html: `${icon("left")}${t(env.pending?.length ? "journalPage.back" : "journalPage.home")}` }),
    h("h1.title", {}, t("journalPage.title")),
    h("p.jp-sub", {}, t("journalPage.sub"), " ", count),
    search,
    h("div.jp-filters", {}, views, group("mode"), group("status")),
    list,
    mapBox,
    credit(),
  );
}

function item(e) {
  const s = e.superseded;
  return h(
    `article.jp-item${s ? ".superseded" : ""}`,
    {},
    h(
      "div.jp-head",
      {},
      h("h2.jp-title", {}, e.title),
      h("span.badge.jp-mode", {}, t(`journalPage.mode.${e.mode === "swipe" ? "swipe" : "questions"}`)),
      s && h("span.badge.jp-old", { title: s.reason || "" }, t("journalPage.superseded")),
    ),
    h("div.jp-meta", {}, h("span", {}, when(e.at)), h("code", { title: t("journalPage.roundId") }, e.round)),
    s && h("p.jp-why", {}, s.by ? t("journalPage.by", s.by) : t("journalPage.noLonger"), s.reason ? ` ${s.reason}` : ""),
    e.digest && h("details.jp-digest", {}, h("summary", { html: `${icon("chevron", "chev")}${t("journalPage.answers", (e.questions || []).length)}` }), h("pre.hist-digest", {}, e.digest)),
  );
}

// The entries under a heading per day, newest first (the server sends them in that order).
function byDay(entries) {
  const out = [];
  let day = null;
  for (const e of entries) {
    const d = String(e.at || "").slice(0, 10);
    if (d !== day) {
      day = d;
      const date = new Date(e.at);
      out.push(h("h2.jp-day", {}, Number.isNaN(date.getTime()) ? d : date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })));
    }
    out.push(item(e));
  }
  return out;
}
