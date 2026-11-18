import { existsSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { api } from "../client.mjs";
import { checkExportTarget } from "../export.mjs";
import { answersPathFor, formatIssues } from "../prepare.mjs";
import { visualSchema } from "../registry/docs.mjs";
import { BRANCH_START, visualRange } from "../visual/baseline.mjs";
import { PROJECT, UserError, readSpec, waitHow } from "./shared.mjs";

const comparison = ({ base, head, baseRef, headRef }) => `Before: ${baseRef} (${base})\nAfter: ${headRef} (${head})`;

export default {
  name: "visual",
  summary: "open a visual acceptance round or preview its baseline",
  description: "Compare the Before and After evidence for a product change. Use compare first to see the proposed revisions. Ask the owner to confirm branch-start on first use or pass an explicit base. Open with specPath or spec, then call wait for the owner's questions and verdict.",
  mcp: true,
  cli: true,
  params: {
    project: PROJECT,
    spec: { kind: "object", only: "mcp", schema: visualSchema },
    specPath: { kind: "path", positional: 0, schema: { type: "string", description: "Visual spec file. Resolve capture paths beside it." } },
    compare: { kind: "boolean", schema: { type: "boolean", description: "Print the comparison without opening a round or saving the policy." } },
    base: { kind: "string", schema: { type: "string", description: "Exact Before revision to use for this round. A branch or commit." } },
    head: { kind: "string", schema: { type: "string", description: "After revision. Defaults to HEAD." } },
    baselinePolicy: { kind: "string", schema: { enum: [BRANCH_START], description: "Remember automatic branch-start comparisons after owner confirmation." } },
    previous: { kind: "string", schema: { type: "string", description: "Returned visual round whose remarks this round addresses." } },
    out: { kind: "path", only: "cli" },
    outside: { kind: "boolean", only: "cli" },
    open: { kind: "boolean", negate: "--no-open", schema: { type: "boolean", description: "Open the browser page. Defaults to true." } },
  },
  async run(args, ctx) {
    const project = ctx.project;
    const { base, head, baselinePolicy } = args;
    if (args.compare) {
      const range = await visualRange({ ...project, base, head, baselinePolicy, preview: true });
      const confirm = "Confirm automatic branch-start comparison with the owner on the project's first use. Pass --baseline-policy branch-start (MCP: baselinePolicy) to remember it. Pass --base <ref> (MCP: base) to override the baseline for a round.";
      return { text: [comparison(range), ...(base === undefined ? [confirm] : [])].join("\n\n") };
    }

    const { raw, specPath, specDir } = readSpec(args, project, "the visual acceptance spec");
    const outPath = args.out ? resolve(project.top, args.out) : answersPathFor(specPath);
    if (args.out) {
      checkExportTarget(outPath, project, args.outside);
      if (existsSync(outPath) && realpathSync(outPath) === realpathSync(specPath)) {
        throw new UserError("Choose a different --out file. This path holds the visual spec.");
      }
    }

    const server = await ctx.server({ patient: true });
    let posted;
    try {
      posted = await api(server, "/api/rounds", {
        method: "POST",
        body: {
          mode: "visual", project: project.top, spec: raw, specFile: specPath, specDir, inline: !args.specPath,
          outPath, source: basename(specPath), open: args.open !== false,
          base, head, previous: args.previous ?? raw?.previous, baselinePolicy,
        },
        timeoutMs: 60_000,
      });
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && error.data?.error) {
        throw new UserError(`${error.data.error}${error.data.issues?.length ? `\n${formatIssues(error.data.issues)}` : ""}`);
      }
      throw error;
    }
    return {
      text: [
        `Visual round ${posted.id} «${raw.title}» is ready: ${posted.url}`,
        comparison(posted.visual),
        `Now ${waitHow(ctx, posted.id)} for the owner's questions and verdict.`,
      ].join("\n\n"),
    };
  },
};
