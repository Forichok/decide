// review — open a code review of a branch: the agent's overview and chapters over the diff the server
// reads from git. Returns at once; then wait: a question on a hunk comes at once, the verdict at the end.

import { basename } from "node:path";
import { api } from "../client.mjs";
import { answersPathFor, formatIssues } from "../prepare.mjs";
import { reviewLines, reviewSchema } from "../registry/docs.mjs";
import { PREVIOUS_PARAMS } from "../registry/index.mjs";
import { snapshotLine } from "../review/snapshot.mjs";
import { normalizeReview } from "../review/spec.mjs";
import { PROJECT, UserError, cliCommand, readSpec, waitHow } from "./shared.mjs";

export default {
  name: "review",
  summary: "open a code review of a branch (overview, chapters, diff)",
  description:
    "Open a code review for the user: your overview (what changed and why, risks, the checks you ran), then the diff cut into chapters by meaning. The server reads the diff from git. A follow-up shows changes since the previous review. Use --previous <round> or --no-previous on the CLI. Pass the spec as spec or specPath. A hunk is named by file: \"lib/x.mjs\" (all its hunks), \"lib/x.mjs:120-180\" (those touching these lines of the new file), \"docs/shots/\" or a glob; the first chapter that names a hunk gets it, and hunks nobody names go to \"The rest\" and are listed as lint warnings. Run the checks first and report them as they went: the page runs nothing. Independent reviewers run before the page opens when required by the project settings. Then call wait: it returns a question the user asks on a hunk (answer with explain, question = the id in brackets) and, at the end, the verdict (approve, approve with nits, return) with every comment. Change code only after the verdict.",
  reviewLines: true,
  mcp: true,
  cli: true,
  params: {
    project: PROJECT,
    spec: { kind: "object", only: "mcp", schema: () => ({ ...reviewSchema(), description: "The review: {title, summary, risks, checks, reviewers, chapters, mechanical}." }) },
    specPath: { kind: "path", positional: 0, schema: { type: "string", description: "Path to a review spec file instead of spec; the result is written next to it." } },
    base: { kind: "string", schema: { type: "string", description: "What the change is reviewed against: a branch or a commit. Default: the remote's default branch, else main or master." } },
    head: { kind: "string", schema: { type: "string", description: "The commit reviewed: a branch or a commit. Default HEAD. Uncommitted work is never in a review." } },
    ...PREVIOUS_PARAMS,
    open: { kind: "boolean", negate: "--no-open", schema: { type: "boolean", description: "Open or focus the browser page (default true)." } },
  },
  async run(args, ctx) {
    const project = ctx.project;
    const { raw, specPath } = readSpec(args, project, "the review: {title, summary, chapters}");
    const previous = args.noPrevious ? false : args.previous ?? raw?.previous;
    // What needs no git is checked here, before a server is asked for anything.
    const local = normalizeReview(previous === undefined ? raw : { ...raw, previous });
    if (!local.spec || local.issues.some((i) => i.level === "error")) throw new UserError(`The review spec has errors, nothing was shown:\n${formatIssues(local.issues)}`);
    const outPath = answersPathFor(specPath);
    const server = await ctx.server({ patient: true });
    let posted;
    try {
      posted = await api(server, "/api/rounds", {
        method: "POST",
        body: { project: project.top, spec: raw, previous, outPath, source: basename(specPath), specFile: specPath, open: args.open !== false, mode: "review", base: typeof args.base === "string" ? args.base : "", head: typeof args.head === "string" ? args.head : "" },
        timeoutMs: 60_000,
      });
    } catch (e) {
      // A refusal (a ref git does not know, nothing to review, a spec the diff proves wrong) is for the agent as it is.
      if (e.status >= 400 && e.status < 500 && e.data?.error) throw new UserError(`${e.data.error}${e.data.issues?.length ? `:\n${formatIssues(e.data.issues)}` : ""}\nNothing was shown.`);
      throw e;
    }
    const { review, issues } = posted;
    return {
      text: [
        `Review ${posted.id} «${local.spec.title}» is open for the user: ${posted.url}`,
        review.previousAutomatic ? `Automatically following up on round ${review.previous.round}.` : "",
        `Snapshot: ${snapshotLine(review)}; ${review.sorted} of ${review.total} hunks sorted into chapters and mechanical groups.`,
        issues.length ? `Lint warnings:\n${formatIssues(issues)}` : "",
        `Now ${waitHow(ctx, posted.id)}. A question the user asks on a hunk comes back at once: answer it with ${ctx.cli ? `\`${cliCommand("explain", posted.id, "--question <id> --text …")}\`` : "explain"} and wait again. The verdict comes at the end with every comment. Don't change code and don't end your turn before it.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  },
};
