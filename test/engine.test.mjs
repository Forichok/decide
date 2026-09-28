/**
 * Feature:    engine
 * Layer:      Integration (CLI client + session daemon over loopback HTTP)
 * Contract:   the plugin manifests, .mcp.json, skills/decide/SKILL.md and the README install commands
 * Covers:
 *   - The repo is a valid plugin and marketplace for both agents, and the README installs it
 *   - Engine accepts a decision spec and persists submitted answers (legacy /submit too)
 *   - Browser-originated writes need the x-decide header and a loopback Host (CSRF / DNS rebinding)
 *   - A second round reuses the running session daemon, so one browser tab serves every round
 *   - Pasted attachments land next to the answers file; drafts survive a reload
 *   - --lint rejects a broken spec before anything opens; cancel writes cancelled: true
 * Why exists: Claude Code and Codex install the plugin straight from this repo.
 * Isolation:  every test gets its own DECIDE_HOME, so no daemon or journal leaks into ~/.decide.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import test from "node:test";
import { enginePath, exitOf, pluginDir, readJson, runEngine, scratchDir, waitForReadyUrl, WRITE } from "./helpers.mjs";

const pagePath = path.join(pluginDir, "ui/index.html");
const showcasePath = path.join(pluginDir, "examples/showcase.questions.json");
const skillPath = path.join(pluginDir, "skills/decide/SKILL.md");
const readmePath = path.join(pluginDir, "README.md");

const spec = (id = "delivery") => ({
  title: "Test decision",
  questions: [{ id, title: "How should this ship?", options: [{ id: "shared", label: "Shared" }] }],
});

function startRound(context, questionsPath, answersPath, extra = []) {
  const args = [questionsPath, ...(answersPath ? ["--out", answersPath] : []), "--no-open", ...extra];
  const { child, output } = runEngine(context, path.dirname(questionsPath), args);
  return { child, output, ready: waitForReadyUrl(child, output) };
}

function rawGet(port, pathname, host) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: pathname, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}

test("ships the decide plugin for Claude and Codex", async (context) => {
  const pluginFiles = [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".mcp.json", "package.json", "mcp.mjs", "LICENSE", "skills/decide/spec.md"];
  for (const requiredPath of [enginePath, pagePath, showcasePath, skillPath, readmePath, ...pluginFiles.map((f) => path.join(pluginDir, f))]) {
    assert.equal(existsSync(requiredPath), true, `missing decide file: ${requiredPath}`);
  }

  const [plugin, market, pkg, mcp] = await Promise.all(
    [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "package.json", ".mcp.json"].map((f) => readJson(path.join(pluginDir, f))),
  );
  const { VERSION } = await import(path.join(pluginDir, "lib/daemon.mjs"));
  assert.equal(pkg.type, "module", "a copied plugin runs outside the repo and needs its own ESM marker");
  assert.deepEqual([plugin.version, market.plugins[0].version, pkg.version], [VERSION, VERSION, VERSION]);
  assert.equal(market.plugins[0].name, plugin.name);
  const server = mcp.mcpServers.decide;
  assert.equal(server.args.at(-1), "${CLAUDE_PLUGIN_ROOT}");
  assert.doesNotMatch(server.args[1], /\$\{/, "the boot script must not contain ${…}: Claude would substitute it");
  assert.ok(server.timeout >= 600_000 && server.tool_timeout_sec >= 600, "wait blocks for minutes in both agents");

  const skill = await readFile(skillPath, "utf8");
  assert.match(skill, /^---\nname: decide\ndescription: .+\n---/);
  const readme = await readFile(readmePath, "utf8");
  const install = `${plugin.name}@${market.name}`;
  assert.ok(readme.includes(`/plugin install ${install}`) && readme.includes(`codex plugin add ${install}`), "README installs the plugin in both agents");

  const scratch = await scratchDir(context);
  const questionsPath = path.join(scratch, "questions.json");
  const answersPath = path.join(scratch, "answers.json");
  await writeFile(questionsPath, JSON.stringify(spec()));

  const { child, output, ready } = startRound(context, questionsPath, answersPath);
  const { url } = await ready;
  const response = await fetch(`${url}submit`, {
    method: "POST",
    headers: WRITE,
    body: JSON.stringify({ answers: { delivery: { selected: ["shared"], note: "" } } }),
  });
  assert.equal(response.status, 200);
  assert.equal(await exitOf(child), 0);

  const saved = JSON.parse(await readFile(answersPath, "utf8"));
  assert.deepEqual(saved.answers, { delivery: { selected: ["shared"], note: "" } });
  assert.match(output.stdout, /\[delivery\] How should this ship\? → Shared/);
});

test("rejects browser writes without the x-decide header or from a foreign Host", async (context) => {
  const scratch = await scratchDir(context);
  const questionsPath = path.join(scratch, "q.json");
  await writeFile(questionsPath, JSON.stringify(spec()));
  const { ready } = startRound(context, questionsPath, path.join(scratch, "a.json"));
  const { url, round } = await ready;

  const noHeader = await fetch(`${url}api/rounds/${round}/submit`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ answers: {} }),
  });
  assert.equal(noHeader.status, 403);

  const port = new URL(url).port;
  assert.equal(await rawGet(port, "/api/state", `evil.example:${port}`), 403);
  assert.equal(await rawGet(port, "/api/state", `127.0.0.1:${port}`), 200);
});

test("second round reuses the session daemon and keeps drafts and attachments", async (context) => {
  const scratch = await scratchDir(context);
  const q1 = path.join(scratch, "one.questions.json");
  const q2 = path.join(scratch, "two.questions.json");
  const a2 = path.join(scratch, "two.answers.json");
  await writeFile(q1, JSON.stringify(spec("first")));
  await writeFile(q2, JSON.stringify(spec("second")));

  const first = startRound(context, q1, path.join(scratch, "one.answers.json"));
  const r1 = await first.ready;
  await fetch(`${r1.url}api/rounds/${r1.round}/submit`, {
    method: "POST",
    headers: WRITE,
    body: JSON.stringify({ answers: { first: { selected: ["shared"] } } }),
  });
  assert.equal(await exitOf(first.child), 0);

  const second = startRound(context, q2, a2);
  const r2 = await second.ready;
  assert.equal(r2.url, r1.url, "second round must be served by the same daemon/tab origin");

  const draft = { answers: { second: { selected: ["shared"], note: "half-way" } } };
  const put = await fetch(`${r2.url}api/rounds/${r2.round}/draft`, {
    method: "PUT",
    headers: WRITE,
    body: JSON.stringify(draft),
  });
  assert.equal(put.status, 200);
  const restored = await (await fetch(`${r2.url}api/rounds/${r2.round}`)).json();
  assert.deepEqual(restored.draft, draft);
  assert.equal(restored.spec.questions[0].id, "second");
  const state = await (await fetch(`${r2.url}api/state`)).json();
  assert.equal(state.history.some((h) => h.digest.includes("[first]")), true);

  const upload = await fetch(`${r2.url}api/rounds/${r2.round}/upload`, {
    method: "POST",
    headers: {
      "x-decide": "1",
      "content-type": "image/png",
      "x-file-name": encodeURIComponent("экран 1.png"),
    },
    body: Buffer.from("fake-png"),
  });
  assert.equal(upload.status, 200);
  const file = await upload.json();
  assert.equal(path.dirname(file.path), path.join(scratch, "two.answers.files"));
  assert.equal(await readFile(file.path, "utf8"), "fake-png");

  await fetch(`${r2.url}api/rounds/${r2.round}/submit`, {
    method: "POST",
    headers: WRITE,
    body: JSON.stringify({ answers: { second: { selected: ["shared"], attachments: [file.path] } } }),
  });
  assert.equal(await exitOf(second.child), 0);
  const saved = JSON.parse(await readFile(a2, "utf8"));
  assert.deepEqual(saved.answers.second.attachments, [file.path]);
  assert.equal(saved.version, 2);
  assert.match(saved.digest, /\[second\]/);
});

test("--lint rejects a broken spec and passes both showcases", async (context) => {
  const scratch = await scratchDir(context);
  const bad = path.join(scratch, "bad.json");
  await writeFile(bad, JSON.stringify({ questions: [spec().questions[0], spec().questions[0]] }));
  const { child: badRun, output: badOut } = runEngine(context, scratch, ["--lint", bad]);
  assert.equal(await exitOf(badRun), 1);
  assert.match(badOut.stdout + badOut.stderr, /duplicate question id "delivery"/);

  const showcaseRu = showcasePath.replace(".questions.json", ".ru.questions.json");
  for (const file of [showcasePath, showcaseRu]) {
    const { child: goodRun, output: goodOut } = runEngine(context, scratch, ["--lint", file]);
    assert.equal(await exitOf(goodRun), 0, goodOut.stdout + goodOut.stderr);
    assert.doesNotMatch(goodOut.stdout, /warn/i, `${path.basename(file)} must be a lint-clean reference spec`);
  }
  const shape = async (file) => JSON.parse(await readFile(file, "utf8")).questions.map((q) => [q.id, q.type, (q.options || []).map((o) => o.id)]);
  assert.deepEqual(await shape(showcaseRu), await shape(showcasePath), "the Russian showcase mirrors the English one");
});

test("cancel writes cancelled: true and lets the agent resume", async (context) => {
  const scratch = await scratchDir(context);
  const questionsPath = path.join(scratch, "c.json");
  const answersPath = path.join(scratch, "c.answers.json");
  await writeFile(questionsPath, JSON.stringify(spec()));
  const { child, ready } = startRound(context, questionsPath, answersPath);
  const { url, round } = await ready;
  const res = await fetch(`${url}api/rounds/${round}/cancel`, { method: "POST", headers: WRITE });
  assert.equal(res.status, 200);
  assert.equal(await exitOf(child), 0);
  const saved = JSON.parse(await readFile(answersPath, "utf8"));
  assert.equal(saved.cancelled, true);
});
