// diff — two texts compared line by line in the browser.

import { arrayOf, object, shared, string } from "../shared.mjs";
import { LIMITS, list, str, text } from "./util.mjs";
import { bad } from "./util.mjs";

export default {
  name: "diff",
  summary: "Two texts side by side, changed lines paired by likeness with the changed part marked.",
  field: shared(
    "diff",
    object("{before, after, lang?, labels?}: two texts. Changed lines are paired by likeness; the changed part of each is marked.", {
      before: string("The old text."),
      after: string("The new text."),
      lang: string("The language; shown in the bar."),
      labels: arrayOf(string("A heading."), "Headings for before and after.", { orOne: true }),
    }),
  ),
  heavy: true,
  mistakes: { old: '"before"', new: '"after"', language: '"lang"' },
  normalize(out, ctx) {
    const { raw, where } = ctx;
    out.diff = raw.diff == null ? null : normalizeDiff(raw.diff, `${where}.diff`, ctx);
  },
  lint() {},
  example: { diff: { before: "a\nb\n", after: "a\nc\n", lang: "txt", labels: ["Old", "New"] } },
};

function normalizeDiff(raw, where, ctx) {
  if (!raw || typeof raw !== "object" || (typeof raw.before !== "string" && typeof raw.after !== "string")) {
    return bad(ctx, where, 'expected {"before": "text", "after": "text"}');
  }
  const before = text(raw.before).replace(/\r\n/g, "\n");
  const after = text(raw.after).replace(/\r\n/g, "\n");
  if (before === after) ctx.add("warn", where, "before and after are identical — nothing to compare");
  const lines = Math.max(before.split("\n").length, after.split("\n").length);
  if (lines > LIMITS.diffLines) ctx.add("warn", where, `${lines} lines — over ${LIMITS.diffLines}, cut the diff to the part that matters`);
  const labels = list(raw.labels).map(str);
  return { before, after, lang: str(raw.lang), labels: [labels[0] || "", labels[1] || ""] };
}
