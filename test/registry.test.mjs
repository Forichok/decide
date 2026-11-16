/**
 * Feature:    registry of question types
 * Layer:      Unit (lib/registry, lib/spec.mjs, lib/swipe.mjs, ui/js/types) plus one --lint run
 * Contract:   one module per question type on each side; a spec with an unknown field is refused
 *             with the place and the nearest known name; every spec the repository ships passes
 * Covers:
 *   - unknown fields at the round, question, option, deck, card and side level, with the nearest name
 *   - every legacy spelling 2.1 read stays known; a field of another type is a warning, not an error
 *   - a string where an option is expected becomes its label
 *   - the registry's shape: FieldDefs, type modules, examples, summaries, strings in en and ru
 *   - every page module imports under Node and answers like logic.js says it does
 *   - the six 2.1 types normalise exactly as 2.1.1 did (a snapshot taken on f62a924)
 *   - every JSON spec in examples/ and in the docs passes the strict check
 *   - media kinds: one module per kind on each side, strict insides, generated schema and reference tables
 * Why exists: the owner's real 2.x specs must keep opening; a new type must be one module per side.
 * Isolation:  pure, except the --lint test, which has its own scratch DECIDE_HOME.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { enginePath, envOf, exitOf, homeOf, pluginDir, runEngine, scratchDir } from "./helpers.mjs";
import { spawnSync } from "node:child_process";
import { prepareSpec } from "../lib/prepare.mjs";
import { CARD_FIELDS, OPTION_FIELDS, QUESTION_FIELDS, ROUND_FIELDS, TYPES as REGISTRY } from "../lib/registry/index.mjs";
import { MISTAKES, nearest, unknownFields } from "../lib/registry/strict.mjs";
import { TYPES, normalizeSpec } from "../lib/spec.mjs";
import { normalizeDeck, normalizePatch } from "../lib/swipe.mjs";

const examples = path.join(pluginDir, "examples");
const load = (...rel) => import(pathToFileURL(path.join(pluginDir, ...rel)).href);
const errorsOf = (issues) => issues.filter((i) => i.level === "error").map((i) => `${i.where}: ${i.message}`);
const warnsOf = (issues) => issues.filter((i) => i.level === "warn").map((i) => `${i.where}: ${i.message}`);
const opts = (...labels) => labels.map((l) => ({ id: l.toLowerCase(), label: l }));

test("an unknown field is an error with the nearest name", () => {
  const { issues } = normalizeSpec({ questions: [{ id: "a", title: "t", optoins: ["x", "y"] }] });
  assert.match(errorsOf(issues)[0], /unknown field "optoins".*"options"/);
});

test("the message names the place: round, question and option level", () => {
  const q = (i) => ({ id: `q${i}`, title: "t", options: opts("A", "B") });
  const { issues } = normalizeSpec({
    titel: "Round",
    questions: [q(0), q(1), { ...q(2), options: [{ id: "a", lable: "A" }, { id: "b", label: "B" }] }],
  });
  assert.deepEqual(
    issues.filter((i) => /unknown field/.test(i.message)).map((i) => `${i.level} ${i.where}: ${i.message}`),
    ['error round: unknown field "titel"; did you mean "title"?', 'error questions[2].options[0]: unknown field "lable"; did you mean "label"?'],
  );
});

test("a field far from every known name is refused without a suggestion", () => {
  const { issues } = normalizeSpec({ questions: [{ id: "a", title: "t", options: opts("A", "B"), zzzzzzzz: 1 }] });
  assert.deepEqual(errorsOf(issues), ['questions[0]: unknown field "zzzzzzzz"']);
});

test("a string where an option is expected becomes its label", () => {
  const { spec } = normalizeSpec({ questions: [{ id: "db", title: "Which?", options: ["Postgres", "SQLite"] }] });
  assert.deepEqual(spec.questions[0].options.map((o) => o.label), ["Postgres", "SQLite"]);
  assert.deepEqual(spec.questions[0].options.map((o) => o.id), ["a", "b"]);
});

test("a field that belongs to another type is a warning, never an error", () => {
  const { spec, issues } = normalizeSpec({ questions: [{ id: "a", title: "t", type: "single", options: opts("A", "B"), max: 2, scale: { min: 1, max: 3 } }] });
  assert.deepEqual(errorsOf(issues), []);
  assert.ok(warnsOf(issues).some((w) => /"max".*single|single.*"max"/.test(w)), warnsOf(issues).join("\n"));
  assert.equal(spec.questions[0].max, 2, "2.1 kept the value, so does 3.0");
});

test("an unknown type is refused with a suggestion and does not pile unknown-field errors on top", () => {
  const { issues } = normalizeSpec({ questions: [{ id: "a", title: "t", type: "sinlge", options: opts("A", "B"), scale: { min: 1, max: 3 } }] });
  assert.equal(errorsOf(issues).length, 1, errorsOf(issues).join("\n"));
  assert.match(errorsOf(issues)[0], /unknown type "sinlge".*did you mean "single"/);
});

test("every spelling 2.1 read stays known", () => {
  const { issues } = normalizeSpec({
    title: "Legacy",
    lang: "en",
    intro: "i",
    recap: "r",
    context: "c",
    glossary: { A: "b" },
    budget: 10,
    sections: [{ id: "s", title: "S", intro: "x" }],
    questions: [
      { id: "b", section: "s", question: "A title written as question", note: true, options: [{ id: "x", label: "X", recommended: true, image: "https://e.com/a.png", link: "https://e.com", videos: [] }, { id: "y", label: "Y" }] },
      {
        id: "a",
        title: "A",
        note: "tell me",
        priority: 2,
        showIf: [{ question: "b", selected: ["x"] }, { q: "b", in: ["x"], notIn: ["y"] }],
        options: [{ id: "x", label: "X", recommended: "because", reason: "r", pros: ["p"], cons: ["c"], metrics: { Speed: 4 }, tags: ["t"], danger: true, detail: "d", image: "https://e.com/a.png", images: [], links: [] }, { id: "y", label: "Y" }],
        image: "https://e.com/b.png",
        images: [],
        videos: [],
        link: "https://e.com",
        links: [],
        layout: "grid",
        default: ["x"],
        allowOther: false,
        stakes: "high",
        reversible: false,
        optional: true,
        mine: false,
      },
    ],
  });
  assert.deepEqual(errorsOf(issues), []);
});

test("the same names stay known on a swipe deck, its cards and sides", () => {
  const card = {
    id: "c",
    section: "s",
    title: "t",
    tldr: "t",
    body: "b",
    what: "w",
    how: "h",
    why: "w",
    goal: "g",
    then: "t",
    recommended: "left",
    reason: "r",
    from: "x",
    stakes: "high",
    image: "https://e.com/a.png",
    left: { label: "L", detail: "d", image: "https://e.com/l.png" },
    right: "R",
  };
  const { issues } = normalizeDeck({ title: "D", lang: "en", goal: "g", intro: "i", recap: "r", glossary: {}, brief: ["b"], confidence: 10, batch: 3, cards: [card] });
  assert.deepEqual(errorsOf(issues), []);
});

test("an unknown field on a deck, a card, a side and a pushed card names the place", () => {
  const card = (extra = {}, left = "L") => ({ id: "c", title: "t", left, right: "R", ...extra });
  const { issues } = normalizeDeck({ titel: "D", goal: "g", cards: [card(), card({ tldr2: "x" }, { label: "L", detial: "d" })] });
  const found = issues.filter((i) => /unknown field/.test(i.message)).map((i) => `${i.where}: ${i.message}`);
  assert.deepEqual(found, [
    'deck: unknown field "titel"; did you mean "title"?',
    'cards[1]: unknown field "tldr2"; did you mean "tldr"?',
    'cards[1].left: unknown field "detial"; did you mean "detail"?',
  ]);
  const pushed = normalizePatch({ add: [card({ bdoy: "x" })] });
  assert.deepEqual(pushed.issues.filter((i) => /unknown field/.test(i.message)).map((i) => `${i.where}: ${i.message}`), ['add[0]: unknown field "bdoy"; did you mean "body"?']);
});

test("a card with options keeps its one message, not a second about an unknown field", () => {
  const { issues } = normalizeDeck({ goal: "g", cards: [{ id: "x", title: "?", options: [{ label: "a" }], left: "a", right: "b" }] });
  assert.deepEqual(errorsOf(issues), ['cards[0] (x): a swipe card has exactly two sides: left and right, not options']);
});

test("an unknown field refuses the spec in prepareSpec, which ask and lint both use", async () => {
  const { errors } = await prepareSpec({ questions: [{ id: "a", title: "t", optoins: ["x"] }] }, { specDir: pluginDir, dataDir: pluginDir, shots: false });
  assert.ok(errors.some((e) => /unknown field "optoins"; did you mean "options"/.test(e.message)), JSON.stringify(errors));
});

test("--lint refuses an unknown field and names the place", async (context) => {
  const scratch = await scratchDir(context);
  const file = path.join(scratch, "typo.json");
  await writeFile(file, JSON.stringify({ questions: [{ id: "a", title: "t", options: [{ id: "x", lable: "X" }] }] }));
  const { child, output } = runEngine(context, scratch, ["--lint", file]);
  assert.equal(await exitOf(child), 1);
  assert.match(output.stdout + output.stderr, /questions\[0\]\.options\[0\]: unknown field "lable"; did you mean "label"\?/);
});

test("nearest: edit distance of at most 2, or a shared prefix of 4; a tie goes to the first", () => {
  assert.equal(nearest("optoins", ["id", "options", "title"]), "options");
  assert.equal(nearest("Options", ["options"]), "options", "case does not count");
  assert.equal(nearest("previewHeigth", ["preview", "previewHeight"]), "previewHeight");
  assert.equal(nearest("recommendation", ["recommended", "reason"]), null, "a shared prefix is not nearness");
  assert.equal(nearest("abx", ["abc", "abd"]), "abc", "on a tie the first in the list wins");
  assert.equal(nearest("abx", ["abd", "abc"]), "abd");
  assert.equal(nearest("tle", ["title", "tile"]), "tile", "the closer one beats the earlier one");
  assert.equal(nearest("zzzzzzzz", ["title", "options"]), null);
  assert.equal(nearest("abc", []), null);
});

test("unknownFields adds one error per unknown name and skips what is not an object", () => {
  const seen = [];
  const add = (...a) => seen.push(a);
  unknownFields({ id: 1, lable: 2, zzzzzz: 3 }, ["id", "label"], "x[0]", add);
  unknownFields("Postgres", ["id"], "x[1]", add);
  unknownFields(null, ["id"], "x[2]", add);
  unknownFields(["a"], ["id"], "x[3]", add);
  assert.deepEqual(seen, [
    ["error", "x[0]", 'unknown field "lable"; did you mean "label"?'],
    ["error", "x[0]", 'unknown field "zzzzzz"'],
  ]);
});

const FIELD_TYPES = new Set(["string", "number", "boolean", "enum", "array", "object", "any", "union"]);
function checkFieldDef(def, where) {
  assert.ok(FIELD_TYPES.has(def.type), `${where}: type ${def.type}`);
  assert.equal(typeof def.doc, "string", where);
  assert.ok(def.doc.length > 3, `${where}: doc`);
  if (def.type === "enum") assert.ok(Array.isArray(def.values) && def.values.length, `${where}: enum needs values`);
  if (def.items) checkFieldDef(def.items, `${where}[]`);
  if (def.type === "union") assert.ok(def.of.length > 1, `${where}: a union lists its shapes`);
  def.of?.forEach((alt, i) => checkFieldDef(alt, `${where}|${i}`));
  for (const [k, f] of Object.entries(def.fields || {})) checkFieldDef(f, `${where}.${k}`);
}

test("the registry lists the six types in the 2.1 order and spec.mjs takes TYPES from it", () => {
  assert.deepEqual([...REGISTRY.keys()], ["single", "multi", "rank", "scale", "text", "confirm"]);
  assert.deepEqual(TYPES, [...REGISTRY.keys()]);
  for (const [name, def] of REGISTRY) assert.equal(def.name, name);
});

test("every field of the registry is a FieldDef with a doc", () => {
  for (const [name, fields] of [["round", ROUND_FIELDS], ["question", QUESTION_FIELDS], ["option", OPTION_FIELDS]]) {
    assert.ok(Object.keys(fields).length > 5, name);
    for (const [k, f] of Object.entries(fields)) checkFieldDef(f, `${name}.${k}`);
  }
  for (const [name, def] of REGISTRY) {
    for (const key of ["fields", "optionFields"]) for (const [k, f] of Object.entries(def[key] || {})) checkFieldDef(f, `${name}.${key}.${k}`);
    assert.equal(typeof def.normalize, "function", name);
    assert.equal(typeof def.lint, "function", name);
  }
  assert.ok(QUESTION_FIELDS.title && QUESTION_FIELDS.question, "the legacy title spelling is listed");
});

test("every type has a summary, an example that validates and strings in en and ru", async () => {
  const [en, ru] = await Promise.all(["en", "ru"].map(async (l) => (await load("ui/js/lang", `${l}.js`)).default));
  for (const [name, def] of REGISTRY) {
    assert.equal(typeof def.summary, "string", name);
    assert.ok(def.summary.length > 10, `${name}: summary`);
    assert.equal(def.example.type, name, `${name}: the example says its type`);
    for (const key of [`type.${name}`, `type.${name}.hint`]) {
      assert.ok(typeof en[key] === "string" && en[key], `en: ${key}`);
      assert.ok(typeof ru[key] === "string" && ru[key], `ru: ${key}`);
    }
  }
});

test("every example of every type validates with no error and no warning", () => {
  for (const [name, def] of REGISTRY) {
    const { spec, issues } = normalizeSpec({ title: "t", questions: [def.example] });
    assert.deepEqual(issues, [], `${name}: ${JSON.stringify(issues)}`);
    assert.equal(spec.questions[0].type, name);
  }
});

test("every type has a page module that imports under Node", async () => {
  const index = await load("ui/js/types/index.js");
  assert.deepEqual([...index.TYPES.keys()], [...REGISTRY.keys()], "the page lists the same types as the engine");
  for (const name of REGISTRY.keys()) {
    const mod = await load("ui/js/types", `${name}.js`);
    for (const fn of ["emptyAnswer", "isAnswered", "describe", "render"]) assert.equal(typeof mod[fn], "function", `${name}.${fn}`);
  }
  const has = (name, member) => typeof index.TYPES.get(name)[member] !== "undefined";
  assert.deepEqual(["single", "multi", "confirm", "scale"].filter((n) => !has(n, "keys")), [], "the number keys work on these");
  assert.deepEqual(["multi", "rank"].filter((n) => !has(n, "badge")), [], "these show a badge under the title");
  assert.equal(typeof document, "undefined", "nothing in the page modules created a DOM");
});

test("the page modules answer as logic.js did", async () => {
  const logic = await load("ui/js/logic.js");
  const { spec } = normalizeSpec({
    questions: [
      { id: "s", title: "S", options: opts("A", "B"), default: ["b"] },
      { id: "m", title: "M", type: "multi", min: 2, options: opts("A", "B", "C") },
      { id: "r", title: "R", type: "rank", options: opts("A", "B", "C"), default: ["c"] },
      { id: "k", title: "K", type: "scale", scale: { min: 1, max: 5, labels: { 5: "great" } } },
      { id: "t", title: "T", type: "text" },
      { id: "c", title: "C", type: "confirm" },
    ],
  });
  const [s, m, r, k, t, c] = spec.questions;
  assert.deepEqual(logic.emptyAnswer(s).selected, ["b"]);
  assert.deepEqual(logic.emptyAnswer(r).order, ["c", "a", "b"]);
  assert.deepEqual(logic.emptyAnswer(r).selected, []);
  assert.deepEqual(Object.keys(logic.emptyAnswer(t)).sort(), ["attachments", "flag", "note", "order", "other", "pins", "selected", "text", "touched", "value"]);
  assert.equal(logic.isAnswered(m, { ...logic.emptyAnswer(m), selected: ["a"] }), false, "multi wants min answers");
  assert.equal(logic.isAnswered(m, { ...logic.emptyAnswer(m), selected: ["a"], other: "own" }), true, "an own option counts");
  assert.equal(logic.isAnswered(r, { ...logic.emptyAnswer(r), touched: true }), true);
  assert.equal(logic.isAnswered(k, { ...logic.emptyAnswer(k), value: 0 }), true);
  assert.equal(logic.isAnswered(t, { ...logic.emptyAnswer(t), text: "  " }), false);
  assert.equal(logic.isAnswered(c, { ...logic.emptyAnswer(c), selected: ["yes"] }), true);
  assert.equal(logic.describe(k, { value: 5 }), '5/5 "great"');
  assert.equal(logic.describe(r, { order: ["b", "a", "c"] }), "B > A > C");
  assert.equal(logic.describe(t, { text: "hi" }), '"hi"');
  assert.equal(logic.describe(s, { flag: "delegate", selected: ["a"], other: "mine" }), '🤝 up to the agent · A · own option: "mine"');
});

// ---- the 2.1 snapshot

// Anything that depends on the machine is replaced by a token on both sides of the comparison.
function tokenise(value, dir) {
  if (typeof value === "string") return value.startsWith(dir) ? `<specDir>${value.slice(dir.length).replace(/\\/g, "/")}` : value;
  if (Array.isArray(value)) return value.map((v) => tokenise(v, dir));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tokenise(v, dir)]));
  return value;
}

test("the six 2.1 types normalise exactly as before", () => {
  const raw = JSON.parse(readFileSync(path.join(pluginDir, "test/fixtures/2.1/showcase.questions.json"), "utf8"));
  const now = JSON.parse(JSON.stringify(normalizeSpec(raw, { specDir: examples })));
  const before = JSON.parse(readFileSync(path.join(pluginDir, "test/fixtures/2.1/showcase.normalized.json"), "utf8"));
  // Three things moved in 3.0: the folded points became `more` (test/migrate.test.mjs checks the text) and each option has
  // a `then`. Everything else is what 2.1 wrote.
  for (const q of before.spec.questions) {
    for (const k of ["what", "how", "goal", "then"]) delete q[k];
    for (const o of q.options) o.then = "";
  }
  for (const q of now.spec.questions) delete q.more;
  // The new lint asks for `why` and `then`; the 2.1 showcase has few of them.
  now.issues = now.issues.filter((i) => !/^("[^"]+" has no "why"|no "then" on )/.test(i.message));
  for (const q of now.spec.questions) { delete q.dependsOn; for (const o of q.options) delete o.evidence; }
  delete now.spec.brief;
  assert.deepEqual(tokenise(now, examples), before);
  const types = new Set(now.spec.questions.map((q) => q.type));
  assert.deepEqual([...types].sort(), [...REGISTRY.keys()].sort(), "the showcase uses all six types, so the snapshot covers them");
});

// ---- every spec the repository ships

// Every file under dir, by hand: readdirSync's recursive option needs Node 20.1 and package.json says 20.
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.isFile() ? [path.join(dir, e.name)] : []));
}

// Every error counts, not only the unknown names: a sample in the docs that does not hold is wrong.
const strictErrors = errorsOf;

function check(label, json, specDir) {
  if (Array.isArray(json?.questions)) return [label, strictErrors(normalizeSpec(json, { specDir }).issues)];
  if (Array.isArray(json?.cards)) return [label, strictErrors(normalizeDeck(json, { specDir }).issues)];
  if (json?.left && json?.right) return [label, strictErrors(normalizeDeck({ goal: "g", cards: [json] }, { specDir }).issues)];
  return null;
}

test("every JSON spec in examples/ passes the strict check", () => {
  const files = walk(examples).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 3, "the walk found the examples");
  for (const f of files) {
    const res = check(path.relative(pluginDir, f), JSON.parse(readFileSync(f, "utf8")), path.dirname(f));
    assert.ok(res, `${f} is neither a questions spec nor a deck`);
    assert.deepEqual(res[1], [], res[0]);
  }
});

test("every whole spec quoted in the README and the skills passes the strict check", () => {
  const files = [path.join(pluginDir, "README.md"), ...walk(path.join(pluginDir, "skills")).filter((f) => f.endsWith(".md"))];
  let found = 0;
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(/```json\n([\s\S]*?)```/g)) {
      let json;
      try {
        json = JSON.parse(m[1]);
      } catch {
        continue;
      }
      const res = check(path.relative(pluginDir, f), json, examples);
      if (!res) continue;
      found += 1;
      assert.deepEqual(res[1], [], res[0]);
    }
  }
  assert.ok(found >= 4, `found ${found} whole specs in the docs`);
});

// ---- fix round 1: strict for a spec handed in now, lenient for one read back

// What 2.1 let through and stored: a description on an option, a recommended on the question.
const oldRound = () => ({
  title: "Old",
  questions: [{ id: "color", title: "Which colour?", recommended: "pink", options: [{ id: "pink", label: "Pink", description: "warm" }, { id: "blue", label: "Blue" }] }],
});

test("fields: lenient turns an unknown name into a warning with the same text; other errors stay errors", () => {
  const strict = normalizeSpec(oldRound());
  const lenient = normalizeSpec(oldRound(), { fields: "lenient" });
  const unknown = (issues) => issues.filter((i) => /unknown field/.test(i.message)).map((i) => `${i.where}: ${i.message}`);
  assert.deepEqual(unknown(strict.issues), unknown(lenient.issues), "the same text");
  assert.equal(unknown(strict.issues).length, 2);
  assert.equal(errorsOf(strict.issues).length, 2);
  assert.deepEqual(errorsOf(lenient.issues), [], "no error");
  assert.equal(warnsOf(lenient.issues).filter((w) => /unknown field/.test(w)).length, 2);
  assert.ok(lenient.spec, "the round goes on");
  const bad = normalizeSpec({ questions: [{ id: "a", title: "t", type: "scale", scale: { min: 5, max: 1 }, showIf: [{ q: "nope", in: ["x"] }], zzz: 1 }] }, { fields: "lenient" });
  assert.deepEqual(errorsOf(bad.issues).map((e) => e.replace(/^[^:]*: /, "")), ["scale needs min < max and at most 11 steps", 'showIf references unknown question "nope"']);
  const deck = { goal: "g", cards: [{ id: "c", title: "T?", why: "w", left: { label: "a", extra: 1 }, right: "b", colour: 1 }], oops: 1 };
  assert.equal(errorsOf(normalizeDeck(deck).issues).length, 3);
  assert.deepEqual(errorsOf(normalizeDeck(deck, { fields: "lenient" }).issues), []);
  assert.equal(warnsOf(normalizeDeck(deck, { fields: "lenient" }).issues).filter((w) => /unknown field/.test(w)).length, 3);
});

test("a 2.1 round: --lint refuses it and names the place; ask refuses it", async (context) => {
  const scratch = await scratchDir(context);
  const file = path.join(scratch, "old.questions.json");
  await writeFile(file, JSON.stringify(oldRound()));
  const { child, output } = runEngine(context, scratch, ["--lint", file]);
  assert.equal(await exitOf(child), 1);
  const said = output.stdout + output.stderr;
  assert.match(said, /questions\[0\]: unknown field "recommended"; "recommended" is an option field: put it on the option/);
  assert.match(said, /questions\[0\]\.options\[0\]: unknown field "description"; did you mean "detail"\?/);
  const { HANDLERS } = await import(pathToFileURL(path.join(pluginDir, "test/helpers.mjs")).href);
  const before = process.env.DECIDE_HOME;
  process.env.DECIDE_HOME = homeOf(scratch);
  try {
    await assert.rejects(HANDLERS.ask({ project: scratch, spec: oldRound(), open: false }), /unknown field "description"/);
  } finally {
    if (before === undefined) delete process.env.DECIDE_HOME;
    else process.env.DECIDE_HOME = before;
  }
});

test("a 2.1 round: --import with its spec imports the answers and prints the warnings", async (context) => {
  const scratch = await scratchDir(context);
  const specFile = path.join(scratch, "old.questions.json");
  writeFileSync(specFile, JSON.stringify(oldRound()));
  const answers = path.join(scratch, "5-abcdef.theirs.json");
  writeFileSync(answers, JSON.stringify({ version: 2, round: "5-abcdef", name: "Ann", answers: { color: { selected: ["pink"] } } }));
  const res = spawnSync(process.execPath, [enginePath, "--import", answers, "--spec", specFile, "--project", scratch], { env: envOf(scratch), encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.match(res.stdout, /Pink/);
  assert.match(res.stdout, /Warnings:[\s\S]*spec questions\[0\]\.options\[0\]: unknown field "description"; did you mean "detail"\?/);
  assert.match(res.stdout, /spec questions\[0\]: unknown field "recommended"/);
});

test("nearest is strict on short names: no nonsense suggestions", () => {
  const option = Object.keys(OPTION_FIELDS);
  const question = Object.keys(QUESTION_FIELDS);
  for (const [name, known] of [["note", option], ["img", question], ["kind", question], ["hint", question], ["img", option], ["kind", option]]) {
    assert.equal(nearest(name, known), null, `${name} suggests nothing`);
  }
  assert.equal(nearest("lable", option), "label", "a swapped pair of letters is one edit");
  assert.equal(nearest("titel", question), "title");
  assert.equal(nearest("detials", option), "detail", "a longer name may be two edits off");
  assert.equal(nearest("tag", option), "tags");
});

test("an option or question field met one level away says where it goes", () => {
  const said = (q, o) => {
    const { issues } = normalizeSpec({ questions: [{ id: "a", title: "t", ...q, options: [{ id: "x", label: "X", ...o }, { id: "y", label: "Y" }] }] });
    return errorsOf(issues).map((e) => e.replace(/^[^:]*: /, ""));
  };
  for (const name of ["recommended", "danger"]) {
    assert.deepEqual(said({ [name]: true }, {}), [`unknown field "${name}"; "${name}" is an option field: put it on the option`], name);
  }
  assert.deepEqual(said({}, { default: ["x"], optional: true }), ["default", "optional"].map((n) => `unknown field "${n}"; "${n}" is a question field: put it on the question`));
  assert.deepEqual(said({}, { how: "x", note: "y" }), ["how", "note"].map((n) => `unknown field "${n}"; "${n}" is a question field; for text on one option use its "detail"`));
  assert.deepEqual(said({ detail: "d" }, {}), ['unknown field "detail"; "detail" is an option field; the question has no "detail": "tldr" is its one line, "body" its longer text']);
  assert.deepEqual(said({ label: "l" }, {}), ['unknown field "label"; "label" is an option field; the question has no "label": its words are "title"']);
});

test("the table of common mistakes", () => {
  assert.deepEqual(MISTAKES, { question: { multi: '"type": "multi"' }, option: { description: '"detail"', title: '"label"' } });
  const run = (q, o) => errorsOf(normalizeSpec({ questions: [{ id: "a", title: "t", ...q, options: [{ id: "x", label: "X", ...o }, { id: "y", label: "Y" }] }] }).issues).map((e) => e.replace(/^[^:]*: /, ""));
  assert.deepEqual(run({}, { description: "d" }), ['unknown field "description"; did you mean "detail"?']);
  assert.deepEqual(run({}, { title: "T" }), ['unknown field "title"; did you mean "label"?']);
  assert.deepEqual(run({ multi: true }, {}), ['unknown field "multi"; did you mean "type": "multi"?']);
  assert.deepEqual(run({}, { lable: "L" }), ['unknown field "lable"; did you mean "label"?'], "a typo still goes by distance");
});

test("a field another type reads is one warning, naming the types, however many there are", () => {
  const { issues } = normalizeSpec({ questions: [{ id: "k", title: "t", type: "single", options: ["a", "b"], scale: { min: 1, max: 5 } }] });
  const warns = warnsOf(issues).filter((w) => /"scale"/.test(w));
  assert.equal(warns.length, 1, warns.join("\n"));
  assert.match(warns[0], /field "scale" belongs to scale questions, not to single ones; leave it out/);
  assert.ok(!/ignored/.test(warns[0]), "it does not say what is not true");
});

test("a card has no question field: nothing reads it, so it is an unknown name that points at title", () => {
  assert.equal(CARD_FIELDS.question, undefined);
  const { issues } = normalizeDeck({ goal: "g", cards: [{ id: "c", question: "Ship it?", why: "w", left: "yes", right: "no" }] });
  assert.match(errorsOf(issues).join("\n"), /unknown field "question"/);
});

// ---- fix round 1: a new type is one module per side

test("a seventh type, registered in the test only, keeps its answer in the answers file and in checkAnswers", async () => {
  const { TYPES: PAGE } = await load("ui/js/types/index.js");
  const logic = await load("ui/js/logic.js");
  const { checkAnswers } = await load("lib/answers.mjs");
  REGISTRY.set("pair", {
    name: "pair",
    summary: "Two numbers.",
    fields: {},
    normalize() {},
    lint() {},
    example: { id: "p", type: "pair", title: "Two numbers?" },
  });
  PAGE.set("pair", {
    emptyAnswer: () => ({ pair: null }),
    isAnswered: (q, a) => Array.isArray(a.pair),
    describe: (q, r) => (r.pair ? `${r.pair[0]} and ${r.pair[1]}` : ""),
    render() {},
    compact: (q, a) => (a.pair ? { pair: [...a.pair] } : {}),
    check: (q, raw, { warn }) => {
      if (!Array.isArray(raw.pair) || raw.pair.length !== 2) return {};
      if (!raw.pair.every(Number.isFinite)) warn("pair needs two numbers");
      return { pair: raw.pair.filter(Number.isFinite) };
    },
    recommend: (q, a) => ({ ...a, pair: [0, 0] }),
  });
  try {
    const { spec, issues } = normalizeSpec({ questions: [{ id: "p", type: "pair", title: "Two numbers?" }] });
    assert.deepEqual(errorsOf(issues), []);
    const [q] = spec.questions;
    const done = logic.finalizeAnswers(spec, { p: { ...logic.emptyAnswer(q), pair: [3, 4] } });
    assert.deepEqual(done, { p: { pair: [3, 4] } }, "compact keeps the answer");
    const filled = logic.finalizeAnswers(spec, {}, { fill: "recommend" });
    assert.deepEqual(filled.p, { pair: [0, 0], flag: "delegate", auto: true }, "recommend fills it in");
    const checked = checkAnswers(spec, { answers: { p: { pair: [3, 4], junk: 1 } } });
    assert.deepEqual(checked.errors, []);
    assert.deepEqual(checked.answers, { p: { pair: [3, 4] } }, "check keeps the answer and nothing else");
    assert.equal(logic.describe(q, { pair: [3, 4] }), "3 and 4");
  } finally {
    REGISTRY.delete("pair");
    PAGE.delete("pair");
  }
});

test("the six types write the answers file as they did: key order and content", async () => {
  const logic = await load("ui/js/logic.js");
  const { checkAnswers } = await load("lib/answers.mjs");
  const { spec } = normalizeSpec({
    questions: [
      { id: "s", title: "S", options: [{ id: "a", label: "A", recommended: true }, { id: "b", label: "B" }] },
      { id: "m", title: "M", type: "multi", options: [{ id: "a", label: "A", recommended: true }, { id: "b", label: "B", recommended: true }] },
      { id: "r", title: "R", type: "rank", options: opts("A", "B") },
      { id: "k", title: "K", type: "scale" },
      { id: "t", title: "T", type: "text" },
      { id: "c", title: "C", type: "confirm" },
    ],
  });
  const answers = {
    s: { ...logic.emptyAnswer(spec.questions[0]), selected: ["b"], other: "mine", note: "n" },
    m: { ...logic.emptyAnswer(spec.questions[1]), selected: ["a", "b"] },
    r: { ...logic.emptyAnswer(spec.questions[2]), order: ["b", "a"], touched: true },
    k: { ...logic.emptyAnswer(spec.questions[3]), value: 4 },
    t: { ...logic.emptyAnswer(spec.questions[4]), text: " hi " },
    c: { ...logic.emptyAnswer(spec.questions[5]), selected: ["yes"], flag: "explain" },
  };
  const out = logic.finalizeAnswers(spec, answers);
  assert.equal(
    JSON.stringify(out),
    '{"s":{"selected":["b"],"other":"mine","note":"n"},"m":{"selected":["a","b"]},"r":{"order":["b","a"]},"k":{"value":4},"t":{"text":"hi"},"c":{"selected":["yes"],"flag":"explain"}}',
  );
  const filled = logic.finalizeAnswers(spec, {}, { fill: "recommend" });
  assert.equal(JSON.stringify(filled.s), '{"selected":["a"],"flag":"delegate","auto":true}');
  assert.equal(JSON.stringify(filled.m), '{"selected":["a","b"],"flag":"delegate","auto":true}');
  assert.equal(JSON.stringify(filled.r), '{"order":["a","b"],"flag":"delegate","auto":true}');
  const back = checkAnswers(spec, { answers: JSON.parse(JSON.stringify(out)) });
  assert.deepEqual(back.answers, out);
  const odd = checkAnswers(spec, { answers: { s: { selected: ["a", "b", "zz"] }, m: { selected: ["a", "b", "zz"] }, k: { value: 99 } } });
  assert.deepEqual(odd.answers, { s: { selected: ["a"] }, m: { selected: ["a", "b"] }, k: { value: 5 } });
  assert.deepEqual(odd.warnings, ['s: unknown option "zz" dropped', 'm: unknown option "zz" dropped']);
});

test("the round's ctx is not written to by the page", () => {
  const source = readFileSync(path.join(pluginDir, "ui/js/inputs.js"), "utf8");
  assert.ok(!/ctx\.\w+\s*(\?\?|\|\||&&)?=[^=]/.test(source), "inputs.js assigns nothing on ctx");
  const round = readFileSync(path.join(pluginDir, "ui/js/round.js"), "utf8");
  assert.match(round, /\n\s+t,\n\s+renderMedia,\n/, "round.js puts the page's t and renderMedia on ctx");
});

// ---- Task 12: media kinds, the generated schema and the reference tables

const KINDS = ["images", "preview", "html", "mermaid", "code", "compare", "video", "diff", "table", "chart", "links"];
const registry = () => load("lib/registry/index.mjs");
const docs = () => load("lib/registry/docs.mjs");

// A directory with the files the media examples point at.
async function mediaDir(context) {
  const dir = await mkdtemp(path.join(tmpdir(), "decide-media-reg-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  for (const f of ["card.html", "after.html", "before.png", "after.png", "clip.mp4"]) await writeFile(path.join(dir, f), "x");
  return dir;
}
const mediaQuestion = (extra = {}, option = {}) => ({ questions: [{ id: "q", title: "t", why: "w", options: [{ id: "a", label: "A", then: "x", recommended: true, ...option }, { id: "b", label: "B", then: "y" }], ...extra }] });
const unknownOf = (issues) => issues.filter((i) => /unknown field/.test(i.message)).map((i) => `${i.level} ${i.where}: ${i.message}`);

test("every media kind has a page module, a doc row and a valid example", async (context) => {
  const { MEDIA, MEDIA_FIELDS } = await registry();
  const { docTables } = await docs();
  const dir = await mediaDir(context);
  assert.deepEqual([...MEDIA.keys()], KINDS);
  const page = await load("ui/js/media/index.js");
  assert.deepEqual([...page.MEDIA.keys()].sort(), [...KINDS].sort(), "the page lists the same kinds as the engine");
  const rows = docTables().media;
  for (const [name, def] of MEDIA) {
    assert.equal(def.name, name);
    assert.ok(typeof def.summary === "string" && def.summary.length > 10 && !/\n/.test(def.summary), `${name}: a one-line summary`);
    checkFieldDef(def.field, `${name}.field`);
    for (const [k, f] of Object.entries(def.extra || {})) checkFieldDef(f, `${name}.extra.${k}`);
    assert.equal(typeof def.normalize, "function", name);
    assert.equal(typeof def.lint, "function", name);
    assert.ok(rows.includes(`\`${name}\``), `${name}: a row in the table`);
    const mod = await load("ui/js/media", `${name}.js`);
    assert.equal(typeof mod.render, "function", `${name}: page render`);
    assert.ok(MEDIA_FIELDS[name] === def.field, `${name}: its field is in MEDIA_FIELDS`);
    for (const k of Object.keys(def.extra || {})) assert.ok(MEDIA_FIELDS[k], `${name}: ${k} is in MEDIA_FIELDS`);
    const { spec, issues } = normalizeSpec(mediaQuestion(def.example), { specDir: dir });
    assert.deepEqual(issues, [], `${name}: ${JSON.stringify(issues)}`);
    assert.ok(spec.questions[0][name] && (!Array.isArray(spec.questions[0][name]) || spec.questions[0][name].length), `${name}: the example makes a node`);
  }
  assert.equal(typeof document, "undefined", "nothing in the page modules created a DOM at import");
});

test("every media field name belongs to exactly one kind, and an alias names a field that exists", async () => {
  const { MEDIA, MEDIA_FIELDS } = await registry();
  const owners = new Map();
  for (const def of MEDIA.values()) for (const k of [def.name, ...Object.keys(def.extra || {})]) owners.set(k, [...(owners.get(k) || []), def.name]);
  for (const [k, who] of owners) assert.equal(who.length, 1, `${k}: ${who}`);
  assert.deepEqual([...owners.keys()].sort(), Object.keys(MEDIA_FIELDS).sort());
  for (const [k, f] of Object.entries(MEDIA_FIELDS)) if (f.alias) assert.ok(MEDIA_FIELDS[f.alias], `${k} stands for ${f.alias}`);
  assert.deepEqual(
    Object.entries(MEDIA_FIELDS).filter(([, f]) => f.alias).map(([k, f]) => `${k}->${f.alias}:${owners.get(k)}`).sort(),
    ["image->images:images", "link->links:links", "videos->video:video"],
  );
});

test("the aliases of 2.1 and the shapes it let through are still known inside a media node", async (context) => {
  const dir = await mediaDir(context);
  const spec = mediaQuestion({
    image: "before.png",
    videos: ["clip.mp4"],
    link: "https://e.com",
    images: [{ src: "before.png", caption: "c" }, { path: "after.png", alt: "a" }, { shot: "http://localhost:1/", viewport: "mobile", caption: "c", name: "n", waitMs: 5 }, { sim: "ios", device: "d", caption: "c", name: "n" }],
    html: { html: "<b>x</b>", maxHeight: 200 },
    code: { source: "x", lang: "js", diff: false },
    compare: { before: { path: "before.png", label: "a" }, after: "after.png", labels: ["a", "b"] },
    video: { path: "clip.mp4", caption: "c", loop: true },
    diff: { before: "a", after: "b", lang: "js", labels: ["a", "b"] },
    table: { columns: ["a", { id: "b", label: "B" }], rows: [["1", "2"]], caption: "c" },
    chart: { type: "line", labels: ["a", "b"], series: [{ label: "x", data: [1, 2] }, { name: "y", values: [3, 4] }], unit: "u", title: "t" },
    links: ["https://e.com", { label: "l", url: "https://e.com" }],
  });
  const { issues } = normalizeSpec(spec, { specDir: dir, fields: "strict" });
  assert.deepEqual(unknownOf(issues), []);
  const bare = normalizeSpec(mediaQuestion({ chart: { series: [1, 2] }, table: { rows: [{ a: 1 }] }, video: "clip.mp4", images: "before.png", links: { url: "https://e.com" } }), { specDir: dir });
  assert.deepEqual(unknownOf(bare.issues), []);
});

test("an unknown field inside a media node is an error with its place and the nearest name", async (context) => {
  const dir = await mediaDir(context);
  const run = (extra, option) => unknownOf(normalizeSpec(mediaQuestion(extra, option), { specDir: dir }).issues);
  assert.deepEqual(run({ chart: { type: "bar", lables: ["a"], series: [1] } }), ['error questions[0].chart: unknown field "lables"; did you mean "labels"?']);
  assert.deepEqual(run({ images: [{ src: "before.png" }, { src: "after.png", captoin: "x" }] }), ['error questions[0].images[1]: unknown field "captoin"; did you mean "caption"?']);
  assert.deepEqual(run({}, { table: { columns: ["a"], rows: [["1"]], captoin: "x" } }), ['error questions[0].options[0].table: unknown field "captoin"; did you mean "caption"?']);
  assert.deepEqual(run({ chart: { series: [{ name: "a", valeus: [1] }] } }), ['error questions[0].chart.series[0]: unknown field "valeus"; did you mean "values"?']);
  assert.deepEqual(run({ table: { columns: [{ id: "a", lable: "A" }], rows: [["1"]] } }), ['error questions[0].table.columns[0]: unknown field "lable"; did you mean "label"?']);
  assert.deepEqual(run({ compare: { before: { src: "before.png", lable: "x" }, after: "after.png" } }), ['error questions[0].compare.before: unknown field "lable"; did you mean "label"?']);
  assert.deepEqual(run({ code: { text: "x", langauge: "js" } }), ['error questions[0].code: unknown field "langauge"']);
  assert.deepEqual(run({ links: [{ url: "https://e.com", titel: "x" }] }), ['error questions[0].links[0]: unknown field "titel"']);
  assert.deepEqual(run({ video: { src: "clip.mp4", captoin: "c" } }), ['error questions[0].video: unknown field "captoin"; did you mean "caption"?']);
  assert.deepEqual(run({ html: { source: "<b>x</b>", maxHeigth: 100 } }), ['error questions[0].html: unknown field "maxHeigth"; did you mean "maxHeight"?']);
  assert.deepEqual(run({ diff: { before: "a", after: "b", lables: [] } }), ['error questions[0].diff: unknown field "lables"; did you mean "labels"?']);
});

test("a name that belongs to another kind, to a common slip or to the option says so instead of guessing", async (context) => {
  const dir = await mediaDir(context);
  const run = (extra) => unknownOf(normalizeSpec(mediaQuestion(extra), { specDir: dir }).issues).map((m) => m.replace(/^error [^:]*: /, ""));
  assert.deepEqual(run({ chart: { series: [1], rows: [] } }), ['unknown field "rows"; "rows" belongs to table, not to chart']);
  assert.deepEqual(run({ images: [{ url: "https://e.com/a.png" }] }), ['unknown field "url"; did you mean "src"?']);
  assert.deepEqual(run({ links: [{ href: "https://e.com" }] }), ['unknown field "href"; did you mean "url"?']);
  assert.deepEqual(run({ table: { headers: ["a"], rows: [["1"]] } }), ['unknown field "headers"; did you mean "columns"?']);
  assert.deepEqual(run({ diff: { old: "a", new: "b" } }), ['unknown field "old"; did you mean "before"?', 'unknown field "new"; did you mean "after"?']);
  assert.deepEqual(run({ images: [{ src: "a.png", detail: "x" }] }), ['unknown field "detail"; "detail" is an option field, not part of a media node: put it on the option']);
});

test("lenient mode turns the same unknown field into a warning, and the node is still drawn", async (context) => {
  const dir = await mediaDir(context);
  const { spec, issues } = normalizeSpec(mediaQuestion({ chart: { lables: ["a"], series: [1, 2] } }), { specDir: dir, fields: "lenient" });
  assert.deepEqual(unknownOf(issues), ['warn questions[0].chart: unknown field "lables"; did you mean "labels"?']);
  assert.deepEqual(errorsOf(issues), []);
  assert.equal(spec.questions[0].chart.series[0].values.length, 2);
});

test("a card, its sides and a pushed card are checked inside too", () => {
  const card = (extra) => ({ id: "c", title: "t", left: { label: "L", chart: { series: [1], lables: [] } }, right: "R", ...extra });
  const { issues } = normalizeDeck({ goal: "g", cards: [card({ table: { rows: [["1"]], columns: ["a"], captoin: "x" } })] });
  assert.deepEqual(unknownOf(issues), [
    'error cards[0].table: unknown field "captoin"; did you mean "caption"?',
    'error cards[0].left.chart: unknown field "lables"; did you mean "labels"?',
  ]);
  const pushed = normalizePatch({ add: [card({})] });
  assert.deepEqual(unknownOf(pushed.issues), ['error add[0].left.chart: unknown field "lables"; did you mean "labels"?']);
});

test("collectMedia without a switch: the reply of an explain warns, it does not refuse", async () => {
  const { collectMedia } = await load("lib/media.mjs");
  const seen = [];
  const ctx = { add: (l, w, m) => seen.push(`${l} ${w}: ${m}`), exists: () => true, abs: (p) => p, fieldLevel: "warn" };
  collectMedia({ chart: { series: [1], lables: [] } }, "explain", ctx);
  assert.deepEqual(seen, ['warn explain.chart: unknown field "lables"; did you mean "labels"?']);
});

test("a remote preview stays in the round with a warning; a local one does not warn", async (context) => {
  const dir = await mediaDir(context);
  const remote = normalizeSpec(mediaQuestion({ preview: "https://example.com/mock.html" }), { specDir: dir });
  assert.equal(remote.spec.questions[0].preview.src, "https://example.com/mock.html");
  assert.equal(remote.spec.questions[0].preview.local, false);
  assert.deepEqual(warnsOf(remote.issues), ["questions[0] (q): preview https://example.com/mock.html: the page frames only files it serves itself; shown as a link"]);
  assert.deepEqual(errorsOf(remote.issues), []);
  const local = normalizeSpec(mediaQuestion({ preview: "card.html" }), { specDir: dir });
  assert.deepEqual(local.issues, []);
  const http = normalizeSpec(mediaQuestion({}, { preview: "http://localhost:5173/" }), { specDir: dir });
  assert.equal(warnsOf(http.issues).length, 1);
});

// ---- the page modules render under a small stand-in for the DOM

function fakeDom() {
  class N {}
  class El extends N {
    constructor(tag) {
      super();
      this.tag = tag;
      this.children = [];
      this.attrs = {};
      this.listeners = {};
      this.dataset = {};
      this.className = "";
      this.style = { cssText: "", setProperty() {} };
      const cls = new Set();
      this.classList = { add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: () => {}, contains: (c) => cls.has(c) };
    }
    append(...kids) { this.children.push(...kids.map((k) => (k instanceof N ? k : { text: String(k) }))); }
    replaceChildren(...kids) { this.children = []; this.append(...kids); }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k]; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    querySelector() { return null; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
    set innerHTML(v) { this.html = v; }
    get innerHTML() { return this.html || ""; }
    get clientWidth() { return 300; }
    get offsetWidth() { return 300; }
    play() { return Promise.resolve(); }
  }
  const root = new El("html");
  const saved = ["document", "Node", "matchMedia", "ResizeObserver", "MutationObserver", "window", "location", "navigator"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  set("Node", N);
  set("document", { createElement: (t) => new El(t), createTextNode: (s) => ({ text: String(s) }), documentElement: root });
  set("matchMedia", () => ({ matches: false, addEventListener() {} }));
  set("ResizeObserver", class { observe() {} unobserve() {} });
  set("MutationObserver", class { observe() {} });
  set("window", { addEventListener() {} });
  set("location", { origin: "http://127.0.0.1:1" });
  return () => {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  };
}

// Every element in a tree, as { tag, attrs, children } walks.
const walkEl = (el) => (el && el.children ? [el, ...el.children.flatMap(walkEl)] : []);

test("every page module draws the normalised example of its kind, under a stand-in DOM", async (context) => {
  const dir = await mediaDir(context);
  const { MEDIA } = await registry();
  const restore = fakeDom();
  context.after(restore);
  const page = await load("ui/js/media/index.js");
  const ctx = { lightbox() {}, zoom() {}, toast() {}, offline: false };
  const env = { qid: "q", compact: false, big: false, t: (k, ...a) => `${k}${a.join(",")}`, zoom: (kind, el) => el, offline: false, dark: () => false, narrow: () => false, sameOrigin: () => true };
  const published = await load("lib/assets.mjs");
  const roots = published.createRoots();
  for (const [name, def] of MEDIA) {
    if (name === "mermaid") continue; // draws in a frame of its own; the browser check covers it
    const { spec } = normalizeSpec(mediaQuestion(def.example), { specDir: dir });
    const node = roots.publishNode(spec.questions[0]);
    const el = page.MEDIA.get(name).render(node, ctx, env);
    assert.ok(el && walkEl(el).length > 0, `${name}: drew something`);
  }
});

test("a remote preview is drawn as a link that opens in a new tab, not as a frame", async (context) => {
  const restore = fakeDom();
  context.after(restore);
  const { render } = await load("ui/js/media/preview.js");
  const env = { qid: "q", compact: false, big: false, t: (k, ...a) => `${k} ${a.join(",")}`, zoom: (kind, el) => el, offline: false, dark: () => false, narrow: () => false };
  const el = render({ preview: { src: "https://example.com/mock.html", local: false }, previewHeight: 360 }, {}, env);
  const tree = walkEl(el);
  assert.equal(tree.filter((n) => n.tag === "iframe").length, 0, "no frame");
  const a = tree.find((n) => n.tag === "a");
  assert.equal(a.attrs.href, "https://example.com/mock.html");
  assert.equal(a.attrs.target, "_blank");
  assert.equal(a.attrs.rel, "noopener noreferrer");
  const local = render({ preview: { src: "/r/0/card.html", local: true }, previewHeight: 360 }, {}, env);
  assert.equal(walkEl(local).filter((n) => n.tag === "iframe").length, 1, "a local mockup keeps its frame");
});

// ---- the generated schema

// A small checker for the part of JSON Schema the generator writes: no library.
function validate(schema, value, root, where = "$") {
  if (schema.$ref) return validate(root.$defs[schema.$ref.replace("#/$defs/", "")], value, root, where);
  if (schema.anyOf) {
    const tries = schema.anyOf.map((s) => validate(s, value, root, where));
    return tries.some((t) => !t.length) ? [] : [`${where}: matches none of ${schema.anyOf.length} shapes (${tries.map((t) => t[0]).join(" | ")})`];
  }
  const errs = [];
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.enum && !schema.enum.includes(value)) return [`${where}: ${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}`];
  if (schema.type && !((Array.isArray(schema.type) ? schema.type.includes(kind) : schema.type === kind) || (schema.type === "integer" && Number.isInteger(value)))) return [`${where}: expected ${schema.type}, got ${kind}`];
  const types = [].concat(schema.type || []);
  if (types.includes("object") && kind === "object") {
    for (const r of schema.required || []) if (!(r in value)) errs.push(`${where}: missing ${r}`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) errs.push(...validate(schema.properties[k], v, root, `${where}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${where}: unknown field "${k}"`);
    }
  }
  if (types.includes("array") && kind === "array") value.forEach((v, i) => errs.push(...validate(schema.items, v, root, `${where}[${i}]`)));
  return errs;
}

test("the schema refuses an unknown field at every level and accepts a string where an option is expected", async () => {
  const { specSchema } = await docs();
  const schema = specSchema();
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  const ok = { title: "t", questions: [{ id: "a", title: "q", options: ["Postgres", { id: "b", label: "SQLite", recommended: true, chart: { series: [1, 2] } }] }] };
  assert.deepEqual(validate(schema, ok, schema), []);
  const bad = (spec) => validate(schema, spec, schema);
  assert.match(bad({ titel: "t", questions: [] })[0], /unknown field "titel"/);
  assert.match(bad({ questions: [{ id: "a", optoins: [] }] })[0], /unknown field "optoins"/);
  assert.match(bad({ questions: [{ id: "a", options: [{ lable: "x" }] }] })[0], /unknown field "lable"/);
  assert.match(bad({ questions: [{ id: "a", chart: { lables: [] } }] })[0], /unknown field "lables"/);
  assert.match(bad({ questions: [{ id: "a", options: [{ images: [{ src: "a.png", captoin: "x" }] }] }] }).join("\n"), /unknown field "captoin"/);
  assert.match(bad({ questions: [{ id: "a", type: "sinlge" }] }).join("\n"), /not one of/);
  assert.match(bad({ title: "t" })[0], /missing questions/);
  assert.deepEqual(bad({ questions: [{ id: "a", images: "a.png", video: { src: "a.mp4" }, links: "https://e.com", options: ["x"] }] }), [], "a single entry stands for a list, as the engine reads it");
});

test("every spec the repository ships passes the generated schema too", async () => {
  const { specSchema } = await docs();
  const schema = specSchema();
  const files = walk(examples).filter((f) => f.endsWith(".questions.json"));
  assert.ok(files.length >= 2);
  for (const f of files) assert.deepEqual(validate(schema, JSON.parse(readFileSync(f, "utf8")), schema), [], f);
});

test("the schema is lean: shapes written once, no examples, doc as description", async () => {
  const { specSchema } = await docs();
  const schema = specSchema();
  const text = JSON.stringify(schema);
  assert.ok(Object.keys(schema.$defs).length >= 10, "shared shapes sit in $defs");
  assert.ok(!/"example/.test(text) && !/"doc"/.test(text), "no examples, no doc keys");
  assert.ok(text.includes('"description"'));
  const refs = text.match(/"\$ref":"#\/\$defs\/([A-Za-z]+)"/g) || [];
  for (const r of new Set(refs)) assert.ok(schema.$defs[r.match(/\/([A-Za-z]+)"$/)[1]], `${r} resolves`);
  assert.ok(text.split('"images":{"$ref"').length >= 3, "the media fields are referred to, not written out each time");
});

test("a spec may carry $schema: it is the one top-level extra, known and ignored", async () => {
  const { specSchema } = await docs();
  const spec = { $schema: "https://example.com/decide.schema.json", title: "t", questions: [{ id: "a", title: "q", options: ["x", "y"] }] };
  const { spec: out, issues } = normalizeSpec(spec);
  assert.deepEqual(errorsOf(issues), []);
  assert.equal("$schema" in out, false);
  assert.deepEqual(validate(specSchema(), spec, specSchema()), []);
  assert.deepEqual(errorsOf(normalizeDeck({ $schema: "x", goal: "g", cards: [{ id: "c", title: "t", left: "L", right: "R" }] }).issues), []);
  assert.match(errorsOf(normalizeSpec({ ...spec, $scheme: "x" }).issues)[0], /unknown field "\$scheme"/);
});

// ---- the reference tables

const between = (text, tag) => {
  const m = text.replace(/\r\n/g, "\n").match(new RegExp(`<!-- ${tag} -->\n([\\s\\S]*?)\n<!-- /${tag} -->`));
  assert.ok(m, `markers for ${tag}`);
  return m[1];
};

test("spec.md is in step with the registry", async () => {
  const { docTables } = await docs();
  const md = readFileSync(path.join(pluginDir, "skills/decide/spec.md"), "utf8");
  assert.equal(between(md, "registry:media"), docTables().media);
  assert.equal(between(md, "registry:types"), docTables().types);
});

test("the tables name every type and every media kind once, with no line break inside a cell", async () => {
  const { docTables } = await docs();
  const { TYPES: types, MEDIA } = await registry();
  const t = docTables();
  for (const [text, names] of [[t.types, [...types.keys()]], [t.media, [...MEDIA.keys()]]]) {
    const rows = text.split("\n");
    assert.ok(rows.every((r) => r.startsWith("|") && r.endsWith("|")), "every line is a row");
    for (const n of names) assert.equal(rows.filter((r) => r.startsWith(`| \`${n}\``)).length, 1, n);
  }
  assert.match(t.media, /\| `preview`.*network/, "a mockup has network access");
  assert.doesNotMatch(t.media, /no network/);
});

test("injecting the tables touches only what is between the markers, and keeps \\n", async () => {
  const { inject, docTables } = await docs();
  const md = readFileSync(path.join(pluginDir, "skills/decide/spec.md"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(inject(md, docTables()), md, "already in step: nothing changes");
  const stale = md.replace(/(<!-- registry:media -->\n)[\s\S]*?(\n<!-- \/registry:media -->)/, "$1stale$2");
  assert.notEqual(stale, md);
  assert.equal(inject(stale, docTables()), md);
  assert.throws(() => inject("no markers here", docTables()), /registry:types/);
  assert.ok(!inject(md, docTables()).includes("\r"));
  // A CRLF checkout keeps CRLF all through: no line of the file ends in a bare \n after a write.
  const crlf = md.replace(/\n/g, "\r\n");
  const staleCrlf = crlf.replace(/(<!-- registry:media -->\r\n)[\s\S]*?(\r\n<!-- \/registry:media -->)/, "$1stale$2");
  const fixed = inject(staleCrlf, docTables());
  assert.equal(fixed, crlf);
  assert.ok(!/[^\r]\n/.test(fixed), "no bare line feed");
});

test("typeLines names every type and every media kind once", async () => {
  const { typeLines } = await docs();
  const { TYPES: types, MEDIA } = await registry();
  const lines = typeLines().split("\n");
  assert.equal(lines.length, types.size + MEDIA.size);
  for (const n of [...types.keys(), ...MEDIA.keys()]) assert.equal(lines.filter((l) => l.startsWith(`${n}: `)).length, 1, n);
  assert.ok(lines.every((l) => l.length < 200), "short lines");
});

test("npm run docs is the generator and is the only script this task added", () => {
  const pkg = JSON.parse(readFileSync(path.join(pluginDir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.docs, "node lib/registry/docs.mjs --write");
  assert.equal(pkg.version, "2.2.0");
});

test("nothing in the engine switches on a media kind outside the registry", () => {
  const src = (f) => readFileSync(path.join(pluginDir, f), "utf8");
  for (const f of ["lib/media.mjs", "lib/spec.mjs", "lib/swipe.mjs", "lib/assets.mjs"]) {
    assert.doesNotMatch(src(f), /["'](mermaid|compare)["']/, `${f}: no kind named in a switch or a list`);
  }
});


// ---- fix round 1: the schema never refuses more than the engine, and it is small

const mdJson = () =>
  ["skills/decide/spec.md", "skills/decide/SKILL.md", "skills/swipe/SKILL.md", "README.md"].flatMap((f) => {
    const file = path.join(pluginDir, f);
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    return [...text.matchAll(/```json\n([\s\S]*?)```/g)].flatMap((m, i) => {
      try {
        return [{ name: `${f} block ${i + 1}`, value: JSON.parse(m[1]) }];
      } catch {
        return [];
      }
    });
  });

test("every spec the docs show, and every deck the repository ships, passes the schema its engine accepts", async () => {
  const { specSchema, deckSchema } = await docs();
  const rounds = mdJson().filter((b) => Array.isArray(b.value?.questions));
  assert.ok(rounds.length >= 2, "spec.md and the README each show a round");
  for (const b of rounds) {
    assert.deepEqual(errorsOf(normalizeSpec(structuredClone(b.value), { specDir: examples }).issues).filter((e) => !/missing file/.test(e)), [], `${b.name}: the engine takes it`);
    assert.deepEqual(validate(specSchema(), b.value, specSchema()), [], b.name);
  }
  const decks = walk(examples).filter((f) => f.endsWith(".deck.json"));
  assert.ok(decks.length >= 1);
  for (const f of decks) assert.deepEqual(validate(deckSchema(), JSON.parse(readFileSync(f, "utf8")), deckSchema()), [], f);
  for (const b of mdJson().filter((b) => Array.isArray(b.value?.cards))) assert.deepEqual(validate(deckSchema(), b.value, deckSchema()), [], b.name);
});

test("the schema takes every shape the strict engine takes without an error", async () => {
  const { specSchema, deckSchema } = await docs();
  const q = (extra, options = ["x", "y"]) => ({ questions: [{ id: "a", title: "t", options, ...extra }] });
  const cases = {
    "metrics as a list": q({}, [{ label: "x", metrics: [{ label: "Speed", value: 4 }] }, "y"]),
    "metrics as an object": q({}, [{ label: "x", metrics: { Speed: 4, Time: "5 days" } }, "y"]),
    "a showIf item with a name of its own": { questions: [{ id: "a", title: "t", options: [{ id: "x", label: "X" }] }, { id: "b", title: "t", options: ["x", "y"], showIf: { q: "a", in: "x", why: "because" } }] },
    "a section with questions listed in it": { sections: [{ id: "s", title: "S", questions: ["a"] }], ...q({ section: "s" }) },
    "one section": { sections: { id: "s", title: "S" }, ...q({ section: "s" }) },
    "stakes the engine only warns on": q({ stakes: "normal" }),
    "layout, lang and sim the engine only warns on": { lang: "de", ...q({ layout: "zzz", images: [{ sim: "zzz", viewport: "zzz" }] }) },
    "options as one object": q({}, { id: "a", label: "A" }),
    "pros, cons, tags and default as one string": q({ default: "x" }, [{ label: "x", pros: "p", cons: "c", tags: "t" }, "y"]),
    "a table with one column": q({ table: { columns: "a", rows: [["1"]] } }),
    "labels as one string": q({ compare: { before: "a.png", after: "b.png", labels: "x" }, diff: { before: "a", after: "b", labels: "x" }, chart: { labels: "a", series: [1] } }),
    "one named series with a single value list": q({ chart: { series: { name: "s", values: 3 } } }),
  };
  for (const [name, spec] of Object.entries(cases)) {
    assert.deepEqual(errorsOf(normalizeSpec(structuredClone(spec), { specDir: examples }).issues).filter((e) => !/missing file/.test(e)), [], `${name}: the engine takes it`);
    assert.deepEqual(validate(specSchema(), spec, specSchema()), [], name);
  }
  const card = (extra) => ({ goal: "g", cards: [{ id: "c", title: "t", left: "L", right: "R", ...extra }] });
  for (const [name, deck] of Object.entries({ "from null": card({ from: null }), "a recommendation the engine only warns on": card({ recommended: "mid", stakes: "low" }), "brief as one string": { ...card({}), brief: "x" } })) {
    assert.deepEqual(errorsOf(normalizeDeck(structuredClone(deck)).issues), [], `${name}: the engine takes it`);
    assert.deepEqual(validate(deckSchema(), deck, deckSchema()), [], name);
  }
  // It still refuses what the engine refuses.
  assert.match(validate(specSchema(), q({ type: "zzz" }), specSchema()).join("\n"), /not one of/);
  assert.match(validate(specSchema(), q({ titel: "x" }), specSchema()).join("\n"), /unknown field "titel"/);
});

test("the schema is small: ask's whole input schema 9,000 bytes, swipe's 7,000, tools/list pinned near its size", async () => {
  const { specSchema, deckSchema } = await docs();
  const size = (v) => JSON.stringify(v).length;
  assert.ok(size(specSchema()) <= 9000, `specSchema ${size(specSchema())} bytes`);
  assert.ok(size(deckSchema()) <= 7000, `deckSchema ${size(deckSchema())} bytes`);
  const { toolList } = await load("lib/commands/index.mjs");
  const tools = toolList();
  const input = (name) => tools.find((t) => t.name === name).inputSchema;
  assert.ok(size(input("ask")) <= 9000 + 1000, `ask inputSchema ${size(input("ask"))} bytes`);
  assert.ok(size(input("swipe")) <= 7000 + 1000, `swipe inputSchema ${size(input("swipe"))} bytes`);
  assert.ok(size(input("ask")) >= size(specSchema()), "the whole input schema holds the spec schema, $defs and all");
  const whole = size({ result: { tools } });
  assert.ok(whole <= 33_000, `tools/list ${whole} bytes: pinned near the size after Task 13's deck lines, far under 2.1.1's 11,281 plus the 2.1 ask schema growth`);
});

test("a description sits only where the name does not say it, never on a spelling or a union arm", async () => {
  const { specSchema } = await docs();
  const schema = specSchema();
  const text = JSON.stringify(schema);
  const count = (text.match(/"description"/g) || []).length;
  assert.ok(count > 5 && count < 40, `${count} descriptions`);
  for (const alias of ["question", "image", "videos", "link", "selected"]) {
    const where = schema.$defs.question.properties[alias] || schema.$defs.showIf.properties[alias];
    if (where) assert.equal("description" in where, false, `${alias}: no description`);
  }
});

test("the media table says everything the old one did: the names inside a kind, their values, and what a URL does to a preview", async () => {
  const { docTables } = await docs();
  const { media } = docTables();
  const row = (kind) => media.split("\n").find((l) => l.startsWith(`| \`${kind}\``));
  for (const word of ["`viewport` (desktop, mobile, both)", "`waitMs`", "`name`", "`device`", "http(s)", "when the round opens"]) assert.ok(row("images").includes(word), `images: ${word}`);
  assert.match(row("preview"), /`previewHeight`: Height of the frame in px/);
  assert.match(row("preview"), /network access/);
  assert.match(row("preview"), /http\(s\) URL is shown as a link/);
  assert.doesNotMatch(row("preview"), /no network/);
  assert.match(row("compare"), /labels/);
});

test("the mermaid line says what the page does now: draws it in a sandboxed frame, offline too, shows the source when that fails", async () => {
  const { typeLines } = await docs();
  const line = typeLines().split("\n").find((l) => l.startsWith("mermaid: "));
  assert.match(line, /sandboxed frame/);
  assert.match(line, /offline|exported file draws it too/);
  assert.doesNotMatch(line, /CDN/);
  assert.match(line, /source/);
});

test("a remote .html in a compare warns and is drawn as two links; a local pair keeps its frames", async (context) => {
  const dir = await mediaDir(context);
  const compare = { before: "https://example.com/a.html", after: "https://example.com/b.html", labels: ["Old", "New"] };
  const out = normalizeSpec({ questions: [{ id: "q", title: "t", options: ["x", "y"], compare }] }, { specDir: dir });
  assert.deepEqual(errorsOf(out.issues), []);
  assert.deepEqual(warnsOf(out.issues).filter((w) => /compare/.test(w)), [
    "questions[0] (q): compare https://example.com/a.html: the page frames only files it serves itself; shown as a link",
    "questions[0] (q): compare https://example.com/b.html: the page frames only files it serves itself; shown as a link",
  ]);
  assert.equal(out.spec.questions[0].compare.live, true, "kept in the round");
  const restore = fakeDom();
  context.after(restore);
  const { render } = await load("ui/js/media/compare.js");
  const env = { qid: "q", compact: false, big: false, t: (k, ...a) => `${k} ${a.join(",")}`, zoom: (kind, el) => el, offline: false, dark: () => false, narrow: () => false };
  const tree = walkEl(render({ compare: out.spec.questions[0].compare, previewHeight: 360 }, {}, env));
  assert.equal(tree.filter((n) => n.tag === "iframe").length, 0, "no frames");
  const links = tree.filter((n) => n.tag === "a");
  assert.deepEqual(links.map((a) => a.attrs.href), ["https://example.com/a.html", "https://example.com/b.html"]);
  for (const a of links) {
    assert.equal(a.attrs.target, "_blank");
    assert.equal(a.attrs.rel, "noopener noreferrer");
  }
  const local = render({ compare: { before: { src: "/r/0/a.html", label: "" }, after: { src: "/r/0/b.html", label: "" }, live: true }, previewHeight: 360 }, {}, env);
  assert.equal(walkEl(local).filter((n) => n.tag === "iframe").length, 2, "two local mockups keep their frames");
});

test("metrics as a list of {label, value} is read as the object form: the same rows, no warning", async (context) => {
  const { exportSpec } = await load("lib/export.mjs");
  const make = (metrics) => normalizeSpec({ questions: [{ id: "q", title: "t", why: "w", options: [{ label: "x", then: "t", recommended: true, metrics }, { label: "y", then: "t" }] }] });
  const asList = make([{ label: "Speed", value: 4 }, { label: "Time", value: "5 days" }]);
  const asObject = make({ Speed: 4, Time: "5 days" });
  assert.deepEqual(asList.issues, []);
  assert.deepEqual(asObject.issues, []);
  assert.deepEqual(asObject.spec.questions[0].options[0].metrics, [{ label: "Speed", value: 4 }, { label: "Time", value: "5 days" }]);
  assert.deepEqual(asList.spec.questions[0].options[0].metrics, asObject.spec.questions[0].options[0].metrics, "the page draws rows from this");
  const dir = await mkdtemp(path.join(tmpdir(), "decide-metrics-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const rows = async (spec, name) => {
    const out = path.join(dir, `${name}.html`);
    await exportSpec(spec, { id: name, out });
    const payload = JSON.parse(readFileSync(out, "utf8").match(/<script type="application\/json" id="decide-export">([\s\S]*?)<\/script>/)[1].replace(/\\u003c/g, "<"));
    return payload.round.spec.questions[0].options[0].metrics;
  };
  assert.deepEqual(await rows(asList.spec, "list"), await rows(asObject.spec, "object"), "the export carries the same rows");
  const md = readFileSync(path.join(pluginDir, "skills/decide/spec.md"), "utf8");
  assert.doesNotMatch(md, /"metrics": \[/);
});

test("an image's label and a link's src name the field they stand for", () => {
  const img = normalizeSpec({ questions: [{ id: "q", title: "t", options: ["x", "y"], images: [{ src: "a.png", label: "Home" }] }] });
  assert.match(errorsOf(img.issues).join("\n"), /unknown field "label".*did you mean "caption"\?/);
  const link = normalizeSpec({ questions: [{ id: "q", title: "t", options: ["x", "y"], links: [{ label: "Doc", src: "https://example.com" }] }] });
  assert.match(errorsOf(link.issues).join("\n"), /unknown field "src".*did you mean "url"\?/);
});


// ---- fix round 2

test("the schema takes null for every optional field, as the engine reads it (absent), but not for what it requires", async () => {
  const { specSchema, deckSchema } = await docs();
  const round = {
    title: null, lang: null, intro: null, recap: null, context: null, glossary: null, budget: null, sections: null,
    questions: [{ id: "a", title: "t", type: null, options: [{ label: "x", recommended: null, metrics: null, pros: null, images: null, preview: null, danger: null }, "y"], showIf: null, stakes: null, images: null, table: null, chart: null, compare: null, links: null, note: null }],
  };
  assert.deepEqual(errorsOf(normalizeSpec(structuredClone(round), { specDir: examples }).issues).filter((e) => !/missing file/.test(e)), [], "the engine takes it");
  assert.deepEqual(validate(specSchema(), round, specSchema()), []);
  assert.ok(validate(specSchema(), { ...round, questions: null }, specSchema()).length, "questions stays required");
  const deck = { title: null, goal: "g", intro: null, brief: null, confidence: null, batch: null, cards: [{ id: "c", title: "t", left: "L", right: { label: "R", detail: null, images: null }, from: null, recommended: null, stakes: null, tldr: null, body: null, images: null }] };
  assert.deepEqual(errorsOf(normalizeDeck(structuredClone(deck)).issues), [], "the engine takes it");
  assert.deepEqual(validate(deckSchema(), deck, deckSchema()), []);
  assert.ok(validate(deckSchema(), { ...deck, cards: null }, deckSchema()).length, "cards stays required");
});

test("the schema is open inside scale (the engine drops a name it does not know) and takes numbers for table columns", async () => {
  const { specSchema } = await docs();
  const spec = { questions: [{ id: "a", title: "t", type: "scale", scale: { min: 1, max: 5, step: 1, labels: { 1: "low" } }, options: [] }, { id: "b", title: "t", options: ["x", "y"], table: { columns: [2021, 2022, "total"], rows: [[1, 2, 3]] } }] };
  assert.deepEqual(errorsOf(normalizeSpec(structuredClone(spec), { specDir: examples }).issues).filter((e) => !/option|missing file/.test(e)), [], "the engine takes it");
  assert.deepEqual(validate(specSchema(), spec, specSchema()), []);
});

test("a compare of one local and one remote mockup: the remote side is a link, the local side keeps its frame, live and exported", async (context) => {
  const dir = await mediaDir(context);
  await writeFile(path.join(dir, "local.html"), "<p>local</p>");
  const compare = { before: "local.html", after: "https://example.com/b.html", labels: ["Old", "New"] };
  const out = normalizeSpec({ questions: [{ id: "q", title: "t", options: ["x", "y"], compare }] }, { specDir: dir });
  assert.deepEqual(errorsOf(out.issues), []);
  assert.deepEqual(warnsOf(out.issues).filter((w) => /compare/.test(w)), ["questions[0] (q): compare https://example.com/b.html: the page frames only files it serves itself; shown as a link"]);
  const restore = fakeDom();
  context.after(restore);
  const { render } = await load("ui/js/media/compare.js");
  const env = { qid: "q", compact: false, big: false, t: (k, ...a) => `${k} ${a.join(",")}`, zoom: (kind, el) => el, offline: false, dark: () => false, narrow: () => false };
  const shape = (c) => {
    const tree = walkEl(render({ compare: c, previewHeight: 360 }, {}, env));
    return { frames: tree.filter((n) => n.tag === "iframe").map((n) => n.attrs.src), links: tree.filter((n) => n.tag === "a" && n.attrs.target === "_blank").map((n) => [n.attrs.href, n.attrs.rel]) };
  };
  const live = shape({ before: { src: "/r/0/local.html", label: "Old" }, after: { src: "https://example.com/b.html", label: "New" }, live: true });
  assert.deepEqual(live, { frames: ["/r/0/local.html"], links: [["https://example.com/b.html", "noopener noreferrer"]] });
  const { exportSpec } = await load("lib/export.mjs");
  const file = path.join(dir, "x.html");
  await exportSpec(out.spec, { id: "x", out: file });
  const payload = JSON.parse(readFileSync(file, "utf8").match(/<script type="application\/json" id="decide-export">([\s\S]*?)<\/script>/)[1].replace(/\\u003c/g, "<"));
  const exported = shape(payload.round.spec.questions[0].compare);
  assert.equal(exported.frames.length, 1);
  assert.match(exported.frames[0], /^data:text\/html/, "the export keeps the local frame as a data: URL");
  assert.deepEqual(exported.links, [["https://example.com/b.html", "noopener noreferrer"]]);
});

test("the briefs still say what priority and budget do", async () => {
  const { specSchema } = await docs();
  const schema = specSchema();
  assert.match(schema.$defs.question.properties.priority.description, /cut/i);
  assert.match(schema.properties.budget.description, /dropped|cut/i);
});

test("the media table says what the old one did and what is true now", async () => {
  const { docTables, typeLines } = await docs();
  const row = (kind) => docTables().media.split("\n").find((l) => l.startsWith(`| \`${kind}\``));
  assert.match(row("mermaid"), /enlarge/);
  assert.match(row("chart"), /\{name, values\}/);
  assert.match(row("compare"), /both run, one divider/);
  assert.match(row("compare"), /remote.*link|link.*remote/i);
  assert.match(row("images"), /xcrun simctl io booted screenshot/);
  assert.match(row("images"), /adb exec-out screencap/);
  const line = typeLines().split("\n").find((l) => l.startsWith("mermaid: "));
  assert.match(line, /source text/);
  assert.match(line, /export/);
  assert.match(line, /sandboxed frame/);
});

test("a near name is a real edit away and valid at that level (stakeholders is not stakes)", () => {
  const said = (q) => errorsOf(normalizeSpec({ questions: [{ id: "a", title: "t", ...q, options: ["x", "y"] }] }).issues).map((e) => e.replace(/^[^:]*: /, ""));
  for (const name of ["stakeholders", "consequences", "linkedin", "reversal"]) assert.deepEqual(said({ [name]: 1 }), [`unknown field "${name}"`], name);
  assert.match(said({ lable: 1 })[0], /"label"/, "lable means label, not table");
  assert.deepEqual(said({ stakse: "high" }), ['unknown field "stakse"; did you mean "stakes"?']);
});

test("default is valid on scale and text; a table column may have a number for a label", () => {
  for (const type of ["scale", "text"]) {
    const { issues } = normalizeSpec({ questions: [{ id: "k", title: "t", type, default: ["3"] }] });
    assert.deepEqual(warnsOf(issues).filter((w) => /"default"/.test(w)), [], type);
  }
  const { issues } = normalizeSpec({ questions: [{ id: "a", title: "t", options: ["x", "y"], table: { columns: [{ id: "y", label: 2024 }], rows: [["1"]] } }] });
  assert.deepEqual(errorsOf(issues), []);
});

// ---- question anatomy: why, more, option then

test("a question has why and more, an option has then; the folded points are older spellings of more", () => {
  assert.ok(QUESTION_FIELDS.why && QUESTION_FIELDS.more, "why and more");
  assert.equal(OPTION_FIELDS.then.type, "string");
  for (const k of ["what", "how", "goal", "then"]) assert.equal(QUESTION_FIELDS[k].alias, "more", `${k} reads into more`);
  const { spec, issues } = normalizeSpec({ questions: [{ id: "a", title: "A", why: "w", more: "m", options: [{ label: "x", then: "t", recommended: true }, "y"] }] });
  assert.deepEqual(errorsOf(issues), []);
  assert.equal(spec.questions[0].why, "w");
  assert.equal(spec.questions[0].more, "m");
  assert.equal(spec.questions[0].options[0].then, "t");
  assert.equal(spec.questions[0].options[1].then, "");
});

test("lint: a single or multi question with no why, or options with no then, is a warning, not an error", () => {
  const lint = (q) => {
    const { issues } = normalizeSpec({ questions: [{ id: "a", title: "A", ...q }] });
    return { errors: errorsOf(issues), warns: warnsOf(issues).filter((w) => /no "why"|no "then"/.test(w)) };
  };
  const options = (then) => [{ id: "x", label: "X", recommended: true, ...(then.x && { then: "t" }) }, { id: "y", label: "Y", ...(then.y && { then: "t" }) }];
  const bare = lint({ options: options({}) });
  assert.deepEqual(bare.errors, []);
  assert.equal(bare.warns.length, 2);
  assert.match(bare.warns[0], /"a" has no "why"/);
  assert.match(bare.warns[1], /no "then" on any option/);
  const partial = lint({ why: "w", options: options({ x: true }) });
  assert.deepEqual(partial.warns.map((w) => w.replace(/^[^:]*: /, "")), ['no "then" on option "y": say what happens next if it is picked']);
  assert.deepEqual(lint({ why: "w", options: options({ x: true, y: true }) }).warns, []);
  assert.equal(lint({ type: "multi", options: options({}) }).warns.length, 2, "multi too");
  for (const type of ["confirm", "rank", "scale", "text"]) assert.deepEqual(lint({ type, options: type === "rank" ? options({}) : undefined, ...(type === "scale" ? { scale: { min: 1, max: 5 } } : {}) }).warns, [], `${type} is not asked for them`);
});

test("pinned sizes after 3.0 milestone 2: the spec schema is 8,704 bytes, the deck schema 6,928", async () => {
  const { specSchema, deckSchema } = await docs();
  assert.equal(JSON.stringify(specSchema()).length, 8704);
  assert.equal(JSON.stringify(deckSchema()).length, 6928);
});

test("evidence labels: a point is a string or {text, evidence, source}; the text stays a string", () => {
  const { spec, issues } = normalizeSpec({
    questions: [{ id: "a", title: "t", options: [
      { id: "x", label: "X", recommended: { text: "fast", evidence: "measured", source: "bench.txt" }, pros: ["plain", { text: "cheap", evidence: "estimate" }], cons: [{ text: "odd", evidence: "guess" }], metrics: { ms: { text: "12ms", evidence: "measured", source: "bench.txt" }, speed: 4 } },
      { id: "y", label: "Y" },
    ] }],
  });
  const o = spec.questions[0].options[0];
  assert.equal(o.reason, "fast");
  assert.deepEqual(o.pros, ["plain", "cheap"]);
  assert.deepEqual(o.evidence.pros, [null, { kind: "estimate", source: "" }]);
  assert.deepEqual(o.evidence.cons, [{ kind: "guess", source: "" }]);
  assert.deepEqual(o.evidence.reason, { kind: "measured", source: "bench.txt" });
  assert.deepEqual(o.evidence.metrics, { ms: { kind: "measured", source: "bench.txt" } });
  assert.deepEqual(o.metrics, [{ label: "ms", value: "12ms" }, { label: "speed", value: 4 }]);
  assert.equal(errorsOf(issues).length, 0);
  assert.ok(!warnsOf(issues).some((w) => /measured/.test(w)));
});

test("lint warns on measured without a source and on an unknown label", () => {
  const { issues } = normalizeSpec({
    questions: [{ id: "a", title: "t", options: [{ id: "x", label: "X", pros: [{ text: "quick", evidence: "measured" }], cons: [{ text: "x", evidence: "sure" }] }, { id: "y", label: "Y" }] }],
  });
  const w = warnsOf(issues);
  assert.ok(w.some((m) => /pros\[0\].*measured but has no source/.test(m)));
  assert.ok(w.some((m) => /unknown evidence "sure"/.test(m)));
});

test("a round brief and dependsOn are read", () => {
  const { spec, issues } = normalizeSpec({ brief: ["the task", { kind: "open", text: "naming" }], questions: [{ id: "a", title: "t", dependsOn: ["b", "r-1"], options: opts("A", "B") }] });
  assert.deepEqual(spec.brief.map((b) => [b.kind, b.text]), [["decision", "the task"], ["open", "naming"]]);
  assert.deepEqual(spec.questions[0].dependsOn, ["b", "r-1"]);
  assert.ok(!errorsOf(issues).some((m) => /unknown field/.test(m)));
});
