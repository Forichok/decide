// done.js — the screen after Done: what happened to the answers, the next round, and the answers
// themselves as a readable summary (question → answer in words, notes, files), not the raw digest.

import { h, icon } from "./dom.js";
import { t } from "./i18n.js";
import { mdInline } from "./md.js";
import { credit, eyebrow, journalPanel, pasteLine } from "./header.js";
import { summarize } from "./summary.js";
import { doneActions } from "./actions.js";
import { ruleButtons } from "./settings.js";

const words = () => ({
  explain: t("sum.explain"),
  skip: t("sum.skip"),
  delegate: t("sum.delegate"),
  autoSkip: t("sum.autoSkip"),
  autoDelegate: t("sum.autoDelegate"),
  against: (recs) => t("sum.against", recs),
  own: (text) => t("sum.own", text),
  later: (revisit) => t("sum.later", revisit),
  none: t("sum.none"),
  condition: (text) => t("sum.condition", text),
});

function summaryCard(spec, result, env = {}) {
  if (result?.mode === "swipe" && result.brief?.length) {
    return h("section.sum", {}, h("h3.sum-h", {}, t("sum.brief")), h("ul.done-brief", {}, result.brief.map((b) => h(`li.sw-item.k-${b.kind}`, {}, b.text))));
  }
  if (!result || result.cancelled) return null;
  if (result.mode === "review") return reviewCard(result);
  const s = spec ? summarize(spec, result, words()) : { rows: [], comment: result.comment || "", leftOut: [], commentFiles: [] };
  const rows = s.rows.map((r) =>
    h(
      "li.sum-row",
      {},
      h("div.sum-q", { html: mdInline(r.title) }),
      h("div.sum-a", {}, r.answer, r.recommended && h("span.sum-rec", {}, t("sum.recommended"))),
      r.note && h("div.sum-note", { html: icon("pen") }, h("span", {}, r.note)),
      r.files.length > 0 && h("div.sum-files", { html: icon("clip") }, h("span", {}, r.files.join(", "))),
      r.pins.map((p) => h("div.sum-files", { html: icon("pointer") }, h("span", {}, `${p.file}: ${p.text}`))),
      !env.offline && ruleButtons(env.project, r),
    ),
  );
  const raw = result.digest && h("details.sum-raw", {}, h("summary", {}, t("sum.raw")), h("pre.done-digest", {}, result.digest));
  if (!rows.length && !s.comment && !raw) return null;
  return h(
    "section.sum",
    {},
    h("h3.sum-h", {}, t("sum.title")),
    rows.length ? h("ol.sum-list", {}, rows) : h("p.sum-empty", {}, t("sum.empty")),
    s.comment && h("div.sum-comment", {}, h("div.sum-label", {}, t("sum.comment")), h("p", {}, s.comment)),
    s.commentFiles.length > 0 && h("div.sum-files", { html: icon("clip") }, h("span", {}, s.commentFiles.join(", "))),
    s.leftOut.length > 0 && h("div.sum-comment", {}, h("div.sum-label", {}, t("sum.leftOut", s.leftOut.length)), h("p", {}, s.leftOut.join("; "))),
    raw,
  );
}

// A code review's result: the verdict, how much was read, and every comment where it was left.
function reviewCard(result) {
  const where = (c) => `${c.file || c.hunk}${Number.isInteger(c.line) ? `:${c.line}` : ""}`;
  const comments = result.comments || [];
  return h(
    "section.sum",
    {},
    h("h3.sum-h", {}, t("cr.done.title")),
    result.range?.head && h("p.cr-sum-commit", {}, t("cr.commit", result.range.head.slice(0, 7), result.range.headRef || "HEAD")),
    result.verdict && h(`span.cr-sum-verdict.${result.verdict}`, {}, t(`cr.done.${result.verdict}`)),
    h("p.cr-sum-line", {}, t("cr.done.read", result.read?.length ?? 0, (result.read?.length ?? 0) + (result.unread?.length ?? 0))),
    result.note && h("div.sum-comment", {}, h("div.sum-label", {}, t("cr.done.note")), h("p", {}, result.note)),
    comments.length > 0 &&
      h(
        "ul.cr-sum-list",
        {},
        comments.map((c) =>
          h(
            `li.cr-cm.${c.kind}`,
            {},
            h("div.cr-cm-top", {}, h(`span.cr-kind.${c.kind}`, {}, t(`cr.kind.${c.kind}`)), h("span.cr-sum-where", {}, where(c)), c.kind === "question" && h("span.who", {}, t(c.reply ? "cr.done.answered" : "cr.done.open"))),
            h("p.cr-cm-text", {}, c.text),
          ),
        ),
      ),
    result.digest && h("details.sum-raw", {}, h("summary", {}, t("sum.raw")), h("pre.done-digest", {}, result.digest)),
  );
}

const REVIEW_STATES = ["sent", "handing", "saved"];

// result: the round's result; env.spec: its spec, when the page has it.
// env.delivery: { delivered, listening }; env.nextRound: the inbox row to go to, or null;
// env.advance: seconds until the page goes there by itself, or null.
export function renderDone(result, env) {
  const cancelled = result?.cancelled || result?.dismissed;
  const next = env.nextRound;
  const { delivered = true, listening = false } = env.delivery || {};
  const reviewed = result?.mode === "review";
  const state = cancelled ? "cancelled" : env.offline ? "file" : delivered ? "sent" : reviewed ? "saved" : listening ? "handing" : "saved";
  const ring = { cancelled: ".cancel", sent: "", handing: ".handing", saved: ".saved", file: "" }[state];
  const line = state === "saved" && pasteLine(env.currentId || result?.round || "");
  const action = env.offline
    ? h(
        "div.close-row",
        {},
        !cancelled && h("button.btn.primary", { type: "button", onclick: env.download, html: `${icon("download")}${t("done.downloadAgain")}` }),
        h("button.btn", { type: "button", onclick: env.reopen, html: `${icon("pen")}${t("done.change")}` }),
      )
    : next
      ? h(
          "div.next-row",
          {},
          h("button.btn.primary", { type: "button", onclick: () => env.switchTo(next.id), html: `${t("done.next", next.title)}${icon("arrow")}` }),
          typeof env.advance === "number" && h("span.next-count", {}, t("done.advance", env.advance)),
          typeof env.advance === "number" && h("button.link-btn", { type: "button", onclick: env.stay }, t("done.stay")),
        )
      : state === "handing"
        ? h("div.waiting", {}, h("span.pulse"), t("done.handingWait"))
        : state === "sent" || cancelled
          ? closer(env)
          : null;
  return h(
    "section.done-view",
    {},
    eyebrow(env),
    h(
      "div.done-card",
      {},
      h(`div.ring${ring}`, { html: icon(cancelled ? "x" : state === "sent" ? "check" : state === "saved" ? "alert" : "arrow") }),
      h("h2", {}, t(reviewed && REVIEW_STATES.includes(state) ? `cr.done.${state}` : `done.${state}`)),
      h("p.done-sub", {}, state === "file" ? t("done.fileSub", result.file) : t(reviewed && REVIEW_STATES.includes(state) ? `cr.done.${state}Sub` : `done.${state}Sub`)),
      reviewed && state === "sent" && h("p.cr-done-recovery", {}, t("cr.done.recovery", env.currentId || result.round)),
      line &&
        h(
          "div.paste-line.block",
          {},
          h("code", {}, line),
          h("button.btn.primary", { type: "button", onclick: env.copyNudge, html: `${icon("clip")}${t("done.copy")}` }),
        ),
      action,
    ),
    summaryCard(env.spec, result, env),
    // Export and ADR are for decisions: a review's verdict is neither.
    !env.offline && !cancelled && env.currentId && result?.mode !== "review" && doneActions(env.currentId),
    !env.offline && journalPanel({ skip: env.currentId }),
    credit(),
  );
}

function closer(env) {
  if (!env.connected) return h("div.waiting", {}, t("done.gone"));
  return h(
    "div.close-row",
    {},
    h("div.waiting", {}, h("span.pulse"), env.closing === "failed" ? t("done.closeFailed") : t("done.waiting")),
    h("button.btn", { type: "button", onclick: env.closeTab, html: `${icon("x")}${t("done.close")}` }),
  );
}
