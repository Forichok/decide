import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../ui/js/summary.js";

const w = {
  explain: "Asked for more detail",
  skip: "Skipped",
  delegate: "Left to the agent",
  autoSkip: "No answer",
  autoDelegate: "No answer: the recommendation",
  against: (r) => `(recommended: ${r})`,
  own: (x) => `Own option: ${x}`,
  later: (r) => (r ? `Later, revisit: ${r}` : "Later"),
  none: "None of these",
  condition: (c) => `but: ${c}`,
};
const spec = {
  questions: [
    { id: "db", title: "Which database?", type: "single", options: [{ id: "pg", label: "Postgres", recommended: true }, { id: "my", label: "MySQL" }], default: [] },
    { id: "name", title: "Name it", type: "text", options: [], default: [] },
    { id: "skipme", title: "Skipped one", type: "single", options: [{ id: "a", label: "A" }], default: [] },
    { id: "untouched", title: "Not in the answers", type: "single", options: [], default: [] },
  ],
};

test("summary says answers in words, with own text, notes and files", () => {
  const result = {
    answers: {
      db: { selected: ["my"], other: "", note: "we already run it", attachments: ["/tmp/x/plan.png"], pins: [{ file: "a/b.png", text: "here" }] },
      name: { selected: [], other: "", text: "Atlas" },
      skipme: { selected: [], flag: "skip" },
    },
    comment: "thanks",
  };
  const s = summarize(spec, result, w);
  assert.deepEqual(s.rows.map((r) => r.id), ["db", "name", "skipme"]);
  assert.equal(s.rows[0].answer, "MySQL (recommended: Postgres)");
  assert.equal(s.rows[0].note, "we already run it");
  assert.deepEqual(s.rows[0].files, ["plan.png"]);
  assert.equal(s.rows[0].pins[0].file, "b.png");
  assert.equal(s.rows[1].answer, '"Atlas"');
  assert.equal(s.rows[2].answer, "Skipped");
  assert.equal(s.comment, "thanks");
});

test("the recommended pick is flagged, not starred", () => {
  const s = summarize(spec, { answers: { db: { selected: ["pg"] } } }, w);
  assert.equal(s.rows[0].answer, "Postgres");
  assert.equal(s.rows[0].recommended, true);
});

test("format 3 answers: a condition and a deferred question", () => {
  const s = summarize(spec, { answers: { db: { selected: ["pg"], condition: "if it stays under 10 GB" }, skipme: { selected: [], flag: "later", revisit: "after launch" } } }, w);
  assert.equal(s.rows[0].answer, "Postgres · but: if it stays under 10 GB");
  assert.equal(s.rows[1].answer, "Later, revisit: after launch");
});

test("a round with no answers gives no rows", () => {
  assert.deepEqual(summarize(spec, {}, w).rows, []);
  assert.deepEqual(summarize(null, null, w).rows, []);
});
