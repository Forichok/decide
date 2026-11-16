// single — pick one option (or write an own one).

import { allowOtherField, defaultField, layoutField, anatomy, needsOptions, recommendations } from "../shared.mjs";

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
    anatomy(q, add);
  },
  example: {
    id: "db",
    type: "single",
    title: "Which database do we use?",
    why: "The schema and the hosting plan follow from it.",
    options: [
      { id: "pg", label: "Postgres", recommended: "it is what the team knows", then: "I set up a managed instance and write the migrations." },
      { id: "sqlite", label: "SQLite", then: "I keep one file next to the app and skip hosting." },
    ],
  },
};
