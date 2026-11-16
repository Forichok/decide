// ask — show the user a round of questions. From an agent it returns at once with the round id (then wait);
// from the CLI it posts the round and waits for the answers itself.

import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "../client.mjs";
import { deferredOverlaps, formatDeferred, formatOverlaps, overlaps } from "../journal.mjs";
import { answersPathFor, formatAsk, formatRequest, formatBatch, formatDeeper, formatIssues, formatResult, prepareSpec } from "../prepare.mjs";
import { formatHints, hintsFor } from "../hints.mjs";
import { formatJudgement, judgeRound, levelIssues, readLevel, readRules, toldAlready } from "../settings.mjs";
import { specSchema } from "../registry/docs.mjs";
import { EXIT_ASK, PROJECT, cliCommand, UserError, readJsonFile, readSpec, settle } from "./shared.mjs";

// The tour comes in English and Russian; the system locale picks one.
function showcase(lang) {
  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  const ru = lang ? lang === "ru" : /^ru/i.test(locale);
  return fileURLToPath(new URL(`../../examples/showcase${ru ? ".ru" : ""}.questions.json`, import.meta.url));
}

// What the CLI prints for the first item that comes in, whatever an agent can be handed (the same texts as the
// tools'); returns the exit code: EXIT_ASK for what needs the agent to act and wait again (a question of the
// user's, a batch, a dig-deeper), 0 for the end of the round. A kind it cannot print throws: it is not acknowledged.
export const reportCli = (say, id, outPath) => ({ kind, payload }) => {
  switch (kind) {
    case "ask": {
      say(`DECIDE ask: ${JSON.stringify(payload)}`);
      const reply = `${cliCommand("--reply", id, "--question", payload.ask.question, "--text")} "…"`;
      say(formatAsk(payload, `with ${reply} (or a reply.json with images/mermaid/code), then run ${cliCommand("--wait", id, "--live")}`));
      return EXIT_ASK;
    }
    case "request":
      say(`DECIDE request: ${JSON.stringify(payload)}`);
      say(formatRequest(payload));
      return EXIT_ASK;
    case "batch":
    case "deeper":
      say(`\n=== DECIDE ${kind} ===\n${kind === "batch" ? formatBatch(payload) : formatDeeper(payload)}`);
      say(`Push with ${cliCommand("push", id, "--file push.json")} (brief, add, replace, remove, confidence, done), then run ${cliCommand("wait", id, "--live")}.`);
      return EXIT_ASK;
    case "final":
    case "cancel":
      say(`\n=== DECIDE ===\n${formatResult(payload, outPath || payload.file)}`);
      return 0;
    case "dismissed":
      say(`\n=== DECIDE ===\n${formatResult({ ...payload, status: "dismissed" })}`);
      return 0;
    default:
      throw new Error(`round ${id} handed out an item of kind "${kind}" that this client cannot print; it was not acknowledged and comes again on the next wait`);
  }
};

export default {
  name: "ask",
  summary: "show a round of questions; the CLI waits for the answers",
  description:
    "Show the user a round of questions in the browser. Pass spec (the questions object, see the decide skill) or specPath (a x.questions.json file). Returns the round id; then call wait. Images may be {\"shot\": url, \"viewport\": \"mobile\"} to capture a running page.",
  typeLines: true,
  mcp: true,
  cli: true,
  params: {
    project: PROJECT,
    spec: { kind: "object", only: "mcp", schema: () => ({ ...specSchema(), description: "Questions spec: {title, intro?, questions: [{id, title, type?, options: [{id, label, recommended?}]}]}" }) },
    specPath: { kind: "path", positional: 0, schema: { type: "string", description: "Path to a spec file instead of spec; answers are written next to it." } },
    open: { kind: "boolean", negate: "--no-open", schema: { type: "boolean", description: "Open or focus the browser page (default true)." } },
    out: { kind: "path", only: "cli" },
    live: { kind: "boolean", only: "cli" },
    port: { kind: "number", only: "cli" },
    demo: { kind: "boolean", only: "cli", selects: true },
    lang: { kind: "string", only: "cli" },
  },
  async run(args, ctx) {
    const project = ctx.project;
    let raw, specPath, specDir;
    if (ctx.cli) {
      specPath = args.demo ? showcase(args.lang) : args.specPath;
      if (!specPath) throw new Error("questions.json path required");
      raw = readJsonFile(specPath);
      specDir = dirname(specPath);
    } else ({ raw, specPath, specDir } = readSpec(args, project, "the questions object"));
    const { spec, issues, errors } = await prepareSpec(raw, { specDir, dataDir: project.dataDir });
    const level = readLevel(project.dataDir);
    issues.push(...levelIssues(raw, level));
    if (ctx.cli) {
      if (issues.length) ctx.say(formatIssues(issues).replace(/^/gm, "decide lint: "));
      if (errors.length) throw new Error(`spec has ${errors.length} error(s) — fix them and rerun`);
    } else if (errors.length) throw new UserError(`The spec has errors, nothing was shown:\n${formatIssues(issues)}`);
    if (!ctx.cli) {
      // Under the bar of the project's level, or covered by a rule: said once; the same round again goes through.
      const rules = readRules(project.dataDir);
      const judged = judgeRound(spec, { level, rules });
      if ((judged.under.length || judged.covered.length) && !toldAlready(`${project.dataDir}\n${spec.questions.map((q) => `${q.id}:${q.title}`).join("\n")}`)) return { text: formatJudgement(judged, { level, rules }) };
    }
    const outPath = ctx.cli ? resolve(args.out || (args.demo ? `${tmpdir()}/decide-demo.answers.json` : answersPathFor(specPath))) : answersPathFor(specPath);
    const server = await ctx.server({ patient: true, port: args.port || undefined });
    const posted = await api(server, "/api/rounds", {
      method: "POST",
      body: { project: project.top, spec, outPath, source: basename(specPath), specFile: specPath, open: args.open !== false, live: ctx.cli ? Boolean(args.live) : true },
      timeoutMs: 5000,
    });
    if (ctx.cli) {
      // One write: a reader of the pipe never sees the ready line without the answers path.
      ctx.say(`DECIDE ready: ${posted.url}\nAnswers will be written to: ${outPath}${server.embedded ? " (embedded server)" : ""}`);
      return { text: "", exit: await settle(server, posted.id, outPath, { live: Boolean(args.live), report: reportCli(ctx.say, posted.id, outPath) }) };
    }
    return {
      text: [
        `Round ${posted.id} «${spec.title}» is open for the user: ${posted.url}`,
        issues.length ? `Lint warnings:\n${formatIssues(issues)}` : "",
        formatOverlaps(overlaps(project, spec.questions.map((q) => ({ id: q.id, text: q.title })))),
        formatHints(hintsFor(spec)),
        formatDeferred(deferredOverlaps(project, spec.questions), "The user put off decisions that touch this round («later»); check whether one is due now:"),
        `Now call wait with round "${posted.id}" and keep calling it until it returns answers. Don't end your turn in between: the answers reach you only through wait.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  },
};
