// html — a snippet drawn in a sandboxed frame like a preview, as tall as its content.
// Markup anywhere else in a spec stays escaped text.

import { any, number, object, shared, string, union } from "../shared.mjs";
import { LIMITS, bad, text } from "./util.mjs";

export default {
  name: "html",
  summary: "An HTML snippet drawn in a sandboxed frame that grows to its content.",
  field: shared(
    "html",
    union(
      "An HTML string, or {source, maxHeight?}: up to 200 KB; maxHeight 80 to 1200 px, default 640.",
      string("The HTML."),
      object("The HTML and its largest height.", {
        source: string("The HTML."),
        html: { ...string("The older spelling of source."), alias: "source" },
        maxHeight: number("Tallest the frame grows, 80 to 1200 px. Default 640."),
      }),
    ),
  ),
  heavy: true,
  mistakes: { code: '"source"', content: '"source"', height: '"maxHeight"' },
  normalize(out, ctx) {
    const { raw, where } = ctx;
    out.html = raw.html == null ? null : normalizeHtml(raw.html, `${where}.html`, ctx);
  },
  lint() {},
  publish(node, { htmlUrl }) {
    if (node.html && typeof node.html.source === "string") node.html = { ...node.html, src: htmlUrl(node.html.source) };
  },
  example: { html: { source: "<b>Hello</b>", maxHeight: 200 } },
};

function normalizeHtml(raw, where, ctx) {
  const o = typeof raw === "string" ? { source: raw } : raw || {};
  const source = text(o.source ?? o.html).trim();
  if (!source) return bad(ctx, where, 'expected an HTML string or {"source": "<div>…</div>"}');
  if (source.length > LIMITS.htmlKB * 1024) ctx.add("warn", where, `${Math.round(source.length / 1024)} KB of HTML — over ${LIMITS.htmlKB} KB; put a page this big in a preview file`);
  return { source, maxHeight: Number.isInteger(o.maxHeight) ? Math.max(80, Math.min(o.maxHeight, 1200)) : 640 };
}
