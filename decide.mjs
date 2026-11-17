#!/usr/bin/env node
// decide.mjs — clickable decision rounds for coding agents (CLI).
//
// The agent writes a questions spec and runs this script in the background.
// The script posts the round to the decide home's server (started on
// demand), which serves one browser tab for every round of every project.
// When the user presses Done, the answers JSON is written, a digest is
// printed, and the script exits 0. With --live it exits 3 as soon as the
// user asks the agent something: reply with --reply, then --wait again.
//
// Usage:
//   node decide.mjs <x.questions.json> [--out a.json] [--live] [--no-open]
//   node decide.mjs --wait <round> [--live]          keep waiting for a round
//   node decide.mjs --reply <round> --question <id> --text "…" | <reply.json>
//   node decide.mjs --shot <url> [--viewport desktop|mobile|both] [--name n]
//   node decide.mjs --sim ios|android [--device id] [--name n]  simulator screen
//   node decide.mjs --journal [--limit n] [--query text] [--status live|superseded] [--topic text]
//   node decide.mjs --supersede <round> [--by <round>] [--reason "…"]
//   node decide.mjs --export <round | x.questions.json> [--out page.html] [--outside]   --out stays in the project unless --outside
//   node decide.mjs --import <a.answers.json> [more.answers.json…] [--round id] [--spec x.questions.json]
//   node decide.mjs --adr [<round>] [--consequences "…"] [--adr-dir docs/decisions]
//   node decide.mjs --demo [--lang en|ru]             the feature tour
//   node decide.mjs notice                            answers the user sent that no agent has collected
//   node decide.mjs --lint <x.questions.json> | --stop
//   node decide.mjs outline [--base ref] [--head ref] [--json] [--place path:from-to] [--out spec.json] [--force] [--outside]
//   node decide.mjs review <x.review.json> [--base ref] [--head ref] [--no-open]   a code review of a branch
//   node decide.mjs serve [--port n]                  run the home's server (started on demand)
//   wait <round> [--live] [--timeout-sec n]: stop after n seconds; without it, keep waiting.
//   Exit codes: 0 result; 1 lint/stop refused; 2 error; 3 live item; 4 wait timed out.
//   Every command also has a name: ask swipe wait push explain screenshot history supersede adr export
//   import lint stop open notice rules patch review, as in `node decide.mjs wait <round> --live`, `node decide.mjs open <round>`.
//   Every command takes --project <dir> (default: the current directory).
//
// Zero dependencies, Node >= 20. Agent guide and spec: skills/decide/.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { contextFor, runCommand } from "./lib/commands/index.mjs";
import { parseArgv } from "./lib/commands/argv.mjs";

// Exit codes: 0 done; 1 lint errors, or a stop that did not happen; 2 an error; EXIT_ASK = 3 (lib/commands/shared.mjs):
// a --live wait that stopped because the user asked the agent something. A command returns its own as `exit`.
const ENGINE = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
function flag(name) {
  const i = argv.indexOf(name);
  const v = i === -1 ? undefined : argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

function print(stream, text) {
  // Pipes write asynchronously: process.exit must wait for the complete message.
  return new Promise((resolve, reject) => {
    stream.write(`${text}\n`, error => error ? reject(error) : resolve());
  });
}

async function main() {
  if (!argv.length || has("-h") || has("--help")) {
    const lines = readFileSync(ENGINE, "utf8").split("\n");
    const usage = lines.slice(lines.indexOf("// Usage:"), lines.findIndex((l) => l.includes("Every command takes")) + 1).join("\n");
    await print(process.stdout, usage.replace(/^\/\/ ?/gm, ""));
    return argv.length ? 0 : 1;
  }
  if (argv[0] === "serve") {
    // Test seams, read only here: DECIDE_TEST_LOAD_BLOCK_MS blocks the event loop right before the store
    // loads; DECIDE_TEST_BUSY_MS="<after>:<for>" blocks it once, <after> ms after the server serves.
    const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const loadBlock = Number(process.env.DECIDE_TEST_LOAD_BLOCK_MS) || 0;
    const started = await startServer({ port: Number(flag("--port")) || undefined, ...(loadBlock > 0 && { beforeLoad: () => block(loadBlock) }) });
    if (!started) {
      await print(process.stdout, "decide: a server of this decide home is already running");
      return 0;
    }
    await print(process.stdout, `DECIDE serving: http://127.0.0.1:${started.port}/`);
    const [after, busy] = String(process.env.DECIDE_TEST_BUSY_MS || "").split(":").map(Number);
    if (busy > 0) setTimeout(() => block(busy), after || 0);
    return null;
  }
  // A directory that is gone has no notice to give: the session-start hook is never failed for it.
  let cwd;
  try {
    cwd = process.cwd();
  } catch {}
  const { command, args, project } = parseArgv(argv, { cwd: cwd ?? resolve("/") });
  if (!cwd && !project) {
    if (command === "notice") return 0;
    throw new Error("the current directory is gone; pass --project <dir>");
  }
  const dir = project || resolve(cwd);
  // `notice` reads the disk only and fails never: a session-start hook runs it.
  const ctx = contextFor({ project: dir }, { cli: true, noticeProject: dir, noticeDir: dir });
  const out = await runCommand(command, args, ctx);
  if (out.text) await print(process.stdout, out.text);
  // Printed: the CLI has what the text carries, so it is acknowledged. Failing to is not an error.
  await out.delivered?.().catch(() => {});
  return out.exit ?? 0;
}

main().then(
  (code) => code !== null && process.exit(code),
  async (e) => {
    try {
      await print(process.stderr, `decide: ${e.message}`);
    } finally {
      process.exit(2);
    }
  },
);
