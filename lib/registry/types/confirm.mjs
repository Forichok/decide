// confirm — yes, no, or yes with changes. The options are written by the engine.

import { confirmOptions, defaultField, needsOptions } from "../shared.mjs";

export default {
  name: "confirm",
  summary: "A yes / no / yes-with-changes question; the engine writes the three options, \"changes\" opens the note.",
  fields: { default: defaultField },
  normalize(q, ctx) {
    if (q.options.length === 0) q.options = confirmOptions(ctx.w).map((o, i) => ctx.option(o, i));
  },
  lint(q, add) {
    needsOptions(q, add);
  },
  example: {
    id: "plan",
    type: "confirm",
    title: "Go with this plan?",
    body: "Migrate the table first, switch the readers after.",
  },
};
