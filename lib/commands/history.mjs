// history — the decisions already made in this project, so nothing is asked twice.

import { deferredDecisions, formatDeferred, formatJournal, formatOverlaps, overlaps, readJournal } from "../journal.mjs";
import { formatSettings } from "../settings.mjs";
import { PROJECT } from "./shared.mjs";

export default {
  name: "history",
  summary: "decisions already made in this project",
  description: "Decisions already made in this project (newest first), to avoid asking the same thing twice.",
  mcp: true,
  cli: true,
  legacyFlag: "--journal",
  params: {
    project: PROJECT,
    limit: { kind: "number", schema: { type: "number", description: "Default 10." } },
    query: { kind: "string", schema: { type: "string", description: "Filter by text." } },
    status: { kind: "string", schema: { type: "string", enum: ["all", "live", "superseded"], description: "live: only decisions that still hold. Default all." } },
    topic: { kind: "string", schema: { type: "string", description: "A question you are about to ask: lists the live decisions on the same topic." } },
  },
  run(args, ctx) {
    if (args.topic) {
      const hits = overlaps(ctx.project, [String(args.topic)], { limit: Number(args.limit) || 10 });
      return { text: hits.length ? formatOverlaps(hits) : `No live decision in this project looks like «${args.topic}».` };
    }
    const status = ["live", "superseded"].includes(args.status) ? args.status : "all";
    const journal = formatJournal(readJournal(ctx.project, { limit: Number(args.limit) || 10, query: args.query || "", status }));
    // Deferred decisions come first, in a block of their own: they are the open ends.
    const deferred = status === "superseded" ? "" : formatDeferred(deferredDecisions(ctx.project));
    return { text: [formatSettings(ctx.project.dataDir), deferred, journal].filter(Boolean).join("\n\n") };
  },
};
