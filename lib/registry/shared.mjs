// shared.mjs — what several question types have in common: FieldDef builders
// and the checks the choice types (single, multi, rank, confirm) share.

export const field = (type, doc, extra = {}) => ({ type, doc, ...extra });
export const string = (doc, extra) => field("string", doc, extra);
export const number = (doc, extra) => field("number", doc, extra);
export const boolean = (doc, extra) => field("boolean", doc, extra);
export const any = (doc, extra) => field("any", doc, extra);
export const oneOf = (values, doc, extra) => field("enum", doc, { values, ...extra });
export const arrayOf = (items, doc, extra) => field("array", doc, { items, ...extra });
export const object = (doc, fields, extra) => field("object", doc, fields ? { fields, ...extra } : extra);
// A name the older versions read: the same field under another spelling.
export const alias = (of, doc, def) => ({ ...def, doc, alias: of });

export const LAYOUTS = ["list", "grid", "compare"];

export const layoutField = oneOf(LAYOUTS, "How the options sit: a list, two columns of short options, or side by side with the media on top.");
export const allowOtherField = boolean("false hides the field where the user writes an option of their own.");
export const defaultField = arrayOf(string("An option id."), "Option ids that start selected, or the starting order of a rank question.");

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
