// docs.mjs — what the registry writes down: the JSON Schema of a spec, the reference tables of
// skills/decide/spec.md, and the one line per type and media kind of the tool descriptions.
//
// `node lib/registry/docs.mjs --write` (npm run docs) rewrites what sits between the markers
//   <!-- registry:types --> … <!-- /registry:types -->   and   <!-- registry:media --> … <!-- /registry:media -->
// of spec.md and nothing else; without --write it prints the tables. A test fails when spec.md drifts.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CARD_FIELDS, CHAPTER_FIELDS, DECK_FIELDS, FOCUS_FIELDS, RISK_FIELDS, ACCEPTANCE_FIELDS, MEDIA, MEDIA_FIELDS, FINDING_FIELDS, REVIEWER_FIELDS, REVIEWER_RUN_FIELDS, REVIEWER_SKIP_FIELDS, REVIEW_FIELDS, ROUND_FIELDS, TYPES, everyQuestionField } from "./index.mjs";
import { arrayOf, object, shared } from "./shared.mjs";

// ---- the schema

// A FieldDef as JSON Schema. It is a safety net, never stricter than the engine: a name the engine ignores
// is allowed (`open`), an enum it only warns on is a string (`loose`), a list it reads from one entry takes
// one (`orOne`). A def with `shared` is written once under $defs and referred to by name. The schema is
// paid for by every agent session, so it is lean: a short `brief` where the name does not say it, none on a spelling the
// engine only tolerates (an alias) or on one arm of a union; the long text lives in spec.md.

function schemaOf(def, defs, bare = false) {
  if (def.alias) bare = true;
  if (def.shared) {
    if (!(def.shared in defs)) {
      defs[def.shared] = null; // reserved first: the body may refer to it
      defs[def.shared] = bodyOf(def, defs, false);
    }
    return { $ref: `#/$defs/${def.shared}` };
  }
  return bodyOf(def, defs, bare);
}

// A list of plain values that may be given as one is written once.
const PLAIN = { string: "strings", number: "numbers", boolean: "booleans" };

// The engine reads null as absent, as 2.1 did: every field takes it. A $ref is nullable in its def.
function orNull(schema) {
  if (schema.enum) return { ...schema, enum: [...schema.enum, null] };
  if (schema.anyOf) return { ...schema, anyOf: [...schema.anyOf, { type: "null" }] };
  if (schema.type) return { ...schema, type: [].concat(schema.type, schema.type.includes?.("null") ? [] : "null") };
  return schema;
}

function bodyOf(def, defs, bare) {
  return orNull(rawBody(def, defs, bare));
}

function rawBody(def, defs, bare) {
  const describe = (schema) => (bare || !def.brief ? schema : { ...schema, description: def.brief });
  switch (def.type) {
    case "enum":
      return def.loose ? { type: "string", ...(!bare && { description: def.values.join("|") }) } : describe({ enum: def.values });
    case "any":
      return describe({});
    case "union":
      return describe({ anyOf: def.of.map((alt) => schemaOf(alt, defs, true)) });
    case "array": {
      const plain = PLAIN[def.items.type];
      if (def.orOne && plain && !def.items.shared) {
        defs[plain] ??= { anyOf: [{ type: "array", items: { type: def.items.type } }, { type: def.items.type }, { type: "null" }] };
        return { $ref: `#/$defs/${plain}` };
      }
      const items = schemaOf(def.items, defs, true);
      const list = { type: "array", items, ...(def.minItems && { minItems: def.minItems }), ...(def.maxItems && { maxItems: def.maxItems }) };
      return def.orOne ? describe({ anyOf: [list, items] }) : describe(list);
    }
    case "object":
      return describe({ type: "object", ...(def.fields && { properties: propertiesOf(def.fields, defs), ...(!def.open && { additionalProperties: false }), ...(def.required && { required: def.required }) }) });
    default:
      return describe({ type: def.type });
  }
}

const propertiesOf = (fields, defs, bare = false) => Object.fromEntries(Object.entries(fields).map(([name, def]) => [name, schemaOf(def, defs, bare)]));

function schemaFor(fields, required, { media = true } = {}) {
  const defs = {};
  const properties = propertiesOf(fields, defs);
  // The media fields are on every level that shows something; name them all so they are written once.
  if (media) for (const def of Object.values(MEDIA_FIELDS)) schemaOf(def, defs);
  // What the engine needs is not optional: its property refuses null.
  for (const name of required) {
    const p = properties[name];
    if (Array.isArray(p.type)) p.type = p.type.find((t) => t !== "null");
  }
  return { type: "object", additionalProperties: false, properties, required, $defs: defs };
}

// JSON Schema of a questions spec: an unknown field is refused at every level; an option may be a string.
// A question may carry the fields of any type (the engine warns about one that is not its own type's).
const QUESTIONS = arrayOf(shared("question", object("One question.", everyQuestionField())), "The questions, at least one.", { minItems: 1 });
export const specSchema = () => schemaFor({ ...ROUND_FIELDS, questions: QUESTIONS }, ["questions"]);

// The same for a swipe deck.
export const deckSchema = () => schemaFor(DECK_FIELDS, ["cards"]);

// The same for a review: it carries no media, so none is named.
export const reviewSchema = () => schemaFor(REVIEW_FIELDS, ["chapters"], { media: false });

// ---- the tables

const cell = (text) => String(text).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
const row = (...cells) => `| ${cells.map(cell).join(" | ")} |`;
const code = (name) => `\`${name}\``;

// Every field a type reads of its own (a legacy spelling is not a field of its own).
const ownFields = (def) => Object.entries(def.fields || {}).filter(([, f]) => !f.alias).map(([name]) => code(name)).join(", ") || "none";

// What a media kind takes: its own doc, then the doc of each name inside it and of each companion field,
// so spec.md says everything the schema leaves out. A spelling the engine only tolerates is not listed.
function fieldNotes(def) {
  const notes = [];
  const named = (name, f) => f.doc && notes.push(`\`${name}\`${f.type === "enum" ? ` (${f.values.join(", ")})` : ""}: ${f.doc}`);
  const inside = (f) => {
    if (f.items) inside(f.items);
    f.of?.forEach(inside);
    for (const [name, child] of Object.entries(f.fields || {})) if (!child.alias) named(name, child);
  };
  inside(def.field);
  for (const [name, f] of Object.entries(def.extra || {})) if (!f.alias) named(name, f);
  return notes;
}

export function docTables() {
  const types = [
    row("Type", "What it is", "Fields of its own"),
    row("---", "---", "---"),
    ...[...TYPES.values()].map((def) => row(code(def.name), def.summary, ownFields(def))),
  ];
  const media = [
    row("Field", "What it shows", "What it takes"),
    row("---", "---", "---"),
    ...[...MEDIA.values()].map((def) => {
      const extra = Object.keys(def.extra || {});
      return row(`${code(def.name)}${extra.length ? ` (also ${extra.map(code).join(", ")})` : ""}`, def.summary, [def.field.doc, ...fieldNotes(def)].join(" "));
    }),
  ];
  return { types: types.join("\n"), media: media.join("\n") };
}

// One line per type and per media kind, for a tool's description.
export function typeLines() {
  return [...TYPES.values(), ...MEDIA.values()].map((def) => `${def.name}: ${def.summary}`).join("\n");
}

// For the swipe tool's description: the fields a card carries, then the media kinds a card or a side takes.
export function deckLines() {
  const own = Object.entries(CARD_FIELDS)
    .filter(([name, def]) => !def.alias && !(name in MEDIA_FIELDS))
    .map(([name, def]) => `${name}: ${def.doc}`);
  return ["Card fields:", ...own, "Media a card, or either of its sides, takes:", ...[...MEDIA.values()].map((def) => `${def.name}: ${def.deckSummary ?? def.summary}`)].join("\n");
}

// For the review tool's description: what a chapter carries and how it names its hunks.
const reviewerSections = [
  ["Reviewer fields", REVIEWER_FIELDS, "reviewers"],
  ["Reviewer run fields", REVIEWER_RUN_FIELDS, "ran[]"],
  ["Skipped reviewer fields", REVIEWER_SKIP_FIELDS, "skipped[]"],
  ["Finding fields", FINDING_FIELDS, "findings[]"],
];

export function reviewLines() {
  return [
    ["Review fields", REVIEW_FIELDS], ["Chapter fields", CHAPTER_FIELDS],
    ["Key place fields", FOCUS_FIELDS], ["Risk fields", RISK_FIELDS],
    ["Acceptance fields", ACCEPTANCE_FIELDS],
    ...reviewerSections,
  ].flatMap(([title, fields]) => [title + ":", ...Object.entries(fields).map(([name, def]) => `${name}: ${def.doc}`)]).join("\n");
}

export function injectReviewers(text) {
  const tag = "registry:reviewers";
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const block = new RegExp(`(<!-- ${tag} -->\\r?\\n)[\\s\\S]*?(<!-- /${tag} -->)`);
  if (!block.test(text)) throw new Error(`review SKILL.md has no <!-- ${tag} --> markers`);
  const table = [
    row("Field", "Meaning"), row("---", "---"),
    ...reviewerSections.flatMap(([, fields, prefix]) => Object.entries(fields).map(([name, def]) => row(code(`${prefix}.${name}`), def.doc))),
  ].join(eol);
  return text.replace(block, (match, open, close) => `${open}${eol}${table}${eol}${eol}${close}`);
}

// ---- spec.md

const TAGS = { types: "registry:types", media: "registry:media" };

// `text` with what sits between each pair of markers replaced; the rest is not touched.
export function inject(text, tables) {
  let out = text;
  const eol = /\r\n/.test(text) ? "\r\n" : "\n"; // the file keeps its own line ending
  for (const [key, tag] of Object.entries(TAGS)) {
    const pattern = new RegExp(`(<!-- ${tag} -->\\r?\\n)[\\s\\S]*?(\\r?\\n<!-- /${tag} -->)`);
    if (!pattern.test(out)) throw new Error(`spec.md has no <!-- ${tag} --> … <!-- /${tag} --> markers`);
    out = out.replace(pattern, (m, open, close) => `${open}${tables[key].replace(/\n/g, eol)}${close}`);
  }
  return out;
}

const REVIEW_SKILL = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/review/SKILL.md");
const SPEC = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/decide/spec.md");

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const tables = docTables();
  if (process.argv.includes("--write")) {
    const before = readFileSync(SPEC, "utf8");
    const after = inject(before, tables);
    if (after !== before) writeFileSync(SPEC, after);
    console.log(after === before ? "skills/decide/spec.md is up to date" : "skills/decide/spec.md updated");
    const skill = readFileSync(REVIEW_SKILL, "utf8");
    const review = injectReviewers(skill);
    if (review !== skill) writeFileSync(REVIEW_SKILL, review);
    console.log(review === skill ? "skills/review/SKILL.md is up to date" : "skills/review/SKILL.md updated");
  } else {
    console.log(`${tables.types}\n\n${tables.media}`);
  }
}
