// commands.mjs — the CLI subcommands behind decide.mjs. Every command works on
// one project: its data dir holds the daemon, journal and screenshots.

import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { infoPath } from "./daemon.mjs";
import { ensureDaemon, findDaemon, postExplain, postRound, waitResult } from "./client.mjs";
import { formatJournal, readJournal } from "./journal.mjs";
import { capture, viewportsOf } from "./shot.mjs";
import { answersPathFor, formatAsk, formatIssues, formatResult, prepareSpec } from "./prepare.mjs";

export const EXIT_ASK = 3;

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${path}: ${e.message}`);
  }
}

export async function lint(path, project) {
  const { issues, errors } = await prepareSpec(readJsonFile(path), { specDir: dirname(path), dataDir: project.dataDir, shots: false });
  if (issues.length) console.log(formatIssues(issues).replace(/^/gm, "decide lint: "));
  console.log(errors.length ? `decide lint: ${errors.length} error(s)` : "decide lint: ok");
  return errors.length ? 1 : 0;
}

export async function round({ questionsPath, out, demo, open, live, port, engine, project }) {
  const outPath = resolve(out || (demo ? `${tmpdir()}/decide-demo.answers.json` : answersPathFor(questionsPath)));
  const { spec, issues, errors } = await prepareSpec(readJsonFile(questionsPath), { specDir: dirname(questionsPath), dataDir: project.dataDir });
  if (issues.length) console.log(formatIssues(issues).replace(/^/gm, "decide lint: "));
  if (errors.length) throw new Error(`spec has ${errors.length} error(s) — fix them and rerun`);
  const daemon = await ensureDaemon({ dir: project.dataDir, engine, port });
  const posted = await postRound(daemon.port, { spec, outPath, source: basename(questionsPath), open, live });
  console.log(`DECIDE ready: ${posted.url}`);
  console.log(`Answers will be written to: ${outPath}${daemon.embedded ? " (embedded server)" : ""}`);
  return settle(daemon.port, posted.id, outPath, live);
}

export async function resume({ id, live, project }) {
  const port = await findDaemon(project.dataDir);
  if (!port) throw new Error(`no decide daemon is running for ${project.root}`);
  return settle(port, id, null, live);
}

async function settle(port, id, outPath, live) {
  const result = await waitResult(port, id, outPath, { events: live });
  if (result.event === "ask") {
    console.log(`DECIDE ask: ${JSON.stringify(result)}`);
    const reply = `decide.mjs --reply ${id} --question ${result.ask.question} --text "…"`;
    console.log(formatAsk(result, `with ${reply} (or a reply.json with images/mermaid/code), then run decide.mjs --wait ${id} --live`));
    return EXIT_ASK;
  }
  console.log(`\n=== DECIDE ===\n${formatResult(result, outPath || result.file)}`);
  return 0;
}

export async function reply({ id, question, text, file, project }) {
  const port = await findDaemon(project.dataDir);
  if (!port) throw new Error(`no decide daemon is running for ${project.root}`);
  const body = file ? readJsonFile(file) : { question, text };
  if (!body.question) throw new Error("--question <id> is required");
  const res = await postExplain(port, id, body);
  for (const w of res.warnings || []) console.log(`decide: warn ${w}`);
  console.log(`decide: explanation posted to question ${body.question}`);
  return 0;
}

export async function shot({ url, viewport, name, waitMs, project }) {
  for (const v of viewportsOf(viewport)) {
    const path = await capture({ url, dir: resolve(project.dataDir, "shots"), name, viewport: v, waitMs });
    console.log(`DECIDE shot ${v}: ${path}`);
  }
  return 0;
}

export function journal({ limit, query, project }) {
  console.log(formatJournal(readJournal(project.dataDir, { limit, query })));
  return 0;
}

export async function stop(project) {
  try {
    const { port } = JSON.parse(readFileSync(infoPath(project.dataDir), "utf8"));
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST", headers: { "x-decide": "1" } });
    console.log(`decide: daemon on :${port} stopped`);
  } catch {
    console.log(`decide: no running daemon for ${project.root}`);
  }
  return 0;
}
