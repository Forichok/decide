// shared.mjs — what several question types have in common: FieldDef builders
// and the checks the choice types (single, multi, rank, confirm) share.

export const field = (type, doc, extra = {}) => ({ type, doc, ...extra });
export const string = (doc, extra) => field("string", doc, extra);
export const number = (doc, extra) => field("number", doc, extra);
export const boolean = (doc, extra) => field("boolean", doc, extra);
export const any = (doc, extra) => field("any", doc, extra);
export const oneOf = (values, doc, extra) => field("enum", doc, { values, ...extra });
// extra.orOne: a single entry stands for a list of one, as the engine reads it.
// Other flags the schema writes: `loose` on an enum (the engine only warns on another value: a string),
// `open` on an object (the engine ignores a name it does not know: more are allowed), `nullable`.
export const arrayOf = (items, doc, extra) => field("array", doc, { items, ...extra });
// One of several shapes, told apart by what the value is: a string, a number, a list, an object.
export const union = (doc, ...of) => field("union", doc, { of });
// A shape that is written once in the generated schema and referred to by name ($defs).
export const shared = (name, def) => ({ ...def, shared: name });
export const object = (doc, fields, extra) => field("object", doc, fields ? { fields, ...extra } : extra);
// A name the older versions read: the same field under another spelling.
export const alias = (of, doc, def) => ({ ...def, doc, alias: of });

export const LAYOUTS = ["list", "grid", "compare"];

export const layoutField = oneOf(LAYOUTS, "How the options sit: a list, two columns of short options, or side by side with the media on top.", { loose: true });
export const allowOtherField = boolean("false hides the field where the user writes an option of their own.");
export const defaultField = arrayOf(string("An option id."), "Option ids that start selected, or the starting order of a rank question.", { orOne: true });

export const confirmOptions = (w) => [
  { id: "yes", label: w.yes },
  { id: "no", label: w.no },
  { id: "change", label: w.change, detail: w.changeDetail },
];

// A choice question without options has nothing to answer.
export function needsOptions(q, add) {
  if (q.options.length === 0) add("error", `"${q.id}" needs at least one option`);
}

// Single and multi questions say what the agent would pick; a lone option needs no pick.
export function recommendations(q, add) {
  const recs = q.options.filter((o) => o.recommended).length;
  if (q.type === "single" && recs > 1) add("warn", "several recommended options in a single-choice question");
  if (q.options.length > 1 && !recs) add("warn", "no recommended option — mark what you would pick and why");
}

// A choice question says why it is asked (`why`) and what each option leads to (`then`): warnings only.
export function anatomy(q, add) {
  if (!q.why) add("warn", `"${q.id}" has no "why": one line on what depends on the answer`);
  const bare = q.options.filter((o) => !o.then);
  if (q.options.length && bare.length) add("warn", `no "then" on ${bare.length === q.options.length ? "any option" : `option ${bare.map((o) => `"${o.id}"`).join(", ")}`}: say what happens next if it is picked`);
}
