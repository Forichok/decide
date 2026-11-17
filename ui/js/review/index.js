// review/index.js — a code review on screen: the agent's overview, then the diff in chapters. On any
// line the reader leaves a comment (fix, nit: kept until the verdict) or asks the agent (sent at once,
// the answer comes back under the line). A chapter is marked read as a whole. One of three verdicts
// ends the round and carries every comment to the agent.
//
// The parts: overview.js (title, overview, rail, bar), chapters.js (cards and folded groups, loaded
// as they come near), hunk.js (one piece: lines, notes, the box). They share the state `s` made here.

import { h, $ } from "../dom.js";
import { t } from "../i18n.js";
import { eyebrow } from "../header.js";
import { modalOpen, openModal, toast } from "../overlays.js";
import { getRound, holdReload, reviewAsk, reviewComment, reviewRead, reviewUncomment, submitRound } from "../net.js";
import { createChapters } from "./chapters.js";
import { composer } from "./hunk.js";
import { checkState, renderBar, renderOverview, renderRail, renderTitle } from "./overview.js";

const KEYS = [
  ["J  K", "cr.key.step"],
  ["R", "cr.key.read"],
  ["⌘↵", "cr.key.verdict"],
  ["Esc", "cr.key.esc"],
];
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

export function mountReview(round, env) {
  const s = {
    id: round.id,
    spec: round.spec,
    rv: round.review,
    dialog: round.dialog || [],
    listening: round.listening !== false,
    seq: round.seq || 0,
    loaded: new Map(), // piece id → {piece, el, group}: the pieces on screen
    draft: null, // the open box: {hunk, group, line?, side?, kind, text, edit?}
    box: null, // its element
    note: "", // the words that go with the verdict
    current: "overview",
    sending: false,
    full: false, // the whole diff: nothing folded
  };

  // ---- key places: piece id → the places of its chapter that fall on it
  const places = new Map();
  s.rv.chapters.forEach((c) => c.focus.forEach((f, k) => f.pieces.forEach((id) => places.set(id, [...(places.get(id) || []), { ...f, key: `${c.id}:${k}` }]))));
  s.focusOf = (piece) => places.get(piece) || [];
  // Is anything on this page folded on the agent's word: key places or a chapter to skim.
  s.guided = s.rv.chapters.some((c) => c.focus.length) || s.spec.chapters.some((c) => c.skim);

  // ---- text that must survive a reload: the open box and the note to the verdict
  const KEY = `decide.review.${round.id}`;
  s.persist = () => {
    try {
      const keep = (s.draft?.text || "").trim() || s.note.trim();
      if (keep) sessionStorage.setItem(KEY, JSON.stringify({ draft: s.draft, note: s.note }));
      else sessionStorage.removeItem(KEY);
    } catch {}
  };
  try {
    const kept = JSON.parse(sessionStorage.getItem(KEY) || "{}");
    if (kept.draft?.hunk && (kept.draft.text || "").trim()) s.draft = kept.draft;
    if (typeof kept.note === "string") s.note = kept.note;
  } catch {}
  holdReload("view", () => Boolean((s.draft?.text || "").trim() || s.note.trim()));
  const FULL = `decide.review.full.${round.id}`;
  try {
    s.full = sessionStorage.getItem(FULL) === "1";
  } catch {}

  // ---- what was said
  // Comments and questions as one list: a question is a dialog entry, with the agent's reply once it came.
  s.notes = () => [
    ...s.rv.comments,
    ...s.dialog.filter((d) => d.ask).map((d) => ({ id: d.id, kind: "question", hunk: d.qid, line: d.line, side: d.side, text: d.ask, reply: d.reply?.text || "" })),
  ];
  s.notesOf = (hunk) => s.notes().filter((c) => c.hunk === hunk);
  s.counts = () => {
    const all = s.notes();
    const of = (kind) => all.filter((c) => c.kind === kind).length;
    return { fix: of("fix"), nit: of("nit"), question: of("question"), open: all.filter((c) => c.kind === "question" && !c.reply).length };
  };
  s.checks = () => ({ failed: s.spec.checks.filter((c) => checkState(c) === "failed").length, missing: s.spec.checks.filter((c) => checkState(c) === "missing").length, total: s.spec.checks.length });
  // Chapter id → how many notes sit on its pieces.
  const chapterOf = new Map(s.rv.chapters.flatMap((c) => c.ids.map((id) => [id, c.id])));
  s.byChapter = () => {
    const out = new Map();
    for (const c of s.notes()) if (chapterOf.has(c.hunk)) out.set(chapterOf.get(c.hunk), (out.get(chapterOf.get(c.hunk)) || 0) + 1);
    return out;
  };
  const isRead = (id) => Object.hasOwn(s.rv.read, id);

  // ---- screen
  document.body.classList.add("review-mode");
  document.body.classList.remove("no-toc");
  $("#bar").hidden = true;
  const title = renderTitle(s);
  const rail = renderRail(s);
  const bar = renderBar(s);
  const chapters = createChapters(s);
  $("#toc").replaceChildren(rail.el);
  $("#main").replaceChildren(h("div.cr-view", {}, eyebrow({ ...env, help: openKeys }), title.el, renderOverview(s), chapters.el, bar.el));
  window.scrollTo({ top: 0, behavior: "instant" });

  s.paint = () => {
    title.paint();
    rail.paint();
    bar.paint();
    chapters.paint();
  };

  // ---- moving around
  const stops = () => [...document.querySelectorAll(".cr-view [data-stop]")];
  const stopEl = (id) => stops().find((el) => el.dataset.stop === id);
  s.go = (id) => {
    const el = stopEl(id);
    if (!el) return;
    el.scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "start" });
    el.focus?.({ preventScroll: true });
  };
  // To a key place: its chapter is loaded, the row that names it comes to the middle of the screen.
  s.goPlace = async (chapter, k) => {
    const row = await chapters.place(chapter, k);
    if (!row) return;
    row.scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "center" });
    row.classList.remove("flash");
    requestAnimationFrame(() => row.classList.add("flash"));
  };
  // The whole diff, nothing folded, or back to the key places. The chapter being read stays in place.
  s.setFull = (on) => {
    const anchor = stopEl(s.current);
    const top = anchor?.getBoundingClientRect().top;
    s.full = on;
    try {
      if (on) sessionStorage.setItem(FULL, "1");
      else sessionStorage.removeItem(FULL);
    } catch {}
    chapters.redraw();
    rail.paint();
    const now = anchor?.getBoundingClientRect().top;
    if (top !== undefined && now !== top) scrollBy({ top: now - top, behavior: "instant" });
  };
  s.goFolds = (key) => {
    const el = key ? stopEl(key) : document.getElementById("cr-folds");
    el?.scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "start" });
  };
  // The stop whose top passed the upper third of the screen is the one being read.
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const line = innerHeight / 3;
      const passed = stops().filter((el) => el.getBoundingClientRect().top <= line);
      const stop = passed.at(-1)?.dataset.stop || "overview";
      const now = stop === "rest" ? "rest" : stop.startsWith("mech:") ? "mech" : stop;
      if (now === s.current) return;
      s.current = now;
      rail.paint();
    });
  };
  addEventListener("scroll", onScroll, { passive: true });
  const chapterIds = s.spec.chapters.map((c) => c.id);
  const order = ["overview", ...chapterIds.map((id) => `ch:${id}`)];
  // From the folded groups below the chapters, a step back lands on the last chapter.
  const step = (delta) => {
    const i = order.includes(s.current) ? order.indexOf(s.current) : order.length;
    s.go(order[Math.max(0, Math.min(order.length - 1, i + delta))]);
  };

  // ---- the server's side of the state
  // Events and reads may land out of order: an older picture never replaces a newer one.
  function setReview(review, seq = 0) {
    if (seq && seq < s.seq) return;
    s.seq = Math.max(s.seq, seq);
    s.rv = { ...s.rv, comments: review.comments ?? s.rv.comments, read: review.read ?? s.rv.read, ...(review.newer !== undefined ? { newer: review.newer } : {}) };
    s.paint();
  }
  const failed = (e) => {
    // The round ended elsewhere (another tab, the agent): show what it became.
    if (e.status === 409 || e.status === 404) return env.switchTo(round.id);
    toast(t("cr.failed"));
  };
  async function refresh() {
    try {
      const d = await getRound(round.id);
      if (d.status !== "pending") return env.switchTo(round.id);
      s.dialog = d.dialog || s.dialog;
      setReview(d.review, d.seq);
    } catch {}
  }

  // ---- the box
  function closeBox() {
    const hunk = s.draft?.hunk;
    s.draft = null;
    s.box = null;
    s.persist();
    if (hunk) chapters.paintPiece(hunk);
  }
  s.closeDraft = closeBox;
  s.compose = (d) => {
    // A box with words in it is not thrown away for a click: not on another line, not on its own.
    if (s.draft && (s.draft.text || "").trim()) {
      const same = s.draft.hunk === d.hunk && s.draft.line === d.line && s.draft.side === d.side;
      if (!same) toast(t("cr.oneBox"));
      s.box?.scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "center" });
      return s.box?.focusText();
    }
    if (s.draft) closeBox();
    s.draft = { text: "", ...d, group: s.loaded.get(d.hunk)?.group || "" };
    s.box = composer(s);
    chapters.paintPiece(d.hunk);
    s.box.focusText();
  };
  s.send = async () => {
    const d = s.draft;
    const text = (d?.text || "").trim();
    if (!d || !text || s.sending) return;
    s.sending = true;
    const at = Number.isInteger(d.line) ? { line: d.line, side: d.side } : {};
    try {
      if (d.kind === "question") await reviewAsk(round.id, { question: d.hunk, text, ...at });
      else await reviewComment(round.id, d.edit ? { id: d.edit, kind: d.kind, text } : { hunk: d.hunk, kind: d.kind, text, ...at });
      closeBox();
      if (d.kind === "question") toast(t(s.listening ? "cr.askSent" : "cr.askKept"));
      await refresh();
    } catch (e) {
      failed(e);
    }
    s.sending = false;
  };
  s.remove = async (id) => {
    try {
      await reviewUncomment(round.id, id);
      await refresh();
    } catch (e) {
      failed(e);
    }
  };
  s.toggleRead = async (chapter) => {
    const read = !isRead(chapter);
    try {
      await reviewRead(round.id, chapter, read);
      await refresh();
      // Reading on: the next chapter is where the eye goes.
      const next = chapterIds[chapterIds.indexOf(chapter) + 1];
      if (read && next) s.go(`ch:${next}`);
    } catch (e) {
      failed(e);
    }
  };

  // ---- the verdict
  s.verdict = (first) => {
    if ((s.draft?.text || "").trim()) {
      toast(t("cr.unsent"));
      s.box?.scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "center" });
      return s.box?.focusText();
    }
    let verdict = first;
    const n = s.counts();
    const checks = s.checks();
    const unread = s.spec.chapters.filter((c) => !isRead(c.id));
    const text = h("p");
    const alerts = h("div");
    const confirm = h("button.btn.primary", { type: "button", "data-autofocus": true, onclick: () => submit() });
    const note = h("textarea", { rows: 3, "aria-label": t("cr.noteLabel"), placeholder: t("cr.notePh") });
    note.value = s.note;
    note.addEventListener("input", () => {
      s.note = note.value;
      s.persist();
    });
    const seg = h(
      "div.cr-seg",
      { role: "group", "aria-label": t("cr.verdictLabel") },
      ["return", "nits", "approve"].map((v) => h("button", { type: "button", dataset: { verdict: v }, onclick: () => pick(v) }, t(`cr.v.${v}`))),
    );
    function pick(v) {
      verdict = v;
      for (const b of seg.children) b.setAttribute("aria-pressed", String(b.dataset.verdict === v));
      text.textContent = t(`cr.vText.${v}`);
      confirm.textContent = t(`cr.vDo.${v}`);
      const approving = v !== "return";
      const red = [checks.failed && t("cr.n.failed", checks.failed), checks.missing && t("cr.n.missing", checks.missing)].filter(Boolean).join(", ");
      alerts.replaceChildren(
        ...[
          approving && red && h("div.cr-alert", { dataset: { alert: "checks" } }, h("b", {}, t("cr.alert.checks")), " ", t("cr.alert.checksText", red)),
          approving && !checks.total && h("div.cr-alert", { dataset: { alert: "checks" } }, h("b", {}, t("cr.alert.noChecks")), " ", t("cr.alert.noChecksText")),
          approving && n.fix > 0 && h("div.cr-alert", { dataset: { alert: "fix" } }, h("b", {}, t("cr.alert.fix", n.fix)), " ", t("cr.alert.fixText")),
          approving && unread.length > 0 && h("div.cr-alert", { dataset: { alert: "unread" } }, h("b", {}, t("cr.alert.unread", unread.length, s.spec.chapters.length)), " ", unread.map((c) => `«${c.title}»`).join(", ")),
          v === "return" && !n.fix && !n.nit && !n.question && h("div.cr-alert", { dataset: { alert: "empty" } }, h("b", {}, t("cr.alert.empty")), " ", t("cr.alert.emptyText")),
        ].filter(Boolean),
      );
    }
    let busy = false;
    async function submit() {
      if (busy) return;
      busy = true;
      try {
        const res = await submitRound(round.id, { verdict, ...(s.note.trim() ? { note: s.note.trim() } : {}) });
        s.note = "";
        s.persist();
        close();
        env.finished(round.id, res.result);
      } catch (e) {
        busy = false;
        if (e.status === 409) {
          close();
          env.switchTo(round.id);
        } else toast(t("toast.sendFailed"));
      }
    }
    note.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        submit();
      }
    });
    const close = openModal(
      h(
        "div.cr-verdict",
        {},
        h("h2.modal-title", {}, t("cr.verdictTitle")),
        seg,
        text,
        alerts,
        h(
          "ul",
          {},
          h("li", {}, h("span.cr-kind.fix", {}, t("cr.kind.fix")), n.fix),
          h("li", {}, h("span.cr-kind.nit", {}, t("cr.kind.nit")), n.nit),
          h("li", {}, h("span.cr-kind.question", {}, t("cr.kind.question")), n.question, n.open > 0 && h("span.cr-hint", {}, t("cr.openQuestions", n.open))),
        ),
        note,
        h("div.modal-actions", {}, h("button.btn.ghost", { type: "button", onclick: () => close() }, t("cr.cancel")), confirm),
      ),
    );
    pick(verdict);
  };
  // ⌘↵ on the page: the verdict the comments point to, to be confirmed.
  const suggested = () => {
    const n = s.counts();
    return n.fix ? "return" : n.nit ? "nits" : "approve";
  };

  // ---- keys: J/K and R come through main.js; Esc here closes an empty box
  const onKey = (e) => {
    if (e.key !== "Escape" || modalOpen() || e.target.closest?.("input, textarea")) return;
    if (s.draft && !(s.draft.text || "").trim()) closeBox();
  };
  document.addEventListener("keydown", onKey);
  // Back on the page after a while: the branch may have a commit this review does not show.
  const onShow = () => document.visibilityState === "visible" && refresh();
  document.addEventListener("visibilitychange", onShow);

  function openKeys() {
    const close = openModal(
      h(
        "div.help",
        {},
        h("h2.modal-title", {}, t("keys.title")),
        h("dl.keys", {}, KEYS.map(([k, d]) => [h("dt", {}, h("kbd", {}, t(k))), h("dd", {}, t(d))])),
        h("div.modal-actions", {}, h("button.btn.primary", { type: "button", onclick: () => close() }, t("keys.ok"))),
      ),
    );
  }

  // A box that came back with the page: its group is opened so that it is on screen again.
  if (s.draft) {
    s.box = composer(s);
    if (s.draft.group) chapters.show(s.draft.group).then(() => s.box?.scrollIntoView({ block: "center" }));
  }
  s.paint();

  return {
    id: round.id,
    mode: "review",
    spec: s.spec,
    setDialog(next) {
      const had = new Set(s.dialog.filter((d) => d.reply).map((d) => d.id));
      s.dialog = next;
      if (next.some((d) => d.reply && !had.has(d.id))) toast(t("cr.replied"));
      s.paint();
    },
    setReview,
    setListening(on) {
      if (s.listening === on) return;
      s.listening = on;
      s.paint();
    },
    step,
    toggleRead: () => s.current.startsWith("ch:") && s.toggleRead(s.current.slice(3)),
    help: openKeys,
    finish: () => (modalOpen() ? null : s.verdict(suggested())),
    stop() {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onShow);
      removeEventListener("scroll", onScroll);
      chapters.stop();
      document.body.classList.remove("review-mode");
      $("#toc").replaceChildren();
      holdReload("view", () => false);
    },
  };
}
