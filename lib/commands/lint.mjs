// lint — check a spec or a deck without showing it: what is wrong with it, and what is only odd. A spec
// handed in now is read strictly: a name nobody reads is an error.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatIssues, prepareDeck, prepareSpec } from "../prepare.mjs";
import { levelIssues, readLevel } from "../settings.mjs";
import { PROJECT, UserError } from "./shared.mjs";

export default {
  name: "lint",
  summary: "check a spec file without showing it",
  description: "Check a questions spec or a swipe deck without showing it: errors that would stop ask or swipe, and warnings about what would be shown oddly. Nothing is opened and no server is started.",
  mcp: true,
  cli: true,
  legacyFlag: "--lint",
  legacyValue: "specPath",
  params: {
    project: PROJECT,
    specPath: { kind: "path", positional: 0, schema: { type: "string", description: "Path to a *.questions.json (or a deck file)." } },
    spec: { kind: "object", only: "mcp", schema: { type: "object", description: "Or the spec itself, as for ask or swipe.", additionalProperties: true } },
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
    // A swipe deck has cards instead of questions.
    const prepare = Array.isArray(raw?.cards) && !raw.questions ? prepareDeck : prepareSpec;
    const { issues, errors } = await prepare(raw, { specDir, dataDir: project.dataDir, shots: false });
    if (prepare === prepareSpec) issues.push(...levelIssues(raw, readLevel(project.dataDir)));
    const lines = [...(issues.length ? [formatIssues(issues).replace(/^/gm, "decide lint: ")] : []), errors.length ? `decide lint: ${errors.length} error(s)` : "decide lint: ok"];
    return { text: lines.join("\n"), exit: errors.length ? 1 : 0 };
  },
};
