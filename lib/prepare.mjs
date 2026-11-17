// prepare.mjs — shared by the CLI and the MCP server: turn a raw spec into a
// lint-checked round (capturing "shot" images first), name its files, and
// format what the agent reads back.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeSpec } from "./spec.mjs";
import { LOW_WATER, normalizeDeck, normalizePatch } from "./swipe.mjs";
import { resolveShots } from "./shot.mjs";
import { slugify, stamp } from "./project.mjs";
import { formatReviewResult } from "./review/digest.mjs";

// fields: "strict" for a spec an agent hands in now, "lenient" for one read back (see normalizeSpec).
export async function prepareSpec(raw, { specDir, dataDir, shots = true, fields = "strict" }) {
  const shotIssues = shots ? await resolveShots(raw, { dir: join(dataDir, "shots") }) : [];
  const { spec, issues } = normalizeSpec(raw, { specDir, fields });
  const all = [...shotIssues, ...issues];
  return { spec, issues: all, errors: all.filter((i) => i.level === "error") };
}

// Shots on a card or either side are captured like shots on a question or option.
export async function prepareDeck(raw, { specDir, dataDir, shots = true, fields = "strict" }) {
  const cards = Array.isArray(raw?.cards) ? raw.cards : [];
  const nodes = { lang: raw?.lang, questions: cards.map((c) => ({ options: [c, c?.left, c?.right].filter((n) => n && typeof n === "object") })) };
  const shotIssues = shots ? await resolveShots(nodes, { dir: join(dataDir, "shots") }) : [];
  const { deck, issues } = normalizeDeck(raw, { specDir, fields });
  const all = [...shotIssues, ...issues];
  return { deck, issues: all, errors: all.filter((i) => i.level === "error") };
}

// A push: new and rewritten cards get their shots captured too.
export async function preparePatch(raw, { specDir, dataDir, lang, shots = true }) {
  const cards = [...(Array.isArray(raw?.add) ? raw.add : []), ...(Array.isArray(raw?.replace) ? raw.replace : [])];
  const nodes = { lang, questions: cards.map((c) => ({ options: [c, c?.left, c?.right].filter((n) => n && typeof n === "object") })) };
  const shotIssues = shots && cards.length ? await resolveShots(nodes, { dir: join(dataDir, "shots") }) : [];
  const { patch, issues } = normalizePatch(raw, { specDir, lang });
  const all = [...shotIssues, ...issues];
  return { patch, issues: all, errors: all.filter((i) => i.level === "error") };
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
  const text = formatResultText(result, result.answersFile || result.file || outPath);
  return result.copyFile ? text.replace(/Full JSON: [^\n]*/, (line) => `${line}\nConvenience copy: ${result.copyFile} (the next round of the same spec overwrites it).`) : text;
}

function formatResultText(result, outPath) {
  if (result.dismissed || result.status === "dismissed") return formatDismissed(result);
  if (result.cancelled) return [`The user cancelled round «${result.title}». Ask in chat how to continue.\nAnswers file: ${outPath}`, result.digest].filter(Boolean).join("\n\n");
  if (result.mode === "swipe") return formatSwipeResult(result, outPath);
  if (result.mode === "review") return formatReviewResult(result, outPath);
  const n = Object.keys(result.answers || {}).length;
  return [`Round «${result.title}» answered (${n} answer${n === 1 ? "" : "s"})${result.name ? ` by ${result.name}` : ""}${result.importedFrom ? `, imported from ${result.importedFrom}` : ""}.`, result.digest || "(no answers)", `Full JSON: ${outPath}`].join("\n\n");
}

// The user closed the round without sending it: one line saying so, then what they had answered.
function formatDismissed(result) {
  return [`The user dismissed round «${result.title}» without sending it. Ask in chat how to continue; this is what they had answered:`, result.digest || "(no answers)"].join("\n\n");
}

export function formatAsk(event, how = "with the explain tool (question, text; images/mermaid/code optional), then call wait again") {
  const { ask } = event;
  // A review round: the question is about a piece of the diff, and names its line when it has one.
  const place = ask.file ? `${ask.file}${Number.isInteger(ask.line) ? `:${ask.line}${ask.side === "old" ? " (old side)" : ""}` : ""}` : "";
  return [
    place ? `The reviewer asks about ${place} [${ask.question}] in review ${event.round}:` : `The user asks about question [${ask.question}] «${ask.title}» in round ${event.round}:`,
    place && typeof ask.code === "string" && ask.code.trim() ? `    ${ask.side === "old" ? "-" : "+"} ${ask.code.trim()}` : "",
    ask.text ? `> ${ask.text.replace(/\n/g, "\n> ")}` : "> (no text — explain this question in more detail)",
    `Answer on the page ${how}.`,
  ].filter(Boolean).join("\n");
}

export function formatMessage(event, how = "with explain") {
  const { message } = event;
  return [
    `The user writes about the whole ${event.mode || "questions"} round ${event.round}:`,
    `> ${String(message.text).replace(/\n/g, "\n> ")}`,
    `Reply in the round dialog ${how}: round: "${event.round}", no question, askId: "${message.id}", text (markdown). You may attach any explain media (images, mermaid, code, diff, compare, table, chart, html, video, links).`,
    event.mode === "review"
      ? "For a request to redo something, do it at once in the working tree, then reply with what changed and that it will be in the next review round."
      : "For a request to redo something, do it at once with the existing patch or push tools, then reply with what changed.",
    "For a complaint or doubt, reply with a proposal and ask whether to settle it here in the dialog or as a card/question in the round; then do what the user picks.",
    'You can ask a two-button question in your reply: choice: {text: "Settle it where?", options: ["Here in the dialog", "As a card/question"]}. The pick arrives as a new message. You may also write first with explain (round, text, no question or askId). Then call wait again.',
    event.mode === "review" ? 'This review page is a commit snapshot and never changes under the reader. Do the requested work in the working tree, then say what you did and that it will be in the next review round. Never claim this page changed.' : '',
  ].filter(Boolean).join("\n\n");
}

export function formatRequest(event) {
  const { request } = event;
  return [
    `The user pressed "None, suggest others" on question [${request.qid}] «${request.title}» in round ${event.round}: none of the options fits.`,
    request.note ? `> ${request.note.replace(/\n/g, "\n> ")}` : "",
    "Reply with explain (question, text, and a patch with the options you suggest instead), then call wait again.",
  ].filter(Boolean).join("\n");
}

// K8: the user described a change to a tune question in words ("make it calmer").
export function formatWords(event, how = "with explain (question, text, and a patch whose ops hold the knobs op), or with the patch tool") {
  const { words } = event;
  const values = Object.entries(words.values ?? {}).map(([id, v]) => `${id} ${JSON.stringify(v)}`).join(", ");
  const example = JSON.stringify({ knobs: { question: words.qid, values: Object.fromEntries(Object.entries(words.values ?? {}).slice(0, 1)) } });
  return [
    `The user asks in words to change the knobs of question [${words.qid}] «${words.title}» in round ${event.round}:`,
    `> ${String(words.text).replace(/\n/g, "\n> ")}`,
    values ? `Knob values now: ${values}.` : "",
    `Answer ${how}: say in a sentence what you changed, and send a knobs op that moves the knobs (values) and/or swaps the mockup for a new html file (preview), e.g. ${example} with a reason. The page keeps the user's values before as a snapshot. Then call wait again.`,
  ].filter(Boolean).join("\n");
}

export function formatBatch(event) {
  if (event.live) {
    const n = Object.keys(event.answers ?? {}).length;
    return [
      `Batch ${event.batch} from round ${event.round}: ${n} new answer${n === 1 ? "" : "s"}; ${event.answered} of ${event.total} questions have one so far.`,
      event.digest,
      "The round is still open. You may patch the questions ahead with explain (a patch to a card the user has not reached), then call wait again.",
    ].join("\n\n");
  }
  const { stats } = event;
  return [
    `Batch ${event.batch} from swipe round ${event.round}: ${event.entries.length} new answer${event.entries.length === 1 ? "" : "s"}; ${stats.answered} answered, ${stats.left} left in the deck of ${stats.total}.`,
    event.digest,
    event.entries.some((e) => e.side === "own")
      ? "An own answer means neither side fit. Take it at its word in the brief; if it is unclear or opens new forks, add a follow-up card with from set to that card."
      : "",
    event.done
      ? "You already marked the interview done; the user is answering what is left. Push only if an answer changes the brief, then call wait again."
      : !stats.left
      ? "The deck is empty and the user is waiting for you. Push new cards now — or, if nothing important is open, push the final brief with done: true. Then call wait again."
      : stats.left <= LOW_WATER
        ? `Only ${stats.left} card${stats.left === 1 ? "" : "s"} left: the user runs out soon. Push follow-ups now (position "next" puts them right behind the card on screen) with the rewritten brief — or done: true if nothing important is open. Then call wait again.`
        : "The user keeps answering the rest. Now push: rewrite the brief, set confidence, add follow-up cards, replace or remove open cards that these answers made wrong or moot. Then call wait again.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// The user pressed "Dig deeper": the deck is open again and waits for a stricter round.
export function formatDeeper(event) {
  const { stats } = event;
  return [
    `The user asked to dig deeper in swipe round ${event.round} (time ${event.deeper}): ${stats.answered} answered so far, ${stats.left} open cards left. The deck is open again and the page shows you preparing harder questions.`,
    event.note ? `What they want you to dig into:\n> ${event.note.replace(/\n/g, "\n> ")}` : "",
    event.digest ? `Answers you had not seen yet:\n${event.digest}` : "",
    [
      "Push a stricter round now: 8–15 new yes/no cards with position \"next\", each one about a single thing.",
      "Go after what is still soft: assumptions the answers rest on, edge cases and failure modes, limits and numbers, who else is affected, what is out of scope, answers given against your recommendation, cards the user skipped, own answers that open new forks, and places where two answers pull against each other.",
      "Lower confidence if the answers left more open than you thought. Rewrite the brief in the same push, then call wait again.",
    ].join(" "),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatSwipeResult(result, outPath) {
  const { stats } = result;
  return [
    `Swipe round «${result.title}» finished by the ${result.stoppedBy}: ${stats.answered} of ${stats.total} cards answered (${stats.skipped} skipped), confidence ${result.confidence}%.`,
    result.digest || "(no answers)",
    result.unread ? `Answers you had not seen in a batch yet:\n${result.unread}` : "",
    result.note ? `The user's closing note:\n> ${result.note.replace(/\n/g, "\n> ")}` : "",
    `Brief (markdown): ${result.briefFile}\nFull JSON: ${outPath}`,
    "Show the user the brief and ask whether to start the work.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
