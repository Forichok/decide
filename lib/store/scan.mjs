// scan.mjs — answers the user sent that no agent has collected. It reads the
// round directories of one project's data dir and writes nothing: no server,
// no repair of a torn log, no directory. Used by `decide.mjs notice`, the
// MCP tool results and the session-start hook.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirPath, decideHome, projectRoot } from "../project.mjs";
import { LISTEN_GRACE_MS, ROUND_ID } from "./rounds.mjs";
import { replay } from "./state.mjs";

const ENGINE = fileURLToPath(new URL("../../decide.mjs", import.meta.url));

const TITLE_MAX = 60;

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

// What the store's log would load: only lines ended by a newline count, so a last line without one is a
// torn write (the store cuts it); a line that does not parse is skipped. Nothing is repaired.
function readEvents(file) {
  const text = readFileSync(file, "utf8");
  const events = [];
  for (const line of text.slice(0, text.lastIndexOf("\n") + 1).split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === "object" && Number.isInteger(event.seq)) events.push(event);
    } catch {}
  }
  return events;
}

// A round only when the store would load it (its checks in rounds.mjs `read`).
function check(dir) {
  const meta = readJson(join(dir, "meta.json"));
  if (meta?.format !== 3 || meta.id !== basename(dir) || !["questions", "swipe"].includes(meta.mode)) return null;
  const spec = readJson(join(dir, "spec.json"));
  if (!Array.isArray(meta.mode === "swipe" ? spec?.cards : spec?.questions)) return null;
  const events = readEvents(join(dir, "events.jsonl"));
  const state = replay(meta, spec, events);
  if (state.status !== "answered") return null;
  const final = [...state.outbox].reverse().find((i) => i.kind === "final");
  if (!final || state.acked >= final.seq) return null;
  const at = events.find((e) => e.seq === final.seq)?.at;
  return { id: meta.id, title: String(state.title ?? ""), at: String(at ?? "") };
}

// Answered rounds whose final item has no acked event, oldest first. [] when there is nothing to read.
// A round younger than graceMs is left out: the agent that asked may still be between two wait calls.
export function uncollected(dataDir, { now = Date.now(), graceMs = LISTEN_GRACE_MS } = {}) {
  const root = join(dataDir, "rounds");
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (!ROUND_ID.test(name)) continue;
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const item = check(dir);
      if (item && !(now - Date.parse(item.at) < graceMs)) found.push(item);
    } catch {} // unreadable or not an event-log round: skipped
  }
  return found.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

const pad = (n) => String(n).padStart(2, "0");
// HH:MM (local) for today; with the date before it for any other day.
function clock(at, now) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "??:??";
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const n = new Date(now);
  return d.toDateString() === n.toDateString() ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}
const oneLine = (title) => [...title.replace(/\s+/g, " ").trim().replace(/"/g, "'")].slice(0, TITLE_MAX).join("");

// One line per round; "" when there are none.
// cli: the command line's wording (decide wait <round>) in place of the tool's.
export const noticeLine = (list, { now = Date.now(), cli = false } = {}) =>
  list.map((r) => `decide: round ${r.id} "${oneLine(r.title)}" was answered at ${clock(r.at, now)} and not collected; ${cli ? `run node ${ENGINE} wait ${r.id}` : `call wait {round: "${r.id}"}`}.`).join("\n");

// The lines for the project at `project`, without creating its data dir; "" when anything is wrong.
// skip: a round id left out (the wait that is collecting it).
export function noticeFor(project, { home = decideHome(), skip, cli = false } = {}) {
  try {
    if (typeof project !== "string" || !isAbsolute(project) || !existsSync(project)) return "";
    // Test seam: DECIDE_TEST_NOTICE_GRACE_MS replaces the listen grace so a test need not wait for it.
    const graceMs = process.env.DECIDE_TEST_NOTICE_GRACE_MS === undefined ? LISTEN_GRACE_MS : Number(process.env.DECIDE_TEST_NOTICE_GRACE_MS);
    const now = Date.now();
    return noticeLine(uncollected(dataDirPath(projectRoot(project), home), { now, graceMs }).filter((r) => r.id !== skip), { now, cli });
  } catch {
    return "";
  }
}
