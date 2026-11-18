// Wave 4: defaults, global settings and whole-project overrides share one resolver.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as settings from "../lib/settings.mjs";
import { openProject } from "../lib/project.mjs";
import rulesCommand from "../lib/commands/rules.mjs";
import { parseArgv } from "../lib/commands/argv.mjs";
import { contextFor, runCommand } from "../lib/commands/index.mjs";
import { asPage, enginePath, homeOf, scratchDir, spawnServer } from "./helpers.mjs";

const reviewers = (over = {}) => ({ mode: "large", lines: 200, roles: [{ id: "custom", title: "Custom check", brief: "Read the change", model: "" }], ...over });

test("reviewer display translates each matching default field without changing stored text", async () => {
  const needsNavigator = !globalThis.navigator;
  if (needsNavigator) globalThis.navigator = {};
  globalThis.location = { search: "?lang=ru" };
  try {
    const { reviewerRoleDisplay } = await import("../ui/js/reviewer-display.js");
    const defaults = settings.effective().reviewers.value.roles;
    assert.deepEqual(defaults.map((role) => reviewerRoleDisplay(role, defaults).title), [
      "Ошибки и регрессии", "Безопасность и данные", "Что доказывают проверки",
    ]);
    const [role] = defaults;
    const translated = reviewerRoleDisplay(role, defaults);
    assert.notEqual(translated.brief, role.brief);
    assert.equal(role.title, "Bugs and regressions");
    assert.deepEqual(reviewerRoleDisplay({ ...role, title: "My check" }, defaults), { title: "My check", brief: translated.brief });
    assert.deepEqual(reviewerRoleDisplay({ ...role, brief: "My brief" }, defaults), { title: translated.title, brief: "My brief" });
    assert.deepEqual(reviewerRoleDisplay({ ...role, id: "custom" }, defaults), { title: role.title, brief: role.brief });
  } finally {
    delete globalThis.location;
    if (needsNavigator) delete globalThis.navigator;
  }
});

test("effective resolves defaults, global and project values without merging reviewer fields", () => {
  assert.equal(typeof settings.effective, "function");
  const defaults = settings.effective({}, {});
  assert.deepEqual(defaults.level, { value: "everything", from: "default" });
  assert.equal(defaults.reviewers.from, "default");
  assert.deepEqual(defaults.reviewers.value.roles.map((r) => r.id), ["correctness", "safety", "tests"]);
  assert.equal(defaults.reviewers.value.lines, 200);
  assert.equal(defaults.reviewers.value.mode, "large");
  assert.ok(defaults.reviewers.value.roles.every((r) => r.model === "" && r.brief.length));
  const global = { level: "mine", reviewers: reviewers({ mode: "always", lines: 500 }) };
  assert.deepEqual(settings.effective(global, {}).level, { value: "mine", from: "global" });
  const project = { level: "irreversible", reviewers: reviewers({ mode: "request", lines: 1, roles: [] }) };
  assert.deepEqual(settings.effective(global, project), {
    level: { value: "irreversible", from: "project" }, reviewers: { value: project.reviewers, from: "project" },
  });
  assert.deepEqual(settings.effective(global, {}).reviewers, { value: global.reviewers, from: "global" });
  // Caller mutations cannot change later defaults or the input objects.
  defaults.reviewers.value.roles[0].title = "Changed";
  assert.equal(settings.effective({}, {}).reviewers.value.roles[0].title, "Bugs and regressions");
  assert.deepEqual(settings.effective(null, ["bad"]), settings.effective({}, {}));
});

test("old files retain their project meaning; bad files are absent; reads never rewrite", async (t) => {
  const dir = await scratchDir(t);
  const home = homeOf(dir);
  const dd = openProject(dir, home).dataDir;
  settings.writeSettings(home, { set: { level: "mine", reviewers: reviewers() } });
  const file = join(dd, "settings.json");
  const old = '{ "level": "irreversible" }\n';
  writeFileSync(file, old);
  assert.equal(settings.readEffective(dd, home).level.value, "irreversible");
  assert.equal(settings.readEffective(dd, home).level.from, "project");
  assert.equal(readFileSync(file, "utf8"), old);
  settings.writeSettings(dd, { clear: ["level"] });
  assert.deepEqual(settings.readEffective(dd, home).level, { value: "mine", from: "global" });
  for (const bad of ["{", "null", "[]", '{"level":"wrong","reviewers":{"mode":"always"}}']) {
    writeFileSync(file, bad);
    assert.deepEqual(settings.readEffective(dd, home), settings.effective({ level: "mine", reviewers: reviewers() }, {}));
    assert.equal(readFileSync(file, "utf8"), bad);
  }
});

test("writes validate the whole patch before writing anything", async (t) => {
  const dir = await scratchDir(t);
  assert.equal(typeof settings.writeSettings, "function");
  settings.writeSettings(dir, { set: { level: "mine", reviewers: reviewers() } });
  const file = join(dir, "settings.json");
  const before = readFileSync(file, "utf8");
  const invalid = [
    { set: { level: "all" } }, { set: { unknown: true } }, { clear: ["unknown"] }, { clear: "level" },
    { set: { reviewers: reviewers({ mode: "sometimes" }) } },
    ...[0, 100001, 1.5, "200", null].map((lines) => ({ set: { level: "everything", reviewers: reviewers({ lines }) } })),
    { set: { reviewers: { mode: "large" } } },
    { set: { reviewers: reviewers({ roles: Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, title: "T", brief: "B", model: "" })) }) } },
    ...[
      [{ id: "bad id", title: "T", brief: "B", model: "" }],
      [{ id: "same", title: "T", brief: "B", model: "" }, { id: "same", title: "T", brief: "B", model: "" }],
      [{ id: "x", title: "x".repeat(81), brief: "B", model: "" }],
      [{ id: "x", title: "T", brief: "x".repeat(601), model: "" }],
      [{ id: "x", title: "T", brief: "B", model: "x".repeat(81) }],
      [{ id: "x", title: "T", brief: "B", model: 3 }],
    ].map((roles) => ({ set: { reviewers: reviewers({ roles }) } })),
  ];
  for (const patch of invalid) {
    assert.throws(() => settings.writeSettings(dir, patch), (err) => err.user && /allowed|one of|must|whole|unique|roles/.test(err.message));
    assert.equal(readFileSync(file, "utf8"), before);
  }
  settings.writeSettings(dir, { set: { reviewers: reviewers({ lines: 100000, mode: "request", roles: [] }) } });
  assert.equal(settings.readSettings(dir).reviewers.lines, 100000);
});

test("settings API preserves the old body and level field, and supports scoped writes and clear", async (t) => {
  const dir = await scratchDir(t);
  const home = homeOf(dir);
  const server = await spawnServer(t, home);
  const base = `http://127.0.0.1:${server.port}`;
  const post = (body) => fetch(`${base}/api/settings`, { method: "POST", headers: asPage(server.port), body: JSON.stringify(body) });
  const get = () => fetch(`${base}/api/settings?project=${encodeURIComponent(dir)}`).then((r) => r.json());
  assert.equal((await post({ scope: "global", set: { level: "mine", reviewers: reviewers() } })).status, 200);
  let data = await get();
  assert.equal(data.level, "mine");
  assert.equal(data.settings.level.from, "global");
  assert.equal(data.settings.level.global, "mine");
  assert.equal((await post({ project: dir, level: "irreversible" })).status, 200);
  data = await get();
  assert.equal(data.level, "irreversible");
  assert.equal(data.settings.level.from, "project");
  assert.equal(data.settings.level.global, "mine");
  assert.equal((await post({ scope: "project", project: dir, set: { reviewers: reviewers({ mode: "request", roles: [] }) } })).status, 200);
  assert.equal((await get()).settings.reviewers.value.mode, "request");
  assert.equal((await post({ scope: "project", project: dir, clear: ["level", "reviewers"] })).status, 200);
  data = await get();
  assert.equal(data.settings.level.from, "global");
  assert.deepEqual(data.settings.reviewers.value, reviewers());
  const before = readFileSync(join(home, "settings.json"), "utf8");
  const bad = await post({ scope: "global", set: { level: "everything", reviewers: reviewers({ mode: "bad" }) } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /always.*large.*request/);
  assert.equal(readFileSync(join(home, "settings.json"), "utf8"), before);
  assert.equal((await post({ scope: "wrong", set: { level: "mine" } })).status, 400);
  assert.equal((await post({ scope: "project", set: { level: "mine" } })).status, 400);
  assert.equal((await fetch(`${base}/api/settings`)).status, 200, "global page needs no project");
});

test("rules exposes reviewer models, briefs, sources and JSON without starting a server", async (t) => {
  const dir = await scratchDir(t);
  const home = homeOf(dir);
  const dd = openProject(dir, home).dataDir;
  settings.writeSettings(home, { set: { level: "mine", reviewers: reviewers({ roles: [{ id: "safety", title: "Safety", brief: "Check data loss", model: "my-model" }] }) } });
  const savedHome = process.env.DECIDE_HOME;
  process.env.DECIDE_HOME = home;
  try {
    const ctx = { project: { dataDir: dd } };
    const out = rulesCommand.run({}, ctx);
    assert.match(out.text, /level "mine"/);
    assert.match(out.text, /global/);
    assert.match(out.text, /Reviewers/);
    assert.match(out.text, /large/);
    assert.match(out.text, /200/);
    assert.match(out.text, /my-model/);
    assert.match(out.text, /Check data loss/);
    assert.match(out.text, /No rules/);
    const json = rulesCommand.run({ json: true }, ctx);
    assert.equal(JSON.parse(json.text).settings.level.value, "mine");
    assert.equal(settings.readLevel(dd), "mine", "ask and lint read the effective level");
    assert.equal(parseArgv(["rules", "--json"]).args.json, true);
    const cli = spawnSync(process.execPath, [enginePath, "rules", "--json", "--project", dir], {
      encoding: "utf8", env: { ...process.env, DECIDE_HOME: home, DECIDE_PORT: "48485", BROWSER: "none" },
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).settings.reviewers.value.roles[0].model, "my-model");
    const args = { project: dir, spec: { title: "Effective global bar", questions: [{ id: "bar", title: "Which shade of blue?", reversible: true, options: ["Sky", "Navy"] }] }, open: false };
    const asked = await runCommand("ask", args, contextFor(args));
    assert.match(asked.text, /under the bar/, "ask uses the global level without opening a round");
    settings.writeSettings(home, { set: { level: "irreversible" } });
    const lintArgs = { project: dir, spec: { title: "Effective global lint", questions: [{ id: "lint", title: "Which shade?", options: ["Sky", "Navy"] }] } };
    const lint = await runCommand("lint", lintArgs, contextFor(lintArgs));
    assert.match(lint.text, /reversible/, "lint uses the effective middle level");
  } finally {
    process.env.DECIDE_HOME = savedHome;
  }
});
