// round.js — one round on screen: answer state, the ctx object the question
// widgets talk to, sections, the closing comment block and the bottom bar.

import { h, icon, $, $$ } from "./dom.js";
import { shortcut, t } from "./i18n.js";
import { md } from "./md.js";
import { renderMedia } from "./media.js";
import { renderQuestion, syncQuestion } from "./question.js";
import { noteArea, paintFiles } from "./extras.js";
import { credit, renderHeader } from "./header.js";
import { renderToc, syncToc, trackCurrent } from "./nav.js";
import { openLightbox, openZoom, toast } from "./overlays.js";
import { emptyAnswer, isResolved, isVisible, progress, withRecommendation } from "./logic.js";
import { askAgent, holdReload, uploadFile } from "./net.js";

const MAX_UPLOAD = 24 * 1024 * 1024;

// Where the reader was on this round (sessionStorage: survives a reload of this tab, nothing else).
const SCROLL_KEY = (id) => `decide-scroll:${id}`;

// env.store: the page's store (store.js). Answers, notes and flags are saved one question at a time through
// it; the round-level part (closing comment, its files, time spent) is the round's draft.
export function mountRound(data, env) {
  const store = env.store;
  // The store takes the round's answers, notes and flags (and its seq), with this tab's unsaved writes on top.
  const round = store.adopt(data);
  const { spec } = round;
  const draft = round.draft || {};
  // A round from before 3.0 keeps every answer in its draft; the server reads those into `answers` too.
  const saved = round.answers || draft.answers || {};
  const answers = {};
  for (const q of spec.questions) answers[q.id] = { ...emptyAnswer(q), ...(saved[q.id] || {}) };
  const loadedAt = Date.now();
  const s = {
    comment: draft.comment || "",
    commentFiles: draft.commentFiles || [],
    files: new Map([...(draft.files || []), ...Object.entries(round.files || {})]),
    ui: { note: new Set(), other: new Set(), ask: new Set(), askDraft: noteMap((qid, text) => store.saveNote(round.id, qid, text).catch(() => {})) },
  };
  // A question being written for the agent comes back with its box open.
  for (const [qid, text] of Object.entries(round.notes || {})) {
    if (!text || !spec.questions.some((q) => q.id === qid)) continue;
    s.ui.askDraft.load(qid, text);
    s.ui.ask.add(qid);
  }
  const live = Boolean(round.live);
  // Nothing on this view lives only in page memory: what is typed is saved, and the store holds a reload
  // until it is on disk. This replaces the holder of the view before (a swipe round's).
  holdReload("view", () => false);
  // Live "explain" means "waiting for the agent": drop it once every ask on the question has a reply.
  // Returns the questions it changed.
  const settleExplain = (dialog) => {
    const changed = [];
    for (const [qid, a] of Object.entries(answers)) {
      const asks = dialog.filter((d) => d.qid === qid);
      if (a.flag === "explain" && asks.length && asks.every((d) => d.reply)) {
        a.flag = null;
        changed.push(qid);
      }
    }
    return changed;
  };
  if (live) settleExplain(round.dialog || []);
  const qById = new Map(spec.questions.map((q) => [q.id, q]));
  const card = (qid) => document.getElementById(`q-${qid}`);
  let tracker = null;
  const elapsed = () => Math.round((draft.elapsedSec || 0) + (Date.now() - loadedAt) / 1000);

  const ctx = {
    // The type modules (ui/js/types) load under Node, so the page's own strings and media renderer come in here.
    t,
    renderMedia,
    answers,
    live,
    // An exported file has no daemon to keep attachments: no file buttons, no mark-up.
    offline: Boolean(env.offline),
    dialog: round.dialog || [],
    glossary: spec.glossary,
    ui: s.ui,
    files: s.files,
    // For ready answers (quick.js): the store, the round, and the flags kept beside the answers
    // ({qid: {flag: "none" | "later", revisit?, note?}}).
    store,
    roundId: round.id,
    get flags() {
      return store.state(round.id).flags;
    },
    setFlag(qid, flag, extra = {}) {
      const saving = store.saveFlag(round.id, qid, flag, extra);
      syncAll();
      return saving;
    },
    set(qid, patch, { quiet = false } = {}) {
      Object.assign(answers[qid], patch);
      if (quiet) syncOne(qid);
      else syncAll();
      persist(qid);
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
          persist(qid);
        } else {
          s.commentFiles = [...s.commentFiles, up.path];
          paintComment();
          persistRound();
        }
        toast(t("upload.done", up.name));
      } catch (e) {
        toast(t(e.offline ? "upload.offline" : "upload.failed"));
      }
    },
    // Notes pinned on one mockup of this question (see media.js pinLayer).
    pins(qid, src) {
      return {
        listEl: h("ol.pv-list", { hidden: true }),
        list: () => (answers[qid].pins || []).filter((p) => p.src === src),
        add(pin) {
          answers[qid].pins = [...(answers[qid].pins || []), { src, ...pin }];
          syncOne(qid);
          persist(qid);
        },
        remove(pin) {
          answers[qid].pins = answers[qid].pins.filter((p) => p !== pin);
          syncOne(qid);
          persist(qid);
        },
      };
    },
    removeFile(qid, path) {
      answers[qid].attachments = answers[qid].attachments.filter((p) => p !== path);
      syncOne(qid);
      persist(qid);
    },
    applyRecommended(qid) {
      const q = qById.get(qid);
      Object.assign(answers[qid], withRecommendation(q, answers[qid]), { flag: null });
      syncAll();
      persist(qid);
    },
    toggleFlag(qid, flag) {
      const a = answers[qid];
      if (flag === "explain" && live && a.flag !== "explain") return ctx.ask(qid);
      a.flag = a.flag === flag ? null : flag;
      if (a.flag === "explain") s.ui.note.add(qid);
      syncAll();
      persist(qid);
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
        persist(qid);
      } catch {
        toast(t("ask.offline"));
      }
    },
    lightbox: (images, i, qid, opts = {}) => openLightbox(images, i, { ...opts, onAnnotate: env.offline ? undefined : (file) => ctx.attach(qid || null, file) }),
    canMark: !env.offline,
    zoom: openZoom,
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

  // One question's answer; a failure the store cannot retry (the round is finished) shows on the next state.
  function persist(qid) {
    store.saveAnswer(round.id, qid, answers[qid]).catch(() => {});
  }

  function persistRound() {
    store.saveDraft(round.id, { comment: s.comment, commentFiles: s.commentFiles, elapsedSec: elapsed() }).catch(() => {});
  }

  // Another tab (or this one before a reload) changed a question: the card shows it, unless the user is
  // typing in it right now; then only its state is synced and their text stays.
  function onRemote(state, changed) {
    for (const qid of changed) {
      const q = qById.get(qid);
      if (!q) continue;
      const a = answers[qid];
      for (const k of Object.keys(a)) delete a[k];
      Object.assign(a, emptyAnswer(q), state.answers[qid] || {});
      const text = state.notes[qid] || "";
      s.ui.askDraft.load(qid, text);
      if (text) s.ui.ask.add(qid);
      const c = card(qid);
      if (c && !c.contains(document.activeElement)) {
        const fresh = renderQuestion(q, Number($(".q-idx .n", c)?.textContent) || 1, ctx);
        c.replaceChildren(...fresh.childNodes);
        c.className = fresh.className;
      }
    }
    syncAll();
  }
  const unsubscribe = store.subscribe(round.id, onRemote);

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
    persistRound();
  });
  const final = h(
    "section.final",
    { id: "final" },
    h("h2.sec-title", {}, t("final.title")),
    h("p.final-sub", {}, t("final.sub")),
    noteArea(t("final.placeholder"), s.comment, ctx, (v) => {
      s.comment = v;
      persistRound();
    }, (f) => ctx.attach(null, f)),
    !env.offline && h("div.final-tools", {}, h("button.chip.ghost", { type: "button", html: `${icon("clip")}${t("final.attach")}`, onclick: () => pickFiles((f) => ctx.attach(null, f)) })),
    commentFilesBox,
  );
  main.replaceChildren(renderHeader(spec, { ...env, live, listening: round.listening }), ...blocks, final, credit());
  paintComment();
  document.body.classList.toggle("no-toc", spec.questions.length < 4);
  renderToc(spec, env.go);
  renderBar(env);
  const stopStatus = showSaving(store);
  tracker = trackCurrent(onCurrent);
  syncAll();
  const stopScroll = keepScroll(round.id, () => spec.questions.map((q) => card(q.id)).filter((c) => c && !c.hidden));

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
      const settled = settleExplain(next);
      syncAll();
      for (const qid of settled) persist(qid);
    },
    firstOpen: () => spec.questions.find((q) => isVisible(q, answers) && !isResolved(q, answers[q.id]))?.id,
    stop: () => {
      tracker.stop();
      unsubscribe();
      stopStatus();
      stopScroll();
    },
  };
}

// The unsent question to the agent, per question: a Map whose set and delete also save the text as the
// question's note (dialog.js writes it as the user types); load() takes a saved text without saving it again.
function noteMap(save) {
  const map = new Map();
  return Object.assign(map, {
    set(qid, text) {
      const before = Map.prototype.get.call(map, qid) || "";
      Map.prototype.set.call(map, qid, text);
      if ((text || "") !== before) save(qid, text || "");
      return map;
    },
    delete(qid) {
      const had = Map.prototype.get.call(map, qid);
      const out = Map.prototype.delete.call(map, qid);
      if (had) save(qid, "");
      return out;
    },
    load(qid, text) {
      if (text) Map.prototype.set.call(map, qid, text);
      else Map.prototype.delete.call(map, qid);
    },
  });
}

// "Saved" / "Saving…" / "Not saved, retrying" in the bar, from the store's status. Empty until the first write.
function showSaving(store) {
  const el = $(".bar-save");
  let wrote = store.status() !== "saved";
  const paint = (status) => {
    if (status !== "saved") wrote = true;
    if (!el) return;
    el.textContent = wrote ? t(`save.${status}`) : "";
    el.dataset.status = status;
  };
  paint(store.status());
  return store.onStatus(paint);
}

// The card at the top of the screen and how far it sits from the top, kept per round for this tab, and put
// back when the round is shown again (a reload included). Pictures that load late move nothing: the
// position is a card, not a pixel count.
function keepScroll(id, cards) {
  let storage = null;
  try {
    storage = window.sessionStorage;
    history.scrollRestoration = "manual";
  } catch {}
  const read = () => {
    try {
      return JSON.parse(storage?.getItem(SCROLL_KEY(id)) || "null");
    } catch {
      return null;
    }
  };
  const save = () => {
    const top = cards().find((c) => c.getBoundingClientRect().bottom > 80);
    try {
      storage?.setItem(SCROLL_KEY(id), JSON.stringify(top ? { qid: top.dataset.qid, offset: Math.round(top.getBoundingClientRect().top), y: Math.round(scrollY) } : { y: Math.round(scrollY) }));
    } catch {}
  };
  const was = read();
  let restoring = Boolean(was);
  if (was) {
    // After the caller's own scroll to the top, and once more when late layout settled.
    const put = () => {
      const c = was.qid && document.getElementById(`q-${was.qid}`);
      if (c && !c.hidden) window.scrollBy(0, c.getBoundingClientRect().top - (was.offset || 0));
      else window.scrollTo(0, was.y || 0);
    };
    requestAnimationFrame(() => {
      put();
      setTimeout(() => {
        put();
        restoring = false;
      }, 300);
    });
  }
  let queued = false;
  const onScroll = () => {
    if (restoring || queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      save();
    });
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("pagehide", save);
  return () => {
    if (!restoring) save();
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("pagehide", save);
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
      h("div.bar-status", {}, h("div.bar-count"), h("div.bar-hint"), h("div.bar-save", { role: "status", "aria-live": "polite" })),
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
