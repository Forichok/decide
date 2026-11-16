// mermaid — a diagram written as Mermaid source, drawn by the page.

import { string } from "../shared.mjs";
import { str } from "./util.mjs";

export default {
  name: "mermaid",
  summary: "A diagram from Mermaid source, which the user can enlarge. The live page shows the source text (its policy blocks the CDN); an exported file draws it.",
  field: string("Mermaid source."),
  normalize(out, ctx) {
    out.mermaid = str(ctx.raw.mermaid);
  },
  lint() {},
  example: { mermaid: "flowchart LR\n  A --> B" },
};
