// supersede — mark an earlier decision as no longer holding.

import { markAdrSuperseded } from "../adr.mjs";
import { supersedeJournal } from "../journal.mjs";
import { PROJECT, UserError } from "./shared.mjs";

export default {
  name: "supersede",
  summary: "mark an earlier decision as no longer holding",
  description: "Mark an earlier decision as no longer holding, when the user decided otherwise in a later round. history and later rounds then stop treating it as settled, and its ADR (if any) gets a Superseded status.",
  mcp: true,
  cli: true,
  legacyFlag: "--supersede",
  legacyValue: "round",
  required: ["round"],
  params: {
    project: PROJECT,
    round: { kind: "string", positional: 0, schema: { type: "string", description: "The id of the round whose decision no longer holds (history shows ids)." } },
    by: { kind: "string", schema: { type: "string", description: "The id of the round that replaced it, if any." } },
    reason: { kind: "string", schema: { type: "string", description: "One line on why, in the user's language." } },
  },
  run(args, ctx) {
    if (!args.round) throw new UserError("Pass round: the id of the decision that no longer holds.");
    const project = ctx.project;
    const entry = supersedeJournal(project, { round: String(args.round), by: args.by ? String(args.by) : "", reason: args.reason || "" });
    const adr = markAdrSuperseded(project.top, entry);
    if (ctx.cli) return { text: `decide: round ${entry.round} «${entry.title}» superseded${entry.superseded.by ? ` by ${entry.superseded.by}` : ""}${adr ? `; ${adr} updated` : ""}` };
    return { text: [`Round ${entry.round} «${entry.title}» is marked superseded${entry.superseded.by ? ` by round ${entry.superseded.by}` : ""}.`, adr ? `Its ADR now says so: ${adr}` : ""].filter(Boolean).join("\n") };
  },
};
