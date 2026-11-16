// tools.mjs — the MCP tools: ask, swipe, wait, push, explain, screenshot,
// history, supersede, adr, export, import. Each works on one project (its data dir holds the
// daemon, journal, screenshots).

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ack, ensureServer, getRoundView, heldServer, postExplain, postPush, postRound, runningServer, WAITER, waitNext } from "./client.mjs";
import { WAIT_MS } from "./store/rounds.mjs";
import { formatJournal, formatOverlaps, overlaps, readJournal, supersedeJournal } from "./journal.mjs";
import { ADR_DIR, markAdrSuperseded, writeAdr } from "./adr.mjs";
import { exportRound, importAnswers } from "./transfer.mjs";
import { capture, captureSim, viewportsOf } from "./shot.mjs";
import { decideHome, openProject } from "./project.mjs";
import { answersPathFor, formatAsk, formatBatch, formatDeeper, formatIssues, formatResult, prepareDeck, preparePatch, prepareSpec, saveInlineSpec } from "./prepare.mjs";

const HOME = dirname(dirname(fileURLToPath(import.meta.url)));
const ENGINE = resolve(HOME, "decide.mjs");
const WAIT_DEFAULT_SEC = 600;
// The wait call of this process that is running on each round: a newer call on the same round stops it.
const waits = new Map(); // round id → AbortController

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export class UserError extends Error {}

// Claude starts the server in the project dir; Codex starts it in the plugin dir, so there the agent passes project.
function projectOf(args) {
  const cwd = real(process.cwd()) === real(HOME) ? null : process.cwd();
  const dir = args.project || process.env.CLAUDE_PROJECT_DIR || cwd;
  if (!dir) throw new UserError("Pass project: the absolute path of the project you are working in.");
  if (!isAbsolute(dir) || !existsSync(dir)) throw new UserError(`project must be an existing absolute path, got "${dir}"`);
  return openProject(dir);
}

// The home's server for a call on a round (push, explain). A round is found by its id there, so no project
// is needed; one that is passed is checked first, so a bad project still says so. None running: one is
// started, since the round is on disk. A server that does not answer is busy: runningServer says so at once
// instead of "not running", and nothing is started beside it.
async function serverFor(args) {
  if (args.project) projectOf(args);
  const home = decideHome();
  try {
    return (await runningServer(home)) || (await ensureServer({ home, engine: ENGINE }));
  } catch (e) {
    if (e.busy) e.user = true; // the busy text is for the agent as it is, as runningServer's is
    throw e;
  }
}

// What push, explain and wait say for a round the home's server does not know (404): only then is asking again right.
const unknownRound = (round) =>
  new UserError(`Round ${round} is unknown to the decide server of ${decideHome()}: it was never opened in this decide home, or its files were removed. Ask again if you still need the answers.`);

function readSpec(args, project, what) {
  if (args.specPath) {
    const specPath = resolve(project.top, args.specPath);
    return { raw: JSON.parse(readFileSync(specPath, "utf8")), specPath, specDir: dirname(specPath) };
  }
  if (args.spec && typeof args.spec === "object") return { raw: args.spec, specPath: saveInlineSpec(project.dataDir, args.spec), specDir: project.top };
  throw new UserError(`Pass spec (${what}) or specPath.`);
}

async function ask(args) {
  const project = projectOf(args);
  const { raw, specPath, specDir } = readSpec(args, project, "the questions object");
  const { spec, issues, errors } = await prepareSpec(raw, { specDir, dataDir: project.dataDir });
  if (errors.length) throw new UserError(`The spec has errors, nothing was shown:\n${formatIssues(issues)}`);
  const outPath = answersPathFor(specPath);
  const server = await ensureServer({ home: decideHome(), engine: ENGINE });
  const posted = await postRound(server, { project: project.top, spec, outPath, source: basename(specPath), specFile: specPath, open: args.open !== false, live: true });
  return [
    `Round ${posted.id} «${spec.title}» is open for the user: ${posted.url}`,
    issues.length ? `Lint warnings:\n${formatIssues(issues)}` : "",
    formatOverlaps(overlaps(project.dataDir, spec.questions.map((q) => q.title))),
    `Now call wait with round "${posted.id}" and keep calling it until it returns answers. Don't end your turn in between: the answers reach you only through wait.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function swipe(args) {
  const project = projectOf(args);
  const { raw, specPath, specDir } = readSpec(args, project, "the deck: {title, goal, cards}");
  const { deck, issues, errors } = await prepareDeck(raw, { specDir, dataDir: project.dataDir });
  if (errors.length) throw new UserError(`The deck has errors, nothing was shown:\n${formatIssues(issues)}`);
  const outPath = answersPathFor(specPath);
  const server = await ensureServer({ home: decideHome(), engine: ENGINE });
  const posted = await postRound(server, { project: project.top, spec: deck, outPath, source: basename(specPath), specFile: specPath, open: args.open !== false, mode: "swipe" });
  return [
    `Swipe round ${posted.id} «${deck.title}» is open for the user with ${deck.cards.length} cards: ${posted.url}`,
    issues.length ? `Lint warnings:\n${formatIssues(issues)}` : "",
    formatOverlaps(overlaps(project.dataDir, deck.cards.map((c) => c.title))),
    `Now call wait with round "${posted.id}". Every ${deck.batch} answers it returns a batch: rewrite the brief and add, replace or remove cards with push, then wait again. Don't end your turn in between.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function push(args) {
  if (!args.round) throw new UserError("Pass round (the id returned by swipe).");
  const server = await serverFor(args);
  const view = await getRoundView(server, args.round).catch((e) => {
    throw e.status === 404 ? unknownRound(args.round) : new UserError(e.message);
  });
  if (view.mode !== "swipe") throw new UserError(`Round ${args.round} is not a swipe round; push works only on rounds opened with swipe.`);
  if (view.status !== "pending") throw new UserError(`Round ${args.round} is already ${view.status}. Call wait to get the final answers.`);
  // Paths in the patch are read as in the deck: beside its spec file, or from the project for an inline
  // deck (its spec file sits in the data dir).
  const rel = view.specFile ? relative(view.dataDir, view.specFile) : "";
  const inline = !view.specFile || (!rel.startsWith("..") && !isAbsolute(rel));
  const specDir = inline ? projectOf(args).top : dirname(view.specFile);
  const { patch, issues, errors } = await preparePatch(args, { specDir, dataDir: view.dataDir, lang: view.spec.lang });
  if (errors.length) throw new UserError(`The push has errors, nothing changed:\n${formatIssues(issues)}`);
  const res = await postPush(server, args.round, patch);
  const all = [...issues, ...res.issues];
  const { stats } = res;
  return [
    `Deck updated: ${res.added} card${res.added === 1 ? "" : "s"} added; ${stats.answered} answered, ${stats.left} left of ${stats.total}.`,
    all.length ? `Warnings:\n${formatIssues(all)}` : "",
    patch.done ? "You marked the interview done: the page shows the brief and asks the user to finish. Call wait for the final answers." : "Call wait again for the next batch.",
  ]
    .filter(Boolean)
    .join("\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An AbortSignal that aborts when any of the given ones does (AbortSignal.any is newer than Node 20.0).
function anyOf(...signals) {
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  const live = signals.filter(Boolean);
  for (const s of live) s.aborted ? abort() : s.addEventListener("abort", abort, { once: true });
  return { signal: ctl.signal, dispose: () => live.forEach((s) => s.removeEventListener("abort", abort)) };
}

// What the agent reads for an item: 2.1's texts, and Task 5's line for a dismissed round.
function formatItem({ kind, payload }) {
  if (kind === "ask") return formatAsk(payload);
  if (kind === "batch") return formatBatch(payload);
  if (kind === "deeper") return formatDeeper(payload);
  if (kind === "dismissed") return formatResult({ ...payload, status: "dismissed" });
  return formatResult(payload, payload.file); // final, cancel
}

// Items of this process whose result was written to the agent, not cancelled, but whose ack did not reach the
// server ("round seq"): when one comes again, the agent is told it may have had it. An answer that crossed a
// cancel is not among them: a host drops a response that comes after its own cancel, so the agent most likely
// never saw it, and it comes again unmarked.
const unacked = new Set();
const AGAIN = "This item may have reached you already: its acknowledgement did not reach the decide server, so it came again. If you already acted on it, don't act again.";

// The next item of a round for this agent. Nothing is acknowledged here: the result carries `delivered`,
// which mcp.mjs runs once the result is on stdout and only when the call was not cancelled; until then the
// item is handed out again. signal: aborted when the agent cancels the call.
async function wait(args, { signal } = {}) {
  if (!args.round) throw new UserError("Pass round (the id returned by ask).");
  const round = String(args.round);
  if (args.project) projectOf(args);
  const home = decideHome();
  // A wait keeps waiting: a server that does not answer is tried for this call's whole time (never started
  // beside); none at all is started, since the round is on disk.
  let server;
  try {
    server = (await runningServer(home)) || (await ensureServer({ home, engine: ENGINE }));
  } catch (e) {
    if (!e.busy || !e.info) throw e;
    server = heldServer(home, e.info);
  }
  const report = {};
  // One wait per round in this process: a newer call on the round stops this one.
  waits.get(round)?.abort();
  const mine = new AbortController();
  waits.set(round, mine);
  const stop = anyOf(signal, mine.signal);
  try {
    const deadline = Date.now() + Math.max(5, Math.min(Number(args.timeoutSec) || WAIT_DEFAULT_SEC, 840)) * 1000;
    for (;;) {
      const asked = Math.max(0, Math.min(deadline - Date.now(), WAIT_MS));
      const started = Date.now();
      let item;
      try {
        item = await waitNext(server, round, { waiter: WAITER, events: true, timeoutMs: asked, signal: stop.signal, report });
      } catch (e) {
        if (e.status === 404) throw unknownRound(round);
        throw e;
      }
      if (signal?.aborted) return "The wait was cancelled."; // mcp.mjs writes no answer to a cancelled call
      if (mine.signal.aborted) return `A newer wait call on round ${round} took over from this one; that call gets what the user sends.`;
      if (item?.superseded) return `Another session took over the wait for round ${round}, so this session stops waiting on it.`;
      if (item) return delivery(server, round, item);
      if (Date.now() >= deadline - 1000) {
        const still = `Still waiting for the user on round ${round}. Call wait again now and don't end your turn while the round is open. If you must stop, ask the user to message you once they've answered, then call wait with timeoutSec 5 first.`;
        if (report.answered) return still;
        // pid and port both from the handle: one record of the server this call tried.
        return `${still} The decide server (${server.pid ? `pid ${server.pid}, ` : ""}port ${server.port}) did not answer during this call.`;
      }
      // Nothing, and back before the hold was up: something else let go of this waiter. Never loop on that
      // without a pause, or two waits that push each other out spin.
      if (Date.now() - started < asked - 1_000) await sleep(1_000);
    }
  } finally {
    if (waits.get(round) === mine) waits.delete(round);
    stop.dispose();
  }
}

// The result for an item: its text (said to maybe have come before when an earlier ack of it failed) and
// what acknowledges it. A dismissed round's item is not acknowledged (the store ignores acks on it).
function delivery(server, round, item) {
  const key = `${round} ${item.seq}`;
  const text = unacked.has(key) ? `${AGAIN}\n\n${formatItem(item)}` : formatItem(item);
  if (item.kind === "dismissed") return { text };
  const delivered = async () => {
    try {
      await ack(server, round, item.seq, WAITER);
    } catch (e) {
      unacked.add(key);
      throw e;
    }
    unacked.delete(key);
  };
  return { text, delivered };
}

async function explain(args) {
  if (!args.round || !args.question) throw new UserError("Pass round and question.");
  const root = args.project || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const abs = (p) => (typeof p === "string" && !/^(https?:|data:)/i.test(p) ? resolve(root, p) : p);
  const absAll = (v) => (Array.isArray(v) ? v.map(absAll) : v && typeof v === "object" ? { ...v, src: abs(v.src || v.path) } : abs(v));
  const images = (args.images || []).map(absAll);
  const compare = args.compare && typeof args.compare === "object" ? { ...args.compare, before: absAll(args.compare.before), after: absAll(args.compare.after) } : undefined;
  const server = await serverFor(args);
  const sent = postExplain(server, args.round, {
    question: args.question,
    askId: args.askId,
    text: args.text || "",
    images,
    mermaid: args.mermaid,
    code: args.code,
    links: args.links,
    compare,
    video: args.video == null ? undefined : absAll(args.video),
    diff: args.diff,
    table: args.table,
    chart: args.chart,
  });
  const res = await sent.catch((e) => {
    throw e.status === 404 ? unknownRound(args.round) : e;
  });
  const warn = res.warnings?.length ? `\nWarnings: ${res.warnings.join("; ")}` : "";
  return `Explanation shown under question ${args.question}.${warn}\nCall wait again for the user's answers.`;
}

async function screenshot(args) {
  if (!args.url && !args.simulator) throw new UserError("Pass url (http or https), or simulator: ios | android.");
  const project = projectOf(args);
  const dir = resolve(project.dataDir, "shots");
  const shots = [];
  if (args.simulator) {
    const path = await captureSim({ simulator: String(args.simulator), dir, name: args.name, device: args.device }).catch((e) => {
      throw new UserError(e.message);
    });
    shots.push({ viewport: args.simulator, path });
  } else {
    for (const viewport of viewportsOf(args.viewport)) {
      shots.push({ viewport, path: await capture({ url: args.url, dir, name: args.name, viewport, waitMs: args.waitMs }) });
    }
  }
  const content = [{ type: "text", text: `${shots.map((s) => `${s.viewport}: ${s.path}`).join("\n")}\nUse these paths in a spec's images.` }];
  if (args.show !== false) {
    for (const s of shots) content.push({ type: "image", data: readFileSync(s.path).toString("base64"), mimeType: "image/png" });
  }
  return content;
}

function history(args) {
  const project = projectOf(args);
  if (args.topic) {
    const hits = overlaps(project.dataDir, [String(args.topic)], { limit: Number(args.limit) || 10 });
    return hits.length ? formatOverlaps(hits) : `No live decision in this project looks like «${args.topic}».`;
  }
  const status = ["live", "superseded"].includes(args.status) ? args.status : "all";
  return formatJournal(readJournal(project.dataDir, { limit: Number(args.limit) || 10, query: args.query || "", status }));
}

function supersede(args) {
  if (!args.round) throw new UserError("Pass round: the id of the decision that no longer holds.");
  const project = projectOf(args);
  const entry = supersedeJournal(project.dataDir, { round: String(args.round), by: args.by ? String(args.by) : "", reason: args.reason || "" });
  const adr = markAdrSuperseded(project.top, entry);
  return [`Round ${entry.round} «${entry.title}» is marked superseded${entry.superseded.by ? ` by round ${entry.superseded.by}` : ""}.`, adr ? `Its ADR now says so: ${adr}` : ""]
    .filter(Boolean)
    .join("\n");
}

function adr(args) {
  const project = projectOf(args);
  const all = readJournal(project.dataDir, { limit: 500 });
  const entry = args.round ? all.find((e) => e.round === args.round) : all[0];
  if (!entry) throw new UserError(args.round ? `No decision with round id "${args.round}" in this project's journal.` : "No decisions recorded for this project yet.");
  const dir = args.dir ? String(args.dir) : ADR_DIR;
  if (isAbsolute(dir) || dir.split(/[\\/]/).includes("..")) throw new UserError("dir must be a folder inside the project, like docs/decisions.");
  const { file, created } = writeAdr({ root: project.top, entry, consequences: args.consequences || "", dir });
  return `${created ? "Wrote" : "Updated"} ${file}. Review it before committing: the Consequences section is only as good as what you passed.`;
}

async function exportTool(args) {
  const project = projectOf(args);
  if (args.round) return (await exportRound({ project, round: String(args.round), out: args.out })).text;
  const { raw, specPath, specDir } = readSpec(args, project, "the questions object");
  if (Array.isArray(raw?.cards) && !raw.questions) throw new UserError("export works on question rounds; a swipe deck needs you between batches.");
  return (await exportRound({ project, raw, specPath, specDir, out: args.out })).text;
}

async function importTool(args) {
  const project = projectOf(args);
  const files = Array.isArray(args.files) ? args.files : args.file ? [args.file] : [];
  return importAnswers({ project, files, round: args.round, specPath: args.specPath });
}

export const HANDLERS = { ask, swipe, wait, push, explain, screenshot, history, supersede, adr, export: exportTool, import: importTool };
