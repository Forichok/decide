// shared.mjs — what the commands have in common: the error that is meant for the user, the context a
// command runs in (its project and its server, both found only when a command asks), spec reading,
// and the CLI's wait loop.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ack, ensureServer, findServer, runningServer, waitNext, WAITER } from "../client.mjs";
import { PROTOCOL, speaks } from "../protocol.mjs";
import { decideHome, openProject, unknownRound } from "../project.mjs";
import { saveInlineSpec } from "../prepare.mjs";
import { WAIT_MS } from "../store/rounds.mjs";
import { UserError } from "../errors.mjs";

export const HOME = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const ENGINE = resolve(HOME, "decide.mjs");
// The exit code of a CLI wait that stopped because the user asked the agent something.
export const EXIT_ASK = 3;
export const EXIT_TIMEOUT = 4;
export function waitTimedOut(id, say, live) {
  say(`Still waiting for the user on round ${id}. Wait again: ${cliCommand("wait", id)}${live ? " --live" : ""}.`);
  return EXIT_TIMEOUT;
}

export { UserError };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

// The project dir a call names: its project, else the one Claude Code names; Claude starts the server in
// the project dir, Codex starts it in the plugin dir, so there the agent passes project. null: none.
export const projectDirOf = (given) => given || process.env.CLAUDE_PROJECT_DIR || (real(process.cwd()) === real(HOME) ? null : process.cwd());

function projectOf(given) {
  const dir = projectDirOf(given);
  if (!dir) throw new UserError("Pass project: the absolute path of the project you are working in.");
  if (!isAbsolute(dir) || !existsSync(dir)) throw new UserError(`project must be an existing absolute path, got "${dir}"`);
  return openProject(dir);
}

// What a call to a command runs with. project and server() are found when a command asks, so a command
// that needs neither (lint, history, a spec read) starts no server; the project's data directory is made when
// the project is first used, as in 2.1.
//   project: the working tree (top) and identity (root, dataDir) of the project the call names
//   server(): the home's server for a command that works on a round: the running one, else one is started
//             (the round is on disk). A server that does not answer is busy: that is said at once, nothing is
//             started beside it. { patient: true } (ask, swipe, open: the commands that start a round's page)
//             gives it ensureServer's patience first, as 2.1 did
//   cli: true when decide.mjs runs the command (its text and exit codes are the CLI's); say/warn print as it goes
//   signal: aborted when the agent cancels the call
export function contextFor(args = {}, extra = {}) {
  const given = typeof args?.project === "string" && args.project ? args.project : undefined;
  let project;
  const ctx = {
    cli: false,
    signal: undefined,
    say: (text) => console.log(text),
    warn: (text) => console.error(text),
    ...extra,
    hasProject: Boolean(projectDirOf(given)),
    async server({ patient, ...opts } = {}) {
      const home = decideHome();
      try {
        const live = patient ? await findServer(home) : await runningServer(home);
        if (live && speaks(live.protocol, PROTOCOL)) return live;
        return await ensureServer({ home, engine: ENGINE, ...opts });
      } catch (e) {
        if (e.busy) e.user = true; // the busy text is for the agent as it is
        throw e;
      }
    },
  };
  Object.defineProperty(ctx, "project", {
    enumerable: true,
    configurable: true,
    get: () => (project ??= projectOf(given)),
    set: (v) => (project = v),
  });
  return ctx;
}

export { unknownRound };

export function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${path}: ${e.message}`);
  }
}

// The spec a call hands in: a file (read from the working tree) or an inline object (saved under the data dir).
export function readSpec(args, project, what) {
  if (args.specPath) {
    const specPath = resolve(project.top, args.specPath);
    return { raw: JSON.parse(readFileSync(specPath, "utf8")), specPath, specDir: dirname(specPath) };
  }
  if (args.spec && typeof args.spec === "object") return { raw: args.spec, specPath: saveInlineSpec(project.dataDir, args.spec), specDir: project.top };
  throw new UserError(`Pass spec (${what}) or specPath.`);
}

// An AbortSignal that aborts when any of the given ones does (AbortSignal.any is newer than Node 20.0).
export function anyOf(...signals) {
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  const live = signals.filter(Boolean);
  for (const s of live) s.aborted ? abort() : s.addEventListener("abort", abort, { once: true });
  return { signal: ctl.signal, dispose: () => live.forEach((s) => s.removeEventListener("abort", abort)) };
}

// Server gone or restarted: the answers file may still have been written.
function savedResult(outPath, id, error) {
  const saved = outPath && existsSync(outPath) && JSON.parse(readFileSync(outPath, "utf8"));
  if (saved && saved.round === id) return saved;
  throw new Error(`decide round ${id} is gone: ${error.message}`);
}

// The CLI waits for a round to end (or, with live, until the user asks something): `report({ kind, payload })`
// prints the item and returns the exit code, or throws for a kind it cannot print; the item is acknowledged
// once it is printed, never before and never when printing threw (an item the CLI died before printing, or
// could not print, comes again). A failed ack is not an error: the item comes again on the next wait.
export async function settle(server, id, outPath, { live, report, deadline = Infinity, say = console.log }) {
  for (;;) {
    if (Date.now() >= deadline) {
      return waitTimedOut(id, say, live);
    }
    let item;
    const started = Date.now();
    const controller = new AbortController();
    let timer;
    try {
      const waiting = waitNext(server, id, { events: live, waiter: WAITER, timeoutMs: Math.min(WAIT_MS, deadline - Date.now()), signal: controller.signal });
      item = Number.isFinite(deadline) ? await Promise.race([waiting, new Promise((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, Math.max(0, deadline - Date.now()));
      })]) : await waiting;
    } catch (e) {
      if (e.status === 404) return report({ kind: "final", payload: savedResult(outPath, id, e) });
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (item) {
      if (item.superseded) throw Object.assign(new Error(`another session took over the wait for round ${id}`), { superseded: true, user: true });
      const exit = report(item);
      if (item.kind !== "dismissed") await ack(server, id, item.seq, WAITER).catch(() => {});
      return exit;
    }
    // Nothing, and back before the hold was up: something let go of this waiter. Never loop on that without
    // a pause of its own (the same pause as the MCP wait's).
    if (Date.now() - started < WAIT_MS - 1_000) await sleep(Math.max(0, Math.min(1_000, deadline - Date.now())));
  }
}

// ---- the parameters every command has

export const PROJECT = { kind: "string", schema: { type: "string", description: "Absolute path of the project you are working in. Always pass it (Codex needs it)." } };
export const ROUND = (description = "Round id returned by ask.") => ({ kind: "string", positional: 0, schema: { type: "string", description } });

// A command line that runs this engine from a shell (there is no `decide` executable): `node <decide.mjs> wait 3-ab`.
export const cliCommand = (...words) => `node ${ENGINE} ${words.join(" ")}`;
// How to wait for a round, in the words of whoever reads it: the tool's from MCP, the command line's from the CLI.
export const waitHow = (ctx, round) => (ctx.cli ? `run \`${cliCommand("wait", round, "--live")}\`` : `call wait with round "${round}"`);
