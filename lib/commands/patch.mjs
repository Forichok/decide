// patch — change an open question round while the user answers: ghost or bring back questions, reword,
// add or drop options, move the recommendation, mark answers to check. The server checks the patch with
// validatePatch (lib/store/patch.mjs) and refuses it whole on an error.

import { readFileSync } from "node:fs";
import { api } from "../client.mjs";
import { PATCH_OPS } from "../store/patch.mjs";
import { PROJECT, ROUND, UserError, cliCommand, unknownRound } from "./shared.mjs";

export const PATCH_SCHEMA = {
  type: "object",
  description: `A change to the round: {ops, reason, override?, keepAnswers?}. Each op names one of ${PATCH_OPS.join(", ")}.`,
  additionalProperties: true,
};

export default {
  name: "patch",
  summary: "change an open question round: ghost, restore, reword, options, stale",
  description:
    `Change an open question round while the user answers. ops: a list, each naming one of ${PATCH_OPS.join(", ")} and an optional reason. ` +
    "A ghost greys a question out with the reason; stale asks the user to check an answer. The user's own restore and keep win. override: true beats the round's rules; keepAnswers: true keeps answers on changed questions. " +
    "It works on a swipe round too: its cards are the items (push is the same change in a deck's words).",
  mcp: true,
  cli: true,
  required: ["round", "ops"],
  params: {
    project: PROJECT,
    round: ROUND("Round id returned by ask."),
    ops: { kind: "json", schema: { type: "array", items: { type: "object", additionalProperties: true }, description: "The operations, in order." } },
    reason: { kind: "string", schema: { type: "string", description: "Why, shown to the user next to what changed." } },
    override: { kind: "boolean", schema: { type: "boolean", description: "Beat the round's rules on the items it names." } },
    keepAnswers: { kind: "boolean", schema: { type: "boolean", description: "Keep the answers on questions this patch changes." } },
    file: { kind: "path", positional: 1, only: "cli" },
  },
  async run(args, ctx) {
    const { round, project: _project, file, ...given } = args;
    if (!round) throw new UserError("Pass round (the id returned by ask).");
    const body = file ? { ...JSON.parse(readFileSync(file, "utf8")), ...given } : given;
    if (!Array.isArray(body.ops) || !body.ops.length) throw new UserError("Pass ops: a non-empty list of operations.");
    if (args.project) void ctx.project;
    const server = await ctx.server();
    const res = await api(server, `/api/rounds/${encodeURIComponent(round)}/patch`, { method: "POST", body, timeoutMs: 5000 }).catch((e) => {
      if (e.status === 404 && /unknown round/.test(e.message)) throw unknownRound(round);
      throw new UserError(e.message);
    });
    const warn = res.warnings?.length ? `\nWarnings: ${res.warnings.join("; ")}` : "";
    const ghosts = res.view?.ghosts?.length ? ` Ghosts now: ${res.view.ghosts.map((g) => g.id).join(", ")}.` : "";
    const stale = res.view?.stale?.length ? ` To check: ${res.view.stale.join(", ")}.` : "";
    return { text: `Round ${round} changed.${ghosts}${stale}${warn}\n${ctx.cli ? `Run \`${cliCommand("wait", round)}\`` : "Call wait"} for the user's answers.` };
  },
};
