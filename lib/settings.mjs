// settings.mjs — shared resolution of defaults, global choices and project overrides.
// Rules made from answers still belong only to their project.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { topicWords } from "./journal.mjs";
import { decideHome } from "./project.mjs";
import { globalSettingsPath } from "./home.mjs";

export const LEVELS = ["everything", "irreversible", "mine"];
export const TOUCHES = ["money", "data", "security", "public"];
export const RULE_MODES = ["never", "always"];

const settingsPath = (dataDir) => join(dataDir, "settings.json");
const rulesPath = (dataDir) => join(dataDir, "rules.json");

function readJson(file, fallback) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

const userError = (message) => Object.assign(new Error(message), { user: true });

export const REVIEWER_MODES = ["always", "large", "request"];
const DEFAULTS = {
  level: "everything",
  reviewers: {
    mode: "large", lines: 200,
    roles: [
      { id: "correctness", title: "Bugs and regressions", brief: "Logic errors, broken edge cases, behaviour that changed without being said.", model: "" },
      { id: "safety", title: "Security and data", brief: "Input checks, auth, secrets, money, migrations, data loss.", model: "" },
      { id: "tests", title: "What the checks prove", brief: "Whether the checks named in the overview really cover the risks, what is not covered.", model: "" },
    ],
  },
};
const NAMES = Object.keys(DEFAULTS);
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

function fields(value, allowed, name) {
  if (!object(value)) throw userError(`${name} must be an object; allowed fields: ${allowed.join(", ")}`);
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw userError(`${name} allowed fields: ${allowed.join(", ")}`);
}

function validate(name, value) {
  if (name === "level") {
    if (!LEVELS.includes(value)) throw userError(`level is one of: ${LEVELS.join(", ")}`);
    return;
  }
  if (name !== "reviewers") throw userError(`allowed settings: ${NAMES.join(", ")}`);
  fields(value, ["mode", "lines", "roles"], "reviewers");
  if (!REVIEWER_MODES.includes(value.mode)) throw userError(`reviewers.mode is one of: ${REVIEWER_MODES.join(", ")}`);
  if (!Number.isInteger(value.lines) || value.lines < 1 || value.lines > 100000) throw userError("reviewers.lines must be a whole number; allowed: 1…100000");
  if (!Array.isArray(value.roles) || value.roles.length > 8) throw userError("reviewers.roles must be a list; allowed: 0…8 roles");
  const ids = new Set();
  for (const role of value.roles) {
    fields(role, ["id", "title", "brief", "model"], "reviewers.roles entry");
    if (typeof role.id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/i.test(role.id) || ids.has(role.id)) throw userError("reviewers.roles id must be unique; allowed: 1…32 letters, digits, _ or -, starting with a letter");
    ids.add(role.id);
    for (const [key, max] of [["title", 80], ["brief", 600], ["model", 80]]) {
      if (typeof role[key] !== "string" || role[key].length > max || (key === "title" && !role[key].trim())) throw userError(`reviewers.roles ${key} must be a string; allowed: ${key === "title" ? 1 : 0}…${max} characters`);
    }
  }
}

// Invalid stored entries are absent. Reads do not repair or rewrite old files.
function overrides(raw) {
  const valid = {};
  if (!object(raw)) return valid;
  for (const name of NAMES) {
    if (!Object.hasOwn(raw, name)) continue;
    try { validate(name, raw[name]); valid[name] = clone(raw[name]); } catch {}
  }
  return valid;
}

// Pure and shared by every reader. Reviewers is one setting, never a nested merge.
export function effective(global = {}, project = {}) {
  const g = overrides(global), p = overrides(project);
  return Object.fromEntries(NAMES.map((name) => [name,
    Object.hasOwn(p, name) ? { value: p[name], from: "project" }
      : Object.hasOwn(g, name) ? { value: g[name], from: "global" }
        : { value: clone(DEFAULTS[name]), from: "default" },
  ]));
}

export const readSettings = (dir) => overrides(readJson(settingsPath(dir), {}));
export const readGlobalSettings = (home = decideHome()) => overrides(readJson(globalSettingsPath(home), {}));
export const readEffective = (dataDir, home = decideHome()) => effective(readGlobalSettings(home), dataDir ? readSettings(dataDir) : {});
export const readLevel = (dataDir, home = decideHome()) => readEffective(dataDir, home).level.value;

// The API keeps its 3.0 scalar level field; new clients read settings for value and scope.
export function settingsFor(dataDir, home = decideHome()) {
  const global = readGlobalSettings(home);
  const resolved = effective(global, dataDir ? readSettings(dataDir) : {});
  const everywhere = effective(global, {});
  return {
    level: resolved.level.value, levels: LEVELS,
    settings: Object.fromEntries(NAMES.map((name) => [name, { ...resolved[name], global: everywhere[name].value, globalFrom: everywhere[name].from }])),
    defaults: clone(DEFAULTS), rules: dataDir ? readRules(dataDir) : [],
  };
}

// Validate the entire patch before touching disk: a bad reviewers block cannot save its sibling level.
export function writeSettings(dir, { set = {}, clear = [] } = {}) {
  fields(set, NAMES, "set");
  if (!Array.isArray(clear) || clear.some((name) => !NAMES.includes(name))) throw userError(`clear must be a list; allowed settings: ${NAMES.join(", ")}`);
  for (const [name, value] of Object.entries(set)) validate(name, value);
  if (clear.some((name) => Object.hasOwn(set, name))) throw userError("a setting must be set or cleared, not both");
  const next = readSettings(dir);
  for (const name of clear) delete next[name];
  Object.assign(next, set);
  writeJson(settingsPath(dir), next);
  return next;
}

export function writeLevel(dataDir, level) {
  writeSettings(dataDir, { set: { level } });
  return level;
}

export function readRules(dataDir) {
  const list = readJson(rulesPath(dataDir), { rules: [] }).rules;
  return Array.isArray(list) ? list.filter((r) => r && typeof r.id === "string" && typeof r.text === "string") : [];
}

// mode: "never" (decide it yourself, do not ask) or "always" (ask me, I decide it).
export function addRule(dataDir, { text, mode = "never", question = "" }) {
  const body = String(text || "").trim().slice(0, 500);
  if (!body) throw userError("a rule needs its text");
  if (!RULE_MODES.includes(mode)) throw userError(`mode is one of: ${RULE_MODES.join(", ")}`);
  const rules = readRules(dataDir);
  const rule = { id: `r${Date.now().toString(36)}${randomBytes(2).toString("hex")}`, mode, text: body, question: String(question || "").slice(0, 300), at: new Date().toISOString() };
  writeJson(rulesPath(dataDir), { rules: [...rules, rule] });
  return rule;
}

export function removeRule(dataDir, id) {
  const rules = readRules(dataDir);
  if (!rules.some((r) => r.id === id)) throw userError(`no rule "${id}"`);
  writeJson(rulesPath(dataDir), { rules: rules.filter((r) => r.id !== id) });
}

// Does a rule talk about this question? Shared words, as the overlap check reads them.
function covers(rule, q) {
  const a = topicWords(`${q.title} ${q.tldr || ""}`);
  const b = topicWords(`${rule.text} ${rule.question || ""}`);
  if (a.size < 2 || b.size < 2) return false;
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared >= 2 && shared / Math.min(a.size, b.size) >= 0.5;
}

export const rulesCovering = (rules, q, mode) => rules.filter((r) => r.mode === mode && covers(r, q));

// Whether a normalised question clears the bar of the level. An "always ask me" rule makes a question mine.
export function overBar(q, level, rules = []) {
  if (level === "everything") return true;
  if (q.mine || rulesCovering(rules, q, "always").length) return true;
  if (level === "mine") return false;
  return q.reversible === false || q.stakes === "high" || (q.touches || []).length > 0;
}

// What ask tells the agent about a round: questions under the bar, and questions a "don't ask" rule seems to cover.
export function judgeRound(spec, { level, rules }) {
  const under = spec.questions.filter((q) => !overBar(q, level, rules));
  const covered = spec.questions
    .filter((q) => !q.mine && !under.includes(q))
    .map((q) => ({ q, rules: rulesCovering(rules, q, "never") }))
    .filter((c) => c.rules.length && !rulesCovering(rules, c.q, "always").length);
  return { under, covered };
}

// Lint at the middle level: reversible is stated on every question (the raw spec: true or false).
export function levelIssues(raw, level) {
  if (level !== "irreversible") return [];
  const list = Array.isArray(raw?.questions) ? raw.questions : [];
  return list.flatMap((q, i) => (typeof q?.reversible === "boolean" ? [] : [{ level: "warn", where: `questions[${i}]`, message: `this project asks only about the irreversible: state "reversible": true or false on every question` }]));
}

export const rulesLine = (r) => `- [${r.id}] ${r.mode === "never" ? "do not ask, decide it yourself" : "always ask the user"}: ${r.text}`;

// The head of a history: the level and the rules.
export function formatSettings(dataDir) {
  const resolved = readEffective(dataDir);
  const level = resolved.level.value;
  const reviewers = resolved.reviewers.value;
  const rules = readRules(dataDir);
  const levelText = {
    everything: "ask about everything that has more than one sensible answer",
    irreversible: "ask only what is irreversible, touches money, data, security or public things, has high stakes or is marked mine; decide the rest yourself and say so in your report",
    mine: "ask only the questions marked mine; decide the rest yourself and say so in your report",
  }[level];
  return [
    `How much to ask (level "${level}"): ${levelText}. Source: ${resolved.level.from}.`,
    `Reviewers (source: ${resolved.reviewers.from}): mode ${reviewers.mode}; large from ${reviewers.lines} changed lines.`,
    ...reviewers.roles.map((r) => `- [${r.id}] ${r.title}; model: ${r.model || "(the agent's own default model)"}\n  ${r.brief}`),
    rules.length ? `Rules the user made (project):\n${rules.map(rulesLine).join("\n")}` : "No rules.",
  ].join("\n");
}

// Said once; a second identical ask goes through.
const told = new Set();
export function toldAlready(key) {
  if (told.has(key)) return true;
  told.add(key);
  return false;
}

export function formatJudgement({ under, covered }, { level, rules }) {
  const lines = [];
  if (under.length) {
    lines.push(`Not shown. This project's level is "${level}" and these questions are under the bar; decide them yourself and say so in your report, or resend with the ones that matter:`);
    lines.push(...under.map((q) => `- [${q.id}] ${q.title}`));
  }
  if (covered.length) {
    lines.push("These questions look covered by a rule the user made:", ...covered.map(({ q, rules: rs }) => `- [${q.id}] ${q.title}\n${rs.map((r) => `  ${rulesLine(r)}`).join("\n")}`));
    lines.push("Drop them, or resend saying why you ask anyway.");
  }
  lines.push(`Sending the same round again shows it as it is. All rules:\n${rules.map(rulesLine).join("\n") || "(none)"}`);
  return lines.join("\n");
}
