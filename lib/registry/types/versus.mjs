// versus — 4 to 8 variants, compared two at a time until one wins. No calls to the agent.

export default {
  name: "versus",
  summary: "Four to eight options compared in pairs (arrow keys) until one wins: a knockout, at most 7 pairs. Answer: winner, order, pairs.",
  fields: {},
  normalize() {},
  lint(q, add) {
    if (q.options.length < 4 || q.options.length > 8) add("error", `"${q.id}" needs four to eight options to compare, has ${q.options.length}`);
  },
  seconds: (q) => 8 * Math.max(1, (q.options?.length || 4) - 1),
  example: {
    id: "logo",
    type: "versus",
    title: "Which direction wins?",
    options: [{ id: "a", label: "Calm" }, { id: "b", label: "Bold" }, { id: "c", label: "Playful" }, { id: "d", label: "Plain" }],
  },
};
