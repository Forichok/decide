import { $, h } from "../dom.js";
import { shortcut, t } from "../i18n.js";
import { eyebrow, roundTabs } from "../header.js";
import { getRound, holdReload, onEvent, sendMessage, submitRound, visualAction } from "../net.js";
import { toast, modalOpen, openModal } from "../overlays.js";
import { hideBar } from "../round.js";
import { captureLabel, evidenceViewer, marker, themeName } from "./evidence.js";
import { visualChoice } from "./choice.js";
import { seconds } from "./playback.js";

const word = key => t("va." + key);
const button = (key, fn, primary = false) => h("button.btn", { class: primary ? "primary" : "", type: "button", onclick: fn }, word(key));
const hasGap = task => !task.manualOnly && Boolean(task.gap || !task.evidence.length || task.evidence.some(e => !e.before || !e.after));
function sceneLink(value) {
  if (!value) return null;
  try {
    const url = new URL(value, location.href);
    if (["http:", "https:"].includes(url.protocol)) return url.href;
  } catch {}
  return null;
}
function anchorFrame(source, mark, title) {
  if (!source) return h("p.va-empty", {}, word("noCapture"));
  const timed = mark?.time != null;
  const src = timed ? source.video : source.image;
  if (!src) return h("p.va-empty", {}, word("noCapture"));
  const frame = timed ? h("video", { src, preload: "auto", controls: true, playsinline: true,
    onloadedmetadata: e => { e.currentTarget.currentTime = mark.time; } }) : h("img", { src, alt: title });
  return h("figure.va-recheck-frame", {}, h("figcaption", {}, title,
    timed && h("small", {}, seconds(mark.time))), h("div.va-plane", {}, frame, !timed && mark?.x != null && marker(mark, "•")));
}
function taskEvidence(task, range, save) {
  const views = task.evidence.map(e => evidenceViewer(task, e, range, save));
  let selected = 0;
  const picker = views.length > 1 && visualChoice(word("capture"), task.evidence.map((e, i) =>
    [String(i), captureLabel(e)]), value => {
      views[selected].stop();
      views[selected].el.hidden = true;
      selected = Number(value);
      views[selected].el.hidden = false;
    }, "va-picker");
  views.forEach((view, i) => { view.el.hidden = i !== 0; });
  return {
    el: [picker, views.map(view => view.el)],
    setMarks(marks) { for (const view of views) view.setMarks(marks); },
    stop() { for (const view of views) view.stop(); }
  };
}
function recheck(reply, tasks, save, renderers) {
  const old = reply.original;
  const task = tasks.find(task => task.id === reply.task);
  const evidence = task?.evidence.find(row => row.id === reply.evidence);
  const side = reply.side || old.side || "after";
  const anchor = reply.time != null || reply.x != null ? reply : old;
  const fixed = button("fixed", () => save({ op: "resolve", ref: reply.ref, value: "fixed" }));
  const open = button("stillOpen", () => save({ op: "resolve", ref: reply.ref, value: "open" }));
  renderers?.push(state => {
    for (const [b, value] of [[fixed, "fixed"], [open, "open"]]) b.setAttribute("aria-pressed", String(state.resolutions[reply.ref] === value));
  });
  return h("article.va-recheck", {}, h("h3", {}, old.text),
    h("p.va-meta", {}, [old.label, old.viewport, themeName(old.theme), word(old.side || "after"), old.revision?.slice(0, 8)].filter(Boolean).join(" · ")),
    h("div.va-recheck-pair", {}, anchorFrame(old, old, word("original")),
      evidence ? anchorFrame(evidence[side], anchor, word("replacement")) : h("p.va-empty", {}, word("noReplacement"))),
    h("p", {}, h("strong", {}, word("response") + " · "), reply.text), save && h("div.va-buttons", {}, fixed, open));
}

export function mountVisual(round, env) {
  const spec = round.spec;
  let state = round.visual, seq = round.seq || 0, active = true, sending = false;
  const renderers = [], viewers = [], pending = new Set();
  const error = h("p.va-error", { role: "alert" });
  function setVisual(next, n) {
    if (!active || !next || (n != null && n < seq)) return;
    state = next; if (n != null) seq = n;
    for (const paint of renderers) paint(state);
  }
  async function save(body) {
    const job = visualAction(round.id, body);
    pending.add(job);
    try {
      const result = await job;
      setVisual(result.visual, result.seq);
      return true;
    } catch (err) { if (active) { toast(err.message); setVisual(state, seq); } return false; }
    finally { pending.delete(job); }
  }
  const toggle = (task, op, key) => {
    const input = h("input", { type: "checkbox", onchange: async () => {
      input.disabled = true;
      await save({ op, task: task.id, value: input.checked });
      input.disabled = false;
    } });
    renderers.push(s => { input.checked = Boolean((op === "check" ? s.checks : s.gaps)[task.id]); });
    return h("label.va-check", {}, input, word(key));
  };
  function requestCapture(task) {
    const id = "visual-capture-" + spec.tasks.indexOf(task);
    const text = (word("requestText") + " " + task.title + ". " + (task.gap || "")).slice(0, 4000);
    const request = button("request", async () => {
      request.disabled = true;
      try {
        await sendMessage(round.id, { id, text });
        request.textContent = word("requested");
      } catch (err) { toast(err.message); request.disabled = false; }
    });
    if (round.thread?.some(m => m.id === id && m.from === "user")) {
      request.textContent = word("requested"); request.disabled = true;
    }
    return request;
  }
  function taskCard(task) {
    const url = sceneLink(task.scene);
    const summary = (key, value) => h("div", {}, h("dt", {}, word(key)), h("dd", {}, value));
    const gallery = taskEvidence(task, spec.range, save);
    viewers.push(gallery);
    renderers.push(s => gallery.setMarks(s.marks));
    return h("article.va-task", { dataset: { task: task.id } }, h("div.va-task-title", {},
      h("h2", {}, task.title)),
      h("dl.va-changes", {}, summary("before", task.beforeText), summary("after", task.afterText)),
      gallery.el,
      hasGap(task) && h("aside.va-gap", {}, h("h3", {}, word("gap")), h("p", {}, task.gap || word("noCapture")),
        h("div.va-buttons", {}, requestCapture(task), toggle(task, "gap", "acceptGap"))),
      h("section.va-try", {}, h("h3", {}, word("try")), h("ol", {}, task.steps.map(step => h("li", {}, step))),
        h("p", {}, h("b", {}, word("expected") + " · "), task.expected),
        h("div.va-buttons", {}, url ? h("a.btn.sm", { href: url, target: "_blank", rel: "noopener noreferrer" }, word("openScene")) :
          h("span.va-meta", {}, word("sceneAbsent")), toggle(task, "check", "checked"))));
  }
  const note = h("textarea.note", { rows: 2, maxlength: 4000, placeholder: word("note"), "aria-label": word("note") });
  const storageKey = "decide.visual.note." + round.id;
  try { note.value = sessionStorage.getItem(storageKey) || ""; } catch {}
  note.oninput = () => { try { sessionStorage.setItem(storageKey, note.value); } catch {} };
  async function submit(verdict) {
    if (sending) return;
    sending = true; approve.disabled = back.disabled = true; error.textContent = "";
    try {
      await Promise.all([...pending]);
      const result = await submitRound(round.id, { verdict, ...(note.value.trim() && { note: note.value.trim() }) });
      try { sessionStorage.removeItem(storageKey); } catch {}
      if (active) env.finished(round.id, result.result);
    } catch (err) { if (active) error.textContent = err.message; }
    finally { sending = false; if (active) setVisual(state, seq); }
  }
  const approve = button("approve", () => submit("approve"), true);
  const back = button("return", () => submit("return"));
  const outstanding = h("p.va-meta");
  renderers.push(s => {
    const gap = spec.tasks.some(task => hasGap(task) && !s.gaps[task.id] && !s.checks[task.id]);
    const manual = spec.tasks.some(task => task.manualOnly && !s.checks[task.id]);
    const open = spec.replies?.some(r => s.resolutions[r.ref] !== "fixed");
    outstanding.textContent = [gap && word("needsGap"), manual && word("needsManual"), open && word("needsRecheck")].filter(Boolean).join(" ");
    approve.disabled = Boolean(sending || gap || manual || open);
    back.disabled = sending;
  });
  const verdict = h("section.va-verdict", {}, h("h2", {}, word("verdict")), note, outstanding, error, h("div.va-buttons", {}, approve, back));
  const range = spec.range;
  const rev = (ref, sha) => h("span", {}, ref && !/^[0-9a-f]{40,64}$/i.test(ref) ? ref + " " : "", h("code", { title: sha }, sha.slice(0, 8)));
  function help() {
    const close = openModal(h("div.help", {}, h("h2.modal-title", {}, t("keys.title")), h("dl.keys", {},
      h("dt", {}, h("kbd", {}, "Tab")), h("dd", {}, word("controlKeys")),
      h("dt", {}, h("kbd", {}, "← ↑ ↓ →")), h("dd", {}, word("arrowKeys")),
      h("dt", {}, h("kbd", {}, shortcut("⌘↵"))), h("dd", {}, word("jumpVerdict"))),
      h("div.modal-actions", {}, h("button.btn.primary", { type: "button", onclick: () => close() }, t("keys.ok")))));
  }
  const title = h("header.top.va-head", {}, eyebrow({ ...env, help }), roundTabs(env),
    h("p.va-kicker", {}, word("title")), h("h1", {}, spec.title),
    h("div.va-revisions", {}, rev(range.baseRef, range.base), h("span", {}, "→"), rev(range.headRef, range.head)),
    h("ul.va-summary", {}, spec.summary.map(line => h("li", {}, line))));
  const cards = spec.tasks.map(taskCard);
  document.body.classList.add("visual-mode");
  hideBar();
  $(".skip-link").textContent = word("jump");
  $("#toc").replaceChildren();
  $("#main").replaceChildren(title, ...(spec.replies?.length || spec.previousNote ? [h("section.va-replies", {}, h("h2", {}, word("recheck")),
    spec.previousNote && h("p", {}, h("b", {}, word("previousNote") + " · "), spec.previousNote),
    (spec.replies || []).map(r => recheck(r, spec.tasks, save, renderers)))] : []), ...cards, verdict);
  document.title = spec.title + " — decide";
  setVisual(state, seq);
  const refresh = async () => { try { const fresh = await getRound(round.id); setVisual(fresh.visual, fresh.seq); } catch {} };
  const off = onEvent("reconnect", refresh);
  holdReload("view", () => pending.size > 0 || sending || Boolean(document.querySelector(".va-compose textarea")?.value));
  return { id: round.id, mode: "visual", spec, setVisual, help, setDialog() {},
    finish() { if (!modalOpen()) { verdict.scrollIntoView({ block: "center" }); note.focus({ preventScroll: true }); } },
    stop() { $(".skip-link").textContent = t("a11y.skip"); active = false; off(); holdReload("view", () => false); for (const v of viewers) v.stop(); document.body.classList.remove("visual-mode"); } };
}

// Delivery updates repaint Done. Retain the open capture and playhead for this settled round.
let lastEvidence;
function completedEvidence(spec, result, stay) {
  if (!spec?.tasks) return null;
  if (lastEvidence?.id === result.round) return lastEvidence.el;
  const body = h("div");
  const viewers = [];
  const details = h("details.va-completed", {}, h("summary", {}, word("revisit")), body);
  details.ontoggle = () => {
    if (!details.open) { for (const viewer of viewers) viewer.stop(); return; }
    stay?.();
    if (body.childElementCount) return;
    for (const reply of spec.replies || []) body.append(recheck(reply, spec.tasks));
    for (const task of spec.tasks) {
      const gallery = taskEvidence(task, result.range || spec.range, null);
      gallery.setMarks(result.marks || []);
      viewers.push(gallery);
      body.append(h("section.va-try", {}, h("h3", {}, task.title), h("p", {}, task.afterText), gallery.el,
        task.gap && h("p.va-gap", {}, task.gap)));
    }
  };
  lastEvidence = { id: result.round, el: details };
  return details;
}

export function visualSummary(result, spec, stay) {
  const title = id => spec?.tasks?.find(task => task.id === id)?.title || id;
  return h("section.sum.va-result", {}, h("h3.sum-h", {}, word(result.verdict === "approve" ? "approved" : "returned")),
    result.note && h("p", {}, result.note),
    result.marks?.length > 0 && h("ol", {}, result.marks.map(m => h("li", {}, h("b", {}, m.text), " · ",
      [title(m.task), m.label, word(m.side), m.time != null ? seconds(m.time) : ""].filter(Boolean).join(" · ")))),
    result.replies?.length > 0 && h("section", {}, h("h4", {}, word("recheck")),
      h("ul", {}, result.replies.map(reply => h("li", {}, h("b", {}, reply.original?.text || spec?.replies?.find(r => r.ref === reply.ref)?.original?.text || reply.ref), " · ",
        word({ fixed: "fixed", open: "stillOpen" }[result.resolutions?.[reply.ref]] || "unchecked"))))),
    ...[["checks", "manual"], ["gaps", "acceptedGaps"]].map(([key, label]) => {
      const names = Object.keys(result[key] || {}).filter(id => result[key][id]).map(title);
      return names.length ? h("p", {}, h("b", {}, word(label)), " · ", names.join(", ")) : null;
    }),
    completedEvidence(spec, result, stay),
    result.digest && h("details.sum-raw", {}, h("summary", {}, t("sum.raw")), h("pre.done-digest", {}, result.digest)));
}
