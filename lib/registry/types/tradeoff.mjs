// tradeoff — a slider between two poles.

import { arrayOf, number, string } from "../shared.mjs";

export default {
  name: "tradeoff",
  summary: 'A slider from 0 to 100 between two poles (poles: ["faster", "more careful"]); recommendedAt marks the agent\'s pick.',
  fields: {
    poles: arrayOf(string("One pole."), "Exactly two: the words at 0 and at 100.", { orOne: true, brief: "Two words" }),
    recommendedAt: number("0 to 100: where the agent would put the slider."),
  },
  normalize(q, ctx) {
    const poles = (Array.isArray(ctx.raw.poles) ? ctx.raw.poles : []).map((p) => String(p ?? "").trim());
    if (poles.length !== 2 || poles.some((p) => !p)) ctx.add("error", ctx.where, 'tradeoff needs poles: ["left word", "right word"]');
    q.poles = poles.length === 2 ? poles : ["", ""];
    const at = ctx.raw.recommendedAt;
    if (at != null && !(Number.isFinite(at) && at >= 0 && at <= 100)) ctx.add("error", ctx.where, "recommendedAt is a number from 0 to 100");
    q.recommendedAt = Number.isFinite(at) ? Math.max(0, Math.min(100, Math.round(at))) : null;
  },
  lint(q, add) {
    if (q.recommendedAt == null) add("warn", `"${q.id}": no recommendedAt; mark where you would put the slider`);
  },
  seconds: () => 10,
  example: {
    id: "pace",
    type: "tradeoff",
    title: "How should we weigh speed against care?",
    poles: ["ship fast", "check everything"],
    recommendedAt: 60,
  },
};
