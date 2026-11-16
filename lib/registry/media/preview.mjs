// preview — a self-contained HTML file shown as a live mockup in a sandboxed frame.
// Owns `preview` and `previewHeight`.

import { number, shared, string } from "../shared.mjs";
import { asset, str } from "./util.mjs";

export default {
  name: "preview",
  summary: "A live mockup: an HTML file the user can click around in, at phone, tablet or laptop width, with notes pinned on it.",
  field: string("Path to a self-contained HTML file, shown in a sandboxed frame with no access to the page. The mockup itself has network access. The page frames only files it serves, so an http(s) URL is shown as a link, not framed.", { brief: "A local .html file" }),
  extra: { previewHeight: number("Height of the frame in px, default 360. The page offers 375, 768 and 1440 px widths and pins notes on the mockup.") },
  deckSummary: "A live mockup: an HTML file the user can click around in, at phone, tablet or laptop width.",
  heavy: true,
  normalize(out, ctx) {
    const { raw, where } = ctx;
    out.preview = str(raw.preview) ? asset(str(raw.preview), where, ctx, {}) : null;
    out.previewHeight = Number.isInteger(raw.previewHeight) ? raw.previewHeight : 360;
  },
  // The page frames only files it serves itself (its policy has frame-src 'self'): a page on the web is a link.
  lint(node, add) {
    const p = node.preview;
    if (p && /^https?:/i.test(p.src)) add("warn", `preview ${p.src}: the page frames only files it serves itself; shown as a link`);
  },
  publish(node, { pub }) {
    node.preview = pub(node.preview);
  },
  example: { preview: "card.html", previewHeight: 400 },
};
