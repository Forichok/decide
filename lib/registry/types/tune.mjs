// tune — a panel of knobs the agent declared, driving a live mockup (or a table of derived numbers).
// Page side: ui/js/types/tune.js. The mockup is the common `preview` field; the page posts the values to it.

import { check } from "../../../ui/js/formula.js";
import { cleanValues } from "../../../ui/js/tune-logic.js";
import { any, arrayOf, number, object, oneOf, string } from "../shared.mjs";

export const KNOB_KINDS = ["range", "toggle", "select", "color", "text", "image"];
export const FRAMES = ["phone", "desktop"];
export const THEMES = ["light", "dark"];
const ID = /^[A-Za-z][A-Za-z0-9_]*$/;
const COLOR = /^#[0-9a-f]{3,8}$/i;

const optionOf = (o, i) => {
  if (typeof o === "string" || typeof o === "number") return { id: String(o), label: String(o) };
  if (o && typeof o === "object") {
    const id = String(o.id ?? o.value ?? o.label ?? i);
    return { id, label: String(o.label ?? id) };
  }
  return null;
};

// One knob as the page reads it; null when it cannot work (the reason goes to `add`).
export function normalizeKnob(raw, i, add, where) {
  if (!raw || typeof raw !== "object") return add("error", where, "a knob is an object"), null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!ID.test(id)) return add("error", where, `knob ${i + 1} needs an id of letters, digits and _ (it becomes --knob-<id>)`), null;
  const kind = raw.kind ?? raw.type ?? "range";
  if (!KNOB_KINDS.includes(kind)) return add("error", where, `knob "${id}": kind "${kind}" is not one of ${KNOB_KINDS.join(", ")}`), null;
  const k = { id, label: typeof raw.label === "string" && raw.label ? raw.label : id, kind };
  const def = raw.default !== undefined ? raw.default : raw.value;
  if (kind === "range") {
    const min = Number.isFinite(raw.min) ? raw.min : 0;
    let max = Number.isFinite(raw.max) ? raw.max : 10;
    if (max <= min) {
      add("error", where, `knob "${id}": max must be above min`);
      max = min + 1;
    }
    const span = max - min;
    const step = Number.isFinite(raw.step) && raw.step > 0 ? raw.step : span > 20 ? 1 : span >= 5 ? 0.5 : 0.01;
    Object.assign(k, { min, max, step, unit: typeof raw.unit === "string" ? raw.unit : "" });
    k.default = Number.isFinite(def) ? Math.max(min, Math.min(max, def)) : min;
  } else if (kind === "toggle") {
    k.default = def === true;
  } else if (kind === "select") {
    k.options = (Array.isArray(raw.options) ? raw.options : []).map(optionOf).filter(Boolean);
    if (!k.options.length) add("error", where, `knob "${id}": a select needs options`);
    k.default = k.options.some((o) => o.id === String(def)) ? String(def) : (k.options[0]?.id ?? "");
  } else if (kind === "color") {
    k.default = typeof def === "string" && COLOR.test(def) ? def : "#3b6cff";
  } else {
    k.default = typeof def === "string" ? def : "";
  }
  return k;
}

export default {
  name: "tune",
  summary: "A panel of knobs (range, toggle, select, color, text, image) that drives a live mockup in `preview` or a table of derived numbers; the answer is the values.",
  fields: {
    knobs: arrayOf(
      object(
        "One knob.",
        {
          id: string("Letters, digits, _. Becomes --knob-<id> and data-knob=<id> in the mockup."),
          label: string("The words on the control."),
          kind: oneOf(KNOB_KINDS, "The control. Default range."),
          type: string("The older spelling of kind."),
          min: number("range: lowest value. Default 0."),
          max: number("range: highest value. Default 10."),
          step: number("range: step. Default from the span."),
          unit: string("range: shown after the value, and added to --knob-<id>."),
          options: arrayOf(any("An id string, or {id, label}."), "select: the choices."),
          default: any("The starting value.", { brief: "The starting value" }),
          value: any("The older spelling of default.", { brief: "The starting value" }),
        },
        { open: true },
      ),
      "The controls.",
      { minItems: 1 },
    ),
    presets: arrayOf(
      object(
        "A named starting point.",
        { name: string("Its name."), values: object("knob id: value; knobs left out keep their defaults.", undefined, { open: true }) },
        { open: true },
      ),
      "Two to four named starting points.",
      { orOne: true },
    ),
    frames: arrayOf(string("phone or desktop."), "Widths shown side by side. Default phone only.", { orOne: true }),
    themes: arrayOf(string("light or dark."), "Themes shown side by side. Default light only.", { orOne: true }),
    derived: arrayOf(
      object("A number computed from the knobs.", {
        id: string("Its name; later formulas may use it."),
        label: string("The words in the table."),
        formula: string("Arithmetic over knob ids and earlier derived ids: price * clients * (1 - churn)."),
      }),
      "Numbers shown as a table, recomputed as a knob moves.",
      { orOne: true },
    ),
  },
  normalize(q, ctx) {
    const rawKnobs = Array.isArray(ctx.raw.knobs) ? ctx.raw.knobs : [];
    const seen = new Set();
    q.knobs = [];
    rawKnobs.forEach((r, i) => {
      const k = normalizeKnob(r, i, ctx.add, ctx.where);
      if (!k) return;
      if (seen.has(k.id)) return ctx.add("error", ctx.where, `knob id "${k.id}" is used twice`);
      seen.add(k.id);
      q.knobs.push(k);
    });
    if (!q.knobs.length) ctx.add("error", ctx.where, "a tune question needs at least one knob");
    q.presets = (Array.isArray(ctx.raw.presets) ? ctx.raw.presets : []).flatMap((p, i) => {
      if (!p || typeof p !== "object" || !p.values || typeof p.values !== "object") return [];
      return [{ name: String(p.name ?? p.label ?? p.id ?? `Preset ${i + 1}`), values: cleanValues(q.knobs, p.values) }];
    });
    const pick = (v, allowed, dflt) => {
      const a = [...new Set([].concat(v ?? []).map((x) => (x === "mobile" ? "phone" : x)).filter((x) => allowed.includes(x)))];
      return a.length ? a : dflt;
    };
    q.frames = pick(ctx.raw.frames, FRAMES, ["phone"]);
    q.themes = pick(ctx.raw.themes, THEMES, ["light"]);
    const known = new Set(q.knobs.map((k) => k.id));
    q.derived = [];
    for (const d of [].concat(ctx.raw.derived ?? [])) {
      if (!d || typeof d !== "object" || typeof d.id !== "string" || typeof d.formula !== "string") {
        ctx.add("error", ctx.where, "a derived value needs id and formula");
        continue;
      }
      const r = check(d.formula, [...known]);
      if (!r.ok) {
        ctx.add("error", ctx.where, `derived "${d.id}": ${r.error}`);
        continue;
      }
      known.add(d.id);
      q.derived.push({ id: d.id, label: typeof d.label === "string" && d.label ? d.label : d.id, formula: d.formula });
    }
  },
  lint(q, add) {
    if (!q.preview && !q.derived.length) add("warn", `"${q.id}" has no preview and no derived values: the knobs drive nothing`);
    if (q.presets.length === 1) add("warn", `"${q.id}": give two to four presets, or none`);
  },
  example: {
    id: "price",
    type: "tune",
    title: "Where should the price sit?",
    knobs: [
      { id: "price", label: "Price", kind: "range", min: 5, max: 50, step: 1, unit: " \u20ac", default: 20 },
      { id: "clients", label: "Clients", kind: "range", min: 10, max: 500, step: 10, default: 100 },
    ],
    derived: [{ id: "revenue", label: "Revenue", formula: "price * clients" }],
  },
};
