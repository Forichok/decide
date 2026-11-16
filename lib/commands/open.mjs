// open — open the decide page (a round's, or the home's) in the browser, starting the server if need be.

import { api } from "../client.mjs";
import { openBrowser } from "../open.mjs";
import { PROJECT, unknownRound } from "./shared.mjs";

export default {
  name: "open",
  summary: "open the decide page in the browser",
  mcp: false,
  cli: true,
  params: {
    project: PROJECT,
    round: { kind: "string", positional: 0 },
  },
  async run(args, ctx) {
    const server = await ctx.server({ patient: true });
    if (args.round) {
      await api(server, `/api/rounds/${encodeURIComponent(args.round)}`).catch((e) => {
        throw e.status === 404 ? unknownRound(args.round) : e;
      });
    }
    const url = `http://127.0.0.1:${server.port}/${args.round ? `#r=${encodeURIComponent(args.round)}` : ""}`;
    // DECIDE_NOTIFY=0 keeps the browser shut, as it keeps the notifications off (tests, CI).
    if (process.env.DECIDE_NOTIFY !== "0") (ctx.openUrl ?? openBrowser)(url);
    return { text: `decide: the page is at ${url}` };
  },
};
