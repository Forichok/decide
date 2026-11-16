// compare — a before/after slider over two pictures. Two HTML mockups make a live compare:
// both pages stay clickable behind one divider.

import { alias, arrayOf, object, shared, string, union } from "../shared.mjs";
import { HTML, REMOTE, asset, bad, list, str } from "./util.mjs";

const PICTURE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;

const SIDE = shared(
  "compareSide",
  union(
    "A path or URL, or {src, label}.",
    string("A path or URL."),
    object("One side.", {
      src: string("A path or a URL."),
      path: alias("src", "The older spelling of src.", string("A path or a URL.")),
      label: string("The tag on the side. Default Before / After."),
    }),
  ),
);

export default {
  name: "compare",
  summary: "A before/after slider over two pictures, or over two live mockups.",
  field: shared(
    "compare",
    object("{before, after, labels?}: two pictures of the same size, or two .html mockups. Two .html files make a live compare: both run, one divider. Mixing a picture and an .html is skipped with a warning. A remote .html is shown as a link, not framed.", {
      before: SIDE,
      after: SIDE,
      labels: arrayOf(string("A tag."), "Tags for before and after.", { orOne: true }),
    }, { brief: "{before, after, labels?}: pictures or live mockups" }),
  ),
  mistakes: { left: '"before"', right: '"after"', old: '"before"', new: '"after"' },
  normalize(out, ctx) {
    const { raw, where } = ctx;
    out.compare = raw.compare == null ? null : normalizeCompare(raw.compare, `${where}.compare`, ctx);
  },
  // The page frames only files it serves itself (frame-src 'self'): a mockup on the web is shown as a link.
  lint(node, add) {
    if (!node.compare?.live) return;
    for (const side of [node.compare.before, node.compare.after]) {
      if (/^https?:/i.test(side.src)) add("warn", `compare ${side.src}: the page frames only files it serves itself; shown as a link`);
    }
  },
  publish(node, { pub }) {
    if (node.compare) node.compare = { ...node.compare, before: pub(node.compare.before), after: pub(node.compare.after) };
    else node.compare = node.compare ?? null;
  },
  example: { compare: { before: "before.png", after: "after.png", labels: ["Today", "New"] } },
};

function normalizeCompare(raw, where, ctx) {
  if (!raw || typeof raw !== "object") return bad(ctx, where, 'expected {"before": image, "after": image}');
  const srcOf = (v) => str((typeof v === "string" ? { src: v } : v || {}).src || (v || {}).path);
  const live = [raw.before, raw.after].map((v) => HTML.test(srcOf(v).split("?")[0]));
  if (live[0] !== live[1]) return bad(ctx, where, "compare two pictures or two HTML mockups, not one of each — skipped");
  const side = (v, fallback) => {
    const o = typeof v === "string" ? { src: v } : v || {};
    const src = str(o.src || o.path);
    if (src && !live[0] && !REMOTE.test(src) && !PICTURE.test(src.split("?")[0])) return bad(ctx, where, `${src}: not a picture — skipped`);
    return asset(src, where, ctx, { label: str(o.label) || fallback });
  };
  const labels = list(raw.labels).map(str);
  const before = side(raw.before, labels[0] || "");
  const after = side(raw.after, labels[1] || "");
  if (!before || !after) return bad(ctx, where, `a compare needs both before and after ${live[0] ? "mockups" : "images"} — skipped`);
  if (before.src === after.src) ctx.add("warn", where, `before and after are the same ${live[0] ? "mockup" : "picture"}`);
  return live[0] ? { before, after, live: true } : { before, after };
}
