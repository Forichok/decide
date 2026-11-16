// scale — a number on a short scale, with optional words under the steps.

import { number, object } from "../shared.mjs";

export default {
  name: "scale",
  summary: "A number from scale.min to scale.max (default 1 to 5, at most 11 steps), with labels for steps.",
  fields: {
    scale: object("The range: {min, max, labels}. Default 1 to 5.", {
      min: number("First step. Default 1."),
      max: number("Last step. Default 5."),
      labels: object("Words under steps, keyed by the step number."),
    }, { open: true }),
  },
  normalize(q, ctx) {
    const s = ctx.raw.scale ?? {};
    const min = Number.isInteger(s.min) ? s.min : 1;
    const max = Number.isInteger(s.max) ? s.max : 5;
    if (max <= min || max - min > 10) ctx.add("error", ctx.where, "scale needs min < max and at most 11 steps");
    q.scale = { min, max, labels: s.labels && typeof s.labels === "object" ? s.labels : {} };
  },
  lint() {},
  example: {
    id: "risk",
    type: "scale",
    title: "How risky is this change?",
    scale: { min: 1, max: 5, labels: { 1: "harmless", 5: "could take us down" } },
  },
};
