// table — a data table; numeric columns align right.

import { h } from "../dom.js";
import { mdInline } from "../md.js";

const NUM = /^[-+−]?[\d\s.,]*\d[\d\s.,]*\s*(%|[kKMB]|[$€₽£]|ms|s|x|×)?$/;

export function render(node, ctx, env) {
  const tb = node.table;
  if (!tb) return null;
  const numeric = tb.columns.map((_, j) => tb.rows.every((r) => !r[j] || NUM.test(r[j])) && tb.rows.some((r) => r[j]));
  const cell = (tag, text, j) => h(`${tag}${numeric[j] ? ".num" : ""}`, { html: mdInline(text) });
  return env.zoom(
    "table",
    h(
      "div.table-wrap.media-stop",
      {},
      h(
        "table.data",
        {},
        tb.caption && h("caption", {}, tb.caption),
        h("thead", {}, h("tr", {}, tb.columns.map((c, j) => cell("th", c, j)))),
        h("tbody", {}, tb.rows.map((r) => h("tr", {}, r.map((c, j) => cell("td", c, j))))),
      ),
    ),
  );
}
