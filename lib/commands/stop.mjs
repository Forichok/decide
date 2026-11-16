// stop — stop the decide server of this home. Rounds are on disk; the next call starts a server again.

import { serverOf, silentServer } from "../client.mjs";
import { decideHome } from "../project.mjs";
import { request } from "../request.mjs";
import { PROJECT } from "./shared.mjs";

// How long the stop waits for the server to answer it.
const STOP_MS = 5_000;

export default {
  name: "stop",
  summary: "stop the decide server of this home",
  description:
    "Stop the decide server of this home (the one process that serves every project's rounds). Open rounds are not ended: they are on disk, and the next ask, wait or push starts a server again that serves them. Use it only when the user asks to stop decide or the server is stuck; never to end a round.",
  mcp: true,
  cli: true,
  legacyFlag: "--stop",
  params: { project: PROJECT },
  async run() {
    const home = decideHome();
    // Only a live decide server of this home is sent the token: daemon.json may name anything by now.
    const found = await serverOf(home);
    if (found.state === "silent") return { text: `decide: ${silentServer(home, found.info)}; nothing was sent. Try again once it answers.`, exit: 1 };
    if (found.state !== "live") return { text: `decide: no running server for ${home}` };
    const { info } = found;
    try {
      const res = await request(info.port, "/api/stop", { method: "POST", headers: { "x-decide-token": String(info.token) }, timeoutMs: STOP_MS });
      // A second stop that races the first: the server is already going, which is what was asked.
      if (res.status === 503) return { text: `decide: the server of ${home} (pid ${info.pid}, port ${info.port}) is already stopping` };
      if (res.status !== 200) return { text: `decide: the server of ${home} (pid ${info.pid}, port ${info.port}) refused to stop: ${res.status}${res.data?.error ? ` ${res.data.error}` : ""}`, exit: 1 };
      return { text: `decide: server on :${info.port} stopped` };
    } catch (err) {
      if (err.kind === "timeout") return { text: `decide: the server of ${home} (pid ${info.pid}, port ${info.port}) did not answer within ${STOP_MS / 1000} s; it may still be running. Try again shortly.`, exit: 1 };
      // Refused or cut: it went between the ping and the stop.
      return { text: `decide: no running server for ${home}` };
    }
  },
};
