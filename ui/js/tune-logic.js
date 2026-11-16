// tune-logic.js — the pure part of the tune question: knob values, derived numbers, the answer.
// It imports only the formula evaluator, so the engine, the answers file and the page all use it.

import { compile } from "./formula.js";

const COLOR = /^#[0-9a-f]{3,8}$/i;

// A raw value made fit for the knob: clamped, or its default when it is nonsense.
export function coerceValue(k, v) {
  switch (k.kind) {
    case "range": {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
      return Number.isFinite(n) ? Math.max(k.min, Math.min(k.max, n)) : k.default;
    }
    case "toggle":
      return v === true;
    case "select":
      return k.options.some((o) => o.id === String(v)) ? String(v) : k.default;
    case "color":
      return typeof v === "string" && COLOR.test(v) ? v : k.default;
    case "image":
      return typeof v === "string" && /^(data:image\/|https?:|\/)/i.test(v) && v.length < 2_000_000 ? v : "";
    default:
      return typeof v === "string" ? v.slice(0, 500) : k.default;
  }
}

export const defaultValues = (knobs) => Object.fromEntries(knobs.map((k) => [k.id, k.default]));

// Values over the knobs: unknown names dropped, known ones coerced; a missing one takes `base`.
export function cleanValues(knobs, raw, base = defaultValues(knobs)) {
  const src = raw && typeof raw === "object" ? raw : {};
  return Object.fromEntries(knobs.map((k) => [k.id, k.id in src ? coerceValue(k, src[k.id]) : (base[k.id] ?? k.default)]));
}

// The derived numbers for these values, in order: a formula may use the ones before it. null where it cannot be computed.
export function derivedOf(q, values) {
  const env = {};
  for (const k of q.knobs) env[k.id] = k.kind === "range" ? values[k.id] : k.kind === "toggle" ? (values[k.id] ? 1 : 0) : Number(values[k.id]);
  const out = {};
  for (const d of q.derived ?? []) {
    const v = compile(d.formula)(env);
    out[d.id] = v;
    if (v != null) env[d.id] = v;
  }
  return out;
}

// What a snapshot is called when the user gives no name: A, B, C… then A2…
export function nextName(snapshots) {
  const used = new Set(snapshots.map((s) => s.name));
  for (let i = 0; ; i += 1) {
    const name = String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) + 1 : "");
    if (!used.has(name)) return name;
  }
}

// The answer as the agent reads it: only what is real (names that exist, values that fit).
export function tuneAnswer(q, a) {
  const snapshots = (a.snapshots ?? []).map((s) => ({ name: s.name, values: cleanValues(q.knobs, s.values) }));
  const names = new Set(snapshots.map((s) => s.name));
  const candidates = (a.candidates ?? []).filter((n) => names.has(n)).slice(0, 2);
  const picked = a.picked === "now" || names.has(a.picked) ? a.picked : null;
  const values = cleanValues(q.knobs, a.values);
  return { values, preset: a.preset ?? null, snapshots, picked, candidates, derived: derivedOf(q, values) };
}

export const isTuned = (a) => Boolean(a.tuned) || a.picked != null || (a.candidates?.length ?? 0) > 0;

// ---- K8: the agent's knobs patch and image knobs kept as files

// A snapshot name not taken yet: the name itself, else "name 2", "name 3"…
export function uniqueName(name, snapshots = []) {
  const base = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || "Before";
  const used = new Set(snapshots.map((s) => s.name));
  if (!used.has(base)) return base;
  for (let i = 2; ; i += 1) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}

// The agent's knobs entry (view.knobs[qid]: {values?, preview?, seq, reason}) applied to the page's answer:
// what the user had is kept as a snapshot called `name`, the knobs move, the mockup is swapped (`mockup`,
// a URL; none means the spec's own). Returns the fields to save, or null when this entry was applied already
// (the answer's knobsSeq).
export function agentKnobs(q, a, k, name) {
  if (!k || !Number.isFinite(k.seq) || k.seq <= (Number(a.knobsSeq) || 0)) return null;
  const snapshots = a.snapshots ?? [];
  const before = { name: uniqueName(name, snapshots), values: { ...a.values }, ...(a.mockup ? { mockup: a.mockup } : {}) };
  return {
    values: cleanValues(q.knobs, { ...a.values, ...(k.values ?? {}) }, a.values),
    snapshots: [...snapshots, before],
    knobsSeq: k.seq,
    ...(k.preview ? { mockup: k.preview } : {}),
  };
}

// What a mockup gets for an image knob's value: a data:, blob: or http(s) URL and a /r/ URL as they are; a
// stored file's path (the answer keeps it) through the round's files ({path: {url}} or a Map of the same).
export function imageSrc(v, files) {
  const s = typeof v === "string" ? v : "";
  if (!s) return "";
  if (/^(data:image\/|blob:|https?:)/i.test(s) || s.startsWith("/r/")) return s;
  const f = files instanceof Map ? files.get(s) : files?.[s];
  return typeof f?.url === "string" ? f.url : "";
}
