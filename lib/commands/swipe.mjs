// swipe — start a swipe interview: a deck of two-sided cards. Returns at once; then wait and push.

import { basename } from "node:path";
import { api } from "../client.mjs";
import { formatOverlaps, overlaps } from "../journal.mjs";
import { answersPathFor, formatIssues, prepareDeck } from "../prepare.mjs";
import { deckSchema } from "../registry/docs.mjs";
import { PROJECT, UserError, readSpec } from "./shared.mjs";

export default {
  name: "swipe",
  summary: "start a swipe interview (a deck of two-answer cards)",
  description:
    "Start a swipe interview: a deck of cards, each a simple question with exactly two answers (left / right), answered with the arrow keys (or with the user's own typed answer when neither fits), with the brief growing beside the deck. Pass spec {title, goal, cards: [{id, title, left: {label}, right: {label}, recommended?: \"left\"|\"right\"}], brief?, confidence?, batch?} or specPath. Then call wait: it returns batches of answers; answer each with push. At the end the user may add a note, or press \"Dig deeper\": wait then returns that event and you push a stricter round of cards.",
  deckLines: true,
  mcp: true,
  cli: true,
  params: {
    project: PROJECT,
    spec: {
      kind: "object",
      only: "mcp",
      schema: () => ({
        ...deckSchema(),
        description:
          "The deck: {title, goal, cards: [{id, title, tldr?, body?, left, right, recommended?, reason?, from?, images?, compare?, video?, diff?, table?, chart?, mermaid?, preview?, code?}], brief?, confidence?, batch?}. Each side may carry the same media.",
      }),
    },
    specPath: { kind: "path", positional: 0, schema: { type: "string", description: "Path to a deck file instead of spec; answers and the brief are written next to it." } },
    open: { kind: "boolean", negate: "--no-open", schema: { type: "boolean", description: "Open or focus the browser page (default true)." } },
  },
  async run(args, ctx) {
    const project = ctx.project;
    const { raw, specPath, specDir } = readSpec(args, project, "the deck: {title, goal, cards}");
    const { deck, issues, errors } = await prepareDeck(raw, { specDir, dataDir: project.dataDir });
    if (errors.length) throw new UserError(`The deck has errors, nothing was shown:\n${formatIssues(issues)}`);
    const outPath = answersPathFor(specPath);
    const server = await ctx.server({ patient: true });
    const posted = await api(server, "/api/rounds", {
      method: "POST",
      body: { project: project.top, spec: deck, outPath, source: basename(specPath), specFile: specPath, open: args.open !== false, mode: "swipe" },
      timeoutMs: 5000,
    });
    return {
      text: [
        `Swipe round ${posted.id} «${deck.title}» is open for the user with ${deck.cards.length} cards: ${posted.url}`,
        issues.length ? `Lint warnings:\n${formatIssues(issues)}` : "",
        formatOverlaps(overlaps(project, deck.cards.map((c) => c.title))),
        `Now call wait with round "${posted.id}". Every ${deck.batch} answers it returns a batch: rewrite the brief and add, replace or remove cards with push, then wait again. Don't end your turn in between.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  },
};
