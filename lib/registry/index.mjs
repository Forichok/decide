// registry/index.mjs — the question types and the fields every shape of a spec may carry.
//
// A FieldDef is { type: "string" | "number" | "boolean" | "enum" | "array" | "object" | "any",
// doc, values?, items?, fields?, alias? }. `alias` names the field a legacy spelling stands for.
//
// The lists below are taken from the code that reads a spec (spec.mjs, swipe.mjs, media.mjs,
// shot.mjs, words.mjs), not from the docs: a name 2.1 read is known here, legacy spellings included.
//
// A type is one module in ./types: { name, summary, fields, optionFields?, normalize(q, ctx),
// lint(q, add), example, seconds?(q) }. To add a type, write the module, add it to TYPES below
// and write ui/js/types/<name>.js.

import { alias, any, arrayOf, boolean, number, object, oneOf, shared, string, union } from "./shared.mjs";
import chart from "./media/chart.mjs";
import code from "./media/code.mjs";
import compare from "./media/compare.mjs";
import diff from "./media/diff.mjs";
import html from "./media/html.mjs";
import images from "./media/images.mjs";
import links from "./media/links.mjs";
import mermaid from "./media/mermaid.mjs";
import preview from "./media/preview.mjs";
import table from "./media/table.mjs";
import video from "./media/video.mjs";
import buckets from "./types/buckets.mjs";
import spot from "./types/spot.mjs";
import tradeoff from "./types/tradeoff.mjs";
import versus from "./types/versus.mjs";
import confirm from "./types/confirm.mjs";
import multi from "./types/multi.mjs";
import rank from "./types/rank.mjs";
import scale from "./types/scale.mjs";
import single from "./types/single.mjs";
import text from "./types/text.mjs";
import tune from "./types/tune.mjs";

// The 2.1 order: the error for an unknown type lists them like this.
export const TYPES = new Map([single, multi, rank, scale, text, confirm, buckets, tradeoff, spot, versus, tune].map((def) => [def.name, def]));

export const STAKES = ["low", "medium", "high"];

// A media kind is one module in ./media: { name, summary, field, extra?, normalize(out, ctx), lint(node, add),
// example, mistakes?, heavy?, plain?, beside?(nodes), publish?(node, helpers) }. `field` is the FieldDef of
// the kind's own name; `extra` holds the names it also owns (a companion such as previewHeight, or the older
// spelling of its name). `normalize` writes the kind's keys on the normalised node `out`; ctx carries `raw`,
// `where` and `path`. To add a kind, write the module, add it here and write ui/js/media/<name>.js.
// The order is the one the docs and tool descriptions use.
export const MEDIA = new Map([images, preview, html, mermaid, code, compare, video, diff, table, chart, links].map((def) => [def.name, def]));

// What a question, an option, a swipe card or a swipe side may show: every name a media kind owns.
export const MEDIA_FIELDS = Object.assign({}, ...[...MEDIA.values()].map((def) => ({ [def.name]: def.field, ...def.extra })));

// A reason, pro, con or metric value is a string, or this: the words with how well they are known.
export const EVIDENCE = ["measured", "estimate", "guess"];
const POINT = (what) => any(`${what} A string, or {text, evidence: "measured"|"estimate"|"guess", source}.`, { brief: "A string, or {text, evidence, source}" });

export const OPTION_FIELDS = {
  id: string("Short and unique within the question. Default a, b, c…"),
  label: string("The words on the option. Markdown-lite."),
  detail: string("A line or two under the label. Markdown."),
  recommended: any("true marks the agent's pick; a string does too and is the reason.", { brief: "true, or the reason" }),
  reason: POINT("Why the agent picks this one; shown with the star."),
  pros: arrayOf(POINT("One point."), "What speaks for the option.", { orOne: true }),
  cons: arrayOf(POINT("One point."), "What speaks against it.", { orOne: true }),
  metrics: any("An object of name: value. A number from 1 to 5 draws dots, anything else is shown as text. A value may be {text, evidence, source}.", { brief: "An object of name: value" }),
  tags: arrayOf(string("One tag."), "Small badges.", { orOne: true }),
  danger: boolean("Marks an option that is hard to take back."),
  then: string("What happens next if this option is picked. One line under the option."),
  ...MEDIA_FIELDS,
};

export const SECTION_FIELDS = {
  id: string("Referenced by questions' section."),
  title: string("The section's heading."),
  intro: string("A line under the heading."),
};

export const QUESTION_FIELDS = {
  id: string("Unique within the round. Default q1, q2…"),
  title: string("The question. Markdown-lite."),
  question: alias("title", "The older spelling of title.", string("The question.")),
  type: oneOf([...TYPES.keys()], "How the user answers. Default single."),
  section: string("The id of one of the round's sections."),
  tldr: string("One line on what depends on the answer."),
  body: string("More context. Markdown with tables, quotes and headings."),
  why: string("One line above the options: why you ask, what depends on the answer."),
  more: string("Connected text behind one \"more\" button. Markdown."),
  what: alias("more", "The 2.x fold, read into more.", string("The 2.x fold.")),
  how: alias("more", "The 2.x fold, read into more.", string("The 2.x fold.")),
  goal: alias("more", "The 2.x fold, read into more.", string("The 2.x fold.")),
  then: alias("more", "The 2.x fold, read into more.", string("The 2.x fold.")),
  optional: boolean("An optional question is never waited for."),
  mine: boolean("Only the user may answer; the recommendation is never filled in and the agent may not decide.", { brief: "Only the user may answer" }),
  note: any("true opens the note field from the start; a string does too and is its placeholder.", { brief: "true, or the placeholder" }),
  stakes: oneOf(STAKES, "high shows a badge and raises the priority.", { loose: true }),
  reversible: boolean("false shows an irreversible badge."),
  touches: arrayOf(oneOf(["money", "data", "security", "public"], "One thing the question touches.", { loose: true }), "What the question touches: money, data, security, public. At the level \"only the irreversible\" these questions are asked.", { orOne: true }),
  dependsOn: arrayOf(string("The id of a question or of an earlier round."), "What this question builds on; the decision map draws an edge.", { orOne: true }),
  priority: number("1 to 3, 1 first: which questions stay when the user has little time. Default 1 for high stakes, else 2.", { brief: "1 to 3, 1 first; decides what is cut when the budget is short" }),
  showIf: arrayOf(
    shared("showIf", object("Show this question only when the condition holds.", {
      q: string("The id of an earlier question."),
      question: alias("q", "The older spelling of q.", string("The id of an earlier question.")),
      in: arrayOf(string("An option id."), "Shown when one of these is selected.", { orOne: true }),
      selected: alias("in", "The older spelling of in.", arrayOf(string("An option id."), "", { orOne: true })),
      notIn: arrayOf(string("An option id."), "Hidden when one of these is selected.", { orOne: true }),
    }, { open: true })),
    "Conditions, all of which must hold.",
    { orOne: true },
  ),
  options: arrayOf(
    union("One option, or its label as a string.", string("The label of an option with nothing else to say."), shared("option", object("One option.", OPTION_FIELDS))),
    "The options.",
    { orOne: true },
  ),
  ...MEDIA_FIELDS,
};

export const ROUND_FIELDS = {
  $schema: string("Ignored: lets an editor check the spec against a schema."),
  title: string("The round's title."),
  lang: oneOf(["en", "ru"], "The language of the labels the page fills in itself. Default: guessed from the text.", { loose: true }),
  intro: string("Why these questions now."),
  recap: string("What the agent took from earlier answers."),
  context: string("Longer background, folded by default. Markdown."),
  glossary: object("Terms and their explanations; a term gets a tooltip.", undefined, { brief: "term: explanation" }),
  live: boolean("true: wait hands you a batch of answers after 3 new ones or 20 s of pause, so you can patch what is ahead. Without it you hear only the final answers."),
  brief: arrayOf(any("A string or {id?, kind?, text}."), "The task panel: what the task is, decided, checked, open.", { orOne: true }),
  budget: number("Minutes the user has: the questions that fit stay, by priority.", { brief: "Minutes the user has; questions that do not fit are dropped" }),
  sections: arrayOf(shared("section", object("One section.", SECTION_FIELDS, { open: true })), "Groups of questions.", { orOne: true }),
  questions: arrayOf(shared("question", object("One question.", QUESTION_FIELDS)), "The questions, at least one.", { minItems: 1 }),
  // 3.0 rounds that react: {when, do: [{ghost|restore|removeOptions|stale}], reason}. lintRules checks the insides.
  rules: arrayOf(any("{when, do, reason}"), "Rules: when answers hold, ghost, restore, drop options or mark stale.", { brief: "{when, do, reason}" }),
};

// ---- the swipe deck: cards with two sides

export const SIDE_FIELDS = {
  label: string("The words on the side."),
  detail: string("A line under the label."),
  ...MEDIA_FIELDS,
};

const SIDE = shared("side", union("One side of the card: {label, detail?, …media}, or the label as a string.", string("The label."), object("A side.", SIDE_FIELDS)));

export const CARD_FIELDS = {
  id: string("Short, stable, unique. Required in a push."),
  title: string("The question, short."),
  left: SIDE,
  right: SIDE,
  recommended: oneOf(["left", "right"], "The side the agent would pick.", { loose: true }),
  reason: string("Why."),
  section: string("A small heading."),
  tldr: string("One line on what depends on the answer."),
  body: string("More context."),
  what: string("The fold: what it is."),
  how: string("The fold: how it works."),
  why: string("The fold: why it matters."),
  goal: string("The fold: what it is for."),
  then: string("The fold: what each answer leads to."),
  from: string("The id of the card this one follows up.", { nullable: true }),
  stakes: oneOf(["high"], "high for money, data and anything hard to undo.", { loose: true }),
  ...MEDIA_FIELDS,
};

export const DECK_FIELDS = {
  $schema: string("Ignored: lets an editor check the spec against a schema."),
  title: string("The interview's title."),
  lang: oneOf(["en", "ru"], "The language of the labels the page fills in itself.", { loose: true }),
  goal: string("One line on what the interview is for; it heads the brief."),
  intro: string("A line before the first card."),
  recap: string("Read to guess the language; shown nowhere."),
  glossary: object("Terms and their explanations."),
  cards: arrayOf(shared("card", object("One card.", CARD_FIELDS)), "The cards, at least one.", { minItems: 1 }),
  brief: arrayOf(any("A string or {id?, kind?, text, cards?}."), "Starting points of the brief.", { orOne: true }),
  confidence: number("0 to 100: how well the agent understands what the user wants.", { brief: "0 to 100" }),
  batch: number("Answers per batch. Default 5.", { brief: "Answers per batch" }),
};

// ---- the review: an overview and chapters over the diff of a branch

export const RISKS = ["high", "medium", "low"];
// What a key place is: where it can break, a choice that could have gone another way, a spot the agent is not sure of.
export const FOCUS_KINDS = ["risk", "decision", "check"];
const HUNK_REFS = (doc) => arrayOf(string("\"path\", \"path:from-to\" (lines of the new file), \"dir/\" or a glob."), doc, { orOne: true });

export const FOCUS_FIELDS = {
  text: string("Trimmed text of the first line at at, as outline prints it. Lint detects a moved place."),
  at: string("\"path:from-to\": 10 to 30 lines of the new file, inside the chapter's hunks."),
  note: string("What to check there, in one phrase."),
  checkedBy: string("For a risk: which check covers it, or say that nothing does."),
  question: string("For a decision: one yes/no question about behaviour the owner can judge."),
  options: arrayOf(string("Short answer label."), "Two labels, yes then no. Default: localised Yes / No.", { minItems: 2, maxItems: 2 }),
  kind: oneOf(FOCUS_KINDS, "risk: can break. decision: a choice to agree with. check: you are not sure. Leave out for a plain place.", { loose: true }),
};

export const CHAPTER_FIELDS = {
  id: string("Short and unique within the review. Default ch1, ch2…"),
  title: string("What this part of the change does, in a few words."),
  summary: string("What changed here and why: two or three sentences. Markdown."),
  watch: string("Where to look: the line or the decision you are least sure of."),
  risk: oneOf(RISKS, "How much can go wrong here. Default low.", { loose: true }),
  hunks: HUNK_REFS("The hunks of this chapter, tests next to the code they cover."),
  focus: arrayOf(shared("focus", object("One key place.", FOCUS_FIELDS)), "Up to five places a person should read. The page folds the chapter's other lines.", { orOne: true }),
  skim: string("Why no line-by-line reading is needed here. The page folds the chapter."),
};

export const MECHANICAL_FIELDS = {
  title: string("What the edit is: \"renamed x to y\", \"screenshots\", \"lock file\"."),
  hunks: HUNK_REFS("The hunks folded into this one line."),
};

export const RISK_FIELDS = {
  level: oneOf(RISKS, "Default medium.", { loose: true }),
  what: string("What can go wrong, in one line."),
  checkedBy: string("Which check covers this risk, or say that nothing does."),
  why: string("Why you think so, and what you did about it."),
  chapter: string("The id of the chapter where it lives: the page jumps there."),
};

export const CHECK_FIELDS = {
  command: string("The command as you ran it."),
  exit: number("Its exit code. Leave it out for a check you did not run.", { brief: "Exit code; leave out when not run" }),
  seconds: number("How long it took."),
  note: string("One line: what it covers, or why it was not run."),
};

export const ACCEPTANCE_FIELDS = {
  changed: string("What changed for the user. For a refactoring: Nothing changes from outside."),
  where: string("Where to look: a URL, screen or command."),
  steps: arrayOf(string("What to do."), "Steps the owner can follow."),
  expect: string("What should happen."),
};

export const REVIEW_FIELDS = {
  acceptance: object("How to check the change yourself; the page runs and verifies nothing.", ACCEPTANCE_FIELDS),
  mechanicalWhy: string("Why mechanical groups hold more than one third of changed lines. One or two sentences; required above that share."),
  $schema: string("Ignored: lets an editor check the spec against a schema."),
  title: string("The review's title: what the change is."),
  lang: oneOf(["en", "ru"], "The language of the labels the page fills in itself. Default: guessed from the text.", { loose: true }),
  summary: string("What changed and why, under What changed in the overview. Markdown."),
  risks: arrayOf(shared("risk", object("One risk.", RISK_FIELDS)), "What can go wrong, the worst first.", { orOne: true }),
  checks: arrayOf(shared("check", object("One check.", CHECK_FIELDS)), "What you ran: command, exit code, seconds. The page runs nothing.", { orOne: true }),
  chapters: arrayOf(shared("chapter", object("One chapter.", CHAPTER_FIELDS)), "The change in the order of the idea, at least one chapter.", { minItems: 1 }),
  mechanical: arrayOf(shared("mechanical", object("One group of mechanical edits.", MECHANICAL_FIELDS)), "Renames, formatting, generated and lock files: each group folds into one line with a count.", { orOne: true }),
};

// What a question of this type may carry: the common fields and the type's own.
export const questionFieldsOf = (type) => ({ ...QUESTION_FIELDS, ...(TYPES.get(type)?.fields || {}) });
// What an option of a question of this type may carry.
export const optionFieldsOf = (type) => ({ ...OPTION_FIELDS, ...(TYPES.get(type)?.optionFields || {}) });
// Every name some type reads, for a question whose type is not known.
export const everyQuestionField = () => Object.assign({}, QUESTION_FIELDS, ...[...TYPES.values()].map((t) => t.fields || {}));
