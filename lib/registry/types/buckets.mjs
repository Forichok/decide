// buckets — sort the options into named buckets.

import { arrayOf, object, string, union } from "../shared.mjs";

// A bucket is a name, or {id, label}. The id is what the answer is keyed by.
export const bucketsOf = (raw) =>
  (Array.isArray(raw) ? raw : raw == null ? [] : [raw])
    .map((b) => (typeof b === "string" ? { id: b.trim(), label: b.trim() } : b && typeof b === "object" ? { id: String(b.id ?? b.label ?? "").trim(), label: String(b.label ?? b.id ?? "").trim() } : null))
    .filter((b) => b && b.id);

export default {
  name: "buckets",
  summary: 'Sort every option into one of the named buckets (buckets: ["now", "later", "no"]) by dragging or with the number keys.',
  fields: {
    buckets: arrayOf(
      union("A bucket's name, or {id, label}.", string("The name."), object("A bucket.", { id: string("The key in the answer."), label: string("The words on the bucket.") })),
      "The buckets, two to six. Default now, later, no.",
      { orOne: true, brief: "Names, e.g. now, later, no" },
    ),
  },
  normalize(q, ctx) {
    const found = bucketsOf(ctx.raw.buckets);
    q.buckets = found.length ? found : bucketsOf(["now", "later", "no"]);
    const seen = new Set();
    for (const b of q.buckets) {
      if (seen.has(b.id)) ctx.add("error", ctx.where, `duplicate bucket "${b.id}"`);
      seen.add(b.id);
    }
    if (q.buckets.length < 2 || q.buckets.length > 6) ctx.add("error", ctx.where, "buckets needs two to six buckets");
  },
  lint(q, add) {
    if (q.options.length < 2) add("error", `"${q.id}" needs at least two options to sort`);
  },
  seconds: (q) => 15 + 6 * (q.options?.length || 3),
  example: {
    id: "plan",
    type: "buckets",
    title: "When do these ship?",
    buckets: ["now", "later", "no"],
    options: [{ id: "search", label: "Search" }, { id: "export", label: "Export" }, { id: "share", label: "Sharing" }],
  },
};
