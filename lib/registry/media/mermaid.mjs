// mermaid — a diagram written as Mermaid source, drawn by the page.

import { string } from "../shared.mjs";
import { str } from "./util.mjs";

export default {
  name: "mermaid",
  summary: "A diagram from Mermaid source, which the user can enlarge. Drawn in a sandboxed frame; an exported file draws it too. A failed drawing shows the source text.",
  field: string("Mermaid source."),
  normalize(out, ctx) {
    out.mermaid = str(ctx.raw.mermaid);
  },
  lint() {},
  example: { mermaid: "flowchart LR\n  A --> B" },
};
