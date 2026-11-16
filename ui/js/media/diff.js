// diff — two texts side by side (or one under the other on a narrow screen), changed lines paired.

import { h } from "../dom.js";
import { diffStats, inlineSpan, lineDiff } from "../diff.js";

// Unchanged runs longer than this fold into a "N unchanged lines" row.
const FOLD = 8;
const KEEP = 3;

export function render(node, ctx, env) {
  const d = node.diff;
  if (!d) return null;
  return env.zoom("diff", diffView(d, ctx, env, { unified: env.compact || env.narrow() }));
}

function diffView(d, ctx, { t }, { unified }) {
  const rows = lineDiff(d.before, d.after);
  const { added, removed } = diffStats(rows);
  const grid = h(`table.diff-grid${unified ? ".unified" : ""}`);
  const body = h("tbody");
  // Element.append writes a null as the text "null", so the parts are filtered.
  grid.append(
    ...[
      unified ? h("colgroup", {}, h("col.n"), h("col.sign"), h("col.t")) : h("colgroup", {}, h("col.n"), h("col.t"), h("col.n"), h("col.t")),
      !unified && (d.labels[0] || d.labels[1]) ? h("thead", {}, h("tr", {}, h("th", { colspan: "2" }, d.labels[0] || t("cmp.before")), h("th", { colspan: "2" }, d.labels[1] || t("cmp.after")))) : null,
      body,
    ].filter(Boolean),
  );
  const line = (r) => (unified ? unifiedRows(r) : [splitRow(r)]);
  for (let i = 0; i < rows.length; ) {
    let j = i;
    while (j < rows.length && rows[j].type === "same") j++;
    const run = j - i;
    if (run > FOLD) {
      const lead = i === 0 ? 0 : KEEP;
      const trail = j === rows.length ? 0 : KEEP;
      body.append(...rows.slice(i, i + lead).flatMap(line));
      const hidden = rows.slice(i + lead, j - trail);
      const fold = h("tr.fold", {}, h("td", { colspan: unified ? "3" : "4" }, h("button", { type: "button", onclick: () => fold.replaceWith(...hidden.flatMap(line)) }, t("diff.fold", hidden.length))));
      body.append(fold, ...rows.slice(j - trail, j).flatMap(line));
      i = j;
    } else if (run) {
      body.append(...rows.slice(i, j).flatMap(line));
      i = j;
    } else {
      body.append(...line(rows[i]));
      i += 1;
    }
  }
  const copy = h("button.copy", {
    type: "button",
    html: t("code.copy"),
    onclick: (e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(d.after).then(() => ctx?.toast(t("code.copied")));
    },
  });
  return h(
    "div.code.diffbox.media-stop",
    {},
    h("div.code-bar", {}, h("span", {}, d.lang || t("code.diff"), h("b.d-add", {}, ` +${added}`), h("b.d-del", {}, ` −${removed}`)), copy),
    h("div.diff-scroll", {}, grid),
  );
}

function splitRow(r) {
  const span = r.type === "mod" ? inlineSpan(r.left.text, r.right.text) : null;
  const side = (s, cls, parts) => [h(`td.n.${cls}`, {}, s ? String(s.n) : ""), h(`td.t.${cls}`, {}, s ? textCell(s.text, parts) : "")];
  const lc = r.type === "same" ? "same" : r.left ? "del" : "none";
  const rc = r.type === "same" ? "same" : r.right ? "add" : "none";
  return h("tr", {}, side(r.left, lc, span?.left), side(r.right, rc, span?.right));
}

function unifiedRows(r) {
  const span = r.type === "mod" ? inlineSpan(r.left.text, r.right.text) : null;
  const row = (cls, sign, n, text, parts) => h(`tr.${cls}`, {}, h("td.n", {}, String(n)), h("td.sign", {}, sign), h("td.t", {}, textCell(text, parts)));
  if (r.type === "same") return [row("same", " ", r.right.n, r.right.text)];
  return [r.left && row("del", "−", r.left.n, r.left.text, span?.left), r.right && row("add", "+", r.right.n, r.right.text, span?.right)].filter(Boolean);
}

const textCell = (text, parts) => (parts && parts[1] ? [parts[0], h("mark", {}, parts[1]), parts[2]] : text || " ");
