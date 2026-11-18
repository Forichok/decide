// lint — check a spec or a deck without showing it: what is wrong with it, and what is only odd. A spec
// handed in now is read strictly: a name nobody reads is an error.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatIssues, prepareDeck, prepareSpec } from "../prepare.mjs";
import { levelIssues, readEffective, readLevel } from "../settings.mjs";
import { requirementLine, reviewerIssues, reviewerRequirement } from "../review/reviewers.mjs";
import { normalizeReview } from "../review/spec.mjs";
import { prepareReview } from "../review/snapshot.mjs";
import { takeReviewSnapshot } from "../review/followup.mjs";
import { PREVIOUS_PARAMS } from "../registry/index.mjs";
import { PROJECT, UserError } from "./shared.mjs";

// A review spec is checked in two steps: its own shape, then against the diff it would be shown on
// (base and head as review takes them), so "7 hunks in no chapter" is said before anything opens.
async function lintReview(raw, { top, dataDir, base, head, previous, specFile }) {
  const { spec, issues } = normalizeReview(previous === undefined ? raw : { ...raw, previous });
  if (!spec || issues.some((i) => i.level === "error")) return { issues };
  try {
    const snapshot = await takeReviewSnapshot({ top, dataDir, base, head, previous: spec.previous, specFile });
    const built = prepareReview(spec, snapshot);
    const settings = readEffective(dataDir).reviewers.value;
    const requirement = reviewerRequirement({ stats: snapshot.meta.stats, paths: built.paths, settings, spec });
    return { requirement, snapshot: snapshot.meta, issues: [...issues, ...snapshot.issues, ...built.issues, ...reviewerIssues(spec, requirement)] };
  } catch (e) {
    if (!e.user) throw e;
    return { issues: [...issues, { level: "error", where: "snapshot", message: e.message }] };
  }
}

export default {
  name: "lint",
  summary: "check a spec file without showing it",
  description: "Check a questions spec, a swipe deck or a review spec without showing it: errors that would stop ask, swipe or review, and warnings about what would be shown oddly. A review spec is also laid on the diff (base and head as for review), so hunks in no chapter are named. Use --previous <round> or --no-previous for a review spec. Nothing is opened and no server is started.",
  mcp: true,
  cli: true,
  legacyFlag: "--lint",
  legacyValue: "specPath",
  params: {
    project: PROJECT,
    specPath: { kind: "path", positional: 0, schema: { type: "string", description: "Path to a *.questions.json (or a deck file)." } },
    spec: { kind: "object", only: "mcp", schema: { type: "object", description: "Or the spec itself, as for ask, swipe or review.", additionalProperties: true } },
    base: { kind: "string", schema: { type: "string", description: "For a review spec: what the change is reviewed against, as for review." } },
    ...PREVIOUS_PARAMS,
    head: { kind: "string", schema: { type: "string", description: "For a review spec: the commit reviewed, as for review." } },
  },
  async run(args, ctx) {
    const project = ctx.project;
    let raw, specDir, specFile;
    if (args.specPath) {
      const file = resolve(project.top, args.specPath);
      try {
        raw = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        throw ctx.cli ? new Error(`cannot read ${file}: ${e.message}`) : new UserError(`Cannot read ${file}: ${e.message}`);
      }
      specDir = dirname(file);
      specFile = file;
    } else if (args.spec && typeof args.spec === "object") {
      raw = args.spec;
      specDir = project.top;
    } else throw new UserError("Pass specPath (a spec file) or spec.");
    // A review has chapters instead of questions.
    if (Array.isArray(raw?.chapters) && !raw.questions && !raw.cards) {
      const previous = args.noPrevious ? false : args.previous;
      const { issues, requirement, snapshot } = await lintReview(raw, { ...project, base: args.base, head: args.head, previous, specFile });
      const errors = issues.filter((i) => i.level === "error");
      const lines = [...(snapshot?.previous ? [`decide lint: following up on round ${snapshot.previous.round}`] : []), ...(requirement ? [`decide lint: ${requirementLine(requirement)}`] : []), ...(issues.length ? [formatIssues(issues).replace(/^/gm, "decide lint: ")] : []), errors.length ? `decide lint: ${errors.length} errors` : "decide lint: ok"];
      return { text: lines.join("\n"), exit: errors.length ? 1 : 0 };
    }
    // A swipe deck has cards instead of questions.
    const prepare = Array.isArray(raw?.cards) && !raw.questions ? prepareDeck : prepareSpec;
    const { issues, errors } = await prepare(raw, { specDir, dataDir: project.dataDir, shots: false });
    if (prepare === prepareSpec) issues.push(...levelIssues(raw, readLevel(project.dataDir)));
    const lines = [...(issues.length ? [formatIssues(issues).replace(/^/gm, "decide lint: ")] : []), errors.length ? `decide lint: ${errors.length} errors` : "decide lint: ok"];
    return { text: lines.join("\n"), exit: errors.length ? 1 : 0 };
  },
};
