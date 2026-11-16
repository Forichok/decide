/**
 * Feature:    how much to ask: level, rules from answers, the bar, history head, lint at the middle level
 * Layer:      Unit and in-process commands against scratch homes
 * Covers:
 *   - level and rules round-trip through <dataDir>/settings.json and rules.json
 *   - the bar of each level; touches and an "always ask" rule put a question over it
 *   - ask rejects under-the-bar questions once, a second identical ask passes
 *   - ask rejects a question a "don't ask again" rule covers once, listing the rules
 *   - history starts with the level and the rules
 *   - lint demands reversible at the middle level
 * Isolation:  every test has its own DECIDE_HOME.
 */

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import test from "node:test";
import { COMMANDS, contextFor, runCommand } from "../lib/commands/index.mjs";
import { addRule, judgeRound, levelIssues, overBar, readLevel, readRules, removeRule, writeLevel } from "../lib/settings.mjs";
import { homeOf, scratchDir } from "./helpers.mjs";

async function inHome(home, fn) {
  const saved = process.env.DECIDE_HOME;
  process.env.DECIDE_HOME = home;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.DECIDE_HOME;
    else process.env.DECIDE_HOME = saved;
  }
}
const call = (home, name, args) => inHome(home, () => runCommand(name, args, contextFor(args, {})));

async function scratch(t) {
  const dir = await scratchDir(t);
  mkdirSync(homeOf(dir), { recursive: true });
  return { dir, home: homeOf(dir) };
}
const dataDirOf = async (home, dir) => inHome(home, () => contextFor({ project: dir }, {}).project.dataDir);

const q = (over) => ({ id: "q", title: "Which colour?", mine: false, stakes: null, reversible: null, touches: [], ...over });

test("level and rules round-trip", async (t) => {
  const { dir, home } = await scratch(t);
  const dd = await dataDirOf(home, dir);
  assert.equal(readLevel(dd), "everything");
  writeLevel(dd, "irreversible");
  assert.equal(readLevel(dd), "irreversible");
  assert.throws(() => writeLevel(dd, "bogus"), /level is one of/);
  const r = addRule(dd, { text: "Pick the library with fewer dependencies", mode: "never" });
  assert.deepEqual(readRules(dd).map((x) => x.id), [r.id]);
  removeRule(dd, r.id);
  assert.deepEqual(readRules(dd), []);
});

test("the bar of each level", () => {
  assert.equal(overBar(q(), "everything"), true);
  assert.equal(overBar(q(), "irreversible"), false);
  for (const over of [{ reversible: false }, { stakes: "high" }, { mine: true }, { touches: ["money"] }]) assert.equal(overBar(q(over), "irreversible"), true);
  assert.equal(overBar(q({ reversible: false }), "mine"), false);
  assert.equal(overBar(q({ mine: true }), "mine"), true);
  const rules = [{ id: "r1", mode: "always", text: "Always ask me about the database schema migrations" }];
  assert.equal(overBar(q({ title: "Which database schema migrations tool?" }), "mine", rules), true);
});

test("touches is a known question field and is kept", async (t) => {
  const { dir, home } = await scratch(t);
  const out = await call(home, "lint", { project: dir, spec: { title: "T", questions: [{ id: "a", title: "Pay now?", touches: ["money"], options: ["Yes", "No"] }] } });
  assert.match(out.text, /lint: ok/);
});

test("ask under the bar: rejected once, the second identical ask passes", async (t) => {
  const { dir, home } = await scratch(t);
  const dd = await dataDirOf(home, dir);
  writeLevel(dd, "irreversible");
  const spec = { title: "Round", questions: [{ id: "a", title: "Which button colour?", reversible: true, options: ["Pink", "Blue"] }] };
  const first = await call(home, "ask", { project: dir, spec, open: false });
  assert.match(first.text, /under the bar/);
  assert.match(first.text, /\[a\] Which button colour/);
  const second = await call(home, "ask", { project: dir, spec, open: false });
  assert.match(second.text, /is open for the user/);
  await call(home, "stop", { project: dir }).catch(() => {});
});

test("ask covered by a rule: rejected once with the rules listed", async (t) => {
  const { dir, home } = await scratch(t);
  const dd = await dataDirOf(home, dir);
  const rule = addRule(dd, { text: "Always take the smaller dependency tree for the logging library", mode: "never" });
  const spec = { title: "Round", questions: [{ id: "a", title: "Which logging library should we use?", options: ["pino", "winston"] }] };
  const first = await call(home, "ask", { project: dir, spec, open: false });
  assert.match(first.text, /covered by a rule/);
  assert.ok(first.text.includes(rule.id));
  const second = await call(home, "ask", { project: dir, spec, open: false });
  assert.match(second.text, /is open for the user/);
  await call(home, "stop", { project: dir }).catch(() => {});
});

test("history starts with the level and the rules; the rules command edits them", async (t) => {
  const { dir, home } = await scratch(t);
  await call(home, "rules", { project: dir, action: "level", level: "mine" });
  await call(home, "rules", { project: dir, action: "add", text: "Never ask about commit message style", mode: "never" });
  const h = await call(home, "history", { project: dir });
  assert.match(h.text, /^How much to ask \(level "mine"\)/);
  assert.match(h.text, /commit message style/);
  const list = await call(home, "rules", { project: dir });
  const id = list.text.match(/\[(r\w+)\]/)[1];
  await call(home, "rules", { project: dir, action: "remove", id });
  assert.match((await call(home, "rules", { project: dir })).text, /No rules/);
  assert.ok(COMMANDS.some((c) => c.name === "rules"));
});

test("lint demands reversible at the middle level", () => {
  const raw = { questions: [{ title: "a" }, { title: "b", reversible: true }] };
  assert.equal(levelIssues(raw, "irreversible").length, 1);
  assert.equal(levelIssues(raw, "everything").length, 0);
  assert.deepEqual(judgeRound({ questions: [q()] }, { level: "everything", rules: [] }), { under: [], covered: [] });
});
