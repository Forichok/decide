// push — update an open swipe round after a batch: the brief, the confidence, new, rewritten and removed cards.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { api } from "../client.mjs";
import { formatIssues, preparePatch } from "../prepare.mjs";
import { PROJECT, ROUND, UserError, cliCommand, unknownRound } from "./shared.mjs";

const CARDS = (description) => ({ kind: "json", schema: { type: "array", items: { type: "object", additionalProperties: true }, description } });

export default {
  name: "push",
  summary: "update an open swipe round: brief, confidence, cards",
  description:
    "Update an open swipe round after a batch: rewrite the brief, set your confidence, add follow-up cards, replace or remove cards the user hasn't answered. done: true tells the user you have no more questions. The user keeps answering while you push.",
  mcp: true,
  cli: true,
  required: ["round"],
  params: {
    project: PROJECT,
    round: ROUND("Round id returned by ask."),
    add: CARDS("New cards, same shape as in swipe."),
    position: { kind: "string", schema: { type: "string", enum: ["next", "end"], description: "Where new cards go: next (right behind the card on the user's screen) or end (default)." } },
    replace: CARDS("Open cards to rewrite, matched by id."),
    remove: { kind: "list", schema: { type: "array", items: { type: "string" }, description: "Ids of open cards that became moot." } },
    brief: {
      kind: "json",
      schema: {
        type: "array",
        items: { type: "object", properties: { kind: { type: "string", enum: ["decision", "risk", "problem", "open", "note"] }, text: { type: "string" }, cards: { type: "array", items: { type: "string" } } }, required: ["text"] },
        description: "The whole brief, rewritten: short points, each a decision, risk, problem, open question or note. Replaces the previous brief.",
      },
    },
    goal: { kind: "string", schema: { type: "string", description: "One line on what the interview is about, if it changed." } },
    confidence: { kind: "number", schema: { type: "number", description: "How well you now understand what the user wants, 0–100." } },
    batch: { kind: "number", schema: { type: "number", description: "Answers per batch from now on." } },
    done: { kind: "boolean", schema: { type: "boolean", description: "No important question left: the page shows the brief and asks the user to finish." } },
    // 3.0: push runs through the patch engine. A removed card the user saw or answered stays as a ghost with
    // the reason; a replaced answered card comes back to the user to check, unless keepAnswers.
    reason: { kind: "string", schema: { type: "string", description: "Why cards changed or went: shown on the ghost and on answers to check." } },
    keepAnswers: { kind: "boolean", schema: { type: "boolean", description: "A cosmetic rewrite: replaced cards keep their answers unchecked." } },
    file: { kind: "path", only: "cli" },
  },
  async run(args, ctx) {
    if (!args.round) throw new UserError("Pass round (the id returned by swipe).");
    if (args.project) void ctx.project;
    const server = await ctx.server();
    const id = encodeURIComponent(args.round);
    const view = await api(server, `/api/rounds/${id}`).catch((e) => {
      throw e.status === 404 ? unknownRound(args.round) : new UserError(e.message);
    });
    if (view.mode !== "swipe") throw new UserError(`Round ${args.round} is not a swipe round; push works only on rounds opened with swipe.`);
    if (view.status !== "pending") throw new UserError(`Round ${args.round} is already ${view.status}. ${ctx.cli ? `Run \`${cliCommand("wait", args.round)}\`` : "Call wait"} to get the final answers.`);
    // Paths in the patch are read as in the deck: beside its spec file, or from the project for an inline
    // deck (its spec file sits in the data dir).
    const rel = view.specFile ? relative(view.dataDir, view.specFile) : "";
    const inline = !view.specFile || (!rel.startsWith("..") && !isAbsolute(rel));
    const specDir = inline ? ctx.project.top : dirname(view.specFile);
    const raw = args.file ? { ...JSON.parse(readFileSync(args.file, "utf8")), ...args } : args;
    const { patch, issues, errors } = await preparePatch(raw, { specDir, dataDir: view.dataDir, lang: view.spec.lang });
    if (errors.length) throw new UserError(`The push has errors, nothing changed:\n${formatIssues(issues)}`);
    const res = await api(server, `/api/rounds/${id}/push`, { method: "POST", body: patch, timeoutMs: 5000 });
    const all = [...issues, ...res.issues];
    const { stats } = res;
    return {
      text: [
        `Deck updated: ${res.added} card${res.added === 1 ? "" : "s"} added; ${stats.answered} answered, ${stats.left} left of ${stats.total}.`,
        all.length ? `Warnings:\n${formatIssues(all)}` : "",
        patch.done ? `You marked the interview done: the page shows the brief and asks the user to finish. ${ctx.cli ? `Run \`${cliCommand("wait", args.round)}\`` : "Call wait"} for the final answers.` : `${ctx.cli ? `Run \`${cliCommand("wait", args.round)}\` again` : "Call wait again"} for the next batch.`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
};
