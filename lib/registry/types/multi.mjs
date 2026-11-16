// multi — pick several options; min and max bound how many.

import { allowOtherField, defaultField, layoutField, anatomy, needsOptions, number, recommendations } from "../shared.mjs";

export default {
  name: "multi",
  summary: "Pick several options, between min (default 1) and max, or write own ones.",
  fields: {
    layout: layoutField,
    allowOther: allowOtherField,
    default: defaultField,
    min: number("The least options the user must pick. Default 1."),
    max: number("The most options the user may pick. Default: no limit."),
  },
  normalize(q, ctx) {
    q.allowOther = ctx.raw.allowOther !== false;
    q.min = Number.isInteger(ctx.raw.min) ? ctx.raw.min : 1;
  },
  lint(q, add) {
    needsOptions(q, add);
    recommendations(q, add);
    anatomy(q, add);
  },
  example: {
    id: "features",
    type: "multi",
    title: "Which features ship in the first release?",
    max: 2,
    why: "The release date depends on how much goes in.",
    options: [
      { id: "export", label: "Export", recommended: "people ask for it first", then: "Export goes into the first release." },
      { id: "search", label: "Search", then: "Search waits for the second release." },
      { id: "share", label: "Sharing", then: "Sharing is cut from this round." },
    ],
  },
};
