// adr — write a finished round as an architecture decision record in the repo.

import { isAbsolute } from "node:path";
import { ADR_DIR, writeAdr } from "../adr.mjs";
import { readJournal } from "../journal.mjs";
import { PROJECT, UserError } from "./shared.mjs";

export default {
  name: "adr",
  summary: "write a finished round as an ADR in the repo",
  description: "Write a finished round as an architecture decision record in the repo: docs/decisions/NNNN-slug.md with context, options, decision and consequences. Writing the same round again updates its file.",
  mcp: true,
  cli: true,
  legacyFlag: "--adr",
  params: {
    project: PROJECT,
    round: { kind: "string", positional: 0, schema: { type: "string", description: "The round id. Default: the latest decision." } },
    consequences: { kind: "string", schema: { type: "string", description: "Markdown: what this makes easier and harder. Pros and cons of the picked options are added on their own." } },
    dir: { kind: "string", flags: ["--adr-dir"], schema: { type: "string", description: "Folder relative to the project. Default docs/decisions." } },
  },
  run(args, ctx) {
    const project = ctx.project;
    const all = readJournal(project.dataDir, { limit: 500 });
    const entry = args.round ? all.find((e) => e.round === args.round) : all[0];
    if (!entry) {
      if (ctx.cli) throw new Error(args.round ? `no decision with round id "${args.round}" in this project's journal` : "no decisions recorded for this project yet");
      throw new UserError(args.round ? `No decision with round id "${args.round}" in this project's journal.` : "No decisions recorded for this project yet.");
    }
    const dir = args.dir ? String(args.dir) : ADR_DIR;
    if (!ctx.cli && (isAbsolute(dir) || dir.split(/[\\/]/).includes(".."))) throw new UserError("dir must be a folder inside the project, like docs/decisions.");
    const { file, created } = writeAdr({ root: project.top, entry, consequences: args.consequences || "", dir });
    if (ctx.cli) return { text: `decide: ${created ? "wrote" : "updated"} ${file}` };
    return { text: `${created ? "Wrote" : "Updated"} ${file}. Review it before committing: the Consequences section is only as good as what you passed.` };
  },
};
