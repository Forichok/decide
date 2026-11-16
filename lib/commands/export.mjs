// export — save a question round as one self-contained .html page for someone who cannot reach this machine.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { exportRound } from "../transfer.mjs";
import { PROJECT, UserError, readSpec } from "./shared.mjs";

export default {
  name: "export",
  summary: "save a question round as one .html file to send to someone",
  description:
    "Save a question round as one self-contained .html file for someone who can't reach this machine: they open it from disk, answer, and Done saves an answers JSON with their name. Pass round to export an open round, or spec/specPath to export without opening a page. Then end your turn; when the files come back, call import.",
  mcp: true,
  cli: true,
  legacyFlag: "--export",
  legacyValue: "round",
  params: {
    project: PROJECT,
    round: { kind: "string", positional: 0, schema: { type: "string", description: "An open question round to export." } },
    spec: { kind: "object", only: "mcp", schema: { type: "object", description: "Or the questions object, as for ask." } },
    specPath: { kind: "path", schema: { type: "string", description: "Or the path of a *.questions.json." } },
    out: { kind: "string", schema: { type: "string", description: "Where to write the .html. Default: next to the spec, *.decide.html." } },
  },
  // `--export x.questions.json`: a spec file, not a round id.
  fromArgv(args, { cwd }) {
    const file = args.round && /\.json$/i.test(args.round) && resolve(cwd, args.round);
    if (!file || !existsSync(file)) return args;
    const { round: _round, ...rest } = args;
    return { ...rest, specPath: file };
  },
  async run(args, ctx) {
    const project = ctx.project;
    const getServer = () => ctx.server();
    if (args.round) return { text: (await exportRound({ project, round: String(args.round), out: args.out, getServer })).text };
    const { raw, specPath, specDir } = readSpec(args, project, "the questions object");
    if (Array.isArray(raw?.cards) && !raw.questions) throw new UserError("export works on question rounds; a swipe deck needs you between batches.");
    return { text: (await exportRound({ project, raw, specPath, specDir, out: args.out, getServer })).text };
  },
};
