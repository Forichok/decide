/**
 * Feature:    hints in the ask result; the overlap index of the journal
 * Layer:      Unit
 * Covers:
 *   - two images in text give a compare hint; long option texts a table hint; at most three hints
 *   - the overlap check finds a live decision by text and ignores a superseded one
 *   - the overlap check for 90 questions against 500 entries takes under 100 ms
 * Isolation:  scratch data dirs only.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { formatHints, hintsFor } from "../lib/hints.mjs";
import { overlaps } from "../lib/journal.mjs";
import { scratchDir } from "./helpers.mjs";

const opt = (id, label, detail = "") => ({ id, label, detail, recommended: id === "1" });

test("hints: two images, long options, at most three", () => {
  const long = "x".repeat(130);
  const spec = {
    sections: [],
    questions: [
      { id: "a", type: "single", images: [{}, {}], options: [opt("1", "A"), opt("2", "B")], priority: 2 },
      { id: "b", type: "single", options: [opt("1", "A", long), opt("2", "B", long), opt("3", "C", long)], priority: 2 },
      { id: "c", type: "single", options: [opt("1", "A"), opt("2", "B")], priority: 2 },
      { id: "d", type: "single", options: [opt("1", "A"), opt("2", "B")], priority: 2 },
    ],
  };
  const hints = hintsFor(spec);
  assert.equal(hints.length, 3);
  assert.match(hints[0], /compare/);
  assert.match(hints[1], /table/);
  assert.match(formatHints(hints), /^Hints for next time/);
  assert.equal(formatHints([]), "");
});

const WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu".split(" ");
const phrase = (n) => Array.from({ length: 6 }, (_, i) => `${WORDS[(n * 7 + i * 3) % 26]}${WORDS[(n + i) % 26]}${n % 40}`).join(" ");

function journalWith(dir, count, superseded = []) {
  mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < count; i++) {
    const questions = [phrase(i * 3), phrase(i * 3 + 1), phrase(i * 3 + 2)];
    lines.push(JSON.stringify({ at: new Date(2026, 0, 1, 0, i).toISOString(), round: `r${i}`, title: `Round ${i}`, mode: "questions", questions, digest: questions.map((x) => `${x}: yes`).join("\n"), format: 3, records: questions.map((x, j) => ({ id: `r${i}/q${j}`, title: x, answer: "yes" })) }));
  }
  for (const round of superseded) lines.push(JSON.stringify({ type: "supersede", round, at: new Date().toISOString() }));
  writeFileSync(join(dir, "journal.jsonl"), `${lines.join("\n")}\n`);
}

test("overlap: live decisions only", async (t) => {
  const dir = await scratchDir(t);
  const data = join(dir, "data");
  journalWith(data, 3, ["r1"]);
  const live = overlaps(data, [phrase(0)]);
  assert.equal(live.length, 1);
  assert.equal(live[0].entry.round, "r0");
  assert.equal(overlaps(data, [phrase(3)]).length, 0, "the superseded round is not found");
});

test("overlap: 90 questions against 500 entries in under 100 ms", async (t) => {
  const dir = await scratchDir(t);
  const data = join(dir, "data");
  journalWith(data, 500);
  const texts = Array.from({ length: 90 }, (_, i) => ({ id: `q${i}`, text: phrase(i * 11 + 1) }));
  const start = performance.now();
  const hits = overlaps(data, texts, { limit: 200 });
  const ms = performance.now() - start;
  assert.ok(hits.length > 0, "fixture produces overlaps");
  assert.ok(ms < 100, `took ${ms.toFixed(0)} ms`);
});
