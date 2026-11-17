// wait — the next thing the user sent on a round. From an agent: one item (answers, a question, a batch),
// handed out again until it is acknowledged; from the CLI: waits until the round ends, or with live until the
// user asks something.

import { ack, heldServer, silentServer, waitNext, WAITER } from "../client.mjs";
import { decideHome } from "../project.mjs";
import { WAIT_MS } from "../store/rounds.mjs";
import { formatAsk, formatRequest, formatBatch, formatDeeper, formatResult, formatWords } from "../prepare.mjs";
import { reportCli } from "./ask.mjs";
import { PROJECT, ROUND, UserError, anyOf, settle, sleep, unknownRound, waitTimedOut } from "./shared.mjs";

const WAIT_DEFAULT_SEC = 600;
// The wait call of this process that is running on each round: a newer call on the same round stops it.
const waits = new Map(); // round id → AbortController

// What the agent reads for an item: 2.1's texts, and Task 5's line for a dismissed round.
function formatItem({ kind, payload }) {
  if (kind === "ask") return formatAsk(payload);
  if (kind === "batch") return formatBatch(payload);
  if (kind === "request") return formatRequest(payload);
  if (kind === "words") return formatWords(payload);
  if (kind === "deeper") return formatDeeper(payload);
  if (kind === "dismissed") return formatResult({ ...payload, status: "dismissed" });
  return formatResult(payload, payload.file); // final, cancel
}

// Items of this process whose result was written to the agent, not cancelled, but whose ack did not reach the
// server ("round seq"): when one comes again, the agent is told it may have had it. An answer that crossed a
// cancel is not among them: a host drops a response that comes after its own cancel, so the agent most likely
// never saw it, and it comes again unmarked.
const unacked = new Set();
const AGAIN = "This item may have reached you already: its acknowledgement did not reach the decide server, so it came again. If you already acted on it, don't act again.";

// The result for an item: its text (said to maybe have come before when an earlier ack of it failed) and
// what acknowledges it. A dismissed round's item is not acknowledged (the store ignores acks on it).
function delivery(server, round, item) {
  const key = `${round} ${item.seq}`;
  const text = unacked.has(key) ? `${AGAIN}\n\n${formatItem(item)}` : formatItem(item);
  if (item.kind === "dismissed") return { text };
  const delivered = async () => {
    try {
      await ack(server, round, item.seq, WAITER);
    } catch (e) {
      unacked.add(key);
      throw e;
    }
    unacked.delete(key);
  };
  return { text, delivered, collects: round };
}

export default {
  name: "wait",
  summary: "wait for the user on a round",
  description:
    "Wait for the user on a round. Returns the answers digest, or a question the user asked you (answer it with explain, then wait again), or \"still waiting\" after timeoutSec: then call wait again at once. Don't end your turn while the round is open, or the answers never reach you.",
  mcp: true,
  cli: true,
  legacyFlag: "--wait",
  legacyValue: "round",
  required: ["round"],
  params: {
    project: PROJECT,
    round: ROUND(),
    timeoutSec: { kind: "number", schema: { type: "number", description: "How long to block, default 600, max 840." } },
    live: { kind: "boolean", only: "cli" },
  },
  async run(args, ctx) {
    const { signal } = ctx;
    if (!args.round) throw new UserError("Pass round (the id returned by ask).");
    const round = String(args.round);
    if (args.project) void ctx.project;
    const home = decideHome();
    // A wait keeps waiting: a server that does not answer is tried for this call's whole time (never started
    // beside); none at all is started, since the round is on disk.
    const cliDeadline = ctx.cli && args.timeoutSec !== undefined ? Date.now() + Math.max(0, Number(args.timeoutSec) || 0) * 1000 : Infinity;
    let server;
    let startupTimer;
    try {
      const finding = ctx.server();
      server = Number.isFinite(cliDeadline) ? await Promise.race([finding, new Promise((resolve) => {
        startupTimer = setTimeout(() => resolve(null), Math.max(0, cliDeadline - Date.now()));
      })]) : await finding;
      if (!server) return { text: "", exit: waitTimedOut(round, ctx.say) };
    } catch (e) {
      if (!e.busy || !e.info) throw e;
      if (ctx.cli) ctx.warn(`decide: ${silentServer(home, e.info)}; still waiting for round ${round}, and it is tried again until it answers.`);
      server = heldServer(home, e.info);
    } finally {
      clearTimeout(startupTimer);
    }
    if (ctx.cli) return { text: "", exit: await settle(server, round, null, { live: Boolean(args.live), report: reportCli(ctx.say, round, null), say: ctx.say, deadline: cliDeadline }) };
    const report = {};
    // One wait per round in this process: a newer call on the round stops this one.
    waits.get(round)?.abort();
    const mine = new AbortController();
    waits.set(round, mine);
    const stop = anyOf(signal, mine.signal);
    try {
      const deadline = Date.now() + Math.max(5, Math.min(Number(args.timeoutSec) || WAIT_DEFAULT_SEC, 840)) * 1000;
      for (;;) {
        const asked = Math.max(0, Math.min(deadline - Date.now(), WAIT_MS));
        const started = Date.now();
        let item;
        try {
          item = await waitNext(server, round, { waiter: WAITER, events: true, timeoutMs: asked, signal: stop.signal, report });
        } catch (e) {
          if (e.status === 404) throw unknownRound(round, home);
          throw e;
        }
        if (signal?.aborted) return { text: "The wait was cancelled." }; // mcp.mjs writes no answer to a cancelled call
        if (mine.signal.aborted) return { text: `A newer wait call on round ${round} took over from this one; that call gets what the user sends.` };
        if (item?.superseded) return { text: `Another session took over the wait for round ${round}, so this session stops waiting on it.` };
        if (item) return delivery(server, round, item);
        if (Date.now() >= deadline - 1000) {
          const still = `Still waiting for the user on round ${round}. Call wait again now and don't end your turn while the round is open. If you must stop, ask the user to message you once they've answered, then call wait with timeoutSec 5 first.`;
          if (report.answered) return { text: still };
          // pid and port both from the handle: one record of the server this call tried.
          return { text: `${still} The decide server (${server.pid ? `pid ${server.pid}, ` : ""}port ${server.port}) did not answer during this call.` };
        }
        // Nothing, and back before the hold was up: something else let go of this waiter. Never loop on that
        // without a pause, or two waits that push each other out spin.
        if (Date.now() - started < asked - 1_000) await sleep(1_000);
      }
    } finally {
      if (waits.get(round) === mine) waits.delete(round);
      stop.dispose();
    }
  },
};
