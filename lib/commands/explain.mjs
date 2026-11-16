// explain — answer the user's question about one question of an open round: text and visuals under it.
// The media are sent as they were given, with the project's working tree as the base of relative paths;
// the server reads every kind and spelling through the media registry, as it does for a question.

import { api } from "../client.mjs";
import { MEDIA_FIELDS } from "../registry/index.mjs";
import { PROJECT, ROUND, UserError, readJsonFile, unknownRound } from "./shared.mjs";

const LISTED = {
  images: { kind: "list", schema: { type: "array", items: { type: "string" }, description: "Image paths (absolute or relative to project) or URLs." } },
  mermaid: { kind: "string", schema: { type: "string", description: "Mermaid diagram source." } },
  code: { kind: "string", schema: { type: "string", description: "Code or diff to show." } },
  compare: { kind: "json", schema: { type: "object", description: "Before/after slider: {before: image, after: image, labels?: [before, after]}.", additionalProperties: true } },
  video: { kind: "any", schema: { description: "A short clip: path or URL of an mp4, webm or gif, or {src, caption}." } },
  diff: { kind: "json", schema: { type: "object", description: "Side-by-side text diff: {before: text, after: text, lang?, labels?}.", additionalProperties: true } },
  table: { kind: "json", schema: { type: "object", description: "Data table: {columns: [...], rows: [[...]], caption?}.", additionalProperties: true } },
  chart: { kind: "json", schema: { type: "object", description: "Simple chart: {type: \"bar\"|\"line\", labels: [...], series: [{name, values}], unit?, title?}.", additionalProperties: true } },
};
// Every other kind and spelling a question takes (html, preview, image, link, links, videos, …): accepted as it
// is, and not listed to the agent, whose tool says what 2.1's did.
const MORE = Object.fromEntries(Object.keys(MEDIA_FIELDS).filter((name) => !(name in LISTED)).map((name) => [name, { kind: "any" }]));

export default {
  name: "explain",
  summary: "answer the user's question about a question of an open round",
  description: "Answer the user's question about one question of an open round. The text (markdown) and visuals appear right under that question on the page.",
  mcp: true,
  cli: true,
  legacyFlag: "--reply",
  legacyValue: "round",
  required: ["round", "question", "text"],
  params: {
    project: PROJECT,
    round: ROUND(),
    question: { kind: "string", schema: { type: "string", description: "Question id the explanation belongs to." } },
    askId: { kind: "string", schema: { type: "string", description: "Id of the user's ask, if wait returned one." } },
    text: { kind: "string", schema: { type: "string", description: "Short, plain explanation. Markdown: lists, tables, > quotes, ### headings." } },
    ...LISTED,
    ...MORE,
    file: { kind: "path", positional: 1, only: "cli" },
  },
  async run(args, ctx) {
    const { round, project: _project, file, ...given } = args;
    // A reply.json is the same fields; what is passed beside it wins.
    const body = file ? { ...readJsonFile(file), ...given } : given;
    if (!round || !body.question) throw new UserError(ctx.cli ? (round ? "--question <id> is required" : "Pass round and question.") : "Pass round and question.");
    if (args.project) void ctx.project;
    const server = await ctx.server();
    const res = await api(server, `/api/rounds/${encodeURIComponent(round)}/explain`, {
      method: "POST",
      body: { ...body, text: body.text || "", ...(ctx.hasProject && { base: ctx.project.top }) },
      timeoutMs: 5000,
    }).catch((e) => {
      throw e.status === 404 ? unknownRound(round) : e;
    });
    if (ctx.cli) return { text: [...(res.warnings || []).map((w) => `decide: warn ${w}`), `decide: explanation posted to question ${body.question}`].join("\n") };
    const warn = res.warnings?.length ? `\nWarnings: ${res.warnings.join("; ")}` : "";
    return { text: `Explanation shown under question ${body.question}.${warn}\nCall wait again for the user's answers.` };
  },
};
