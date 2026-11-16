// media.mjs — normalize visual attachments of a question, option, swipe card,
// swipe side or explanation. Each kind (images, preview, html, mermaid, code, compare,
// video, diff, table, chart, links) is one module in registry/media; this file runs them over
// a node and checks the insides of what the node carries. Every shape problem becomes a lint
// issue; a broken attachment is dropped, never shown half-made.

import { MEDIA, OPTION_FIELDS, QUESTION_FIELDS } from "./registry/index.mjs";
import { unknownInside } from "./registry/strict.mjs";
import { LIMITS } from "./registry/media/util.mjs";

export { LIMITS };

// The names inside each kind's nodes, to tell a name that belongs to another kind from a plain slip.
const innerNames = (def) => {
  const names = new Set();
  const walk = (f) => {
    if (!f) return;
    for (const name of Object.keys(f.fields || {})) names.add(name);
    Object.values(f.fields || {}).forEach(walk);
    walk(f.items);
    f.of?.forEach(walk);
  };
  walk(def.field);
  Object.values(def.extra || {}).forEach(walk);
  return names;
};
const INNER = new Map([...MEDIA.values()].map((def) => [def.name, innerNames(def)]));
const LEVEL_NAMES = new Set([...Object.keys(OPTION_FIELDS), ...Object.keys(QUESTION_FIELDS)]);
const levelOf = (n) => (n in OPTION_FIELDS ? "option" : "question");

function elsewhereOf(def) {
  const others = [...INNER].filter(([name]) => name !== def.name);
  const owners = (n) => others.filter(([, names]) => names.has(n)).map(([name]) => name);
  return {
    get names() {
      return [...new Set([...others.flatMap(([, names]) => [...names]), ...LEVEL_NAMES])];
    },
    say: (n) => (owners(n).length ? `"${n}" belongs to ${owners(n).join(", ")}, not to ${def.name}` : `"${n}" is ${levelOf(n) === "option" ? "an option" : "a question"} field, not part of a media node: put it on the ${levelOf(n)}`),
  };
}

// The names this node uses for each kind, walked along the kind's FieldDef.
function checkInsides(node, path, ctx) {
  const level = ctx.fieldLevel ?? "error";
  for (const def of MEDIA.values()) {
    const opts = { level, mistakes: def.mistakes, elsewhere: elsewhereOf(def) };
    for (const [name, field] of Object.entries({ [def.name]: def.field, ...def.extra })) {
      if (node[name] != null) unknownInside(node[name], field, `${path}.${name}`, ctx.add, opts);
    }
  }
}

// ctx: {add, exists, abs, fieldLevel?}. `where` is the place in issue messages; `path` the plain path
// the unknown-field errors name (the same as `where` when a caller has no other).
export function collectMedia(node, where, ctx, path = where) {
  checkInsides(node, path, ctx);
  const out = {};
  const mctx = { ...ctx, raw: node, where, path };
  for (const def of MEDIA.values()) def.normalize(out, mctx);
  for (const def of MEDIA.values()) {
    if (kindsOf(out).includes(def.name)) def.lint(out, (level, message) => ctx.add(level, where, message));
  }
  return out;
}

const has = (m, k) => (Array.isArray(m[k]) ? m[k].length : m[k]);
const kindsOf = (m) => [...MEDIA.keys()].filter((k) => has(m, k));

// The kinds a node carries that count as something to look at, for lint rules that read a card and
// its sides together. Links are not one.
export const mediaKinds = (m) => kindsOf(m).filter((k) => !MEDIA.get(k).plain);

// The kinds that are too much to read in a swipe side tile when two share one.
export const heavyKinds = (m) => kindsOf(m).filter((k) => MEDIA.get(k).heavy);

// Nodes shown next to each other (two swipe sides, the options of a question) may need the same
// scale; a kind with something to share does it.
export function beside(nodes) {
  for (const def of MEDIA.values()) def.beside?.(nodes);
}
