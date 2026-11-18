import { h } from "../dom.js";
import { t } from "../i18n.js";
import { openModal } from "../overlays.js";
import { visualChoice } from "./choice.js";
import { playback, seconds } from "./playback.js";

const sides = ["before", "after"];
const clamp = value => Math.min(1, Math.max(0, value));
const word = name => t("va." + name);
const action = (key, click) => h("button.btn.sm", { type: "button", onclick: click }, word(key));
const point = (event, el) => {
  const rect = el.getBoundingClientRect();
  return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
};
export function themeName(theme) {
  return ["light", "dark", "system"].includes(theme) ? t("settings4.theme." + theme) : theme;
}
export function captureLabel(evidence) {
  const label = evidence.label.toLocaleLowerCase();
  const theme = themeName(evidence.theme);
  const named = [theme, evidence.theme].some(name => name && label.includes(name.toLocaleLowerCase()));
  return [evidence.label, evidence.viewport, !named && theme].filter(Boolean).join(" · ");
}
function selection(first, last) {
  const w = Math.abs(last.x - first.x), h = Math.abs(last.y - first.y);
  return w > .008 && h > .008 ? { x: Math.min(first.x, last.x), y: Math.min(first.y, last.y), w, h } : first;
}
export function marker(mark, label) {
  const region = mark.w > 0 && mark.h > 0;
  const el = h("span.va-pin", { class: region ? "area" : "", "aria-hidden": "true", title: mark.text || "" }, label);
  el.style.left = (mark.x * 100) + "%"; el.style.top = (mark.y * 100) + "%";
  if (region) { el.style.width = (mark.w * 100) + "%"; el.style.height = (mark.h * 100) + "%"; }
  return el;
}

function compose(anchor, task, evidence, save, finished) {
  const note = h("textarea.note", { rows: 3, maxlength: 4000, "aria-label": word("remark"), "data-autofocus": true });
  const submit = action("saveMark", async () => {
    if (!note.value.trim() || submit.disabled) return;
    submit.disabled = true;
    if (await save({ op: "mark", task: task.id, evidence: evidence.id, ...anchor, text: note.value.trim() })) close();
    else submit.disabled = false;
  });
  submit.disabled = true;
  note.oninput = () => { submit.disabled = !note.value.trim(); };
  const close = openModal(h("div.va-compose", {}, h("h2.modal-title", {}, word("rightHere")),
    h("p.va-meta", {}, [evidence.label, word(anchor.side), anchor.time != null ? seconds(anchor.time) : null].filter(Boolean).join(" · ")),
    note, h("div.modal-actions", {}, action("cancel", () => close()), submit)), { onClose: finished });
}

export function evidenceViewer(task, evidence, range, save) {
  const figures = {}, panes = {}, planes = {}, layers = {}, clips = [];
  const has = kind => sides.some(side => evidence[side]?.[kind]);
  const readOnly = !save;
  let kind = has("image") ? "image" : "video";
  let wipe = false, zoom = 1, expanded = "", marking = false, syncing = false;
  let marks = [], player;
  const view = h("div.va-compare");
  const hint = h("p.va-meta", { hidden: true }, word("placeHint"));
  const controls = h("div.va-controls");
  const choose = (key, fn) => action(key, () => {
    const visible = panes[expanded || "after"];
    const x = (visible.scrollLeft + visible.clientWidth / 2) / (visible.scrollWidth || 1);
    const y = (visible.scrollTop + visible.clientHeight / 2) / (visible.scrollHeight || 1);
    fn(); update();
    for (const pane of Object.values(panes)) {
      if (!pane.clientWidth) continue;
      pane.scrollLeft = x * pane.scrollWidth - pane.clientWidth / 2;
      pane.scrollTop = y * pane.scrollHeight - pane.clientHeight / 2;
    }
  });
  const photos = choose("photo", () => { kind = "image"; player?.pause(); });
  const motion = choose("video", () => { kind = "video"; marking = false; });
  const split = choose("split", () => { wipe = false; expanded = ""; });
  const dividerMode = choose("wipe", () => { wipe = true; expanded = ""; });
  const markButton = choose("rightHere", () => { marking = !marking; if (marking && wipe) wipe = false; });
  const zoomControl = visualChoice(word("zoom"), [1, 1.5, 2, 3].map(n => [String(n), (n * 100) + "%"]), value => {
    zoom = Number(value); update();
  }, "va-zoom");
  const divider = h("input.va-divider", { type: "range", min: 0, max: 100, value: 50, "aria-label": word("divider") });
  divider.oninput = () => view.style.setProperty("--cut", divider.value + "%");
  const bar = (...items) => h("div.va-buttons", {}, items);
  const sameImages = sides.every(side => evidence[side]?.image);
  controls.append(bar(has("image") && has("video") ? [photos, motion] : []),
    bar(sameImages ? [split, dividerMode] : [], zoomControl, markButton));
  const list = h("ol.va-marks");
  const expandButtons = {}, timeButtons = {};
  function addMark(side, anchor) {
    player?.pause();
    compose({ side, ...anchor }, task, evidence, save, () => { marking = false; update(); });
  }
  for (const side of sides) {
    const asset = evidence[side] || {};
    const layer = layers[side] = h("div.va-marks-layer");
    const img = asset.image && h("img", { src: asset.image, alt: evidence.label + " · " + word(side), draggable: "false", loading: "lazy" });
    const video = asset.video && h("video", { src: asset.video, playsinline: true, preload: "metadata", "aria-label": evidence.label + " · " + word(side) });
    if (video) { video.muted = true; clips.push({ side, video, cue: asset.cue || 0 }); }
    const plane = planes[side] = h("div.va-plane", {}, img, video, layer);
    const status = h("p.va-empty", { hidden: true }, word("loadFailed"));
    for (const media of [img, video].filter(Boolean)) media.addEventListener("error", () => { status.hidden = false; });
    let start = null, ghost = null, cursor = { x: .5, y: .5 };
    const clear = () => { start = null; ghost?.remove(); ghost = null; };
    const preview = anchor => { ghost?.remove(); ghost = marker(anchor, "+"); plane.append(ghost); };
    plane.onpointerdown = e => {
      if (!marking || kind !== "image" || !img || e.button !== 0) return;
      e.preventDefault(); start = point(e, plane); plane.setPointerCapture(e.pointerId); preview(start);
    };
    plane.onpointermove = e => { if (start) preview(selection(start, point(e, plane))); };
    plane.onpointercancel = clear;
    plane.onpointerup = e => {
      if (!start) return;
      const anchor = selection(start, point(e, plane)); clear(); addMark(side, anchor);
    };
    plane.onkeydown = e => {
      if (!marking || !img) return;
      const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (move) { e.preventDefault(); cursor = { x: clamp(cursor.x + move[0] * .025), y: clamp(cursor.y + move[1] * .025) }; preview(cursor); }
      else if (["Enter", " "].includes(e.key)) { e.preventDefault(); clear(); addMark(side, cursor); }
    };
    const pane = panes[side] = h("div.va-scroll", {}, plane);
    pane.onscroll = () => {
      if (syncing) return;
      const other = panes[side === "before" ? "after" : "before"];
      if (!other?.clientWidth || !pane.clientWidth) return;
      syncing = true;
      other.scrollLeft = pane.scrollLeft; other.scrollTop = pane.scrollTop;
      syncing = false;
    };
    const expand = expandButtons[side] = choose("expand", () => { expanded = expanded === side ? "" : side; wipe = false; });
    const stamp = timeButtons[side] = action(side === "after" ? "markAfter" : "markBefore", () => addMark(side, { time: video.currentTime }));
    const missing = h("p.va-empty", {}, word("noCapture"));
    const fig = figures[side] = h("figure.va-side", { dataset: { side } },
      h("figcaption", {}, h("b", {}, word(side)), h("code", { title: range[side === "before" ? "base" : "head"] }, (range[side === "before" ? "base" : "head"] || "").slice(0, 8)), expand),
      pane, missing, status, stamp, asset.unmatched && h("p.va-unmatched", {}, word("unmatched") + " · " + asset.unmatched));
    view.append(fig);
  }
  view.append(divider);
  if (clips.length) player = playback(clips);
  const block = h("section.va-evidence", {}, h("div.va-evidence-head", {}, h("h3", {}, evidence.label),
    h("details.va-info", {}, h("summary", {}, [evidence.viewport, themeName(evidence.theme)].join(" · ")),
      h("p.va-meta", {}, [evidence.fixture, evidence.state].join(" · ")))),
    controls, hint, view, player?.el, list);
  function update() {
    const activeWipe = wipe && kind === "image" && !expanded;
    view.classList.toggle("wipe", activeWipe); view.classList.toggle("one", Boolean(expanded));
    divider.hidden = !activeWipe;
    split.hidden = dividerMode.hidden = kind !== "image";
    zoomControl.hidden = kind !== "image";
    markButton.hidden = readOnly || kind !== "image";
    hint.hidden = !marking;
    for (const [b, state] of [[photos, kind === "image"], [motion, kind === "video"], [split, !activeWipe && !expanded], [dividerMode, activeWipe], [markButton, marking]]) b.setAttribute("aria-pressed", String(state));
    if (player) player.el.hidden = kind !== "video";
    for (const side of sides) {
      const fig = figures[side], plane = planes[side], asset = evidence[side];
      fig.hidden = Boolean(expanded && expanded !== side);
      panes[side].hidden = !asset?.[kind]; fig.querySelector(".va-empty").hidden = Boolean(asset?.[kind]);
      for (const media of plane.querySelectorAll("img, video")) media.hidden = media.tagName !== (kind === "video" ? "VIDEO" : "IMG");
      plane.style.width = (kind === "image" ? zoom * 100 : 100) + "%";
      plane.classList.toggle("drawing", marking && Boolean(asset?.image));
      plane.tabIndex = marking && asset?.image ? 0 : -1;
      if (plane.tabIndex === 0) { plane.setAttribute("role", "button"); plane.setAttribute("aria-label", word(side) + " · " + word("rightHere")); }
      else { plane.removeAttribute("role"); plane.removeAttribute("aria-label"); }
      layers[side].hidden = kind !== "image";
      timeButtons[side].hidden = readOnly || kind !== "video" || !asset?.video;
      expandButtons[side].textContent = word(expanded === side ? "collapse" : "expand");
      expandButtons[side].setAttribute("aria-label", word(expanded === side ? "collapse" : "expand") + " · " + word(side));
    }
  }
  function setMarks(all) {
    marks = all.filter(m => m.task === task.id && m.evidence === evidence.id);
    for (const side of sides) layers[side].replaceChildren(...marks.flatMap((m, i) => m.side === side && m.time == null && m.x != null ? [marker(m, i + 1)] : []));
    list.hidden = !marks.length;
    list.replaceChildren(...marks.map((m, i) => h("li", {}, h("button.va-mark-row", { type: "button", onclick: () => {
      kind = m.time == null ? "image" : "video"; expanded = m.side; marking = false; update();
      if (m.time != null) player?.go(m.side, m.time);
      else Array.from(layers[m.side].children).find(el => el.textContent === String(i + 1))?.scrollIntoView({ block: "nearest", inline: "center" });
    } }, h("b", {}, i + 1), h("span", {}, m.text), h("small", {}, [word(m.side), m.time != null ? seconds(m.time) : ""].filter(Boolean).join(" · "))))));
  }
  update(); setMarks([]);
  return { el: block, setMarks, stop: () => player?.pause() };
}
