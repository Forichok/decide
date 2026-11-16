// table — a data table; numeric cells align right.

import { any, arrayOf, number, object, shared, string, union } from "../shared.mjs";
import { LIMITS, bad, list, text, str } from "./util.mjs";

export default {
  name: "table",
  summary: "A data table; numeric cells align right.",
  field: shared(
    "table",
    object("{columns, rows, caption?}: columns are strings or {id, label}; rows are arrays or objects keyed by column. Up to 50 rows and 8 columns.", {
      columns: arrayOf(
        shared("column", union("A column.", string("The heading."), number("A heading that is a number, a year."), object("A column.", { id: string("The key rows use."), label: union("The heading.", string("The heading."), number("A heading that is a number, a year.")) }))),
        "The columns. Taken from the first row when it is an object.",
        { orOne: true },
      ),
      rows: arrayOf(union("A row.", arrayOf(any("A cell."), "The cells, in column order."), object("The cells by column.")), "The rows."),
      caption: string("Shown above the table."),
    }, { brief: "{columns, rows, caption?}" }),
  ),
  heavy: true,
  mistakes: { headers: '"columns"', header: '"columns"', data: '"rows"', title: '"caption"' },
  normalize(out, ctx) {
    const { raw, where } = ctx;
    out.table = raw.table == null ? null : normalizeTable(raw.table, `${where}.table`, ctx);
  },
  lint() {},
  example: { table: { columns: ["Plan", { id: "price", label: "Price" }], rows: [["Free", "0"], { Plan: "Pro", price: "$9" }], caption: "Plans" } },
};

function normalizeTable(raw, where, ctx) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.rows)) return bad(ctx, where, 'expected {"columns": [...], "rows": [[...], ...]}');
  let columns = list(raw.columns).map((c) => text(typeof c === "object" && c ? c.label ?? c.id : c).trim());
  if (!columns.length && raw.rows[0] && typeof raw.rows[0] === "object" && !Array.isArray(raw.rows[0])) columns = Object.keys(raw.rows[0]);
  if (!columns.length) return bad(ctx, where, "a table needs columns");
  const keys = list(raw.columns).map((c, i) => (c && typeof c === "object" ? text(c.id ?? c.label) : columns[i]));
  const rows = raw.rows.map((r, i) => {
    const cells = Array.isArray(r) ? r : r && typeof r === "object" ? (keys.length ? keys : columns).map((k) => r[k]) : [r];
    if (Array.isArray(r) && r.length !== columns.length) ctx.add("warn", `${where}.rows[${i}]`, `${r.length} cells for ${columns.length} columns`);
    return columns.map((_, j) => text(cells[j]).trim());
  });
  if (!rows.length) return bad(ctx, where, "a table needs at least one row");
  if (rows.length > LIMITS.tableRows) ctx.add("warn", where, `${rows.length} rows — over ${LIMITS.tableRows}, show the rows that matter`);
  if (columns.length > LIMITS.tableCols) ctx.add("warn", where, `${columns.length} columns — over ${LIMITS.tableCols} won't fit on a phone`);
  return { columns, rows, caption: str(raw.caption) };
}
