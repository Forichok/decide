// single — pick one option (or write an own one).

import { allowOtherField, defaultField, layoutField, needsOptions, recommendations } from "../shared.mjs";

export default {
  name: "single",
  summary: "Pick exactly one option, or write an own one. The default type.",
  fields: { layout: layoutField, allowOther: allowOtherField, default: defaultField },
  normalize(q, ctx) {
    q.allowOther = ctx.raw.allowOther !== false;
  },
  lint(q, add) {
    needsOptions(q, add);
    recommendations(q, add);
  },
  example: {
    id: "db",
    type: "single",
    title: "Which database do we use?",
    options: [
      { id: "pg", label: "Postgres", recommended: "it is what the team knows" },
      { id: "sqlite", label: "SQLite" },
    ],
  },
};
