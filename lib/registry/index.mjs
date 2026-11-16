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

import { alias, any, arrayOf, boolean, number, object, oneOf, string } from "./shared.mjs";
import confirm from "./types/confirm.mjs";
import multi from "./types/multi.mjs";
import rank from "./types/rank.mjs";
import scale from "./types/scale.mjs";
import single from "./types/single.mjs";
import text from "./types/text.mjs";

// The 2.1 order: the error for an unknown type lists them like this.
export const TYPES = new Map([single, multi, rank, scale, text, confirm].map((def) => [def.name, def]));

export const STAKES = ["low", "medium", "high"];

// What a question, an option, a swipe card or a swipe side may show. Their insides are lib/media.mjs's.
export const MEDIA_FIELDS = {
  images: arrayOf(any("A path, a URL, {src, caption} or a capture {shot|sim, …}."), "Pictures, a list or a single entry."),
  image: alias("images", "One picture; the older spelling of images.", any("A path, a URL or {src, caption}.")),
  preview: string("Path to a self-contained HTML file, shown as a live mockup."),
  previewHeight: number("Height of the preview in px. Default 360."),
  html: any("An HTML string or {source, maxHeight?}, drawn in a sandboxed frame."),
  code: any("A string, or {text, lang?, diff?}."),
  mermaid: string("Mermaid source."),
  compare: object("{before, after, labels?}: two pictures or two mockups behind one divider."),
  video: any("A path or URL, {src, caption?, loop?}, or a list. mp4, webm or gif."),
  videos: alias("video", "The older spelling of video.", any("A list of videos.")),
  diff: object("{before, after, lang?, labels?}: two texts compared line by line."),
  table: object("{columns, rows, caption?}."),
  chart: object("{type, labels, series, unit?, title?}."),
  links: arrayOf(any("{label, url} or a URL string."), "Links shown with the question."),
  link: alias("links", "One link; the older spelling of links.", any("{label, url} or a URL string.")),
};

export const OPTION_FIELDS = {
  id: string("Short and unique within the question. Default a, b, c…"),
  label: string("The words on the option. Markdown-lite."),
  detail: string("A line or two under the label. Markdown."),
  recommended: any("true marks the agent's pick; a string does too and is the reason."),
  reason: string("Why the agent picks this one; shown with the star."),
  pros: arrayOf(string("One point."), "What speaks for the option."),
  cons: arrayOf(string("One point."), "What speaks against it."),
  metrics: object("Facts by name: a number from 1 to 5 draws dots, anything else is shown as text."),
  tags: arrayOf(string("One tag."), "Small badges."),
  danger: boolean("Marks an option that is hard to take back."),
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
  what: string("The fold: what it is."),
  how: string("The fold: how it works."),
  why: string("The fold: why it matters."),
  goal: string("The fold: what it is for."),
  then: string("The fold: what happens after each answer."),
  optional: boolean("An optional question is never waited for."),
  mine: boolean("Only the user may answer; the recommendation is never filled in and the agent may not decide."),
  note: any("true opens the note field from the start; a string does too and is its placeholder."),
  stakes: oneOf(STAKES, "high shows a badge and raises the priority."),
  reversible: boolean("false shows an irreversible badge."),
  priority: number("1 to 3, 1 first: which questions stay when the user has little time. Default 1 for high stakes, else 2."),
  showIf: arrayOf(
    object("Show this question only when the condition holds.", {
      q: string("The id of an earlier question."),
      question: alias("q", "The older spelling of q.", string("The id of an earlier question.")),
      in: arrayOf(string("An option id."), "Shown when one of these is selected."),
      selected: alias("in", "The older spelling of in.", arrayOf(string("An option id."), "Shown when one of these is selected.")),
      notIn: arrayOf(string("An option id."), "Hidden when one of these is selected."),
    }),
    "Conditions, all of which must hold.",
  ),
  options: arrayOf(object("One option.", OPTION_FIELDS), "The options. A string is an option with that label."),
  ...MEDIA_FIELDS,
};

export const ROUND_FIELDS = {
  title: string("The round's title."),
  lang: oneOf(["en", "ru"], "The language of the labels the page fills in itself. Default: guessed from the text."),
  intro: string("Why these questions now."),
  recap: string("What the agent took from earlier answers."),
  context: string("Longer background, folded by default. Markdown."),
  glossary: object("Terms and their explanations; a term gets a tooltip."),
  budget: number("Minutes the user has: the questions that fit stay, by priority."),
  sections: arrayOf(object("One section.", SECTION_FIELDS), "Groups of questions."),
  questions: arrayOf(object("One question.", QUESTION_FIELDS), "The questions, at least one."),
};

// ---- the swipe deck: cards with two sides

export const SIDE_FIELDS = {
  label: string("The words on the side."),
  detail: string("A line under the label."),
  ...MEDIA_FIELDS,
};

export const CARD_FIELDS = {
  id: string("Short, stable, unique. Required in a push."),
  title: string("The question, short."),
  question: alias("title", "The older spelling of title.", string("The question, short.")),
  left: object("The left side: {label, detail?, …media} or a string.", SIDE_FIELDS),
  right: object("The right side.", SIDE_FIELDS),
  recommended: oneOf(["left", "right"], "The side the agent would pick."),
  reason: string("Why."),
  section: string("A small heading."),
  tldr: string("One line on what depends on the answer."),
  body: string("More context."),
  what: string("The fold: what it is."),
  how: string("The fold: how it works."),
  why: string("The fold: why it matters."),
  goal: string("The fold: what it is for."),
  then: string("The fold: what each answer leads to."),
  from: string("The id of the card this one follows up."),
  stakes: oneOf(["high"], "high for money, data and anything hard to undo."),
  ...MEDIA_FIELDS,
};

export const DECK_FIELDS = {
  title: string("The interview's title."),
  lang: oneOf(["en", "ru"], "The language of the labels the page fills in itself."),
  goal: string("One line on what the interview is for; it heads the brief."),
  intro: string("A line before the first card."),
  recap: string("Read to guess the language; shown nowhere."),
  glossary: object("Terms and their explanations."),
  cards: arrayOf(object("One card.", CARD_FIELDS), "The cards, at least one."),
  brief: arrayOf(any("A string or {id?, kind?, text, cards?}."), "Starting points of the brief."),
  confidence: number("0 to 100: how well the agent understands what the user wants."),
  batch: number("Answers per batch. Default 5."),
};

// What a question of this type may carry: the common fields and the type's own.
export const questionFieldsOf = (type) => ({ ...QUESTION_FIELDS, ...(TYPES.get(type)?.fields || {}) });
// What an option of a question of this type may carry.
export const optionFieldsOf = (type) => ({ ...OPTION_FIELDS, ...(TYPES.get(type)?.optionFields || {}) });
// Every name some type reads, for a question whose type is not known.
export const everyQuestionField = () => Object.assign({}, QUESTION_FIELDS, ...[...TYPES.values()].map((t) => t.fields || {}));
