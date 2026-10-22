// spec.mjs — normalize a questions spec (v1 or v2) into the shape the page
// renders, and collect lint issues. Pure except for existsSync on local assets.

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { collectMedia, shareScale } from "./media.mjs";
import { specLang, words } from "./words.mjs";

export const TYPES = ["single", "multi", "rank", "scale", "text", "confirm"];
const CHOICE = new Set(["single", "multi", "rank", "confirm"]);
const LAYOUTS = ["list", "grid", "compare"];
const STAKES = ["low", "medium", "high"];
const FLAT_LIMIT = 12;
const confirmOptions = (w) => [
  { id: "yes", label: w.yes },
  { id: "no", label: w.no },
  { id: "change", label: w.change, detail: w.changeDetail },
];

const str = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);

export function normalizeSpec(raw, { specDir = process.cwd() } = {}) {
  const issues = [];
  const add = (level, where, message) => issues.push({ level, where, message });
  const lang = specLang(raw);
  const w = words(lang);
  const ctx = { specDir, add, w, exists: (p) => existsSync(p), abs: (p) => (isAbsolute(p) ? p : resolve(specDir, p)) };

  if (!raw || typeof raw !== "object" || !Array.isArray(raw.questions) || raw.questions.length === 0) {
    add("error", "questions", 'expected { "questions": [ ... ] } with at least one question');
    return { spec: null, issues };
  }

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
    return normalizeQuestion(q || {}, id, where, ctx, sectionIds);
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

function normalizeQuestion(q, id, where, ctx, sectionIds) {
  const type = str(q.type) || "single";
  if (!TYPES.includes(type)) ctx.add("error", where, `unknown type "${type}" (use ${TYPES.join(", ")})`);

  let rawOptions = list(q.options);
  if (type === "confirm" && rawOptions.length === 0) rawOptions = confirmOptions(ctx.w);
  const options = rawOptions.map((o, oi) => normalizeOption(o || {}, oi, `${where}.options[${oi}]`, ctx));
  shareScale(options.map((o) => o.chart));

  if (CHOICE.has(type) && options.length === 0) ctx.add("error", where, `"${id}" needs at least one option`);
  const optIds = new Set();
  for (const o of options) {
    if (optIds.has(o.id)) ctx.add("error", where, `duplicate option id "${o.id}"`);
    optIds.add(o.id);
  }
  const recs = options.filter((o) => o.recommended).length;
  if (type === "single" && recs > 1) ctx.add("warn", where, "several recommended options in a single-choice question");
  if ((type === "single" || type === "multi") && options.length > 1 && !recs) {
    ctx.add("warn", where, "no recommended option — mark what you would pick and why");
  }

  if (q.mine === true && q.optional === true) ctx.add("warn", where, "mine and optional together: an optional question is never waited for");
  const section = str(q.section);
  if (section && !sectionIds.has(section)) ctx.add("error", where, `unknown section "${section}"`);
  const layout = str(q.layout) || "list";
  if (!LAYOUTS.includes(layout)) ctx.add("warn", where, `unknown layout "${layout}", using list`);
  const stakes = str(q.stakes);
  if (stakes && !STAKES.includes(stakes)) ctx.add("warn", where, `unknown stakes "${stakes}"`);

  return {
    id,
    section: section || null,
    title: str(q.title) || str(q.question) || ctx.w.question,
    tldr: str(q.tldr),
    body: str(q.body),
    what: str(q.what),
    how: str(q.how),
    why: str(q.why),
    goal: str(q.goal),
    type,
    optional: q.optional === true,
    // Only the user's own answer counts: no recommendation is filled in, "Agent decides" is off.
    mine: q.mine === true,
    noteOpen: Boolean(q.note),
    note: typeof q.note === "string" ? q.note : "",
    allowOther: q.allowOther !== false && (type === "single" || type === "multi"),
    stakes: STAKES.includes(stakes) ? stakes : null,
    reversible: q.reversible === false ? false : null,
    layout: LAYOUTS.includes(layout) ? layout : "list",
    showIf: list(q.showIf).map((c) => ({
      q: str(c.q) || str(c.question),
      in: list(c.in ?? c.selected).map(String),
      notIn: list(c.notIn).map(String),
    })),
    priority: Number.isInteger(q.priority) ? q.priority : q.stakes === "high" ? 1 : 2,
    min: Number.isInteger(q.min) ? q.min : type === "multi" ? 1 : 0,
    max: Number.isInteger(q.max) ? q.max : null,
    scale: type === "scale" ? normalizeScale(q.scale, where, ctx) : null,
    placeholder: str(q.placeholder),
    default: list(q.default).map(String),
    ...collectMedia(q, where, ctx),
    options,
  };
}

function normalizeOption(o, oi, where, ctx) {
  const rec = o.recommended;
  return {
    id: str(o.id) || String.fromCharCode(97 + oi),
    label: str(o.label) || ctx.w.option(oi + 1),
    detail: str(o.detail),
    recommended: Boolean(rec),
    reason: typeof rec === "string" ? rec : str(o.reason),
    pros: list(o.pros).map(String),
    cons: list(o.cons).map(String),
    metrics: Object.entries(o.metrics || {}).map(([label, value]) => ({ label, value })),
    tags: list(o.tags).map(String),
    danger: o.danger === true,
    ...collectMedia(o, where, ctx),
  };
}

function normalizeScale(s = {}, where, ctx) {
  const min = Number.isInteger(s.min) ? s.min : 1;
  const max = Number.isInteger(s.max) ? s.max : 5;
  if (max <= min || max - min > 10) ctx.add("error", where, "scale needs min < max and at most 11 steps");
  return { min, max, labels: s.labels && typeof s.labels === "object" ? s.labels : {} };
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
  return { kept: questions.filter((q) => keep.has(q.id)), leftOut: questions.filter((q) => !keep.has(q.id)) };
}

function cost(q) {
  if (q.type === "text" || q.type === "rank") return 45;
  return 15 + q.options.length * 4;
}
