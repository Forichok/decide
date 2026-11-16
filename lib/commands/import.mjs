// import — read answers files saved from an exported page. One file settles the round; several show where
// the people disagree. The spec a round is read back from is read leniently (a name nobody reads is a warning).

import { collectFinal } from "../client.mjs";
import { importAnswers } from "../transfer.mjs";
import { PROJECT } from "./shared.mjs";

export default {
  name: "import",
  summary: "read answers files saved from an exported page",
  description:
    "Read answers files saved from an exported page. One file settles the round (answers file, journal) and returns the digest; several files return each person's answers and where they disagree, and settle nothing.",
  mcp: true,
  cli: true,
  legacyFlag: "--import",
  required: ["files"],
  params: {
    project: PROJECT,
    files: { kind: "paths", positional: "rest", schema: { type: "array", items: { type: "string" }, description: "Paths of the *.answers.json files." } },
    round: { kind: "string", schema: { type: "string", description: "Override the round id the files carry." } },
    specPath: { kind: "path", flags: ["--spec"], schema: { type: "string", description: "The questions file, if decide no longer knows which one the round came from." } },
    // 2.1 took a single file under this name too, and still does.
    file: { kind: "string", only: "mcp" },
  },
  async run(args, ctx) {
    const project = ctx.project;
    const files = Array.isArray(args.files) ? args.files : args.file ? [args.file] : [];
    let settled = null;
    const text = await importAnswers({ project, files, round: args.round, specPath: args.specPath, getServer: () => ctx.server(), onSettled: (s) => (settled = s) });
    // A round this call settled: the answers are in this result, so it is acknowledged once the result is out,
    // and its own result does not announce it.
    return settled ? { text, collects: settled.id, delivered: () => collectFinal(settled.server, settled.id) } : { text };
  },
};
