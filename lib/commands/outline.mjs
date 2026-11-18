import { constants, statSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { outline, outlineText } from "../review/outline.mjs";
import { worktreeTop } from "../project.mjs";
import { checkExportTarget } from "../export.mjs";
import { PREVIOUS_PARAMS } from "../registry/index.mjs";
import { PROJECT, UserError, projectDirOf } from "./shared.mjs";

const string = (description) => ({ kind: "string", schema: { type: "string", description } });
const boolean = (description) => ({ kind: "boolean", schema: { type: "boolean", description } });

export default {
  name: "outline",
  summary: "list review pieces and prepare a spec skeleton",
  description: "Read the committed review snapshot with line numbers and a spec skeleton. Regroup by meaning: a chapter is an idea, not a directory. Use --previous <round> or --no-previous to choose the range. Opens nothing and writes only with out. place returns an exact {at, text} key place.",
  cli: true,
  mcp: true,
  params: {
    project: PROJECT,
    base: string("Base ref, with the same default as review."),
    head: string("Head ref, default HEAD."),
    ...PREVIOUS_PARAMS,
    place: string("path:from-to in the new file: return the ready {at, text} object."),
    json: { ...boolean("Print the complete structured outline."), only: "cli" },
    out: string("Write the skeleton spec to this file inside the project."),
    force: boolean("Overwrite an existing output file."),
    outside: boolean("Allow out outside the project."),
  },
  async run(args, ctx) {
    // ctx.project creates a decide data directory. Preparation needs only the working tree.
    const dir = projectDirOf(args.project || ctx.noticeProject);
    if (!dir || !isAbsolute(dir)) throw new UserError("Pass project: an existing absolute project directory.");
    try { if (!statSync(dir).isDirectory()) throw new Error("not a directory"); }
    catch { throw new UserError(`project must be an existing directory: ${dir}`); }
    const top = worktreeTop(dir);
    const file = args.out ? resolve(top, args.out) : "";
    const previous = args.noPrevious ? false : args.previous;
    const result = await outline({ top, base: args.base, head: args.head, previous, specFile: file, place: args.place });
    if (file) {
      checkExportTarget(file, { top }, Boolean(args.outside));
      // A dangling output symlink cannot be resolved by the containment check. Refuse it at open too.
      try { writeFileSync(file, JSON.stringify(result.skeleton, null, 2) + "\n", { flag: args.force ? constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW : "wx", mode: 0o600 }); }
      catch (e) {
        if (e.code === "ELOOP") throw new UserError(`Refusing to overwrite a symlink: ${file}`);
        if (e.code === "EEXIST") throw new UserError(`${file} already exists; pass --force to overwrite it.`);
        throw e;
      }
    }
    return { text: args.json ? JSON.stringify(result) : outlineText(result), structuredContent: result };
  },
};
