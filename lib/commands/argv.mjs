// argv.mjs — the command line, read through the command table: `decide <command> [--param value …] [file]`,
// and every flag 2.1 had (--wait, --reply, --lint, a bare spec path, …), which still picks its command.
// A flag that 2.1 accepted but a command does not use is accepted and ignored, as it was.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nearest } from "../registry/strict.mjs";
import { COMMANDS } from "./index.mjs";
import { UserError } from "./shared.mjs";

const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const cliCommands = COMMANDS.filter((c) => c.cli);
const byName = new Map(cliCommands.map((c) => [c.name, c]));
// The parameters a command line can fill, in the order the command lists them. project is global.
const paramsOf = (def) => Object.entries(def.params).filter(([name, p]) => name !== "project" && p.only !== "mcp");
const flagsOf = (name, p) => [`--${kebab(name)}`, ...(p.flags || [])];

// Every flag any command knows, and whether it takes a value.
const TABLE = new Map([["--project", { value: true }]]);
for (const def of cliCommands) {
  for (const [name, p] of paramsOf(def)) {
    for (const flag of flagsOf(name, p)) if (!TABLE.has(flag)) TABLE.set(flag, { value: p.kind !== "boolean" });
    if (p.negate) TABLE.set(p.negate, { value: false });
  }
  if (def.legacyFlag && !TABLE.has(def.legacyFlag)) TABLE.set(def.legacyFlag, { value: Boolean(def.legacyValue) });
}

// 2.1 looked for these in this order: the first present picks the command.
const ORDER = ["stop", "lint", "history", "supersede", "export", "import", "adr", "screenshot", "wait", "explain", "ask"];

function jsonOf(text, flag) {
  try {
    return JSON.parse(text.startsWith("@") ? readFileSync(text.slice(1), "utf8") : text);
  } catch (e) {
    throw new UserError(`${flag}: not JSON (${e.message}); pass JSON, or @file.json`);
  }
}

function coerce(kind, text, flag, cwd) {
  if (kind === "path") return resolve(cwd, text);
  if (kind === "number") return Number.isFinite(Number(text)) ? Number(text) : undefined;
  if (kind === "json" || kind === "object") return jsonOf(text, flag);
  if (kind === "any") return /^\s*[[{]/.test(text) ? jsonOf(text, flag) : text;
  return text;
}

function tokenize(tokens) {
  const flags = new Map(); // flag → its values (a flag without a value has none)
  const positionals = [];
  const unknown = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (!t.startsWith("--")) {
      positionals.push(t);
      continue;
    }
    const spec = TABLE.get(t);
    if (!spec) {
      unknown.push(t);
      continue;
    }
    const values = flags.get(t) || [];
    flags.set(t, values);
    const next = tokens[i + 1];
    if (spec.value && next !== undefined && !next.startsWith("--")) {
      values.push(next);
      i++;
    }
  }
  return { flags, positionals, unknown };
}

// { command, args, project }: args as the command's params, paths made absolute against cwd.
export function parseArgv(argv, { cwd = process.cwd() } = {}) {
  // The first word is a command when it is not a flag (and not the value of --project).
  let lead = 0;
  while (argv[lead] === "--project") lead += 2;
  const word = argv[lead] && !argv[lead].startsWith("-") ? argv[lead] : undefined;
  const rest = word === undefined ? argv : [...argv.slice(0, lead), ...argv.slice(lead + 1)];
  const { flags, positionals, unknown } = tokenize(rest);
  const projectText = flags.get("--project")?.[0];
  const project = projectText && resolve(cwd, projectText);

  // The session-start hook runs this: whatever else is on the line, it is the notice command.
  if (word === "notice") return { command: "notice", args: {}, project };

  let def = word ? byName.get(word) : undefined;
  if (!def) {
    for (const name of ORDER) {
      const candidate = byName.get(name);
      const selectors = [...paramsOf(candidate).filter(([, p]) => p.selects).flatMap(([n, p]) => flagsOf(n, p)), ...(candidate.legacyFlag ? [candidate.legacyFlag] : [])];
      if (selectors.some((f) => flags.has(f))) {
        def = candidate;
        break;
      }
    }
  }
  if (!def) {
    // A bare word is a spec file, unless it is a slip for a command name.
    if (word && !/[./\\]/.test(word) && !existsSync(resolve(cwd, word))) {
      const near = nearest(word, [...byName.keys()]);
      if (near) throw new UserError(`unknown command "${word}"; did you mean "${near}"?`);
    }
    def = byName.get("ask");
    if (word) positionals.unshift(word);
  } else if (word && !byName.has(word)) positionals.unshift(word);

  if (unknown.length) {
    const known = [...TABLE.keys()].filter((f) => paramsOf(def).some(([n, p]) => flagsOf(n, p).includes(f) || p.negate === f) || f === "--project").map((f) => f.slice(2));
    const near = nearest(unknown[0].slice(2), known);
    throw new UserError(`unknown option "${unknown[0]}"${near ? `; did you mean "--${near}"?` : ""}`);
  }

  const args = {};
  for (const [name, p] of paramsOf(def)) {
    const names = flagsOf(name, p);
    const present = names.filter((f) => flags.has(f));
    if (p.kind === "boolean") {
      if (present.length) args[name] = true;
      if (p.negate && flags.has(p.negate)) args[name] = false;
      continue;
    }
    const values = present.flatMap((f) => flags.get(f).map((v) => [f, v]));
    if (!values.length) continue;
    const one = (v, f) => coerce(p.kind, v, f, cwd);
    const value = p.kind === "list" || p.kind === "paths" ? values.map(([f, v]) => coerce(p.kind === "paths" ? "path" : "string", v, f, cwd)) : one(values.at(-1)[1], values.at(-1)[0]);
    if (value !== undefined) args[name] = value;
  }
  // `--wait 1-ab`: the value of the flag that picked the command is one of its params.
  if (def.legacyFlag && def.legacyValue && flags.get(def.legacyFlag)?.length) {
    const p = def.params[def.legacyValue];
    args[def.legacyValue] = coerce(p.kind, flags.get(def.legacyFlag)[0], def.legacyFlag, cwd);
  }
  // What is left over fills the positional params no flag filled, in order.
  const slots = paramsOf(def)
    .filter(([name, p]) => p.positional !== undefined && args[name] === undefined)
    .sort(([, a], [, b]) => (a.positional === "rest") - (b.positional === "rest") || a.positional - b.positional);
  const queue = [...positionals];
  for (const [name, p] of slots) {
    if (!queue.length) break;
    if (p.positional === "rest") args[name] = queue.splice(0).map((v) => coerce("path", v, name, cwd));
    else args[name] = coerce(p.kind, queue.shift(), name, cwd);
  }
  if (queue.length && !args.demo) throw new UserError(`unexpected argument "${queue[0]}"`);
  return { command: def.name, args: def.fromArgv ? def.fromArgv(args, { cwd }) : args, project };
}
