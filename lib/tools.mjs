// tools.mjs — the MCP tools: ask, wait, explain, screenshot, history. Each
// works on one project (its data dir holds the daemon, journal, screenshots).

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDaemon, findDaemon, postExplain, postRound, waitOnce } from "./client.mjs";
import { formatJournal, readJournal } from "./journal.mjs";
import { capture, viewportsOf } from "./shot.mjs";
import { openProject } from "./project.mjs";
import { answersPathFor, formatAsk, formatIssues, formatResult, prepareSpec, saveInlineSpec } from "./prepare.mjs";

const HOME = dirname(dirname(fileURLToPath(import.meta.url)));
const ENGINE = resolve(HOME, "decide.mjs");
const WAIT_DEFAULT_SEC = 600;
const known = new Map(); // round id → { dataDir, outPath }

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

async function portFor(args) {
  const dataDir = known.get(args.round)?.dataDir || projectOf(args).dataDir;
  const port = await findDaemon(dataDir);
  if (!port) throw new UserError("The decide page is not running for this project any more. Ask again with the ask tool.");
  return port;
}

async function ask(args) {
  const project = projectOf(args);
  let raw;
  let specPath;
  if (args.specPath) {
    specPath = resolve(project.root, args.specPath);
    raw = JSON.parse(readFileSync(specPath, "utf8"));
  } else if (args.spec && typeof args.spec === "object") {
    raw = args.spec;
    specPath = saveInlineSpec(project.dataDir, raw);
  } else throw new UserError("Pass spec (the questions object) or specPath.");
  const specDir = args.specPath ? dirname(specPath) : project.root;
  const { spec, issues, errors } = await prepareSpec(raw, { specDir, dataDir: project.dataDir });
  if (errors.length) throw new UserError(`The spec has errors, nothing was shown:\n${formatIssues(issues)}`);
  const outPath = answersPathFor(specPath);
  const daemon = await ensureDaemon({ dir: project.dataDir, engine: ENGINE });
  const posted = await postRound(daemon.port, { spec, outPath, source: basename(specPath), open: args.open !== false, live: true });
  known.set(posted.id, { dataDir: project.dataDir, outPath });
  return [
    `Round ${posted.id} «${spec.title}» is open for the user: ${posted.url}`,
    issues.length ? `Lint warnings:\n${formatIssues(issues)}` : "",
    `Now call wait with round "${posted.id}" and keep calling it until it returns answers. Don't end your turn in between: the answers reach you only through wait.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function wait(args) {
  if (!args.round) throw new UserError("Pass round (the id returned by ask).");
  const port = await portFor(args);
  const deadline = Date.now() + Math.max(5, Math.min(Number(args.timeoutSec) || WAIT_DEFAULT_SEC, 840)) * 1000;
  const outPath = known.get(args.round)?.outPath;
  for (;;) {
    let res;
    try {
      res = await waitOnce(port, args.round, { events: true, timeoutMs: Math.min(deadline - Date.now(), 240_000) });
    } catch (e) {
      if (e.status !== 404) throw e;
      if (outPath && existsSync(outPath)) return formatResult(JSON.parse(readFileSync(outPath, "utf8")), outPath);
      throw new UserError(`Round ${args.round} is gone (the page was restarted). Ask again if you still need the answers.`);
    }
    if (res?.event === "ask") return formatAsk(res);
    if (res) return formatResult(res, outPath || res.file);
    if (Date.now() >= deadline - 1000) return `Still waiting for the user on round ${args.round}. Call wait again now and don't end your turn while the round is open. If you must stop, ask the user to message you once they've answered, then call wait with timeoutSec 5 first.`;
  }
}

async function explain(args) {
  if (!args.round || !args.question) throw new UserError("Pass round and question.");
  const root = args.project || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const abs = (p) => (typeof p === "string" && !/^(https?:|data:)/i.test(p) ? resolve(root, p) : p);
  const images = (args.images || []).map((img) => (typeof img === "string" ? abs(img) : { ...img, src: abs(img.src) }));
  const port = await portFor(args);
  const res = await postExplain(port, args.round, {
    question: args.question,
    askId: args.askId,
    text: args.text || "",
    images,
    mermaid: args.mermaid,
    code: args.code,
    links: args.links,
  });
  const warn = res.warnings?.length ? `\nWarnings: ${res.warnings.join("; ")}` : "";
  return `Explanation shown under question ${args.question}.${warn}\nCall wait again for the user's answers.`;
}

async function screenshot(args) {
  if (!args.url) throw new UserError("Pass url (http or https).");
  const project = projectOf(args);
  const shots = [];
  for (const viewport of viewportsOf(args.viewport)) {
    shots.push({ viewport, path: await capture({ url: args.url, dir: resolve(project.dataDir, "shots"), name: args.name, viewport, waitMs: args.waitMs }) });
  }
  const content = [{ type: "text", text: `${shots.map((s) => `${s.viewport}: ${s.path}`).join("\n")}\nUse these paths in a spec's images.` }];
  if (args.show !== false) {
    for (const s of shots) content.push({ type: "image", data: readFileSync(s.path).toString("base64"), mimeType: "image/png" });
  }
  return content;
}

function history(args) {
  const project = projectOf(args);
  return formatJournal(readJournal(project.dataDir, { limit: Number(args.limit) || 10, query: args.query || "" }));
}

export const HANDLERS = { ask, wait, explain, screenshot, history };
