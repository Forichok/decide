// prepare.mjs — shared by the CLI and the MCP server: turn a raw spec into a
// lint-checked round (capturing "shot" images first), name its files, and
// format what the agent reads back.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeSpec } from "./spec.mjs";
import { resolveShots } from "./shot.mjs";
import { slugify, stamp } from "./project.mjs";

export async function prepareSpec(raw, { specDir, dataDir, shots = true }) {
  const shotIssues = shots ? await resolveShots(raw, { dir: join(dataDir, "shots") }) : [];
  const { spec, issues } = normalizeSpec(raw, { specDir });
  const all = [...shotIssues, ...issues];
  return { spec, issues: all, errors: all.filter((i) => i.level === "error") };
}

// feature.questions.json → feature.answers.json
export const answersPathFor = (specPath) => specPath.replace(/(\.questions)?\.json$/i, "") + ".answers.json";

// An inline spec (MCP) is saved under the project data dir, so it has files like a CLI round.
export function saveInlineSpec(dataDir, raw) {
  const specPath = join(dataDir, "rounds", `${stamp()}-${slugify(raw?.title)}.questions.json`);
  mkdirSync(dirname(specPath), { recursive: true });
  writeFileSync(specPath, JSON.stringify(raw, null, 2));
  return specPath;
}

export const formatIssues = (issues) => issues.map((i) => `${i.level === "error" ? "ERROR" : "warn "} ${i.where}: ${i.message}`).join("\n");

export function formatResult(result, outPath) {
  if (result.cancelled) return `The user cancelled round «${result.title}». Ask in chat how to continue.\nAnswers file: ${outPath}`;
  const n = Object.keys(result.answers || {}).length;
  return [`Round «${result.title}» answered (${n} answer${n === 1 ? "" : "s"}).`, result.digest || "(no answers)", `Full JSON: ${outPath}`].join("\n\n");
}

export function formatAsk(event, how = "with the explain tool (question, text; images/mermaid/code optional), then call wait again") {
  const { ask } = event;
  return [
    `The user asks about question [${ask.question}] «${ask.title}» in round ${event.round}:`,
    ask.text ? `> ${ask.text.replace(/\n/g, "\n> ")}` : "> (no text — explain this question in more detail)",
    `Answer on the page ${how}.`,
  ].join("\n");
}
