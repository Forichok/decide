// tune — knobs that drive a live mockup, or a table of derived numbers. Engine side: lib/registry/types/tune.mjs.
// The mockup is the question's `preview`; every change is posted to each frame as
//   postMessage({ type: "decide:knobs", values, units, theme })
// and the bridge the server adds to a served mockup applies it (CSS --knob-<id>, [data-knob=<id>]).
// Answer: { values, preset, snapshots: [{name, values}], picked, candidates, derived }.

import { h } from "../dom.js";
import { cleanValues, defaultValues, derivedOf, isTuned, nextName, tuneAnswer } from "../tune-logic.js";
import { joinParts } from "./shared.js";

export const emptyAnswer = (q) => ({ values: defaultValues(q.knobs ?? []), preset: null, snapshots: [], picked: null, candidates: [], tuned: false });
export const isAnswered = (q, a) => isTuned(a);
export const compact = (q, a) => (isTuned(a) ? tuneAnswer(q, a) : {});

// An answers file read back: values that fit, snapshots that exist, no more than two candidates.
export function check(q, raw) {
  if (!raw || typeof raw !== "object") return {};
  const seed = { values: raw.values, preset: typeof raw.preset === "string" ? raw.preset : null, snapshots: Array.isArray(raw.snapshots) ? raw.snapshots.filter((s) => s && typeof s.name === "string") : [], picked: raw.picked, candidates: Array.isArray(raw.candidates) ? raw.candidates : [] };
  const r = tuneAnswer(q, seed);
  const { derived, ...rest } = r;
  return { ...rest, derived };
}

const shortValue = (k, v) => (k.kind === "toggle" ? (v ? "on" : "off") : k.kind === "image" ? (v ? "picture" : "none") : k.kind === "range" ? `${v}${k.unit ?? ""}` : `"${v}"`);

export function describe(q, r, w) {
  if (!r.values) return "";
  const own = q.knobs.filter((k) => k.kind !== "image" || r.values[k.id]).map((k) => `${k.id} ${shortValue(k, r.values[k.id])}`).join(", ");
  const derived = Object.entries(r.derived ?? {}).filter(([, v]) => v != null).map(([id, v]) => `${id} = ${v}`).join(", ");
  const saved = r.snapshots?.length ? `saved ${r.snapshots.map((s) => s.name).join(", ")}` : "";
  const pick = r.picked ? `picked ${r.picked === "now" ? "the current values" : r.picked}` : "";
  const cand = r.candidates?.length ? `candidates ${r.candidates.join(" and ")}` : "";
  return joinParts(r.preset && `from "${r.preset}"`, own, derived, saved, pick, cand);
}

export function sync(card, q, a) {
  card.querySelector(".tune-host")?._tune?.(a);
}

// ---- small helpers

const WIDTH = { phone: 390, desktop: 1100 };
const HEIGHT = { phone: 640, desktop: 620 };
const fmt = (v, step) => {
  const digits = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
  return Number(v).toFixed(digits);
};
const unitsOf = (q) => Object.fromEntries(q.knobs.filter((k) => k.unit).map((k) => [k.id, k.unit]));

function post(frame, q, values, theme) {
  try {
    frame.contentWindow?.postMessage({ type: "decide:knobs", values, units: unitsOf(q), theme }, "*");
  } catch {
    // A frame that is gone has nothing to hear.
  }
}

// One frame of the mockup at a width and theme, scaled down to fit its box.
function mockFrame(q, ctx, { frame, theme, mini = false }) {
  const w = WIDTH[frame] ?? 390;
  const hh = HEIGHT[frame] ?? 600;
  const el = h("iframe", { src: q.preview.src, sandbox: "allow-scripts", title: q.title, referrerpolicy: "no-referrer", loading: "lazy" });
  el.style.width = `${w}px`;
  el.style.height = `${hh}px`;
  const box = h("div.tn-shot", { dataset: { frame, theme } }, el);
  const fit = () => {
    const bw = box.clientWidth || (mini ? 150 : 320);
    const s = Math.min(1, bw / w);
    el.style.transform = `scale(${s})`;
    box.style.height = `${Math.round(hh * s)}px`;
  };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(fit).observe(box);
  requestAnimationFrame(fit);
  setTimeout(fit, 120);
  let last = null;
  const push = (values) => {
    last = values;
    post(el, q, values, theme);
  };
  el.addEventListener("load", () => {
    fit();
    if (last) {
      post(el, q, last, theme);
      setTimeout(() => last && post(el, q, last, theme), 200);
    }
  });
  // One listener per frame, dropped once a re-render has taken the frame out of the page.
  const onMessage = (e) => {
    if (!el.isConnected) return window.removeEventListener("message", onMessage);
    if (e.source === el.contentWindow && e.data?.type === "decide:knobs-ready" && last) post(el, q, last, theme);
  };
  window.addEventListener("message", onMessage);
  return { box, push, label: `${ctx.t(`tune.${frame}`)} · ${ctx.t(`tune.${theme}`)}` };
}

// ---- colour arithmetic for the arrow keys

function hexToHsl(hex) {
  let s = hex.replace("#", "");
  if (s.length === 3) s = [...s].map((c) => c + c).join("");
  const r = parseInt(s.slice(0, 2), 16) / 255;
  const g = parseInt(s.slice(2, 4), 16) / 255;
  const b = parseInt(s.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let hue = 0;
  let sat = 0;
  if (d) {
    sat = d / (1 - Math.abs(2 * l - 1));
    hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return [hue, sat, l];
}
function hslToHex(hue, sat, l) {
  const c = (1 - Math.abs(2 * l - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}
export function nudgeColor(hex, key) {
  const [hue, sat, l] = hexToHsl(hex);
  if (key === "ArrowLeft") return hslToHex((hue + 355) % 360, sat, l);
  if (key === "ArrowRight") return hslToHex((hue + 5) % 360, sat, l);
  if (key === "ArrowUp") return hslToHex(hue, sat, Math.min(1, l + 0.03));
  return hslToHex(hue, sat, Math.max(0, l - 0.03));
}

// A picture picked from disk, shrunk to at most 640px and kept as a data URL with the answer.
function readImage(file, done) {
  const fr = new FileReader();
  fr.onload = () => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 640 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * s));
      c.height = Math.max(1, Math.round(img.height * s));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      done(c.toDataURL("image/jpeg", 0.82));
    };
    img.src = String(fr.result);
  };
  fr.readAsDataURL(file);
}

// ---- the controls: each returns { el, set(value) }; `change(value)` reports the user's move

function rangeControl(k, change) {
  const span = k.max - k.min;
  const thumb = h("span.tn-thumb");
  const fill = h("span.tn-fill");
  const ticks = h("span.tn-ticks");
  const count = Math.min(40, Math.round(span / k.step));
  for (let i = 0; i <= count; i += 1) ticks.append(h("i", { class: i % 5 === 0 ? "major" : "" }));
  const track = h("div.tn-track", {}, ticks, fill, thumb);
  const readout = h("output.tn-read");
  let value = k.default;
  const set = (v) => {
    value = v;
    const p = ((v - k.min) / span) * 100;
    thumb.style.left = `${p}%`;
    fill.style.width = `${p}%`;
    readout.replaceChildren(fmt(v, k.step), h("small", {}, k.unit ?? ""));
    slider.setAttribute("aria-valuenow", String(v));
    slider.setAttribute("aria-valuetext", `${fmt(v, k.step)}${k.unit ?? ""}`);
  };
  const move = (v) => {
    const snapped = Math.round((v - k.min) / k.step) * k.step + k.min;
    const next = Math.max(k.min, Math.min(k.max, Number(snapped.toFixed(6))));
    if (next !== value) {
      set(next);
      change(next);
    }
  };
  const slider = h("div.tn-slider", {
    role: "slider",
    tabindex: "0",
    "aria-label": k.label,
    "aria-valuemin": String(k.min),
    "aria-valuemax": String(k.max),
    "aria-valuenow": String(k.default),
    onkeydown: (e) => {
      const big = e.shiftKey ? 10 : 1;
      const keys = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
      if (keys[e.key]) move(value + keys[e.key] * k.step * big);
      else if (e.key === "Home") move(k.min);
      else if (e.key === "End") move(k.max);
      else if (e.key === "PageUp") move(value + k.step * 10);
      else if (e.key === "PageDown") move(value - k.step * 10);
      else return;
      e.preventDefault();
      e.stopPropagation();
    },
    onpointerdown: (e) => {
      slider.focus();
      slider.setPointerCapture?.(e.pointerId);
      const at = (ev) => {
        const r = track.getBoundingClientRect();
        move(k.min + Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * span);
      };
      at(e);
      const up = () => {
        slider.removeEventListener("pointermove", at);
        slider.removeEventListener("pointerup", up);
      };
      slider.addEventListener("pointermove", at);
      slider.addEventListener("pointerup", up);
    },
  }, track);
  set(k.default);
  return { el: [readout, slider], set };
}

function toggleControl(k, change, t) {
  let on = false;
  const btn = h("button.tn-switch", { type: "button", role: "switch", "aria-checked": "false", "aria-label": k.label, onclick: () => flip(), onkeydown: (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      const want = e.key === "ArrowRight" || e.key === "ArrowUp";
      if (want !== on) flip();
      e.preventDefault();
      e.stopPropagation();
    }
  } }, h("span.tn-knob"));
  const readout = h("output.tn-read");
  const set = (v) => {
    on = Boolean(v);
    btn.setAttribute("aria-checked", String(on));
    readout.textContent = on ? t("tune.on") : t("tune.off");
  };
  const flip = () => {
    set(!on);
    change(on);
  };
  return { el: [readout, btn], set };
}

function selectControl(k, change) {
  const btns = k.options.map((o) =>
    h("button.tn-opt", { type: "button", role: "radio", "aria-checked": "false", dataset: { id: o.id }, onclick: () => pick(o.id), onkeydown: (e) => {
      const i = k.options.findIndex((x) => x.id === o.id);
      const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (!d) return;
      const next = k.options[(i + d + k.options.length) % k.options.length];
      pick(next.id);
      group.querySelector(`[data-id="${CSS.escape(next.id)}"]`)?.focus();
      e.preventDefault();
      e.stopPropagation();
    } }, o.label),
  );
  const group = h("div.tn-seg", { role: "radiogroup", "aria-label": k.label }, btns);
  const set = (v) => {
    for (const b of btns) {
      const on = b.dataset.id === String(v);
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
  };
  const pick = (id) => {
    set(id);
    change(id);
  };
  return { el: [group], set };
}

function colorControl(k, change) {
  const input = h("input.tn-color", { type: "color", "aria-label": k.label, oninput: (e) => (set(e.target.value), change(e.target.value)) });
  const hex = h("output.tn-read.tn-hex", { tabindex: "0", "aria-label": `${k.label}: arrows change hue and lightness`, onkeydown: (e) => {
    if (!e.key.startsWith("Arrow")) return;
    const v = nudgeColor(input.value, e.key);
    set(v);
    change(v);
    e.preventDefault();
    e.stopPropagation();
  } });
  const set = (v) => {
    const six = /^#[0-9a-f]{6}$/i.test(v) ? v : hslToHex(...hexToHsl(v));
    input.value = six.toLowerCase();
    hex.textContent = six.toLowerCase();
    input.style.setProperty("--c", six);
  };
  return { el: [hex, input], set };
}

function textControl(k, change) {
  const input = h("input.tn-text", { type: "text", maxlength: 500, "aria-label": k.label, oninput: (e) => change(e.target.value) });
  return { el: [input], set: (v) => { if (input.value !== v) input.value = v; } };
}

function imageControl(k, change, t) {
  const thumb = h("span.tn-pic");
  const file = h("input", { type: "file", accept: "image/*", hidden: true, onchange: (e) => {
    const f = e.target.files?.[0];
    if (f) readImage(f, (url) => change(url));
    e.target.value = "";
  } });
  const choose = h("button.tn-btn", { type: "button", onclick: () => file.click() }, t("tune.image"));
  const clear = h("button.tn-btn.ghost", { type: "button", onclick: () => change("") }, t("tune.clear"));
  const set = (v) => {
    thumb.style.backgroundImage = v ? `url("${v}")` : "";
    thumb.classList.toggle("has", Boolean(v));
    clear.hidden = !v;
  };
  return { el: [thumb, choose, clear, file], set };
}

const CONTROLS = { range: rangeControl, toggle: toggleControl, select: selectControl, color: colorControl, text: textControl, image: imageControl };

// ---- the question

export function render(q, ctx) {
  const { t } = ctx;
  const get = () => ctx.answers[q.id];
  const save = (patch, opts) => ctx.set(q.id, { flag: get().flag === "explain" ? "explain" : null, ...patch }, opts);
  const shots = [];
  const root = h("div.tune");
  const derivedBox = h("div.tn-derived");
  const stage = h("div.tn-stage");
  const rack = h("div.tn-rack");
  const slots = h("div.tn-slots");
  const presets = h("div.tn-presets");

  // The stage: one frame per width and theme, all driven by the same values.
  if (q.preview) {
    for (const theme of q.themes) {
      for (const frame of q.frames) {
        const f = mockFrame(q, ctx, { frame, theme });
        shots.push(f);
        stage.append(h("figure.tn-fig", { dataset: { frame } }, f.box, h("figcaption", {}, f.label)));
      }
    }
    stage.style.gridTemplateColumns = q.frames.map((f) => (f === "desktop" ? "minmax(0, 2.4fr)" : "minmax(0, 1fr)")).join(" ");
  } else {
    stage.hidden = true;
  }

  // The rack: a row per knob.
  const controls = {};
  for (const k of q.knobs) {
    const change = (v) => {
      const a = get();
      save({ values: { ...a.values, [k.id]: v }, preset: null, tuned: true }, { quiet: k.kind === "text" || k.kind === "range" });
      paint(get());
    };
    const c = CONTROLS[k.kind](k, change, t);
    controls[k.id] = c;
    rack.append(h("div.tn-row", { dataset: { knob: k.id, kind: k.kind } }, h("span.tn-label", {}, k.label), h("div.tn-ctl", {}, c.el)));
  }

  if (q.presets.length) {
    presets.append(h("span.tn-cap", {}, t("tune.presets")));
    for (const p of q.presets) {
      presets.append(h("button.tn-chip", { type: "button", dataset: { preset: p.name }, onclick: () => {
        save({ values: { ...defaultValues(q.knobs), ...p.values }, preset: p.name, tuned: true });
        paint(get());
      } }, p.name));
    }
    rack.prepend(presets);
  }

  const reset = h("button.tn-btn.ghost", { type: "button", onclick: () => {
    save({ values: defaultValues(q.knobs), preset: null, tuned: true });
    paint(get());
  } }, t("tune.reset"));
  const remember = h("button.tn-btn.primary", { type: "button", dataset: { act: "remember" }, onclick: () => {
    const a = get();
    const snap = { name: nextName(a.snapshots), values: { ...a.values } };
    save({ snapshots: [...a.snapshots, snap], tuned: true });
    paint(get());
  } }, t("tune.remember"));
  const pickNow = h("button.tn-btn", { type: "button", dataset: { act: "pick-now" }, onclick: () => {
    const a = get();
    save({ picked: a.picked === "now" ? null : "now", candidates: [] });
    paint(get());
  } }, t("tune.pickNow"));
  rack.append(h("div.tn-actions", {}, remember, pickNow, reset));

  // The memory slots: saved variants as small frames (or a small table of numbers when there is no mockup).
  const slotEls = new Map();
  const drawSlots = (a) => {
    slotEls.clear();
    slots.replaceChildren();
    slots.hidden = !a.snapshots.length;
    if (!a.snapshots.length) return;
    slots.append(h("div.tn-cap", {}, t("tune.saved")));
    const row = h("div.tn-slotrow");
    for (const s of a.snapshots) {
      const shot = q.preview ? mockFrame(q, ctx, { frame: q.frames[0], theme: q.themes[0], mini: true }) : null;
      shot?.push(s.values);
      const isPicked = a.picked === s.name;
      const isCand = a.candidates.includes(s.name);
      const body = shot
        ? shot.box
        : h("dl.tn-mini", {}, ...Object.entries(derivedOf(q, s.values)).flatMap(([id, v]) => [h("dt", {}, q.derived.find((d) => d.id === id)?.label ?? id), h("dd", {}, v == null ? "–" : String(+v.toFixed(2)))]));
      row.append(
        h("div.tn-slot", { dataset: { slot: s.name }, class: `${isPicked ? "picked" : ""} ${isCand ? "cand" : ""}` },
          h("div.tn-slot-head", {}, h("b", {}, s.name), h("button.tn-x", { type: "button", "aria-label": t("tune.remove"), onclick: () => {
            const cur = get();
            save({ snapshots: cur.snapshots.filter((x) => x.name !== s.name), candidates: cur.candidates.filter((n) => n !== s.name), picked: cur.picked === s.name ? null : cur.picked });
            paint(get());
          } }, "×")),
          h("button.tn-load", { type: "button", title: t("tune.load"), onclick: () => {
            save({ values: { ...s.values }, preset: null, tuned: true });
            paint(get());
          } }, body),
          h("div.tn-slot-act", {},
            h("button.tn-chip", { type: "button", "aria-pressed": String(isPicked), dataset: { act: "pick" }, onclick: () => {
              const cur = get();
              save({ picked: cur.picked === s.name ? null : s.name, candidates: [] });
              paint(get());
            } }, t("tune.pick")),
            h("button.tn-chip", { type: "button", "aria-pressed": String(isCand), dataset: { act: "candidate" }, onclick: () => {
              const cur = get();
              const has = cur.candidates.includes(s.name);
              const next = has ? cur.candidates.filter((n) => n !== s.name) : [...cur.candidates, s.name].slice(-2);
              save({ candidates: next, picked: null });
              paint(get());
            } }, t("tune.candidate")),
          ),
        ),
      );
    }
    slots.append(row);
  };

  // Numbers: derived values as a table, recomputed as a knob moves.
  const drawDerived = (a) => {
    if (!q.derived.length) return void (derivedBox.hidden = true);
    derivedBox.hidden = false;
    const now = derivedOf(q, a.values);
    const rows = q.derived.map((d) => {
      const v = now[d.id];
      const cols = a.snapshots.map((s) => derivedOf(q, s.values)[d.id]);
      return h("tr", { dataset: { derived: d.id } }, h("th", {}, d.label), h("td.now", {}, v == null ? "–" : String(+v.toFixed(2))), cols.map((c) => h("td", {}, c == null ? "–" : String(+c.toFixed(2)))));
    });
    derivedBox.replaceChildren(h("table.tn-table", {}, h("thead", {}, h("tr", {}, h("th", {}, t("tune.results")), h("th", {}, t("tune.now")), a.snapshots.map((s) => h("th", {}, s.name)))), h("tbody", {}, rows)));
  };

  let lastSnaps = "";
  function paint(a) {
    for (const k of q.knobs) controls[k.id].set(a.values[k.id]);
    for (const s of shots) s.push(a.values);
    for (const b of presets.querySelectorAll(".tn-chip")) b.setAttribute("aria-pressed", String(b.dataset.preset === a.preset));
    pickNow.setAttribute("aria-pressed", String(a.picked === "now"));
    const key = JSON.stringify([a.snapshots, a.picked, a.candidates]);
    if (key !== lastSnaps) {
      lastSnaps = key;
      drawSlots(a);
    }
    drawDerived(a);
  }

  root.append(stage, h("div.tn-side", {}, rack, slots), derivedBox);
  root._tune = paint;
  const host = h("div.tune-host");
  host.append(root);
  host._tune = paint;
  paint(get());
  return host;
}
