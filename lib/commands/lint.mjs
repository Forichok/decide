// lint — check a spec or a deck without showing it: what is wrong with it, and what is only odd. A spec
// handed in now is read strictly: a name nobody reads is an error.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatIssues, prepareDeck, prepareSpec } from "../prepare.mjs";
import { levelIssues, readLevel } from "../settings.mjs";
import { normalizeReview } from "../review/spec.mjs";
import { buildReview, takeSnapshot } from "../review/snapshot.mjs";
import { PROJECT, UserError } from "./shared.mjs";

// A review spec is checked in two steps: its own shape, then against the diff it would be shown on
// (base and head as review takes them), so "7 hunks in no chapter" is said before anything opens.
async function lintReview(raw, { top, base, head }) {
  const { spec, issues } = normalizeReview(raw);
  if (!spec || issues.some((i) => i.level === "error")) return issues;
  try {
    const snapshot = await takeSnapshot({ top, base: base || "", head: head || "" });
    return [...issues, ...snapshot.issues, ...buildReview(spec, snapshot.patch).issues];
  } catch (e) {
    if (!e.user) throw e;
    return [...issues, { level: "error", where: "snapshot", message: e.message }];
  }
}

export default {
  name: "lint",
  summary: "check a spec file without showing it",
  description: "Check a questions spec, a swipe deck or a review spec without showing it: errors that would stop ask, swipe or review, and warnings about what would be shown oddly. A review spec is also laid on the diff (base and head as for review), so hunks in no chapter are named. Nothing is opened and no server is started.",
  mcp: true,
  cli: true,
  legacyFlag: "--lint",
  legacyValue: "specPath",
  params: {
    project: PROJECT,
    specPath: { kind: "path", positional: 0, schema: { type: "string", description: "Path to a *.questions.json (or a deck file)." } },
    spec: { kind: "object", only: "mcp", schema: { type: "object", description: "Or the spec itself, as for ask, swipe or review.", additionalProperties: true } },
    base: { kind: "string", schema: { type: "string", description: "For a review spec: what the change is reviewed against, as for review." } },
    head: { kind: "string", schema: { type: "string", description: "For a review spec: the commit reviewed, as for review." } },
  },
  async run(args, ctx) {
    const project = ctx.project;
    let raw, specDir;
    if (args.specPath) {
      const file = resolve(project.top, args.specPath);
      try {
        raw = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        throw ctx.cli ? new Error(`cannot read ${file}: ${e.message}`) : new UserError(`Cannot read ${file}: ${e.message}`);
      }
      specDir = dirname(file);
    } else if (args.spec && typeof args.spec === "object") {
      raw = args.spec;
      specDir = project.top;
    } else throw new UserError("Pass specPath (a spec file) or spec.");
    // A review has chapters instead of questions.
    if (Array.isArray(raw?.chapters) && !raw.questions && !raw.cards) {
      const issues = await lintReview(raw, { top: project.top, base: args.base, head: args.head });
      const errors = issues.filter((i) => i.level === "error");
      const lines = [...(issues.length ? [formatIssues(issues).replace(/^/gm, "decide lint: ")] : []), errors.length ? `decide lint: ${errors.length} error(s)` : "decide lint: ok"];
      return { text: lines.join("\n"), exit: errors.length ? 1 : 0 };
    }
    // A swipe deck has cards instead of questions.
    const prepare = Array.isArray(raw?.cards) && !raw.questions ? prepareDeck : prepareSpec;
    const { issues, errors } = await prepare(raw, { specDir, dataDir: project.dataDir, shots: false });
    if (prepare === prepareSpec) issues.push(...levelIssues(raw, readLevel(project.dataDir)));
    const lines = [...(issues.length ? [formatIssues(issues).replace(/^/gm, "decide lint: ")] : []), errors.length ? `decide lint: ${errors.length} error(s)` : "decide lint: ok"];
    return { text: lines.join("\n"), exit: errors.length ? 1 : 0 };
  },
};
