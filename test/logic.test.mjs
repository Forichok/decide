/**
 * Feature:    project-decide-logic
 * Layer:      Agent tooling unit (pure spec + answer logic, no server)
 * Contract:   lib/spec.mjs + ui/js/logic.js + ui/js/md.js
 * Covers:
 *   - v1 specs normalize without changes in meaning (single default, image → images)
 *   - lint errors: duplicate ids, unknown type, broken showIf, choice without options
 *   - lint warnings: several recommendations, missing asset, long flat round
 *   - resolution rules per question type and per flag (explain/delegate/skip)
 *   - conditional questions and auto-fill of unanswered questions by recommendation
 *   - agent digest marks recommended picks, overrides, flags and custom answers
 *   - markdown-lite renderer escapes HTML and marks glossary terms outside code
 * Why exists: /decide v2 answers drive agent work; wrong resolution or digest silently changes decisions.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { normalizeSpec } = await import(path.join(toolDir, "lib/spec.mjs"));
const logic = await import(path.join(toolDir, "ui/js/logic.js"));
const { md } = await import(path.join(toolDir, "ui/js/md.js"));

const choice = (id, extra = {}) => ({
  id,
  title: `Question ${id}`,
  options: [
    { id: "a", label: "Alpha", recommended: true },
    { id: "b", label: "Beta" },
  ],
  ...extra,
});

test("normalizes a v1 spec: single by default, option image becomes an absolute images entry", async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), "decide-logic-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "shot.png"), "png");

  const { spec, issues } = normalizeSpec(
    {
      title: "Legacy",
      questions: [
        {
          id: "q1",
          title: "Pick",
          what: "What",
          note: true,
          options: [{ id: "a", label: "A", image: "shot.png", recommended: "cheapest" }, { id: "b", label: "B" }],
        },
      ],
    },
    { specDir: dir },
  );

  assert.deepEqual(issues.filter((i) => i.level === "error"), []);
  const q = spec.questions[0];
  assert.equal(q.type, "single");
  assert.equal(q.what, "What");
  assert.equal(q.noteOpen, true);
  assert.equal(q.options[0].recommended, true);
  assert.equal(q.options[0].reason, "cheapest");
  assert.deepEqual(q.options[0].images, [{ src: path.join(dir, "shot.png"), caption: "", local: true }]);
});

test("lint reports structural errors that would break the page", () => {
  const { issues } = normalizeSpec(
    {
      questions: [
        choice("dup"),
        choice("dup"),
        { id: "bad-type", title: "?", type: "poll", options: [{ id: "a", label: "A" }] },
        { id: "no-options", title: "?", type: "single", options: [] },
        { ...choice("dup-opt"), options: [{ id: "x", label: "X" }, { id: "x", label: "Y" }] },
        { ...choice("cond"), showIf: { q: "missing", in: ["a"] } },
      ],
    },
    { specDir: tmpdir() },
  );
  const errors = issues.filter((i) => i.level === "error").map((i) => i.message).join("\n");
  assert.match(errors, /duplicate question id "dup"/);
  assert.match(errors, /unknown type "poll"/);
  assert.match(errors, /no-options.*needs at least one option/);
  assert.match(errors, /duplicate option id "x"/);
  assert.match(errors, /showIf references unknown question "missing"/);
});

test("lint warns about soft problems without blocking", () => {
  const many = Array.from({ length: 13 }, (_, i) => choice(`q${i}`));
  many[0] = {
    ...choice("q0"),
    options: [
      { id: "a", label: "A", recommended: true },
      { id: "b", label: "B", recommended: true, image: "/definitely/missing.png" },
    ],
  };
  const { issues } = normalizeSpec({ questions: many }, { specDir: tmpdir() });
  assert.equal(issues.some((i) => i.level === "error"), false);
  const warns = issues.map((i) => i.message).join("\n");
  assert.match(warns, /several recommended options/);
  assert.match(warns, /missing file .*missing\.png/);
  assert.match(warns, /13 questions without sections/);
});

test("resolution rules cover every question type and flag", () => {
  const { spec } = normalizeSpec(
    {
      questions: [
        choice("single"),
        { ...choice("multi"), type: "multi", min: 2 },
        { ...choice("rank"), type: "rank" },
        { id: "scale", title: "?", type: "scale", scale: { min: 1, max: 5 } },
        { id: "text", title: "?", type: "text" },
        { id: "confirm", title: "?", type: "confirm" },
        { ...choice("opt"), optional: true },
      ],
    },
    { specDir: tmpdir() },
  );
  const q = Object.fromEntries(spec.questions.map((x) => [x.id, x]));
  const blank = (id) => logic.emptyAnswer(q[id]);

  assert.equal(logic.isResolved(q.single, blank("single")), false);
  assert.equal(logic.isResolved(q.single, { ...blank("single"), selected: ["b"] }), true);
  assert.equal(logic.isResolved(q.single, { ...blank("single"), other: "  " }), false);
  assert.equal(logic.isResolved(q.single, { ...blank("single"), other: "my own" }), true);
  assert.equal(logic.isResolved(q.multi, { ...blank("multi"), selected: ["a"] }), false);
  assert.equal(logic.isResolved(q.multi, { ...blank("multi"), selected: ["a", "b"] }), true);
  assert.equal(logic.isResolved(q.rank, blank("rank")), false);
  assert.equal(logic.isResolved(q.rank, { ...blank("rank"), touched: true }), true);
  assert.equal(logic.isResolved(q.scale, { ...blank("scale"), value: 4 }), true);
  assert.equal(logic.isResolved(q.text, { ...blank("text"), text: "answer" }), true);
  assert.deepEqual(
    q.confirm.options.map((o) => [o.id, o.label]),
    [
      ["yes", "Yes"],
      ["no", "No"],
      ["change", "Yes, with changes"],
    ],
  );
  assert.equal(logic.isResolved(q.opt, blank("opt")), true);
  for (const flag of ["explain", "delegate", "skip"]) {
    assert.equal(logic.isResolved(q.text, { ...blank("text"), flag }), true, flag);
  }
});

test("hidden conditional questions are excluded and unanswered ones fall back to the recommendation", () => {
  const { spec } = normalizeSpec(
    {
      questions: [
        choice("mode"),
        { ...choice("detail"), showIf: { q: "mode", in: ["b"] } },
        choice("later"),
      ],
    },
    { specDir: tmpdir() },
  );
  const answers = {
    mode: { ...logic.emptyAnswer(spec.questions[0]), selected: ["a"] },
    detail: logic.emptyAnswer(spec.questions[1]),
    later: logic.emptyAnswer(spec.questions[2]),
  };

  assert.equal(logic.isVisible(spec.questions[1], answers), false);
  assert.deepEqual(logic.progress(spec, answers), { resolved: 1, total: 2 });

  const final = logic.finalizeAnswers(spec, answers, { fill: true });
  assert.equal("detail" in final, false);
  assert.deepEqual(final.mode, { selected: ["a"] });
  assert.deepEqual(final.later, { selected: ["a"], flag: "delegate", auto: true });
});

test("digest tells the agent what was chosen, overridden, delegated or asked", () => {
  const { spec } = normalizeSpec(
    {
      title: "Round",
      questions: [
        choice("keep"),
        choice("override"),
        choice("custom"),
        choice("explain"),
        { id: "scale", title: "Scale", type: "scale", scale: { min: 1, max: 5, labels: { 5: "max" } } },
      ],
    },
    { specDir: tmpdir() },
  );
  const text = logic.digest(spec, {
    answers: {
      keep: { selected: ["a"], note: "fine" },
      override: { selected: ["b"] },
      custom: { selected: [], other: "Gamma" },
      explain: { selected: [], flag: "explain" },
      scale: { value: 5 },
    },
    comment: "ship it",
    attachments: ["/tmp/x.png"],
  });

  assert.match(text, /\[keep\] Question keep → Alpha ★/);
  assert.match(text, /fine/);
  assert.match(text, /\[override\] Question override → Beta \(against the recommendation: Alpha\)/);
  assert.match(text, /\[custom\] .*own option: "Gamma"/);
  assert.match(text, /\[explain\] .*explain in more detail/i);
  assert.match(text, /\[scale\] Scale → 5\/5 "max"/);
  assert.match(text, /Comment: ship it/);
  assert.match(text, /ship it/);
  assert.match(text, /\/tmp\/x\.png/);
});

test("labels the server writes itself follow the language of the questions", () => {
  const bare = (extra) => ({ sections: [{ id: "s" }], questions: [{ section: "s", type: "confirm" }, { options: [{}, {}] }], ...extra });
  const labels = (raw) => {
    const { spec } = normalizeSpec(raw, { specDir: tmpdir() });
    const [confirm, choice] = spec.questions;
    return [spec.lang, spec.title, spec.sections[0].title, confirm.title, confirm.options.map((o) => o.label).join("/"), choice.options[0].label];
  };

  assert.deepEqual(labels(bare()), ["en", "Decisions needed", "Section 1", "Question", "Yes/No/Yes, with changes", "Option 1"]);
  assert.deepEqual(labels(bare({ intro: "Пара вопросов" })), ["ru", "Нужно принять решения", "Раздел 1", "Вопрос", "Да/Нет/Да, но с правками", "Вариант 1"]);
  assert.equal(labels(bare({ lang: "ru" }))[0], "ru", "an explicit lang wins over detection");
  assert.equal(labels(bare({ lang: "en", intro: "Пара вопросов" }))[0], "en");
});

test("markdown-lite escapes HTML and marks glossary terms outside code", () => {
  const html = md("**MR** <script>x</script> `MR` [docs](https://example.com) и мр", {
    MR: "Merge request",
  });
  assert.match(html, /<strong><abbr class="term"[^>]*data-def="Merge request"[^>]*>MR<\/abbr><\/strong>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<code>MR<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  assert.equal(md("[x](javascript:alert(1))").includes("<a"), false);
  assert.match(md("- one\n- two"), /<ul><li>one<\/li><li>two<\/li><\/ul>/);
});

test("a round nobody has waited on for the grace period is not listened to", async (context) => {
  const { createRounds } = await import("../lib/rounds.mjs");
  const { createRoots } = await import("../lib/assets.mjs");
  const { normalizeSpec } = await import("../lib/spec.mjs");
  const dir = await mkdtemp(path.join(tmpdir(), "decide-rounds-"));
  context.after(() => rm(dir, { force: true, recursive: true }));
  const store = createRounds({ roots: createRoots(), onChange: () => {}, listenGraceMs: 0 });
  const round = store.create({ spec: normalizeSpec({ title: "t", questions: [{ id: "a", title: "A", options: [{ id: "x", label: "X" }] }] }).spec, outPath: path.join(dir, "t.answers.json") });
  assert.equal(store.summary().rounds[0].listening, false);
  const res = { writeHead: () => ({ end() {} }), end() {} };
  store.wait(round, { on() {} }, res, { timeoutMs: 1_000 });
  assert.equal(store.summary().rounds[0].listening, true);
});
