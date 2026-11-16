// strict.mjs — the "unknown field" check: a name nobody reads is an error that
// names the place and, when one is near, the name the author probably meant.

// Edit distance with adjacent swaps counted once, so "optoins" is one step from "options".
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const prefix = (a, b) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

// The known name closest to `name`: one edit away for a short name (5 letters or fewer, either
// side), two for a longer one, or sharing a prefix of 4 or more. Short names are near too many
// others otherwise ("title" is two edits from "table"). Case does not count. On a tie the one
// that comes first in `known` wins.
export function nearest(name, known) {
  const lower = String(name).toLowerCase();
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const c = candidate.toLowerCase();
    const dist = distance(lower, c);
    const allowed = Math.min(lower.length, c.length) <= 5 ? 1 : 2;
    if (dist > allowed && prefix(lower, c) < 4) continue;
    if (dist < bestDistance) {
      best = candidate;
      bestDistance = dist;
    }
  }
  return best;
}

// Mistakes agents make often enough to name the cure: by the kind of place, then the name.
// Each is a whole "did you mean" answer, since the cure is not always a field of that place.
export const MISTAKES = {
  question: { multi: '"type": "multi"' },
  option: { description: '"detail"', title: '"label"' },
};

// What to say after an unknown name. In order: a known slip of the pen; a name that is a field
// one level up or down (`elsewhere`: {names, say}); the nearest known name.
export function hint(name, known, { kind, elsewhere, mistakes } = {}) {
  const slip = (mistakes ?? MISTAKES[kind])?.[name];
  if (slip) return `did you mean ${slip}?`;
  if (elsewhere?.names.includes(name)) return elsewhere.say(name);
  const near = nearest(name, known);
  return near ? `did you mean "${near}"?` : "";
}

// Reports every key of `obj` that is not in `known`, as an error or (level "warn") a warning with
// the same text. Only plain objects are checked: a string where an object was expected has its own rules.
// opts: {level, kind, elsewhere, mistakes}, see `hint`.
export function unknownFields(obj, known, where, add, { level = "error", ...opts } = {}) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  const names = new Set(known);
  for (const key of Object.keys(obj)) {
    if (names.has(key)) continue;
    const say = hint(key, known, opts);
    add(level, where, `unknown field "${key}"${say ? `; ${say}` : ""}`);
  }
}

const plain = (v) => v && typeof v === "object" && !Array.isArray(v);

// Does a value have the shape a FieldDef of a union names?
const shapeOf = (value, alt) => {
  if (alt.type === "array") return Array.isArray(value);
  if (alt.type === "object") return plain(value);
  if (alt.type === "any") return true;
  return typeof value === (alt.type === "enum" ? "string" : alt.type);
};

// Walks a value along its FieldDef and reports the unknown names of every object inside it:
// a media node's insides (a picture, a chart, a table's column, a series). Same messages as
// `unknownFields`; `where` grows by `.name` and `[i]`. A list given as one entry (`orOne`) is
// walked as that one entry.
export function unknownInside(value, def, where, add, opts) {
  if (!def || value == null) return;
  if (def.type === "union") {
    const alt = def.of.find((a) => shapeOf(value, a));
    if (alt) unknownInside(value, alt, where, add, opts);
  } else if (def.type === "array") {
    if (Array.isArray(value)) value.forEach((v, i) => unknownInside(v, def.items, `${where}[${i}]`, add, opts));
    else if (def.orOne) unknownInside(value, def.items, where, add, opts);
  } else if (def.type === "object" && def.fields && plain(value)) {
    unknownFields(value, Object.keys(def.fields), where, add, opts);
    for (const [name, sub] of Object.entries(def.fields)) if (name in value) unknownInside(value[name], sub, `${where}.${name}`, add, opts);
  }
}
