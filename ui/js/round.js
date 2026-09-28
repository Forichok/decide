// round.js — one round on screen: answer state, the ctx object the question
// widgets talk to, sections, the closing comment block and the bottom bar.

import { h, icon, $, $$ } from "./dom.js";
import { shortcut, t } from "./i18n.js";
import { md } from "./md.js";
import { renderQuestion, syncQuestion } from "./question.js";
import { noteArea, paintFiles } from "./extras.js";
import { credit, renderHeader } from "./header.js";
import { renderToc, syncToc, trackCurrent } from "./nav.js";
import { openLightbox, toast } from "./overlays.js";
import { emptyAnswer, isResolved, isVisible, progress, withRecommendation } from "./logic.js";
import { askAgent, saveDraft, uploadFile } from "./net.js";

const MAX_UPLOAD = 24 * 1024 * 1024;

export function mountRound(round, env) {
  const { spec } = round;
  const draft = round.draft || {};
  const answers = {};
  for (const q of spec.questions) answers[q.id] = { ...emptyAnswer(q), ...(draft.answers?.[q.id] || {}) };
  const loadedAt = Date.now();
  const s = {
    comment: draft.comment || "",
    commentFiles: draft.commentFiles || [],
    files: new Map(draft.files || []),
    ui: { note: new Set(), other: new Set(), ask: new Set(), askDraft: new Map() },
  };
  const live = Boolean(round.live);
  // Live "explain" means "waiting for the agent": drop it once every ask on the question has a reply.
  const settleExplain = (dialog) => {
    for (const [qid, a] of Object.entries(answers)) {
      const asks = dialog.filter((d) => d.qid === qid);
      if (a.flag === "explain" && asks.length && asks.every((d) => d.reply)) a.flag = null;
    }
  };
  if (live) settleExplain(round.dialog || []);
  const qById = new Map(spec.questions.map((q) => [q.id, q]));
  const card = (qid) => document.getElementById(`q-${qid}`);
  let tracker = null;
  const elapsed = () => Math.round((draft.elapsedSec || 0) + (Date.now() - loadedAt) / 1000);

  const ctx = {
    answers,
    live,
    dialog: round.dialog || [],
    glossary: spec.glossary,
    ui: s.ui,
    files: s.files,
    set(qid, patch, { quiet = false } = {}) {
      Object.assign(answers[qid], patch);
      if (quiet) syncOne(qid);
      else syncAll();
      persist();
    },
    openNote(qid) {
      s.ui.note.add(qid);
      syncOne(qid);
      focusIn(qid, "textarea.note");
    },
    openOther(qid) {
      s.ui.other.add(qid);
      syncOne(qid);
      focusIn(qid, ".other-input");
    },
    pickFile: (qid) => pickFiles((f) => ctx.attach(qid, f)),
    async attach(qid, file) {
      if (file.size > MAX_UPLOAD) return toast(t("upload.tooBig"));
      try {
        const up = await uploadFile(round.id, file);
        s.files.set(up.path, { url: up.url, name: up.name, type: up.type || file.type || "" });
        if (qid) {
          answers[qid].attachments = [...answers[qid].attachments, up.path];
          s.ui.note.add(qid);
          syncOne(qid);
        } else {
          s.commentFiles = [...s.commentFiles, up.path];
          paintComment();
        }
        persist();
        toast(t("upload.done", up.name));
      } catch {
        toast(t("upload.failed"));
      }
    },
    removeFile(qid, path) {
      answers[qid].attachments = answers[qid].attachments.filter((p) => p !== path);
      syncOne(qid);
      persist();
    },
    applyRecommended(qid) {
      const q = qById.get(qid);
      Object.assign(answers[qid], withRecommendation(q, answers[qid]), { flag: null });
      syncAll();
      persist();
    },
    toggleFlag(qid, flag) {
      const a = answers[qid];
      if (flag === "explain" && live && a.flag !== "explain") return ctx.ask(qid);
      a.flag = a.flag === flag ? null : flag;
      if (a.flag === "explain") s.ui.note.add(qid);
      syncAll();
      persist();
      if (a.flag === "explain") focusIn(qid, "textarea.note");
    },
    ask(qid) {
      s.ui.ask.add(qid);
      syncOne(qid);
      focusIn(qid, ".ask-input");
    },
    closeAsk(qid) {
      s.ui.ask.delete(qid);
      syncOne(qid);
    },
    async sendAsk(qid, text) {
      try {
        const res = await askAgent(round.id, qid, text);
        if (!ctx.dialog.some((d) => d.id === res.id)) ctx.dialog = [...ctx.dialog, { id: res.id, qid, ask: text, seen: false, reply: null }];
        s.ui.ask.delete(qid);
        s.ui.askDraft.delete(qid);
        answers[qid].flag = "explain";
        syncAll();
        persist();
      } catch {
        toast(t("ask.offline"));
      }
    },
    lightbox: (images, i, qid, opts = {}) => openLightbox(images, i, { ...opts, onAnnotate: (file) => ctx.attach(qid || null, file) }),
    toast,
    shake(qid) {
      const c = card(qid);
      c?.classList.remove("shake");
      void c?.offsetWidth;
      c?.classList.add("shake");
    },
  };

  function focusIn(qid, sel) {
    requestAnimationFrame(() => card(qid)?.querySelector(sel)?.focus());
  }

  function persist() {
    saveDraft(round.id, {
      answers,
      comment: s.comment,
      commentFiles: s.commentFiles,
      files: [...s.files],
      elapsedSec: elapsed(),
    });
  }

  function syncOne(qid) {
    const c = card(qid);
    if (c) syncQuestion(c, qById.get(qid), ctx);
    syncChrome();
  }

  function syncAll() {
    let n = 0;
    for (const q of spec.questions) {
      const c = card(q.id);
      if (!c) continue;
      const vis = isVisible(q, answers);
      c.hidden = !vis;
      if (vis) $(".q-idx .n", c).textContent = String(++n);
      syncQuestion(c, q, ctx);
    }
    for (const sec of $$(".sec")) sec.hidden = $$(".card", sec).every((c) => c.hidden);
    syncChrome();
  }

  function syncChrome() {
    const p = progress(spec, answers);
    const left = p.total - p.resolved;
    syncToc(spec, answers, tracker?.get());
    const bar = $("#bar");
    $(".bar-fill", bar).style.transform = `scaleX(${p.total ? p.resolved / p.total : 1})`;
    $(".bar-count", bar).textContent = left
      ? t("progress.count", p.resolved, p.total)
      : t("progress.all");
    $(".bar-hint", bar).textContent = left
      ? t("progress.left", left)
      : t("progress.ready");
    bar.classList.toggle("complete", left === 0);
    document.title = `${left ? `(${left}) ` : "✓ "}${spec.title} — decide`;
  }

  const onCurrent = () => syncToc(spec, answers, tracker?.get());

  // ---- render
  const main = $("#main");
  const numbered = [];
  const cardsFor = (qs) => qs.map((q) => (numbered.push(q), renderQuestion(q, numbered.length, ctx)));
  const loose = spec.questions.filter((q) => !q.section);
  const blocks = [];
  if (loose.length) blocks.push(h("div.sec.loose", {}, cardsFor(loose)));
  for (const sec of spec.sections) {
    const qs = spec.questions.filter((q) => q.section === sec.id);
    if (!qs.length) continue;
    blocks.push(
      h(
        "section.sec",
        { id: `s-${sec.id}` },
        h("header.sec-head", {}, h("h2.sec-title", {}, sec.title), sec.intro && h("div.sec-intro.rich", { html: md(sec.intro, spec.glossary) })),
        cardsFor(qs),
      ),
    );
  }
  const commentFilesBox = h("div.files");
  const paintComment = () => paintFiles(commentFilesBox, s.commentFiles, s.files, (p) => {
    s.commentFiles = s.commentFiles.filter((x) => x !== p);
    paintComment();
    persist();
  });
  const final = h(
    "section.final",
    { id: "final" },
    h("h2.sec-title", {}, t("final.title")),
    h("p.final-sub", {}, t("final.sub")),
    noteArea(t("final.placeholder"), s.comment, ctx, (v) => {
      s.comment = v;
      persist();
    }, (f) => ctx.attach(null, f)),
    h("div.final-tools", {}, h("button.chip.ghost", { type: "button", html: `${icon("clip")}${t("final.attach")}`, onclick: () => pickFiles((f) => ctx.attach(null, f)) })),
    commentFilesBox,
  );
  main.replaceChildren(renderHeader(spec, { ...env, live, listening: round.listening }), ...blocks, final, credit());
  paintComment();
  document.body.classList.toggle("no-toc", spec.questions.length < 4);
  renderToc(spec, env.go);
  renderBar(env);
  tracker = trackCurrent(onCurrent);
  syncAll();

  return {
    id: round.id,
    spec,
    answers,
    ctx,
    card,
    question: (qid) => qById.get(qid),
    comment: () => s.comment,
    payload: (final) => ({ answers: final, comment: s.comment.trim(), attachments: s.commentFiles, elapsedSec: elapsed() }),
    current: () => tracker.get(),
    setCurrent: (qid) => tracker.set(qid),
    // New agent replies clear the "explain" mark: the user can now decide.
    setDialog(next) {
      const answered = new Set(ctx.dialog.filter((d) => d.reply).map((d) => d.id));
      ctx.dialog = next;
      for (const d of next.filter((x) => x.reply && !answered.has(x.id))) toast(t("toast.replied", qById.get(d.qid)?.title || d.qid));
      settleExplain(next);
      syncAll();
      persist();
    },
    firstOpen: () => spec.questions.find((q) => isVisible(q, answers) && !isResolved(q, answers[q.id]))?.id,
    stop: () => tracker.stop(),
  };
}

function renderBar(env) {
  const bar = $("#bar");
  bar.hidden = false;
  bar.replaceChildren(
    h("div.bar-track", {}, h("div.bar-fill")),
    h(
      "div.bar-inner",
      {},
      h("div.bar-status", {}, h("div.bar-count"), h("div.bar-hint")),
      h(
        "div.bar-actions",
        {},
        h("button.btn.ghost.bar-cancel", { type: "button", onclick: env.cancel }, t("bar.cancel")),
        h("button.btn.ghost.bar-next", { type: "button", title: t("bar.nextTitle"), html: `${t("bar.next")}${icon("down")}`, onclick: env.nextOpen }),
        h("button.btn.primary.bar-done", { type: "button", title: t("bar.doneTitle"), html: `${t("bar.done")}<kbd>${shortcut("⌘↵")}</kbd>`, onclick: env.submit }),
      ),
    ),
  );
}

export function hideBar() {
  $("#bar").hidden = true;
  $("#toc").replaceChildren();
  document.body.classList.add("no-toc");
}

function pickFiles(onFile) {
  const input = h("input", { type: "file", multiple: true, hidden: true });
  input.addEventListener("change", () => {
    [...input.files].forEach(onFile);
    input.remove();
  });
  document.body.append(input);
  input.click();
}
