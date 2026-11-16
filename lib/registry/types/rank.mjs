// rank — put the options in order.

import { defaultField, needsOptions } from "../shared.mjs";

export default {
  name: "rank",
  summary: "Put all options in order, most wanted first; default is the starting order.",
  fields: { default: defaultField },
  normalize() {},
  lint(q, add) {
    needsOptions(q, add);
  },
  // Ranking takes thought: as long as a text answer.
  seconds: () => 45,
  example: {
    id: "order",
    type: "rank",
    title: "In which order do we build these?",
    options: [
      { id: "search", label: "Search" },
      { id: "export", label: "Export" },
      { id: "share", label: "Sharing" },
    ],
  },
};
