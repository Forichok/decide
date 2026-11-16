import { test } from "node:test";
import assert from "node:assert/strict";
import { groups, nextRound, orderRows, progressOf, rowsFromState } from "../ui/js/inbox-logic.js";

const DAY = 24 * 3600 * 1000;
const now = Date.UTC(2026, 10, 16, 12);

test("fallback rows come from /api/state, high stakes first, then the longest waiting, older last", () => {
  const state = {
    rounds: [
      { id: "b", title: "B", mode: "questions", createdAt: now - 3000, count: 4, listening: true, project: "/work/beta/" },
      { id: "a", title: "A", mode: "swipe", createdAt: now - 9000, count: 12, listening: true, project: "/work/alpha" },
      { id: "old", title: "Old", mode: "questions", createdAt: now - 3 * DAY, count: 2, listening: false, project: "/work/alpha" },
      { id: "hi", title: "Hi", mode: "questions", createdAt: now - 1000, count: 1, listening: true, project: "/work/beta", stakes: "high" },
    ],
  };
  const rows = rowsFromState(state, now);
  assert.deepEqual(rows.map((r) => r.id), ["hi", "a", "b", "old"]);
  assert.equal(rows[0].projectName, "beta");
  assert.equal(rows.at(-1).older, true);
  assert.equal(rows[1].mode, "swipe");
  assert.equal(rows[1].answered, null);
});

test("a round nobody listens to for less than a day is not older", () => {
  const [row] = rowsFromState({ rounds: [{ id: "x", title: "X", createdAt: now - DAY / 2, count: 1, listening: false }] }, now);
  assert.equal(row.older, false);
});

test("groups split in place and keep the order", () => {
  const rows = orderRows([{ id: "1", older: true, createdAt: 1 }, { id: "2", older: false, createdAt: 2 }, { id: "3", older: false, createdAt: 1 }]);
  const g = groups(rows);
  assert.deepEqual(g.open.map((r) => r.id), ["3", "2"]);
  assert.deepEqual(g.older.map((r) => r.id), ["1"]);
});

test("next round skips the current one and prefers an open round to an older one", () => {
  const rows = [{ id: "o", older: true }, { id: "a", older: false }, { id: "b", older: false }];
  assert.equal(nextRound(rows, "a").id, "b");
  assert.equal(nextRound(rows, "b").id, "a");
  assert.equal(nextRound([{ id: "o", older: true }, { id: "a", older: false }], "a").id, "o");
  assert.equal(nextRound([{ id: "a" }], "a"), null);
});

test("progress is unknown, not zero, when the server did not say", () => {
  assert.deepEqual(progressOf({ answered: 3, total: 8 }), { answered: 3, total: 8 });
  assert.deepEqual(progressOf({ answered: null, total: 8 }), { answered: null, total: 8 });
});
