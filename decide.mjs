#!/usr/bin/env node
// decide.mjs — clickable decision rounds for coding agents (CLI).
//
// The agent writes a questions spec and runs this script in the background.
// The script posts the round to the project's session daemon (started on
// demand), which serves one browser tab for every round of the project.
// When the user presses Done, the answers JSON is written, a digest is
// printed, and the script exits 0. With --live it exits 3 as soon as the
// user asks the agent something: reply with --reply, then --wait again.
//
// Usage:
//   node decide.mjs <x.questions.json> [--out a.json] [--live] [--no-open]
//   node decide.mjs --wait <round> [--live]          keep waiting for a round
//   node decide.mjs --reply <round> --question <id> --text "…" | <reply.json>
//   node decide.mjs --shot <url> [--viewport desktop|mobile|both] [--name n]
//   node decide.mjs --journal [--limit n] [--query text]
//   node decide.mjs --demo [--lang en|ru]             the feature tour
//   node decide.mjs --lint <x.questions.json> | --stop
//   Every command takes --project <dir> (default: the current directory).
//
// Zero dependencies, Node >= 20. Agent guide and spec: skills/decide/.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "./lib/daemon.mjs";
import { openProject } from "./lib/project.mjs";
import * as cmd from "./lib/commands.mjs";

const ENGINE = fileURLToPath(import.meta.url);
const VALUE_FLAGS = ["--lang", "--out", "--port", "--dir", "--lint", "--wait", "--reply", "--question", "--text", "--shot", "--viewport", "--name", "--wait-ms", "--limit", "--query", "--project"];
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
function flag(name) {
  const i = argv.indexOf(name);
  const v = i === -1 ? undefined : argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}
const positional = argv.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(argv[i - 1]));

// The tour comes in English and Russian; the system locale picks one.
function showcase(lang) {
  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  const ru = lang ? lang === "ru" : /^ru/i.test(locale);
  return fileURLToPath(new URL(`./examples/showcase${ru ? ".ru" : ""}.questions.json`, import.meta.url));
}

async function main() {
  if (!argv.length || has("-h") || has("--help")) {
    const usage = readFileSync(ENGINE, "utf8").split("\n").slice(10, 19).join("\n");
    console.log(usage.replace(/^\/\/ ?/gm, ""));
    return argv.length ? 0 : 1;
  }
  if (has("--daemon")) {
    await startDaemon({ dir: resolve(flag("--dir") || process.cwd()), port: Number(flag("--port")) || 0 });
    return null;
  }
  const project = openProject(flag("--project") || process.cwd());
  const live = has("--live");
  if (has("--stop")) return cmd.stop(project);
  if (has("--lint")) return cmd.lint(resolve(flag("--lint") || positional[0] || ""), project);
  if (has("--journal")) return cmd.journal({ limit: Number(flag("--limit")) || 10, query: flag("--query") || "", project });
  if (has("--shot")) return cmd.shot({ url: flag("--shot"), viewport: flag("--viewport"), name: flag("--name"), waitMs: Number(flag("--wait-ms")) || undefined, project });
  if (has("--wait")) return cmd.resume({ id: flag("--wait"), live, project });
  if (has("--reply")) {
    return cmd.reply({ id: flag("--reply"), question: flag("--question"), text: flag("--text"), file: positional[0] && resolve(positional[0]), project });
  }
  const demo = has("--demo");
  const questionsPath = demo ? showcase(flag("--lang")) : positional[0] && resolve(positional[0]);
  if (!questionsPath) throw new Error("questions.json path required");
  return cmd.round({ questionsPath, out: flag("--out"), demo, open: !has("--no-open"), live, port: Number(flag("--port")) || 0, engine: ENGINE, project });
}

main().then(
  (code) => code !== null && process.exit(code),
  (e) => {
    console.error(`decide: ${e.message}`);
    process.exit(2);
  },
);
