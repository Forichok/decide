// spot — points or areas on a screenshot.

import { number } from "../shared.mjs";

export default {
  name: "spot",
  summary: "Mark points or areas on the question's first picture (images), each with an optional note; answers are in percent.",
  fields: { maxSpots: number("How many marks at most. Default 20.") },
  normalize(q, ctx) {
    const m = ctx.raw.maxSpots;
    q.maxSpots = Number.isInteger(m) && m > 0 ? Math.min(m, 50) : 20;
  },
  lint(q, add) {
    if (!q.images?.length) add("error", `"${q.id}" needs a picture to mark: give it images`);
  },
  seconds: () => 40,
  example: {
    id: "where",
    type: "spot",
    title: "Where does it feel off?",
    images: [{ src: "https://example.com/screen.png", caption: "Today" }],
  },
};
