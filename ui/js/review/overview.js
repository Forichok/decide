// review/overview.js — what the reader sees before the diff: the title with the snapshot's facts, the
// agent's overview (why, risks that jump to their chapter, the checks as it ran them), the rail of
// chapters on the left and the verdict bar at the bottom.

import { h } from "../dom.js";
import { t } from "../i18n.js";
import { md, mdInline } from "../md.js";
import { coverageCounts } from "./coverage.js";
import { answerOf, decisionsOf, renderDecision } from "./decisions.js";
import { renderResolutions } from "./resolved.js";
import { blockingFindings, decisionOf, findingsOf, renderReviewers } from "./reviewers.js";
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
  const counts = ({ files, added, removed }) =>
    [t("cr.files", files), ", ", h("span.cr-add", {}, `+${added}`), " ", h("span.cr-del", {}, `−${removed}`)];
  const el = [
    h("h1.cr-title", { html: mdInline(s.spec.title) }),
    h(
      "div.cr-meta",
      {},
      ...(snap.previous ? [
        h("span.chip.static.cr-round-number", {}, t("cr.followup.round", snap.roundNumber)),
        h("span.cr-followup-range", {}, t("cr.followup.since", snap.previous.round, short(snap.previous.head)), " ",
          counts(snap.stats), "; ", t("cr.followup.whole"), " ", counts(snap.wholeStats)),
      ] : [
        h("span.chip.static", {}, h("code", { title: snap.headRef }, /^[0-9a-f]{40}$/i.test(snap.headRef) ? short(snap.headRef) : snap.headRef || snap.branch || "HEAD"), " → ", h("code", {}, snap.baseRef)),
        h("span.chip.static", {}, h("code", {}, `${short(snap.base)}..${short(snap.head)}`)),
        h("span.chip.static", {}, t("cr.files", snap.stats.files), " ", h("span.cr-add", {}, `+${snap.stats.added}`), " ", h("span.cr-del", {}, `−${snap.stats.removed}`)),
      ]),
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
    return h("li", {}, n > 0 ? h("button.cr-risk", { type: "button", onclick: () => Number.isInteger(r.place) ? s.goPlace(r.chapter, r.place) : s.go(`ch:${r.chapter}`) }, inner) : h("div.cr-risk", {}, inner), h(`p.cr-risk-check${r.checkedBy ? "" : ".warn"}`, {}, r.checkedBy ? t("cr.checkedBy", r.checkedBy) : t("cr.notChecked")));
  });
  const checks = spec.checks.map((c) => {
    const st = checkState(c);
    return h(
      `tr.${st}`,
      {},
      h("td.st", {}, h(`span.cr-mark.${st}`, { title: t(`cr.check.${st}`) }, st === "ok" ? "✓" : st === "failed" ? "!" : "–")),
      h("td.cmd", {}, c.command, c.note && h("small", { html: mdInline(c.note) })),
      h("td.xc", {}, st === "missing" ? t("cr.check.missing") : st === "failed" ? [t("cr.check.failed"), " · ", t("cr.exit", c.exit)] : t("cr.exit", c.exit)),
      h("td.dur", {}, seconds(c.seconds)),
    );
  });
  const section = (key, title, body) => h(`section.cr-overview-section${key === "reviewers" ? ".cr-reviewers" : ""}`, { dataset: { section: key } }, h("h3.cr-sub", {}, title), body);
  const decisions = decisionsOf(s);
  const acceptance = spec.acceptance;
  const sections = [
    rv.snapshot?.previous && renderResolutions(s),
    section("summary", t("cr.whatChanged"), h("div.cr-lead.cr-md", { html: md(spec.summary) })),
    decisions.length && section("decisions", t("cr.decisions"), decisions.map((d) => h("div.cr-overview-decision", {}, renderDecision(s, d), h("button.link-btn", { type: "button", onclick: () => s.goPlace(d.chapter, d.index) }, t("cr.goPlace"))))),
    section("risks", t("cr.risks"), risks.length ? h("ul.cr-risks", {}, risks) : h("p.cr-none", {}, t("cr.noRisks"))),
    section("reviewers", t("cr.reviewers.title"), renderReviewers(s)),
    acceptance && section("acceptance", t("cr.acceptance"), [
      acceptance.changed && h("p", { html: mdInline(acceptance.changed) }),
      acceptance.where && h("p", {}, t("cr.acceptance.where"), " ", h("span", { html: mdInline(acceptance.where) })),
      acceptance.steps?.length > 0 && h("ol", {}, acceptance.steps.map((step) => h("li", { html: mdInline(step) }))),
      acceptance.expect && h("p", {}, t("cr.acceptance.expect"), " ", h("span", { html: mdInline(acceptance.expect) })),
      h("small.cr-hint", {}, t("cr.acceptance.note")),
    ]),
    section("checks", t("cr.checks"), [h("small.cr-hint", {}, t("cr.checksNote")), checks.length ? h("div.cr-checks-wrap", {}, h("table.cr-checks", {}, h("tbody", {}, checks))) : h("p.cr-none.warn", {}, t("cr.noChecks"))]),
    h("p.cr-mechanical-account", {}, mechanicalLine(s)),
  ];
  return h("section.cr-card.cr-overview.glass", { id: "cr-overview", tabindex: "-1", dataset: { stop: "overview" } },
    h("div.cr-ch-head", {}, h("div.cr-ch-titles", {}, h("h2", {}, t("cr.overview"))), h("span.cr-said", {}, t("cr.said"))),
    sections.filter(Boolean),
    s.guided && h("p.cr-how", {}, t("cr.how", rv.chapters.reduce((n, c) => n + c.focus.length, 0))),
    h("div.cr-tally", {},
      h("span", {}, h("b", {}, spec.chapters.length), " ", t("cr.tally.chapters", spec.chapters.length)),
      spec.mechanical.length > 0 && h("span", {}, h("b", {}, spec.mechanical.length), " ", t("cr.tally.mechanical", spec.mechanical.length)),
      h("span", {}, t("cr.tally.sorted"), " ", h("b", {}, t("cr.of", rv.sorted, rv.total)))),
    h("p.cr-whole-note", {}, t("cr.wholeNote"), " ", h("button.link-btn", { type: "button", onclick: () => s.verdict("approve", true) }, t("cr.verdictLink"))),
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
  const progress = h("p.cr-progress");
  const full = h("button.cr-full", { type: "button", onclick: () => s.setFull(!s.full) });
  const el = h(
    "div.cr-rail",
    {},
    h("h2", {}, t("cr.rail")),
    item("overview", "≡", t("cr.overview"), null, () => s.go("overview")),
    spec.chapters.map((c, i) => item(`ch:${c.id}`, i + 1, mdInline(c.title), h("span.tail", {}, h("span.c", { hidden: true, role: "img" }), h("span.cr-open-findings", { hidden: true, role: "img" }), h(`span.cr-dot.${c.risk}`)), () => s.go(`ch:${c.id}`))),
    folds > 0 && h("div.sep"),
    spec.mechanical.length > 0 && item("mech", "⋯", t("cr.railMech", rv.mechanical.reduce((n, m) => n + m.pieces, 0)), null, () => s.goFolds()),
    rv.rest.pieces > 0 && item("rest", "?", t("cr.railRest", rv.rest.pieces), null, () => s.goFolds("rest")),
    full,
    h("button.cr-files", { type: "button", onclick: () => s.openFiles() }, t("cr.fileList")),
    progress,
    rv.sorted < rv.total && h("p.cr-sorted.short", {}, t("cr.sortedA"), " ", h("b", {}, t("cr.of", rv.sorted, rv.total)), " ", t("cr.sortedB")),
  );
  return {
    el,
    paint() {
      const said = s.byChapter();
      const findings = s.openCounts();
      const c = coverageCounts(s);
      // How many chapters are read is on the bar and in the ticks above: here only what the screen has shown.
      progress.replaceChildren(h("span", {}, t("cr.coverage.short", c.opened, c.total, c.part)));
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
        const badge = node.querySelector(".cr-open-findings");
        const open = findings.get(stop);
        badge.hidden = !open;
        badge.textContent = open || "";
        badge.title = open ? t("cr.reviewers.openCountLabel", open) : "";
        badge.setAttribute("aria-label", badge.title);
        const n = said.get(id) || 0;
        const mine = node.querySelector(".c");
        mine.hidden = !n;
        mine.textContent = n || "";
        mine.title = n ? t("cr.comments", n) : "";
        mine.setAttribute("aria-label", mine.title);
      }
    },
  };
}

// The bar: how far the reading went, what still stands in the way, and the three verdicts. The verdict
// the state points to is the filled button; each thing in the way is its own short chip that leads to it,
// so the line breaks between chips and never inside one.
export function renderBar(s) {
  const pills = h("div.cr-pills", { "aria-hidden": "true" });
  const line = h("b");
  const stats = h("span.cr-stats");
  const button = (v) => h("button.btn", { type: "button", dataset: { verdict: v }, onclick: () => s.verdict(v) }, t(`cr.v.${v}`));
  const buttons = { return: button("return"), nits: button("nits"), approve: button("approve") };
  const el = h(
    "div.cr-bar.glass",
    { role: "region", "aria-label": t("cr.barLabel") },
    h("div.state", {}, pills, line, stats),
    h("div.acts", {}, buttons.return, buttons.nits, buttons.approve),
  );
  const toChecks = () => {
    const checks = document.querySelector('.cr-overview [data-section="checks"]');
    checks?.setAttribute("tabindex", "-1");
    checks?.scrollIntoView({ behavior: "instant", block: "center" });
    checks?.focus({ preventScroll: true });
  };
  return {
    el,
    paint() {
      const { spec, rv } = s;
      const read = (c) => Object.hasOwn(rv.read, c.id);
      pills.replaceChildren(...spec.chapters.map((c) => h(`i${read(c) ? ".done" : ""}`)));
      line.textContent = t("cr.readOf", spec.chapters.filter(read).length, spec.chapters.length);
      const n = s.counts();
      const checks = s.checks();
      const blockers = blockingFindings(s);
      const open = findingsOf(s).filter(f => !decisionOf(s, f) && f.severity !== "blocking");
      const waiting = decisionsOf(s).filter(d => answerOf(s, d) === null);
      const said = n.fix + n.nit + n.question;
      // level: what it means for the verdict; low: left off a phone, the verdict dialog repeats it.
      const stat = (kind, level, text, onclick, title) =>
        h(`${onclick ? "button" : "span"}.cr-stat${level ? `.${level}` : ""}`, { dataset: { stat: kind }, ...(onclick ? { type: "button", onclick } : {}), ...(title ? { title } : {}) }, text);
      stats.replaceChildren(...[
        blockers.length > 0 && stat("blockers", "danger", t("cr.bar.blockers", blockers.length), () => s.goReviewers(blockers[0].id)),
        checks.failed > 0 && stat("failed", "danger", t("cr.bar.failed", checks.failed), toChecks),
        waiting.length > 0 && stat("decisions", "warn", t("cr.bar.decisions", waiting.length), () => s.goPlace(waiting[0].chapter, waiting[0].index)),
        !checks.total && stat("nochecks", "warn", t("cr.checksNone"), toChecks),
        open.length > 0 && stat("findings", "low", t("cr.bar.findings", open.length), () => s.goReviewers(open[0].id)),
        checks.missing > 0 && stat("missing", "low", t("cr.bar.missing", checks.missing), toChecks),
        said > 0 && stat("said", "low", t("cr.said.some", said), null,
          [n.fix && t("cr.n.fix", n.fix), n.question && t("cr.n.question", n.question), n.nit && t("cr.n.nit", n.nit)].filter(Boolean).join(", ")),
      ].filter(Boolean));
      const lead = s.suggested();
      for (const [v, b] of Object.entries(buttons)) b.classList.toggle("primary", v === lead);
    },
  };
}

export function mechanicalLine(s) {
  const m = s.rv.mechanicalShare;
  if (!m) return "";
  return t("cr.mechanicalAccount", m.files, m.added, m.removed, m.percent) + (s.spec.mechanicalWhy ? ` ${t("cr.mechanicalReason", s.spec.mechanicalWhy)}` : "");
}
