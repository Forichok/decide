// knobs-store.mjs — the store's side of K8 (the knobs patch op and "in words"); rounds.mjs calls these.
// The pure op lives in knobs-op.mjs; here are the parts that touch the file system or the round's state.

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { cleanValues } from "../../ui/js/tune-logic.js";

const HTML_FILE = /\.html?$/i;
const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// A knobs op's preview, resolved like a spec's preview: a path relative to `base` (the project's working tree
// the client names, else the round's) becomes absolute and must be an html file that exists. A page on the web
// is refused: the page frames only files the server serves. Returns the ops with absolute previews.
export function resolveKnobsOps(ops, base) {
  if (!Array.isArray(ops)) return ops;
  return ops.map((op, i) => {
    const k = op && typeof op === "object" ? op.knobs : undefined;
    if (!k || typeof k !== "object" || typeof k.preview !== "string" || !k.preview.trim()) return op;
    const given = k.preview.trim();
    if (/^[a-z][a-z0-9+.-]+:/i.test(given)) throw refuse(`patch refused: ops[${i}]: knobs: preview ${given} is not a local file; the page frames only files it serves`);
    const abs = isAbsolute(given) ? given : resolve(base || ".", given);
    if (!HTML_FILE.test(abs)) throw refuse(`patch refused: ops[${i}]: knobs: preview ${abs} is not an .html file`);
    if (!existsSync(abs) || !isFile(abs)) throw refuse(`patch refused: ops[${i}]: knobs: missing file ${abs}`);
    return { ...op, knobs: { ...k, preview: abs } };
  });
}

// view.knobs with each preview path swapped for the URL the round serves it at (publish(abs) → url). Every
// preview a knobs op of the trail named is published, so the mockups the page's snapshots show stay served.
// A preview whose file is gone is left out.
export function knobsPreviews(knobs, trail, publish) {
  const url = new Map();
  const pub = (abs) => {
    if (!url.has(abs)) url.set(abs, existsSync(abs) ? publish(abs) : "");
    return url.get(abs);
  };
  for (const e of trail ?? []) {
    if (e?.type !== "patch" || !Array.isArray(e.ops)) continue;
    for (const op of e.ops) if (typeof op?.knobs?.preview === "string" && isAbsolute(op.knobs.preview)) pub(op.knobs.preview);
  }
  return Object.fromEntries(
    Object.entries(knobs).map(([qid, k]) => {
      if (!k.preview) return [qid, k];
      const { preview, ...rest } = k;
      const served = isAbsolute(preview) ? pub(preview) : preview;
      return [qid, served ? { ...rest, preview: served } : rest];
    }),
  );
}

// The words the user typed for a tune question, trimmed and capped; refused on another type or when empty.
export function knobsWords(q, text, max) {
  if (q?.type !== "tune") throw refuse("in words works on a tune question");
  const said = String(text ?? "").trim().slice(0, max);
  if (!said) throw refuse("text is empty");
  return said;
}

// The knob values the user sees now: the answer's, fitted to the knobs, over their defaults.
export const knobsValuesNow = (q, answer) => cleanValues(q.knobs ?? [], answer?.values);
