// transfer.mjs — export and import, shared by the MCP tools and the CLI. An
// export is one .html file someone else answers offline (export.mjs); import
// reads the answer files it produces and settles the round, through the
// daemon while the round is still open there, or straight into the answers
// file and the journal once it is not.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { findDaemon, getRoundView, postExport, postImport } from "./client.mjs";
import { appendJournal, readJournal } from "./journal.mjs";
import { exportSpec, findExport, recordExport } from "./export.mjs";
import { checkAnswers, formatComparison } from "./answers.mjs";
import { answersPathFor, formatIssues, formatResult, prepareSpec } from "./prepare.mjs";
import { digest } from "../ui/js/logic.js";

const userError = (message) => Object.assign(new Error(message), { user: true });
const mb = (bytes) => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
const htmlPathFor = (specPath) => `${answersPathFor(specPath).replace(/\.answers\.json$/i, "")}.decide.html`;

// round: export an open round; else raw/specPath/specDir: export a spec without opening a page.
export async function exportRound({ project, round, raw, specPath, specDir, out }) {
  const target = out && resolve(project.root, out);
  let res;
  let title;
  let id = round;
  let issues = [];
  if (round) {
    const port = await findDaemon(project.dataDir);
    if (!port) throw userError("The decide page is not running for this project any more, so the round is gone. Export the spec instead (spec or specPath).");
    res = await postExport(port, round, { out: target }).catch((e) => {
      throw userError(e.status === 404 ? `Round ${round} is gone.` : e.data?.error || e.message);
    });
    title = (await getRoundView(port, round).catch(() => null))?.spec?.title || round;
  } else {
    const prepared = await prepareSpec(raw, { specDir, dataDir: project.dataDir });
    issues = prepared.issues;
    if (prepared.errors.length) throw userError(`The spec has errors, nothing was exported:\n${formatIssues(issues)}`);
    id = `x${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const file = target || htmlPathFor(specPath);
    const built = exportSpec(prepared.spec, { id, from: basename(specPath), out: file });
    recordExport(project.dataDir, { round: id, title: prepared.spec.title, source: basename(specPath), specFile: specPath, outPath: answersPathFor(specPath), file });
    res = { file, bytes: built.bytes, missing: built.missing };
    title = prepared.spec.title;
  }
  return {
    id,
    file: res.file,
    text: [
      `Exported «${title}» (round ${id}) to ${res.file}, ${mb(res.bytes)}.`,
      "It is one self-contained page: whoever gets it opens it from disk in any browser, answers, and their Done saves an answers file (*.answers.json) with their name in it. Mermaid diagrams need the network once; offline they show their source.",
      res.missing?.length ? `Not found, left out of the file: ${res.missing.join(", ")}` : "",
      issues.length ? `Lint warnings:\n${formatIssues(issues)}` : "",
      `When the answer files come back, call import with files: [their paths]. One file settles the round; several show where the people disagree.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

function readAnswerFile(root, path) {
  const file = resolve(root, path);
  let body;
  try {
    body = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw userError(`Cannot read ${file}: ${e.message}`);
  }
  if (!body || typeof body !== "object" || typeof body.round !== "string") throw userError(`${file} is not a decide answers file (no round id).`);
  return { ...body, file };
}

// files: paths of answers files; round/specPath override what the files and the export record say.
export async function importAnswers({ project, files, round, specPath }) {
  if (!Array.isArray(files) || !files.length) throw userError("Pass files: the paths of the answers files that came back.");
  const bodies = files.map((f) => readAnswerFile(project.root, String(f)));
  const id = round || bodies[0].round;
  const others = bodies.filter((b) => b.round !== id);
  if (others.length && !round) throw userError(`These files answer different rounds: ${[...new Set(bodies.map((b) => b.round))].join(", ")}. Import them one round at a time.`);
  const named = bodies.map((b, i) => ({ ...b, name: typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 80) : `answer ${i + 1}` }));

  // Still open on the page: the daemon settles it, and an agent waiting on it gets the answers too.
  const port = await findDaemon(project.dataDir);
  const view = port && (await getRoundView(port, id).catch(() => null));
  if (view?.status === "pending" && view.mode === "questions") {
    const res = await postImport(port, id, { files: bodies }).catch((e) => {
      throw userError(e.data?.error || e.message);
    });
    const warn = res.warnings?.length ? `\n\nWarnings:\n${res.warnings.map((w) => `- ${w}`).join("\n")}` : "";
    return (res.settled ? formatResult(res.result, res.file) : res.report) + warn;
  }

  const record = findExport(project.dataDir, id);
  const specFile = specPath ? resolve(project.root, specPath) : record?.specFile;
  if (!specFile || !existsSync(specFile)) throw userError(`Round ${id} is not open any more and its spec was not found. Pass specPath: the questions file it was exported from.`);
  const { spec, errors } = await prepareSpec(JSON.parse(readFileSync(specFile, "utf8")), { specDir: dirname(specFile), dataDir: project.dataDir, shots: false });
  if (errors.length) throw userError(`The spec ${specFile} has errors now; fix it or pass the right specPath.`);
  const checked = named.map((b) => ({ ...b, ...checkAnswers(spec, b) }));
  const failed = checked.filter((c) => c.errors.length);
  if (failed.length) throw userError(failed.map((c) => `${c.file}: ${c.errors.join("; ")}`).join("\n"));
  const warnings = checked.flatMap((c) => c.warnings.map((w) => `- ${basename(c.file)}: ${w}`));
  const warn = warnings.length ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
  if (checked.length > 1) return formatComparison(spec, checked) + warn;

  const [one] = checked;
  const earlier = readJournal(project.dataDir, { limit: 500 }).find((e) => e.round === id);
  if (earlier) throw userError(`Round ${id} was already settled (${earlier.at.slice(0, 10)}). To see how several people answered, import all their files together.`);
  const outPath = record?.outPath || answersPathFor(specFile);
  const result = {
    version: 2,
    round: id,
    source: record?.source || basename(specFile),
    title: spec.title,
    submittedAt: typeof one.submittedAt === "string" ? one.submittedAt : new Date().toISOString(),
    elapsedSec: Number.isFinite(one.elapsedSec) ? one.elapsedSec : undefined,
    answers: one.answers,
    ...(typeof one.comment === "string" && one.comment.trim() ? { comment: one.comment.trim() } : {}),
    ...(typeof bodies[0].name === "string" && bodies[0].name.trim() ? { name: one.name } : {}),
    importedFrom: one.file,
    ...(spec.leftOut?.length ? { leftOut: spec.leftOut } : {}),
  };
  result.digest = digest(spec, result);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  appendJournal(project.dataDir, { mode: "questions", spec, specFile, outPath }, result);
  return formatResult(result, outPath) + warn;
}
