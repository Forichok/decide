// rules — the user's "don't ask again" / "always ask me" rules and the level of how much to ask.

import { LEVELS, RULE_MODES, addRule, readLevel, readRules, removeRule, rulesLine, writeLevel } from "../settings.mjs";
import { PROJECT, UserError } from "./shared.mjs";

export default {
  name: "rules",
  summary: "list, add or remove the rules about what to ask",
  description: "The rules the user made about what to ask (\"don't ask about this again\", \"always ask me\") and the project's level of asking. action: list (default), add (text, mode), remove (id), level (level).",
  mcp: true,
  cli: true,
  params: {
    project: PROJECT,
    action: { kind: "string", positional: 0, schema: { type: "string", enum: ["list", "add", "remove", "level"], description: "Default list." } },
    text: { kind: "string", schema: { type: "string", description: "add: the rule in words." } },
    mode: { kind: "string", schema: { type: "string", enum: RULE_MODES, description: "add: never (decide it yourself) or always (ask me). Default never." } },
    id: { kind: "string", schema: { type: "string", description: "remove: the rule id." } },
    level: { kind: "string", schema: { type: "string", enum: LEVELS, description: "level: everything, irreversible or mine." } },
  },
  run(args, ctx) {
    const dir = ctx.project.dataDir;
    const action = args.action || "list";
    try {
      if (action === "add") return { text: `Added: ${rulesLine(addRule(dir, { text: args.text, mode: args.mode || "never" }))}` };
      if (action === "remove") {
        removeRule(dir, String(args.id || ""));
        return { text: `Removed rule ${args.id}.` };
      }
      if (action === "level") return { text: `Level is now "${writeLevel(dir, String(args.level || ""))}".` };
    } catch (e) {
      throw e.user ? new UserError(e.message) : e;
    }
    if (action !== "list") throw new UserError(`Unknown action "${action}": list, add, remove or level.`);
    const rules = readRules(dir);
    return { text: [`Level: ${readLevel(dir)}`, rules.length ? rules.map(rulesLine).join("\n") : "No rules."].join("\n") };
  },
};
