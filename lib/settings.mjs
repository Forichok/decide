// settings.mjs — how much to ask. A project's level lives in <dataDir>/settings.json, the rules the user made
// from answers ("don't ask about this again", "always ask me") in <dataDir>/rules.json.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { topicWords } from "./journal.mjs";

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

export function readLevel(dataDir) {
  const level = readJson(settingsPath(dataDir), {}).level;
  return LEVELS.includes(level) ? level : "everything";
}

export function writeLevel(dataDir, level) {
  if (!LEVELS.includes(level)) throw userError(`level is one of: ${LEVELS.join(", ")}`);
  writeJson(settingsPath(dataDir), { ...readJson(settingsPath(dataDir), {}), level });
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
  const level = readLevel(dataDir);
  const rules = readRules(dataDir);
  const levelText = {
    everything: "ask about everything that has more than one sensible answer",
    irreversible: "ask only what is irreversible, touches money, data, security or public things, has high stakes or is marked mine; decide the rest yourself and say so in your report",
    mine: "ask only the questions marked mine; decide the rest yourself and say so in your report",
  }[level];
  return [`How much to ask (level "${level}"): ${levelText}.`, rules.length ? `Rules the user made:\n${rules.map(rulesLine).join("\n")}` : ""].filter(Boolean).join("\n");
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
