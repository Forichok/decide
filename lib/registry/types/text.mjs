// text — a free answer in the user's own words.

import { string } from "../shared.mjs";

export default {
  name: "text",
  summary: "A free-text answer; placeholder is the hint shown in the empty field.",
  fields: { placeholder: string("The hint shown in the empty field.") },
  normalize() {},
  lint() {},
  seconds: () => 45,
  example: {
    id: "name",
    type: "text",
    title: "What should we call it?",
    placeholder: "A short working name",
  },
};
