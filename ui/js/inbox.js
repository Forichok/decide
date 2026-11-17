// inbox.js — the rail of open rounds across projects. Rows come from GET /api/inbox, already in order;
// an older server without that route gets rows derived from /api/state (inbox-logic.js).
// The rail is a column beside the page on wide screens and a drawer (a sheet on a phone) below that.

import { h, icon } from "./dom.js";
import { t } from "./i18n.js";
import { groups, progressOf, rowsFromState } from "./inbox-logic.js";

const WRITE = { "content-type": "application/json" };
let routeMissing = false;

// state: the latest /api/state, for the fallback.
export async function loadInbox(state) {
  if (!routeMissing) {
    try {
      const res = await fetch("/api/inbox", { cache: "no-store" });
      if (res.status === 404) routeMissing = true;
      else if (res.ok) return (await res.json()).rounds || [];
    } catch {
      return null;
    }
  }
  return rowsFromState(state);
}

export async function dismissRound(id) {
  const res = await fetch(`/api/rounds/${encodeURIComponent(id)}/dismiss`, { method: "POST", headers: WRITE });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export const canNotify = () => typeof Notification !== "undefined" && Notification.permission === "granted";
export const mayAskNotify = () => typeof Notification !== "undefined" && Notification.permission === "default";

// A system notification for a round that arrived while the page was in the background.
export function notifyNew(row) {
  if (!canNotify() || (document.visibilityState === "visible" && document.hasFocus())) return;
  try {
    new Notification(t("inbox.notifyTitle", row.projectName || "decide"), { body: row.title, tag: `decide-${row.id}` });
  } catch {}
}

const modeLabel = (row) => t(row.mode === "swipe" ? "inbox.swipe" : row.mode === "review" ? "inbox.review" : "inbox.questions");

function progressLine(row) {
  const { answered, total } = progressOf(row);
  // A review counts chapters read, not questions answered.
  const text = row.mode === "review" ? t("inbox.chapters", answered ?? 0, total) : answered === null ? t("inbox.total", total) : t("inbox.progress", answered, total);
  const frac = answered === null || !total ? 0 : Math.min(1, answered / total);
  return h(
    "div.ib-meta",
    {},
    h("span.ib-track", { "aria-hidden": "true" }, h("i", { style: `transform:scaleX(${frac})` })),
    h("span.ib-count", {}, text),
    h("span.ib-mode", {}, modeLabel(row)),
  );
}

// env: { open(id), dismiss(id), askNotify(), close() }
export function createInbox(env) {
  const list = h("div.ib-list");
  const foot = h("div.ib-foot");
  const title = h("h2.ib-title", {}, t("inbox.title"));
  const head = h("div.ib-head", {}, title, h("button.icon-btn.ib-close", { type: "button", "aria-label": t("inbox.close"), html: icon("x"), onclick: () => env.close() }));
  const el = h("aside.rail", { id: "rail", "aria-label": t("inbox.title"), hidden: true }, head, list, foot);
  // Review keeps a small entry point; the existing drawer controls close the overlay too.
  let reviewMode = false;
  let reviewOpen = false;
  try { reviewOpen = sessionStorage.getItem("decide.reviewInbox") === "open"; } catch {}
  const toggle = h("button.ib-review-toggle", { type: "button", "aria-controls": "rail", hidden: true, onclick: () => document.body.classList.toggle("rail-open") });
  function syncReview() {
    if (!reviewMode) return;
    const open = document.body.classList.contains("rail-open");
    const wasOpen = toggle.getAttribute("aria-expanded") === "true";
    reviewOpen = open;
    try { sessionStorage.setItem("decide.reviewInbox", open ? "open" : "closed"); } catch {}
    toggle.setAttribute("aria-expanded", String(open));
    el.inert = !open;
    if (wasOpen && !open && el.contains(document.activeElement)) toggle.focus();
  }
  new MutationObserver(syncReview).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  let pendingDismiss = null;
  let pendingTimer = null;

  function row(r, currentId) {
    const current = r.id === currentId;
    const asking = pendingDismiss === r.id;
    const dot = h("span.ib-dot", { class: r.listening ? "live" : "away", title: t(r.listening ? "inbox.listening" : "inbox.away"), role: "img", "aria-label": t(r.listening ? "inbox.listening" : "inbox.away") });
    return h(
      "div.ib-item",
      { class: [current && "current", r.stakes === "high" && "high"].filter(Boolean).join(" "), dataset: { round: r.id } },
      h(
        "button.ib-open",
        { type: "button", "aria-current": current ? "true" : null, onclick: () => env.open(r.id) },
        h("span.ib-top", {}, h("span.ib-project", {}, r.projectName || t("inbox.noProject")), r.stakes === "high" && h("span.ib-high", {}, t("inbox.high")), h("span.spacer"), dot),
        h("span.ib-name", {}, r.title),
        progressLine(r),
      ),
      h(
        "button.ib-x",
        {
          type: "button",
          class: asking ? "asking" : "",
          title: t("inbox.dismiss"),
          "aria-label": asking ? t("inbox.dismissSure") : t("inbox.dismiss"),
          onclick: () => {
            if (pendingDismiss !== r.id) {
              pendingDismiss = r.id;
              clearTimeout(pendingTimer);
              pendingTimer = setTimeout(() => ((pendingDismiss = null), paint()), 3500);
              return paint();
            }
            pendingDismiss = null;
            env.dismiss(r.id);
          },
        },
        asking ? t("inbox.dismissSure") : h("span", { html: icon("x") }),
      ),
    );
  }

  let last = { rows: [], currentId: null };
  function paint() {
    const { rows, currentId } = last;
    const g = groups(rows);
    const older = g.older.length
      ? h(
          "details.ib-older",
          { open: g.older.some((r) => r.id === currentId) || el.dataset.olderOpen === "1", ontoggle: (e) => (el.dataset.olderOpen = e.target.open ? "1" : "0") },
          h("summary", {}, h("span.ib-older-h", {}, t("inbox.older")), h("span.ib-older-n", {}, String(g.older.length))),
          h("p.ib-older-sub", {}, t("inbox.olderSub")),
          g.older.map((r) => row(r, currentId)),
        )
      : null;
    list.replaceChildren(...g.open.map((r) => row(r, currentId)), ...(older ? [older] : []));
    title.textContent = t("inbox.title");
    foot.replaceChildren(
      ...(mayAskNotify() ? [h("button.link-btn", { type: "button", onclick: () => env.askNotify() }, t("inbox.notify"))] : []),
    );
    el.hidden = rows.length < 2;
    if (el.isConnected && !toggle.isConnected) el.before(toggle);
    toggle.hidden = !reviewMode || rows.length < 2;
    toggle.textContent = t("inbox.reviewWaiting", g.open.length);
    toggle.setAttribute("aria-label", t("inbox.reviewWaiting", g.open.length));
    document.body.classList.toggle("has-rail", rows.length >= 2);
  }

  return {
    el,
    set(rows, currentId) {
      last = { rows, currentId };
      paint();
    },
    setReview(active) {
      if (active === reviewMode) return;
      reviewMode = active;
      document.body.classList.toggle("review-inbox", active);
      document.body.classList.toggle("rail-open", active && reviewOpen);
      el.inert = active && !reviewOpen;
      if (active) syncReview();
      paint();
    },
    repaint: paint,
    get rows() {
      return last.rows;
    },
  };
}
