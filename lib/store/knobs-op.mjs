// knobs-op.mjs — the `knobs` patch op: the agent moves a tune question's knobs and/or swaps its mockup.
// patch.mjs dispatches { knobs: { question, values?, preview? } } here. Pure, like the rest of the engine.
//
// What it leaves in the view:
//   view.knobs = { [qid]: { values?, preview?, seq, reason } }
//     values   the knob values the agent set, each fitted to its knob (clamped, coerced); knobs the op does
//              not name are left out, so the page moves only those. Later knobs ops on the same question
//              merge into it, so a page that missed one still lands where the agent meant.
//     preview  the new mockup: an absolute path as the store resolved it (rounds.mjs); the view the page gets
//              carries the URL the round serves it at instead.
//     seq      the patch event's place in the log: the page applies an entry once, when its seq is newer
//              than the one it last applied (the tune answer's knobsSeq).
//     reason   the patch's (or the op's) reason: the page names the snapshot of the state before after it.
// Nothing here touches the answer: the page saves the user's state before as a snapshot and moves the
// controls, and that comes back as an ordinary answer.

import { coerceValue } from "../../ui/js/tune-logic.js";

const str = (v) => (typeof v === "string" ? v.trim() : "");
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// The values an op names, fitted to the question's knobs; unknown names dropped.
export function knobValues(q, raw) {
  if (!isObject(raw)) return {};
  const out = {};
  for (const k of q?.knobs ?? []) if (Object.hasOwn(raw, k.id)) out[k.id] = coerceValue(k, raw[k.id]);
  return out;
}

// ed: patch.mjs's editor over the cloned view v.
export function applyKnobs(ed, v, value, { reason = "", seq } = {}) {
  if (!isObject(value)) return;
  const e = ed.get(String(value.question ?? ""));
  if (!e || e.item?.type !== "tune") return;
  const moved = knobValues(e.item, value.values);
  const preview = str(value.preview);
  if (!Object.keys(moved).length && !preview) return;
  const prev = v.knobs[e.id] ?? {};
  const next = { ...prev, seq: Number.isFinite(seq) ? seq : (prev.seq ?? 0) + 1, reason: str(reason) };
  if (Object.keys(moved).length) next.values = { ...(prev.values ?? {}), ...moved };
  if (preview) next.preview = preview;
  v.knobs = { ...v.knobs, [e.id]: next };
}

// validatePatch's part for one knobs op. source: the round's items (questions as they are now).
export function validateKnobs(source, value, path, add) {
  if (!isObject(value)) return add("error", path, "knobs takes { question, values?, preview? }");
  const id = String(value.question ?? "");
  if (!id) return add("error", path, "knobs names no question");
  const q = source.find((x) => String(x?.id) === id);
  if (!q) return add("error", path, `knobs: no item "${id}"`);
  if (q.type !== "tune") return add("error", path, `knobs: "${id}" is a ${q.type ?? "card"} question, not tune`);
  const hasValues = value.values !== undefined;
  const hasPreview = value.preview !== undefined;
  if (!hasValues && !hasPreview) return add("error", path, "knobs moves values or swaps the preview: give one of them");
  if (hasValues) {
    if (!isObject(value.values)) add("error", path, "knobs: values is { knobId: value }");
    else {
      const known = new Set((q.knobs ?? []).map((k) => k.id));
      const unknown = Object.keys(value.values).filter((k) => !known.has(k));
      if (unknown.length) add("warn", path, `knobs: "${id}" has no knob ${unknown.map((k) => `"${k}"`).join(", ")} (known: ${[...known].join(", ")})`);
    }
  }
  if (hasPreview && !str(value.preview)) add("error", path, "knobs: preview is the path of an html file");
}
