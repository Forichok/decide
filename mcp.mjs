#!/usr/bin/env node
// mcp.mjs — decide as an MCP server (stdio, newline-delimited JSON-RPC), so
// Claude Code and Codex call it as a native tool. Zero dependencies. Stdout
// carries protocol messages only.

import { createInterface } from "node:readline";
import { VERSION } from "./lib/daemon.mjs";
import { HANDLERS, UserError } from "./lib/tools.mjs";

const PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const PROJECT = { type: "string", description: "Absolute path of the project you are working in. Always pass it (Codex needs it)." };
const ROUND = { type: "string", description: "Round id returned by ask." };

const INSTRUCTIONS = `decide opens a browser page where the user answers your questions by clicking: options with a recommendation, pictures, live mockups, diagrams, code.
Use it when the user has to choose, confirm a plan, rank, rate or explain intent — instead of long questions in chat. Load the decide skill for the spec format.
Flow: ask {project, spec} → wait {project, round} (repeat while it says "still waiting") → if wait returns a question from the user, answer it with explain and wait again → act on the answers.
Don't end your turn while a round is open: the answers reach you only through wait.
screenshot captures a running page (desktop / mobile) to put real screens into a spec. history lists what was already decided in this project.`;

const TOOLS = [
  {
    name: "ask",
    description:
      "Show the user a round of questions in the browser. Pass spec (the questions object, see the decide skill) or specPath (a x.questions.json file). Returns the round id; then call wait. Images may be {\"shot\": url, \"viewport\": \"mobile\"} to capture a running page.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        spec: { type: "object", description: "Questions spec: {title, intro?, questions: [{id, title, type?, options: [{id, label, recommended?}]}]}", additionalProperties: true },
        specPath: { type: "string", description: "Path to a spec file instead of spec; answers are written next to it." },
        open: { type: "boolean", description: "Open or focus the browser page (default true)." },
      },
    },
  },
  {
    name: "wait",
    description:
      "Wait for the user on a round. Returns the answers digest, or a question the user asked you (answer it with explain, then wait again), or \"still waiting\" after timeoutSec: then call wait again at once. Don't end your turn while the round is open, or the answers never reach you.",
    inputSchema: {
      type: "object",
      properties: { project: PROJECT, round: ROUND, timeoutSec: { type: "number", description: "How long to block, default 600, max 840." } },
      required: ["round"],
    },
  },
  {
    name: "explain",
    description: "Answer the user's question about one question of an open round. The text (markdown) and visuals appear right under that question on the page.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        round: ROUND,
        question: { type: "string", description: "Question id the explanation belongs to." },
        askId: { type: "string", description: "Id of the user's ask, if wait returned one." },
        text: { type: "string", description: "Short, plain explanation. Markdown." },
        images: { type: "array", items: { type: "string" }, description: "Image paths (absolute or relative to project) or URLs." },
        mermaid: { type: "string", description: "Mermaid diagram source." },
        code: { type: "string", description: "Code or diff to show." },
      },
      required: ["round", "question", "text"],
    },
  },
  {
    name: "screenshot",
    description: "Capture a running web page with the local headless Chrome. Returns PNG paths (and the images) to use in a spec.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        url: { type: "string", description: "http(s) URL, e.g. http://localhost:5173/settings" },
        viewport: { type: "string", enum: ["desktop", "mobile", "both"], description: "desktop 1440×900, mobile 390×844; default desktop." },
        name: { type: "string", description: "File name hint." },
        waitMs: { type: "number", description: "Let the page settle this long before capturing, default 1500." },
        show: { type: "boolean", description: "Return the images to you as well (default true)." },
      },
      required: ["url"],
    },
  },
  {
    name: "history",
    description: "Decisions already made in this project (newest first), to avoid asking the same thing twice.",
    inputSchema: {
      type: "object",
      properties: { project: PROJECT, limit: { type: "number", description: "Default 10." }, query: { type: "string", description: "Filter by text." } },
    },
  },
];

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

async function callTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) return { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true };
  try {
    const out = await handler(args || {});
    return { content: typeof out === "string" ? [{ type: "text", text: out }] : out };
  } catch (e) {
    const text = e instanceof UserError ? e.message : `decide failed: ${e.message}`;
    return { content: [{ type: "text", text }], isError: true };
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
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
  if (method === "tools/list") return send({ id, result: { tools: TOOLS } });
  if (method === "tools/call") return send({ id, result: await callTool(params?.name, params?.arguments) });
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
}).on("close", () => process.exit(0));
