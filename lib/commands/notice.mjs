// notice — the answers the user sent that no agent has collected, as one line per round. It reads the disk
// only: no server, nothing created, nothing fails (a session-start hook runs it).

import { resolve } from "node:path";
import { noticeFor } from "../store/scan.mjs";
import { PROJECT } from "./shared.mjs";

export default {
  name: "notice",
  summary: "answers the user sent that no agent has collected",
  mcp: false,
  cli: true,
  params: { project: PROJECT },
  run(args, ctx) {
    try {
      return { text: noticeFor(resolve(ctx.noticeDir || args.project || process.cwd())) || "" };
    } catch {
      return { text: "" };
    }
  },
};
