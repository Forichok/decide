#!/usr/bin/env node
// mcp.mjs — decide as an MCP server (stdio, newline-delimited JSON-RPC), so
// Claude Code and Codex call it as a native tool. Zero dependencies. Stdout
// carries protocol messages only.

import { createInterface } from "node:readline";
import { VERSION } from "./lib/server.mjs";
import { COMMANDS, UserError, contextFor, runCommand, toolList } from "./lib/commands/index.mjs";

const PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

const INSTRUCTIONS = `decide opens a browser page where the user answers your questions by clicking: options with a recommendation, pictures, live mockups, diagrams, code.
Use it when the user has to choose, confirm a plan, rank, rate or explain intent — instead of long questions in chat. Load the decide skill for the spec format.
Flow: ask {project, spec} → wait {project, round} (repeat while it says "still waiting") → if wait returns a question from the user, answer it with explain and wait again → act on the answers.
Don't end your turn while a round is open: the answers reach you only through wait.
screenshot captures a running page (desktop / mobile) to put real screens into a spec. history lists what was already decided in this project.
swipe runs a thorough interview instead: a deck of two-sided cards the user answers with the arrow keys. wait returns the answers in batches; after each, push the rewritten brief and new cards, then wait again. Load the decide:swipe skill for the deck format.
review shows a code review of a branch: your overview, then the diff the server reads from git, cut into chapters you name. wait returns a question on a hunk at once (answer with explain) and the verdict with every comment at the end. Load the decide:review skill before you cut the chapters.`;

// done (optional) runs once the line is handed to the OS.
const send = (msg, done) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`, done);

// Requests running now: id → AbortController, aborted by notifications/cancelled.
const running = new Map();
// Acknowledgements still on their way. A tool call waits for them first, so a wait that follows a
// delivered item never gets that item again.
const deliveries = new Set();

// A command returns { text, content?, delivered? }. delivered() tells the server the agent has what the text
// carries: it runs after the answer is on stdout, and only for a call nobody cancelled.
async function callTool(name, args, signal) {
  if (!COMMANDS.some((c) => c.mcp && c.name === name)) return { result: { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true } };
  try {
    const out = await runCommand(name, args || {}, contextFor(args || {}, { signal }));
    return { result: { content: out.content ?? [{ type: "text", text: out.text }] }, delivered: out.delivered };
  } catch (e) {
    const text = e instanceof UserError || e.user ? e.message : `decide failed: ${e.message}`;
    return { result: { content: [{ type: "text", text }], isError: true } };
  }
}

// A call is in `running` from the moment it arrives until its answer is decided: a cancel that comes while
// it waits for earlier acks, while it runs, or while its answer is being written is never lost.
async function toolsCall(id, params) {
  const ctl = new AbortController();
  const key = JSON.stringify(id);
  running.set(key, ctl);
  // Only this call's own entry goes: a reused id may name a newer call by then.
  const done = () => running.get(key) === ctl && running.delete(key);
  let answer;
  try {
    await Promise.all(deliveries);
    if (ctl.signal.aborted) return done();
    answer = await callTool(params?.name, params?.arguments, ctl.signal);
  } catch (e) {
    done();
    throw e;
  }
  // A cancelled call gets no answer (MCP: the receiver should not answer it) and acknowledges nothing.
  if (ctl.signal.aborted) return done();
  if (!answer.delivered) {
    done();
    return send({ id, result: answer.result });
  }
  let settle;
  const delivery = new Promise((r) => (settle = r));
  deliveries.add(delivery);
  send({ id, result: answer.result }, async (err) => {
    // Not written, or a cancel crossed the answer (a host drops a response that comes after its own cancel):
    // not acknowledged, and it comes again as it was, unmarked, since the agent most likely never saw it.
    const crossed = ctl.signal.aborted;
    done();
    try {
      if (err || crossed) return;
      await answer.delivered();
    } catch (e) {
      process.stderr.write(`decide: the delivery could not be recorded, so it comes again on the next wait: ${e.message}\n`);
    } finally {
      deliveries.delete(delivery);
      settle();
    }
  });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "notifications/cancelled") return running.get(JSON.stringify(params?.requestId))?.abort();
  if (method === "initialize") {
    const asked = params?.protocolVersion;
    return send({
      id,
      result: {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "decide", version: VERSION },
        instructions: INSTRUCTIONS,
      },
    });
  }
  if (method === "tools/list") return send({ id, result: { tools: toolList() } });
  if (method === "tools/call") return toolsCall(id, params);
  if (method === "ping") return send({ id, result: {} });
  if (id !== undefined && id !== null) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "Parse error" } });
  }
  handle(msg).catch((e) => msg.id != null && send({ id: msg.id, error: { code: -32603, message: e.message } }));
}).on("close", async () => {
  // Acknowledgements on their way are finished first: the agent has those items.
  await Promise.all(deliveries);
  process.exit(0);
});
