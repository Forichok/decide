// The overview and the diff read the same findings and the same owner decisions.
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { mdInline } from "../md.js";
import { reviewerRoleDisplay } from "../reviewer-display.js";

const SEVERITIES = ["blocking", "major", "minor"];
export const findingsOf = (s) => s.rv.reviewers?.findings ?? [];
export const decisionOf = (s, f) => Object.hasOwn(s.rv.findingDecisions ?? {}, f.id) ? s.rv.findingDecisions[f.id] : null;
export const sortedFindings = (s) => [...findingsOf(s)].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));

function roleTitle(s, role) {
  const { requirement, defaultRoles } = s.rv.reviewers;
  const entry = requirement?.roles.find(r => r.id === role);
  return entry ? reviewerRoleDisplay(entry, defaultRoles).title : role;
}

export function ownerOf(s, hunk) {
  const owner = s.rv.owners[hunk];
  if (owner?.chapter !== undefined) return `ch:${owner.chapter}`;
  return owner?.mechanical !== undefined ? `mech:${owner.mechanical}` : "rest";
}

export function openCounts(s) {
  const counts = new Map();
  for (const f of findingsOf(s)) {
    if (!f.anchor || decisionOf(s, f)) continue;
    const key = ownerOf(s, f.anchor.hunk);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function paintOpenCount(el, n) {
  el.hidden = !n;
  el.textContent = n ? t("cr.reviewers.openCount", n) : "";
}

export function renderReviewers(s) {
  const { ran = [], skipped = [], none, requirement } = s.rv.reviewers ?? {};
  const findings = sortedFindings(s);
  const rows = ran.map(r => {
    const own = findings.filter(f => f.role === r.role);
    return h("li.cr-reviewer",
      {}, h("div.cr-reviewer-head", {}, h("b", {}, roleTitle(s, r.role)), h("span.cr-hint", {}, r.model || t("cr.reviewers.defaultModel")),
        h(`span.badge.cr-reviewer-mark.${r.verdict}`, {}, t(`cr.reviewers.verdict.${r.verdict}`))),
      h("div", { html: mdInline(r.summary) }),
      h("small.cr-hint", {}, SEVERITIES.map(severity => t(`cr.reviewers.count.${severity}`, own.filter(f => f.severity === severity).length)).join(" · ")));
  });
  for (const r of skipped) rows.push(h("li.cr-reviewer.warn", {},
    h("div.cr-reviewer-head", {}, h("b", {}, roleTitle(s, r.role)), h("span", {}, r.model || t("cr.reviewers.defaultModel"))),
    h("div", {}, t("cr.reviewers.skipped", r.why))));
  const empty = requirement ? (requirement.mode === "request"
    ? t("cr.reviewers.request", requirement.lines)
    : t("cr.reviewers.notRequired", requirement.lines)) : t("cr.reviewers.legacy");
  return h("div", {},
    (rows.length > 0 || findings.length > 0) && h("small.cr-hint", {}, t("cr.reviewers.words")),
    rows.length > 0 && h("ul.cr-reviewer-list", {}, rows),
    none ? h("p.cr-none.warn", {}, t("cr.reviewers.none", none)) : !ran.length && h("p.cr-none", {}, empty),
    findings.length > 0 && h("ol.cr-reviewer-list", {}, findings.map(f => h("li", {}, renderFinding(s, f, false)))),
    findings.some(f => f.anchor) && h("button.chip.cr-finding-toggle", { type: "button", onclick: () => s.setFindings(!s.showFindings) }),
  );
}

export function renderFinding(s, f, inline = true) {
  const btn = (key, onclick) => h("button.chip", { type: "button", onclick }, t(`cr.reviewers.${key}`));
  const status = h("small.cr-finding-state");
  const saved = h("small.cr-hint.cr-finding-reason");
  const reason = h("input", { type: "text", maxlength: "500", placeholder: t("cr.reviewers.reason"), "aria-label": t("cr.reviewers.reason") });
  const form = h("form.cr-finding-form", { hidden: true, onsubmit: async e => {
    e.preventDefault();
    if (await s.saveFinding(f.id, "dismissed", reason.value)) {
      form.hidden = true;
      el.paint();
    }
  } }, reason, h("button.chip", { type: "submit" }, t("cr.reviewers.dismiss")),
    btn("cancel", () => { form.hidden = true; el.paint(); dismiss.focus(); }));
  const fix = btn("fix", () => s.saveFinding(f.id, "fix"));
  const dismiss = btn("dismiss", () => {
    reason.value = decisionOf(s, f)?.reason || "";
    form.hidden = false;
    el.paint();
    reason.focus();
  });
  const reopen = btn("reopen", () => s.saveFinding(f.id, null));
  const actions = h("div.cr-finding-acts", {}, fix, dismiss, reopen);
  const location = !inline && f.at && (
    f.anchor ? h("button.link-btn.cr-finding-jump", { type: "button", onclick: () => s.goFinding(f) }, f.at)
      : h("span.cr-hint", {}, f.outside ? t("cr.reviewers.outside", f.at) : f.at)
  );
  const el = h(`div.cr-finding.${f.severity}`, { dataset: { finding: f.id } },
    h("div.cr-reviewer-head", {}, h("b", {}, roleTitle(s, f.role)),
      h("span.badge.cr-finding-severity", {}, t(`cr.reviewers.severity.${f.severity}`)), status, location),
    h("div", { html: mdInline(f.text) }),
    f.why && h("div.cr-hint", { html: mdInline(f.why) }),
    f.anchorMismatch && h("small.cr-finding-anchor", {}, f.anchorMismatch.movedTo
      ? t("cr.reviewers.anchorMoved", f.anchorMismatch.movedTo)
      : t("cr.reviewers.anchorMismatch")),
    saved, actions, form,
  );
  el.paint = () => {
    const decision = decisionOf(s, f);
    status.textContent = t(`cr.reviewers.state.${decision?.decision ?? "open"}`);
    saved.textContent = decision?.reason ?? "";
    saved.hidden = !decision?.reason;
    fix.hidden = decision?.decision === "fix";
    dismiss.hidden = (decision?.decision === "dismissed") || !form.hidden;
    reopen.hidden = !decision;
    const busy = s.isFindingSaving(f.id);
    for (const input of el.querySelectorAll("button:not(.cr-finding-jump), input")) input.disabled = busy;
  };
  el.paint();
  return el;
}

export async function saveFinding(id, payload) {
  const res = await fetch(`/api/rounds/${id}/finding`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!res.ok) throw Object.assign(new Error("Finding decision was not saved"), { status: res.status });
  return res.json();
}

export function reviewerWarnings(s, close) {
  const { skipped = [], none } = s.rv.reviewers ?? {};
  const blocking = findingsOf(s).filter(f => f.severity === "blocking" && decisionOf(s, f)?.decision !== "dismissed");
  const groups = new Map();
  for (const f of blocking) {
    const key = f.anchor ? ownerOf(s, f.anchor.hunk) : "overview";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const links = [...groups].slice(0, 6).map(([key, findings]) => {
    const title = key.startsWith("ch:") ? s.spec.chapters.find(c => c.id === key.slice(3)).title
      : key.startsWith("mech:") ? s.spec.mechanical[Number(key.slice(5))].title
      : t(key === "rest" ? "cr.rest" : "cr.overview");
    return h("button.link-btn", {
      type: "button", onclick: () => { close(); findings[0].anchor ? s.goFinding(findings[0]) : s.goReviewers(); },
    }, h("span", { html: mdInline(title) }), ` (${findings.length})`);
  });
  if (groups.size > links.length) links.push(h("button.link-btn", {
    type: "button", onclick: () => { close(); s.goReviewers(); },
  }, t("cr.reviewers.moreGroups", groups.size - links.length)));
  const alert = (kind, ...body) => h("div.cr-alert", { dataset: { alert: `reviewer-${kind}` } }, body);
  return [
    blocking.length && alert("blocking", h("b", {}, t("cr.reviewers.blockingWarning", blocking.length)), h("div.cr-finding-jumps", {}, links)),
    skipped.length && alert("skipped", t("cr.reviewers.skippedWarning", skipped.map(r => roleTitle(s, r.role)).join(", "))),
    none && alert("none", t("cr.reviewers.none", none)),
  ].filter(Boolean);
}
