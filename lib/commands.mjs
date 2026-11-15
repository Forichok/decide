// commands.mjs — the CLI subcommands behind decide.mjs. Every command works on
// one project: its data dir holds the journal and screenshots; the decide home's
// server serves the rounds of every project.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { decideHome } from "./project.mjs";
import { ensureDaemon, findDaemon, postExplain, postRound, serverOf, silentServer, waitResult } from "./client.mjs";
import { formatJournal, formatOverlaps, overlaps, readJournal, supersedeJournal } from "./journal.mjs";
import { ADR_DIR, markAdrSuperseded, writeAdr } from "./adr.mjs";
import { exportRound, importAnswers } from "./transfer.mjs";
import { capture, captureSim, viewportsOf } from "./shot.mjs";
import { answersPathFor, formatAsk, formatIssues, formatResult, prepareDeck, prepareSpec } from "./prepare.mjs";

export const EXIT_ASK = 3;

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${path}: ${e.message}`);
  }
}

export async function lint(path, project) {
  const raw = readJsonFile(path);
  // A swipe deck has cards instead of questions.
  const prepare = Array.isArray(raw?.cards) && !raw.questions ? prepareDeck : prepareSpec;
  const { issues, errors } = await prepare(raw, { specDir: dirname(path), dataDir: project.dataDir, shots: false });
  if (issues.length) console.log(formatIssues(issues).replace(/^/gm, "decide lint: "));
  console.log(errors.length ? `decide lint: ${errors.length} error(s)` : "decide lint: ok");
  return errors.length ? 1 : 0;
}

export async function round({ questionsPath, out, demo, open, live, port, engine, project }) {
  const outPath = resolve(out || (demo ? `${tmpdir()}/decide-demo.answers.json` : answersPathFor(questionsPath)));
  const { spec, issues, errors } = await prepareSpec(readJsonFile(questionsPath), { specDir: dirname(questionsPath), dataDir: project.dataDir });
  if (issues.length) console.log(formatIssues(issues).replace(/^/gm, "decide lint: "));
  if (errors.length) throw new Error(`spec has ${errors.length} error(s) — fix them and rerun`);
  const daemon = await ensureDaemon({ engine, port });
  const posted = await postRound(daemon.port, { project: project.top, spec, outPath, source: basename(questionsPath), specFile: questionsPath, open, live });
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

export async function shot({ url, viewport, name, waitMs, simulator, device, project }) {
  if (simulator) {
    console.log(`DECIDE shot ${simulator}: ${await captureSim({ simulator, dir: resolve(project.dataDir, "shots"), name, device })}`);
    return 0;
  }
  for (const v of viewportsOf(viewport)) {
    const path = await capture({ url, dir: resolve(project.dataDir, "shots"), name, viewport: v, waitMs });
    console.log(`DECIDE shot ${v}: ${path}`);
  }
  return 0;
}

export function journal({ limit, query, status, topic, project }) {
  if (topic) {
    const hits = overlaps(project.dataDir, [topic], { limit });
    console.log(hits.length ? formatOverlaps(hits) : `No live decision in this project looks like «${topic}».`);
    return 0;
  }
  console.log(formatJournal(readJournal(project.dataDir, { limit, query, status: ["live", "superseded"].includes(status) ? status : "all" })));
  return 0;
}

export function supersede({ id, by, reason, project }) {
  const entry = supersedeJournal(project.dataDir, { round: id, by, reason });
  const adr = markAdrSuperseded(project.top, entry);
  console.log(`decide: round ${entry.round} «${entry.title}» superseded${entry.superseded.by ? ` by ${entry.superseded.by}` : ""}${adr ? `; ${adr} updated` : ""}`);
  return 0;
}

export function adr({ id, consequences, dir = ADR_DIR, project }) {
  const all = readJournal(project.dataDir, { limit: 500 });
  const entry = id ? all.find((e) => e.round === id) : all[0];
  if (!entry) throw new Error(id ? `no decision with round id "${id}" in this project's journal` : "no decisions recorded for this project yet");
  const { file, created } = writeAdr({ root: project.top, entry, consequences, dir });
  console.log(`decide: ${created ? "wrote" : "updated"} ${file}`);
  return 0;
}

// The user's stop: the home's server, with the token from its daemon.json.
export async function stop() {
  const home = decideHome();
  // Only a live decide server of this home is sent the token: daemon.json may name anything by now.
  const found = await serverOf(home);
  if (found.state === "silent") {
    console.log(`decide: ${silentServer(home, found.info)}; nothing was sent. Try again once it answers.`);
    return 1;
  }
  if (found.state !== "live") {
    console.log(`decide: no running server for ${home}`);
    return 0;
  }
  const { info } = found;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/stop`, { method: "POST", headers: { "x-decide": "1", "x-decide-token": String(info.token) } });
    if (!res.ok) throw new Error(String(res.status));
    console.log(`decide: server on :${info.port} stopped`);
  } catch {
    console.log(`decide: no running server for ${home}`);
  }
  return 0;
}

// --export <round | x.questions.json>: an open round by id, else a spec file.
export async function exportCmd({ target, out, project }) {
  const isFile = /\.json$/i.test(target) && existsSync(resolve(target));
  const res = isFile
    ? await exportRound({ project, raw: readJsonFile(resolve(target)), specPath: resolve(target), specDir: dirname(resolve(target)), out })
    : await exportRound({ project, round: target, out });
  console.log(res.text);
  return 0;
}

export async function importCmd({ files, round, specPath, project }) {
  console.log(await importAnswers({ project, files: files.map((f) => resolve(f)), round, specPath: specPath && resolve(specPath) }));
  return 0;
}
