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
 * Why exists: the owner's real 2.x specs must keep opening; a new type must be one module per side.
 * Isolation:  pure, except the --lint test, which has its own scratch DECIDE_HOME.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
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
  assert.equal(nearest("recommendation", ["recommended", "reason"]), "recommended", "a shared prefix of 4 is enough");
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

const FIELD_TYPES = new Set(["string", "number", "boolean", "enum", "array", "object", "any"]);
function checkFieldDef(def, where) {
  assert.ok(FIELD_TYPES.has(def.type), `${where}: type ${def.type}`);
  assert.equal(typeof def.doc, "string", where);
  assert.ok(def.doc.length > 3, `${where}: doc`);
  if (def.type === "enum") assert.ok(Array.isArray(def.values) && def.values.length, `${where}: enum needs values`);
  if (def.items) checkFieldDef(def.items, `${where}[]`);
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
  const raw = JSON.parse(readFileSync(path.join(examples, "showcase.questions.json"), "utf8"));
  const now = JSON.parse(JSON.stringify(normalizeSpec(raw, { specDir: examples })));
  const before = JSON.parse(readFileSync(path.join(pluginDir, "test/fixtures/2.1/showcase.normalized.json"), "utf8"));
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
  const { HANDLERS } = await import(pathToFileURL(path.join(pluginDir, "lib/tools.mjs")).href);
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
  for (const [name, known] of [["title", option], ["note", option], ["label", question], ["img", question], ["kind", question], ["hint", question], ["img", option], ["kind", option]]) {
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
  for (const name of ["recommended", "label", "detail", "danger"]) {
    assert.deepEqual(said({ [name]: true }, {}), [`unknown field "${name}"; "${name}" is an option field: put it on the option`], name);
  }
  assert.deepEqual(said({}, { how: "x", note: "y", default: ["x"], then: "z" }), ["how", "note", "default", "then"].map((n) => `unknown field "${n}"; "${n}" is a question field: put it on the question`));
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
  const { issues } = normalizeSpec({ questions: [{ id: "k", title: "t", type: "scale", default: ["a"] }] });
  const warns = warnsOf(issues).filter((w) => /"default"/.test(w));
  assert.equal(warns.length, 1, warns.join("\n"));
  assert.match(warns[0], /field "default" belongs to single, multi, rank, confirm questions, not to scale ones; leave it out/);
  assert.ok(!/ignored/.test(warns[0]), "it does not say what is not true");
});

test("a card may carry question, the older spelling of title", () => {
  assert.ok(CARD_FIELDS.question, "CARD_FIELDS lists question");
  const { issues } = normalizeDeck({ goal: "g", cards: [{ id: "c", question: "Ship it?", why: "w", left: "yes", right: "no" }] });
  assert.deepEqual(errorsOf(issues).filter((e) => /unknown/.test(e)), []);
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
