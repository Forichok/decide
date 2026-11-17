// index.mjs — the one table of commands behind the MCP tools (mcp.mjs) and the CLI (decide.mjs).
//
// CommandDef = { name, summary, description?, params, mcp, cli, legacyFlag?, legacyValue?, required?, run(args, ctx) }
//   params: name → { kind, schema?, positional?, flags?, negate?, selects?, only?: "mcp" | "cli" }
//     schema is the parameter's JSON Schema in tools/list (a function when it is built from the registry when
//     asked); a parameter without one is accepted but not listed. kind tells the CLI how to read the flag.
//   legacyFlag: the 2.1 flag that picks the command (legacyValue: the param its value fills)
//   run(args, ctx) → { text, content?, exit?, delivered?, collects? }

import { noticeFor } from "../store/scan.mjs";
import { nearest } from "../registry/strict.mjs";
import { deckLines, reviewLines, typeLines } from "../registry/docs.mjs";
import ask from "./ask.mjs";
import swipe from "./swipe.mjs";
import review from "./review.mjs";
import outline from "./outline.mjs";
import wait from "./wait.mjs";
import push from "./push.mjs";
import explain from "./explain.mjs";
import screenshot from "./screenshot.mjs";
import history from "./history.mjs";
import supersede from "./supersede.mjs";
import adr from "./adr.mjs";
import exportCommand from "./export.mjs";
import importCommand from "./import.mjs";
import lint from "./lint.mjs";
import stop from "./stop.mjs";
import open from "./open.mjs";
import notice from "./notice.mjs";
import rules from "./rules.mjs";
import patchCommand from "./patch.mjs";

import { UserError, projectDirOf } from "./shared.mjs";
export { EXIT_ASK, UserError, contextFor } from "./shared.mjs";

export const COMMANDS = [ask, swipe, wait, push, explain, screenshot, history, supersede, adr, exportCommand, importCommand, lint, stop, open, notice, rules, patchCommand, review, outline];

const schemaOf = (param) => (typeof param.schema === "function" ? param.schema() : param.schema);

// tools/list, built from the table when asked: a schema that comes from the registry is never a copy.
export function toolList() {
  return COMMANDS.filter((c) => c.mcp).map((def) => {
    const properties = {};
    const defs = {};
    for (const [name, param] of Object.entries(def.params)) {
      if (param.only === "cli" || !param.schema) continue;
      // A $ref in a schema looks for its $defs at the root of the tool's schema.
      const { $defs, ...schema } = schemaOf(param);
      Object.assign(defs, $defs);
      properties[name] = schema;
    }
    return {
      name: def.name,
      description: def.typeLines ? `${def.description}\n\n${typeLines()}` : def.deckLines ? `${def.description}\n\n${deckLines()}` : def.reviewLines ? `${def.description}\n\n${reviewLines()}` : def.description,
      inputSchema: { type: "object", properties, ...(def.required && { required: def.required }), ...(Object.keys(defs).length && { $defs: defs }) },
    };
  });
}

// An argument no command reads is an error that names the nearest one. 2.1 ignored them; the ones it read
// and no longer lists (import's file, explain's links and the other media spellings) are still params.
function checkArguments(def, args) {
  const known = Object.entries(def.params).filter(([, p]) => p.only !== "cli").map(([name]) => name);
  for (const key of Object.keys(args)) {
    if (known.includes(key)) continue;
    const near = nearest(key, known);
    throw new UserError(`Unknown argument "${key}" for ${def.name}${near ? `; did you mean "${near}"?` : ""}`);
  }
}

// Answers nobody collected, as the first lines of a result. skip: the round whose answers this very result
// carries (wait, import).
function noticeOf(def, args, ctx, skip) {
  if (def.name === "notice") return "";
  // The project the command itself would use: the one named, else Claude Code's, else the working directory.
  return noticeFor(ctx.noticeProject ?? projectDirOf(typeof args?.project === "string" && args.project ? args.project : undefined) ?? undefined, { skip, cli: ctx.cli });
}

const prefixed = (line, out) => {
  if (!line) return out;
  if (out.content) return { ...out, content: [{ type: "text", text: line }, ...out.content] };
  return { ...out, text: out.text ? `${line}\n\n${out.text}` : line };
};

// Runs a command: unknown arguments are refused, the notice goes first. The CLI says it before the command
// runs (a command that waits has printed its first line by then); an agent's result carries it.
export async function runCommand(name, args, ctx) {
  const def = COMMANDS.find((c) => c.name === name);
  if (!def) throw new UserError(`Unknown command ${name}`);
  args ||= {};
  if (!ctx.cli) checkArguments(def, args);
  if (ctx.cli) {
    // On stderr: the output of the command stays the command's own.
    const line = noticeOf(def, args, ctx, ["wait", "import"].includes(name) && args.round ? String(args.round) : undefined);
    if (line) ctx.warn(line);
  }
  let out = await def.run(args, ctx);
  if (typeof out === "string") out = { text: out };
  if (ctx.cli) return out;
  return prefixed(noticeOf(def, args, ctx, out.delivered ? out.collects ?? (name === "wait" ? String(args.round) : undefined) : undefined), out);
}
