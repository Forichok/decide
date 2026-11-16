// spec.mjs — normalize a questions spec (v1 or v2) into the shape the page
// renders, and collect lint issues. Pure except for existsSync on local assets.

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { beside, collectMedia } from "./media.mjs";
import { TYPES as REGISTRY, STAKES, ROUND_FIELDS, everyQuestionField, optionFieldsOf, questionFieldsOf } from "./registry/index.mjs";
import { LAYOUTS } from "./registry/shared.mjs";
import { nearest, unknownFields } from "./registry/strict.mjs";
import { specLang, words } from "./words.mjs";

export const TYPES = [...REGISTRY.keys()];
const FLAT_LIMIT = 12;

const str = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);

// fields: "strict" makes a name nobody reads an error (a spec an agent hands in now); "lenient"
// makes it a warning with the same text (a spec read back from a finished round, which 2.1 took
// whatever it held). Every other kind of error stays an error in both.
export function normalizeSpec(raw, { specDir = process.cwd(), fields = "strict" } = {}) {
  const issues = [];
  const add = (level, where, message) => issues.push({ level, where, message });
  const lang = specLang(raw);
  const w = words(lang);
  const ctx = { specDir, add, w, fieldLevel: fields === "lenient" ? "warn" : "error", exists: (p) => existsSync(p), abs: (p) => (isAbsolute(p) ? p : resolve(specDir, p)) };

  if (!raw || typeof raw !== "object" || !Array.isArray(raw.questions) || raw.questions.length === 0) {
    add("error", "questions", 'expected { "questions": [ ... ] } with at least one question');
    return { spec: null, issues };
  }

  unknownFields(raw, Object.keys(ROUND_FIELDS), "round", add, { level: ctx.fieldLevel });
  const sections = list(raw.sections).map((s, i) => ({
    id: str(s.id) || `section-${i + 1}`,
    title: str(s.title) || w.section(i + 1),
    intro: str(s.intro),
  }));
  const sectionIds = new Set(sections.map((s) => s.id));
  const seen = new Set();

  const questions = raw.questions.map((q, qi) => {
    const where = `questions[${qi}]${q && q.id ? ` (${q.id})` : ""}`;
    const id = str(q?.id) || `q${qi + 1}`;
    if (seen.has(id)) add("error", where, `duplicate question id "${id}"`);
    seen.add(id);
    return normalizeQuestion(q || {}, id, where, ctx, sectionIds, `questions[${qi}]`);
  });

  const byId = new Map(questions.map((q) => [q.id, q]));
  questions.forEach((q, qi) => checkShowIf(q, qi, questions, byId, add));
  const budget = Number.isFinite(Number(raw.budget)) && Number(raw.budget) > 0 ? Number(raw.budget) : null;
  if (raw.budget !== undefined && !budget) add("warn", "budget", "budget is the user's time in minutes, a positive number");
  const { kept, leftOut } = budget ? fitBudget(questions, budget * 60) : { kept: questions, leftOut: [] };
  if (leftOut.length) add("warn", "budget", `${leftOut.length} question(s) left out to fit ${budget} min: ${leftOut.map((q) => q.id).join(", ")}`);

  if (!sections.length && kept.length > FLAT_LIMIT) {
    add("warn", "sections", `${kept.length} questions without sections — group them or split into rounds`);
  }

  const spec = {
    lang,
    title: str(raw.title) || w.round,
    intro: str(raw.intro),
    recap: str(raw.recap),
    context: str(raw.context),
    glossary: raw.glossary && typeof raw.glossary === "object" ? raw.glossary : {},
    sections,
    questions: kept,
    budget,
    leftOut: leftOut.map((q) => ({ id: q.id, title: q.title })),
    estimateMin: Math.max(1, Math.round(kept.reduce((s, q) => s + cost(q), 0) / 60)),
  };
  return { spec, issues };
}

function normalizeQuestion(q, id, where, ctx, sectionIds, path) {
  const type = str(q.type) || "single";
  const def = REGISTRY.get(type);
  if (!def) {
    const near = nearest(type, TYPES);
    ctx.add("error", where, `unknown type "${type}" (use ${TYPES.join(", ")})${near ? `; did you mean "${near}"?` : ""}`);
  }
  checkFields(q, def, type, path, ctx);

  const optionOf = (o, oi) => normalizeOption(o, oi, `${where}.options[${oi}]`, ctx, `${path}.options[${oi}]`, def);
  const options = list(q.options).map(optionOf);
  beside(options);

  const optIds = new Set();
  for (const o of options) {
    if (optIds.has(o.id)) ctx.add("error", where, `duplicate option id "${o.id}"`);
    optIds.add(o.id);
  }

  if (q.mine === true && q.optional === true) ctx.add("warn", where, "mine and optional together: an optional question is never waited for");
  const section = str(q.section);
  if (section && !sectionIds.has(section)) ctx.add("error", where, `unknown section "${section}"`);
  const layout = str(q.layout) || "list";
  if (!LAYOUTS.includes(layout)) ctx.add("warn", where, `unknown layout "${layout}", using list`);
  const stakes = str(q.stakes);
  if (stakes && !STAKES.includes(stakes)) ctx.add("warn", where, `unknown stakes "${stakes}"`);

  const out = {
    id,
    section: section || null,
    title: str(q.title) || str(q.question) || ctx.w.question,
    tldr: str(q.tldr),
    body: str(q.body),
    what: str(q.what),
    how: str(q.how),
    why: str(q.why),
    goal: str(q.goal),
    then: str(q.then),
    type,
    optional: q.optional === true,
    // Only the user's own answer counts: no recommendation is filled in, "Agent decides" is off.
    mine: q.mine === true,
    noteOpen: Boolean(q.note),
    note: typeof q.note === "string" ? q.note : "",
    // The types that take an own option switch it on; for the rest it stays off.
    allowOther: false,
    stakes: STAKES.includes(stakes) ? stakes : null,
    reversible: q.reversible === false ? false : null,
    layout: LAYOUTS.includes(layout) ? layout : "list",
    showIf: list(q.showIf).map((c) => ({
      q: str(c.q) || str(c.question),
      in: list(c.in ?? c.selected).map(String),
      notIn: list(c.notIn).map(String),
    })),
    priority: Number.isInteger(q.priority) ? q.priority : q.stakes === "high" ? 1 : 2,
    min: Number.isInteger(q.min) ? q.min : 0,
    max: Number.isInteger(q.max) ? q.max : null,
    scale: null,
    placeholder: str(q.placeholder),
    default: list(q.default).map(String),
    ...collectMedia(q, where, ctx, path),
    options,
  };
  // The type finishes what is its own, then lints; what it reports carries the question's place.
  def?.normalize(out, { ...ctx, raw: q, where, option: optionOf });
  def?.lint(out, (level, message) => ctx.add(level, where, message));
  return out;
}

// Unknown names are errors (warnings when lenient); a name only other types read is one warning,
// since 2.1 let it through.
function checkFields(q, def, type, path, ctx) {
  const optionNames = Object.keys(optionFieldsOf());
  const elsewhere = { names: optionNames, say: (n) => `"${n}" is an option field: put it on the option` };
  unknownFields(q, Object.keys(everyQuestionField()), path, ctx.add, { level: ctx.fieldLevel, kind: "question", elsewhere });
  if (!def || !q || typeof q !== "object") return;
  const known = Object.keys(questionFieldsOf(type));
  const owners = new Map();
  for (const [other, o] of REGISTRY) {
    if (other === type) continue;
    for (const key of Object.keys(o.fields || {})) {
      if (key in q && !known.includes(key)) owners.set(key, [...(owners.get(key) || []), other]);
    }
  }
  for (const [key, types] of owners) ctx.add("warn", path, `field "${key}" belongs to ${types.join(", ")} questions, not to ${type} ones; leave it out`);
}

// Facts by name: {Speed: 4}. The list form {label, value} that 2.1's docs taught is the same facts.
function metricsOf(m) {
  if (Array.isArray(m)) return m.filter((x) => x && typeof x === "object").map((x) => ({ label: String(x.label ?? ""), value: x.value }));
  return Object.entries(m && typeof m === "object" ? m : {}).map(([label, value]) => ({ label, value }));
}

function normalizeOption(o, oi, where, ctx, path, def) {
  // A bare string is an option with that label.
  if (typeof o === "string") o = { label: o };
  o = o || {};
  const questionNames = Object.keys(everyQuestionField());
  const elsewhere = { names: questionNames, say: (n) => `"${n}" is a question field: put it on the question` };
  unknownFields(o, Object.keys(optionFieldsOf(def?.name)), path, ctx.add, { level: ctx.fieldLevel, kind: "option", elsewhere });
  const rec = o.recommended;
  return {
    id: str(o.id) || String.fromCharCode(97 + oi),
    label: str(o.label) || ctx.w.option(oi + 1),
    detail: str(o.detail),
    recommended: Boolean(rec),
    reason: typeof rec === "string" ? rec : str(o.reason),
    pros: list(o.pros).map(String),
    cons: list(o.cons).map(String),
    metrics: metricsOf(o.metrics),
    tags: list(o.tags).map(String),
    danger: o.danger === true,
    ...collectMedia(o, where, ctx, path),
  };
}

function checkShowIf(q, qi, questions, byId, add) {
  for (const c of q.showIf) {
    const target = byId.get(c.q);
    const where = `questions[${qi}] (${q.id})`;
    if (!target) {
      add("error", where, `showIf references unknown question "${c.q}"`);
      continue;
    }
    if (questions.indexOf(target) > qi) add("warn", where, `showIf depends on later question "${c.q}"`);
    const ids = new Set(target.options.map((o) => o.id));
    for (const v of [...c.in, ...c.notIn]) {
      if (!ids.has(v)) add("error", where, `showIf references unknown option "${v}" of "${c.q}"`);
    }
  }
}

// "I have 5 minutes": keep the most important questions that fit, in spec order. priority 1
// goes first (high stakes count as 1), then 2, 3…; ties keep their order. The first pick always
// stays, and a question whose showIf points at a dropped one goes too.
export function fitBudget(questions, seconds) {
  const ranked = questions.map((q, i) => ({ q, i })).sort((a, b) => a.q.priority - b.q.priority || a.i - b.i);
  const keep = new Set();
  let used = 0;
  for (const { q } of ranked) {
    if (keep.size && used + cost(q) > seconds) continue;
    keep.add(q.id);
    used += cost(q);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const q of questions) {
      if (keep.has(q.id) && q.showIf.some((c) => !keep.has(c.q))) {
        keep.delete(q.id);
        changed = true;
      }
    }
  }
  // Pruning can undo the first pick; it then stays with the questions its showIf needs.
  if (!keep.size && ranked.length) {
    const byId = new Map(questions.map((q) => [q.id, q]));
    const add = (q) => {
      if (!q || keep.has(q.id)) return;
      keep.add(q.id);
      for (const c of q.showIf) add(byId.get(c.q));
    };
    add(ranked[0].q);
  }
  return { kept: questions.filter((q) => keep.has(q.id)), leftOut: questions.filter((q) => !keep.has(q.id)) };
}

// Seconds the user needs: a type may say its own, otherwise a glance per option.
function cost(q) {
  const own = REGISTRY.get(q.type)?.seconds;
  return own ? own(q) : 15 + q.options.length * 4;
}
