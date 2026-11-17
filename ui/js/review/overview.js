// review/overview.js — what the reader sees before the diff: the title with the snapshot's facts, the
// agent's overview (why, risks that jump to their chapter, the checks as it ran them), the rail of
// chapters on the left and the verdict bar at the bottom.

import { h } from "../dom.js";
import { t } from "../i18n.js";
import { md, mdInline } from "../md.js";
import { collectRisks } from "./risks.js";

export const checkState = (c) => (Number.isInteger(c.exit) ? (c.exit === 0 ? "ok" : "failed") : "missing");
const short = (sha) => String(sha || "").slice(0, 7);
const clock = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
const seconds = (n) => (typeof n === "number" ? (n >= 60 ? t("cr.minSec", Math.floor(n / 60), Math.round(n % 60)) : t("cr.sec", Math.round(n * 10) / 10)) : "");

export function renderTitle(s) {
  const snap = s.rv.snapshot;
  const presence = h("span.chip.static.cr-presence");
  // "Newer exists": the branch got a commit after the snapshot was taken.
  const newer = h("span.chip.static.warn.cr-newer", { hidden: true, title: t("cr.newerTitle") });
  const el = [
    h("h1.cr-title", { html: mdInline(s.spec.title) }),
    h(
      "div.cr-meta",
      {},
      h("span.chip.static", {}, h("code", {}, snap.headRef || snap.branch || "HEAD"), " → ", h("code", {}, snap.baseRef)),
      h("span.chip.static", {}, h("code", {}, `${short(snap.base)}..${short(snap.head)}`)),
      h("span.chip.static", {}, t("cr.files", snap.stats.files), " ", h("span.cr-add", {}, `+${snap.stats.added}`), " ", h("span.cr-del", {}, `−${snap.stats.removed}`)),
      clock(snap.at) && h("span.chip.static", {}, t("cr.snapshotAt", clock(snap.at))),
      snap.dirty && h("span.chip.static.warn", { title: t("cr.dirtyTitle") }, t("cr.dirty")),
      newer,
      presence,
    ),
  ];
  return {
    el,
    paint() {
      presence.classList.toggle("away", !s.listening);
      presence.textContent = t(s.listening ? "cr.live" : "cr.away");
      newer.hidden = !s.rv.newer;
      newer.textContent = s.rv.newer ? t("cr.newer", short(s.rv.newer.head)) : "";
    },
  };
}

export function renderOverview(s) {
  const { spec, rv } = s;
  const number = (id) => spec.chapters.findIndex((c) => c.id === id) + 1;
  const risks = collectRisks(spec, rv.chapters).map((r) => {
    const n = number(r.chapter);
    const inner = [h(`span.badge.cr-${r.level}`, {}, t(`cr.risk.${r.level}`)), h("span.what", {}, h("span", { html: mdInline(r.what) }), r.why && h("span.why", { html: mdInline(r.why) })), n > 0 && h("span.go", {}, t("cr.goChapter", n))];
    return h("li", {}, n > 0 ? h("button.cr-risk", { type: "button", onclick: () => Number.isInteger(r.place) ? s.goPlace(r.chapter, r.place) : s.go(`ch:${r.chapter}`) }, inner) : h("div.cr-risk", {}, inner));
  });
  const checks = spec.checks.map((c) => {
    const st = checkState(c);
    return h(
      `tr.${st}`,
      {},
      h("td.st", {}, h(`span.cr-mark.${st}`, { title: t(`cr.check.${st}`) }, st === "ok" ? "✓" : st === "failed" ? "!" : "–")),
      h("td.cmd", {}, c.command, c.note && h("small", { html: mdInline(c.note) })),
      h("td.xc", {}, st === "missing" ? t("cr.check.missing") : t("cr.exit", c.exit)),
      h("td.dur", {}, seconds(c.seconds)),
    );
  });
  return h(
    "section.cr-card.cr-overview.glass",
    { id: "cr-overview", tabindex: "-1", dataset: { stop: "overview" } },
    h("div.cr-ch-head", {}, h("div.cr-ch-titles", {}, h("h2", {}, t("cr.overview"))), h("span.cr-said", {}, t("cr.said"))),
    h("div.cr-lead.cr-md", { html: md(spec.summary) }),
    s.guided && h("p.cr-how", {}, t("cr.how", rv.chapters.reduce((n, c) => n + c.focus.length, 0))),
    h("h3.cr-sub", {}, t("cr.risks")),
    risks.length ? h("ul.cr-risks", {}, risks) : h("p.cr-none", {}, t("cr.noRisks")),
    h("h3.cr-sub", {}, t("cr.checks"), h("small", {}, t("cr.checksNote"))),
    checks.length ? h("div.cr-checks-wrap", {}, h("table.cr-checks", {}, h("tbody", {}, checks))) : h("p.cr-none.warn", {}, t("cr.noChecks")),
    h(
      "div.cr-tally",
      {},
      h("span", {}, h("b", {}, spec.chapters.length), " ", t("cr.tally.chapters", spec.chapters.length)),
      spec.mechanical.length > 0 && h("span", {}, h("b", {}, spec.mechanical.length), " ", t("cr.tally.mechanical", spec.mechanical.length)),
      h("span", {}, t("cr.tally.sorted"), " ", h("b", {}, t("cr.of", rv.sorted, rv.total))),
    ),
  );
}

// The rail: overview, chapters, the folded groups, and how much of the diff the agent sorted.
export function renderRail(s) {
  const { spec, rv } = s;
  const items = new Map();
  const item = (stop, n, title, tail, onclick) => {
    const el = h("button.cr-rail-item", { type: "button", onclick }, h("span.n", {}, n), h("span", { html: title }), tail);
    items.set(stop, el);
    return el;
  };
  const folds = spec.mechanical.length + (rv.rest.pieces ? 1 : 0);
  const full = h("button.cr-full", { type: "button", onclick: () => s.setFull(!s.full) });
  const el = h(
    "div.cr-rail",
    {},
    h("h2", {}, t("cr.rail")),
    item("overview", "≡", t("cr.overview"), null, () => s.go("overview")),
    spec.chapters.map((c, i) => item(`ch:${c.id}`, i + 1, mdInline(c.title), h("span.tail", {}, h("span.c"), h(`span.cr-dot.${c.risk}`)), () => s.go(`ch:${c.id}`))),
    folds > 0 && h("div.sep"),
    spec.mechanical.length > 0 && item("mech", "⋯", t("cr.railMech", rv.mechanical.reduce((n, m) => n + m.pieces, 0)), null, () => s.goFolds()),
    rv.rest.pieces > 0 && item("rest", "?", t("cr.railRest", rv.rest.pieces), null, () => s.goFolds("rest")),
    full,
    h(`p.cr-sorted${rv.sorted < rv.total ? ".short" : ""}`, {}, t("cr.sortedA"), " ", h("b", {}, t("cr.of", rv.sorted, rv.total)), " ", t("cr.sortedB")),
  );
  return {
    el,
    paint() {
      const said = s.byChapter();
      full.textContent = s.fullLoading ? t("cr.fullLoading", s.loaded.size, rv.total) : t(s.full ? "cr.fullOff" : "cr.fullOn");
      full.disabled = Boolean(s.fullLoading);
      full.setAttribute("aria-pressed", String(s.full));
      for (const [stop, node] of items) {
        node.classList.toggle("on", stop === s.current);
        const id = stop.startsWith("ch:") ? stop.slice(3) : null;
        const i = spec.chapters.findIndex((c) => c.id === id);
        if (i < 0) continue;
        const read = Object.hasOwn(s.rv.read, id);
        node.classList.toggle("read", read);
        node.querySelector(".n").textContent = read ? "✓" : i + 1;
        const n = said.get(id) || 0;
        node.querySelector(".c").textContent = n || "";
        node.querySelector(".c").title = n ? t("cr.comments", n) : "";
      }
    },
  };
}

// The bar: how far the reading went, what was said, and the three verdicts.
export function renderBar(s) {
  const pills = h("div.cr-pills", { "aria-hidden": "true" });
  const line = h("b");
  const sub = h("small");
  const el = h(
    "div.cr-bar.glass",
    { role: "region", "aria-label": t("cr.barLabel") },
    h("div.state", {}, pills, line, sub),
    h(
      "div.acts",
      {},
      h("button.btn.ghost", { type: "button", dataset: { verdict: "return" }, onclick: () => s.verdict("return") }, t("cr.v.return")),
      h("button.btn", { type: "button", dataset: { verdict: "nits" }, onclick: () => s.verdict("nits") }, t("cr.v.nits")),
      h("button.btn.primary", { type: "button", dataset: { verdict: "approve" }, onclick: () => s.verdict("approve") }, t("cr.v.approve")),
    ),
  );
  return {
    el,
    paint() {
      const { spec, rv } = s;
      const read = (c) => Object.hasOwn(rv.read, c.id);
      pills.replaceChildren(...spec.chapters.map((c) => h(`i${read(c) ? ".done" : ""}`)));
      line.textContent = t("cr.readOf", spec.chapters.filter(read).length, spec.chapters.length);
      const n = s.counts();
      const checks = s.checks();
      const said = n.fix + n.nit + n.question ? t("cr.said.some", n.fix + n.nit + n.question, [n.fix && t("cr.n.fix", n.fix), n.question && t("cr.n.question", n.question), n.nit && t("cr.n.nit", n.nit)].filter(Boolean).join(", ")) : t("cr.said.none");
      const red = [checks.failed && t("cr.n.failed", checks.failed), checks.missing && t("cr.n.missing", checks.missing)].filter(Boolean).join(", ");
      sub.replaceChildren(said, red ? " · " : "", red ? h("span.warn", {}, t("cr.checksRed", red)) : !checks.total ? h("span.warn", {}, ` · ${t("cr.checksNone")}`) : "");
    },
  };
}
