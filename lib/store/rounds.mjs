// rounds.mjs — the decision rounds of one decide home, kept on disk. Every round
// is a directory in its project's data dir (meta.json, spec.json, raw.json,
// events.jsonl, files/, answers.json once sent) and its state in memory is a
// replay of the log (state.mjs). Every change is built from the current state,
// appended to the log, and only then applied and announced through `on.*`; an
// append that fails is status 507 and changes nothing. A store started on the
// same home loads every round that is open or whose answers the agent has not
// acknowledged; any other round is read from disk when it is asked for. No
// timer ends a round.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { digest, emptyAnswer, finalizeAnswers, isCounted, isVisible } from "../../ui/js/logic.js";
import { ANSWERS_FORMAT } from "../migrate.mjs";
import { batchDigest, briefMarkdown, deckStats, finalDigest, NOTE_MAX, sideLabel } from "../swipe.mjs";
import { openLog } from "./log.mjs";
import { validatePatch } from "./patch.mjs";
import { viewOf as roundView } from "./view.mjs";
import { apply, batchPayload, batchReady, liveDue, pendingAnswers, deeperPayload, dialogEntry, FLAG_VALUES, patchDeck, patchOf, pendingEntries, pendingItems, publicDialog as dialogOf, replay, swipePayload, swipeView as viewOf } from "./state.mjs";

export const LIVE_COUNT = 3; // a live questions round: a batch after this many new answers
export const LIVE_PAUSE_MS = 20_000; // or after this long without a change
export const WAIT_MS = 240_000; // under undici's 300 s headers timeout
// Agents re-call wait in a loop (Codex every ~75 s); a gap shorter than this still counts as listening.
export const LISTEN_GRACE_MS = 90_000;
const HISTORY = 30;
const ASK_MAX = 4000;
// One question's answer as the page keeps it, serialized; a note; a revisit condition or a flag's note.
export const ANSWER_MAX = 256 * 1024;
const NOTE_TEXT_MAX = 8000;
const REVISIT_MAX = 1000;
// A round with no agent listening for this long goes to the inbox's "older" group.
export const OLDER_MS = 24 * 60 * 60_000;
// Round ids keep the 2.x shape: the project's round number in base 36, a dash, six hex digits.
export const ROUND_ID = /^([0-9a-z]+)-[0-9a-f]{6}$/;
const FINAL = new Set(["answered", "cancelled"]);
const FINAL_KINDS = new Set(["final", "cancel"]);
// The answers file next to a spec file may be replaced when it is missing, torn, or an older round's.
const REPLACEABLE = new Set(["missing", "torn", "older"]);
const numberOf = (id) => parseInt(ROUND_ID.exec(id)?.[1] ?? "0", 36);

export const roundDir = (dataDir, id) => join(dataDir, "rounds", id);

const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const diskError = (err) => Object.assign(new Error(`the round could not be saved: ${err.message}`), { status: 507, cause: err });
const hex = (n) => randomBytes(n).toString("hex");
const pretty = (value) => JSON.stringify(value, null, 2);
const isInside = (parent, child) => {
  const rel = relative(parent, child);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
};
const entries = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

// Temp file + rename: a reader sees the old file or the new one, never half of one. The temp file
// sits beside the target with a leading dot and is removed when the write or the rename fails.
// A round's own files are the user's only (PRIVATE); a copy next to the spec file gets the usual mode.
const PRIVATE = 0o600;
function writeAtomic(file, text, mode) {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}-${hex(3)}.tmp`);
  try {
    writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// home: the decide home (DECIDE_HOME); rounds live under <home>/projects/*/rounds/<id>/.
// on: { change(), dialog(round, entry?), deck(round, info?), finish(round, result), round(round, {seq, prev, patch}) },
// all optional. `round` follows every answer, note and flag: prev is the seq of the change before it.
// Test seams, not features: `now` replaces the clock, `warn` gets the one-line notes load writes
// to stderr, `logFs` is handed to every event log (openLog's fault-injection seam).
export function createStore({ home, roots, on = {}, listenGraceMs = LISTEN_GRACE_MS, now = Date.now, warn = (line) => process.stderr.write(`${line}\n`), logFs } = {}) {
  home = resolve(home);
  const recs = new Map(); // round id → record (internal)
  const handles = new WeakMap(); // public round → record
  const openLogAt = (dir) => openLog(join(dir, "events.jsonl"), logFs ? { fs: logFs } : undefined);

  // A callback that throws must not leave a saved change half announced.
  function tell(name, ...args) {
    if (typeof on[name] !== "function") return;
    try {
      on[name](...args);
    } catch (err) {
      warn(`decide: on.${name} failed: ${err.message}`);
    }
  }

  function recOf(round) {
    const rec = round && handles.get(round);
    if (!rec) throw refuse("unknown round", 404);
    return rec;
  }

  // A log that failed on an earlier write is reopened before anything is built from the state, so a
  // line it could not roll back is applied first. Every method that writes starts here, and so does
  // `next`. When that line ended the round (sent, imported, cancelled, dismissed), the end of the round
  // runs now, once: the failed call that appended it threw before it got there.
  function sync(rec) {
    if (!rec.logFailed) return;
    const before = rec.state.status;
    try {
      reopen(rec);
    } catch (err) {
      throw diskError(err);
    }
    if (before === "pending" && rec.state.status !== "pending") ended(rec);
  }

  function openOnly(rec) {
    if (rec.state.status !== "pending") throw refuse(`round is ${rec.state.status}`, 409);
  }

  // ---- the log: append, then apply

  // Callers reopen a failed log through sync first; a log still failed here refuses with 507.
  function append(rec, type, data) {
    let event;
    try {
      if (rec.logFailed) throw Object.assign(new Error("the log failed on an earlier write and could not be reopened"), { code: "ELOGFAILED" });
      event = rec.log.append(type, data);
    } catch (err) {
      rec.logFailed = true;
      throw diskError(err);
    }
    rec.state = apply(rec.state, event);
    return event;
  }

  // A log that failed refuses appends until it is reopened. Reopening reads what is really on
  // disk: a line the log could not roll back is the truth and is applied.
  function reopen(rec) {
    try {
      rec.log.close();
    } catch {}
    const log = openLogAt(rec.dir);
    if (log.last() < rec.state.lastSeq) throw Object.assign(new Error("events.jsonl lost events"), { code: "ELOGLOST" });
    for (const e of log.read(rec.state.lastSeq)) rec.state = apply(rec.state, e);
    rec.log = log;
    rec.logFailed = false;
  }

  // ---- what the page sees

  const publishSide = (n) => (n && typeof n === "object" ? roots.publishNode(n) : n);
  const publishCard = (c) => ({ ...roots.publishNode(c), left: publishSide(c.left), right: publishSide(c.right) });

  const publishDeck = (deck) => ({ ...deck, cards: deck.cards.map(publishCard) });

  // Publishes for the round. A round read from disk that is not open (rec.quiet) gives everything back at
  // once: its view still names URLs, and they are not served. The page shows such a round's result only.
  function owned(rec, fn) {
    const out = roots.within(rec.id, fn);
    if (rec.quiet) roots.release(rec.id);
    return out;
  }

  // spec.json and the events keep local paths; the page gets served URLs, published once per deck.
  // Everything published for a round is owned by it, so a round that is no longer open gives its files back.
  function published(rec) {
    return owned(rec, () => {
      if (rec.meta.mode !== "swipe") return (rec.specPub ??= roots.publish(rec.spec));
      const { deck } = rec.state.swipe;
      if (rec.deckRef !== deck) {
        rec.deckPub = publishDeck(deck);
        rec.deckRef = deck;
      }
      return rec.deckPub;
    });
  }

  const dialogOut = (rec) => owned(rec, () => structuredClone(dialogOf(rec.state)).map((d) => (d.reply ? { ...d, reply: roots.publishNode(d.reply) } : d)));
  const itemsOf = (rec) => (rec.meta.mode === "swipe" ? rec.state.swipe.deck.cards : rec.spec.questions);
  const finalItem = (state) => state.outbox.findLast((i) => FINAL_KINDS.has(i.kind)) ?? null;

  function delivered(rec) {
    const item = finalItem(rec.state);
    return Boolean(item) && rec.state.acked >= item.seq;
  }

  const listeningRec = (rec) => rec.held !== null || now() - rec.lastWaiter < listenGraceMs;

  function handle(rec) {
    const { meta, dir } = rec;
    return Object.freeze({
      id: meta.id,
      mode: meta.mode,
      project: meta.project,
      top: meta.top || meta.project,
      dataDir: dirname(dirname(dir)),
      dir,
      source: meta.source,
      specFile: meta.specFile,
      outPath: meta.outPath,
      live: meta.live,
      createdAt: Date.parse(meta.createdAt),
      answersFile: join(dir, "answers.json"),
      // Read-only: the store replaces it, nobody changes it.
      get state() {
        return rec.state;
      },
      get status() {
        return rec.state.status;
      },
      get title() {
        return rec.state.title;
      },
      get draft() {
        return structuredClone(rec.state.draft);
      },
      get answers() {
        return structuredClone(rec.state.answers);
      },
      get notes() {
        return structuredClone(rec.state.notes);
      },
      get flags() {
        return structuredClone(rec.state.flags);
      },
      get seq() {
        return rec.state.lastSeq;
      },
      get result() {
        return structuredClone(rec.state.result);
      },
      get dialog() {
        return dialogOut(rec);
      },
      get spec() {
        return structuredClone(published(rec));
      },
      get delivered() {
        return delivered(rec);
      },
    });
  }

  // The round's own publish: create tried one under another owner, to refuse a spec that cannot be shown.
  // fromDisk: read back by load or get, not created now.
  function register(dir, meta, spec, log, lastWaiter, fromDisk = false) {
    const state = replay({ id: meta.id, mode: meta.mode, title: meta.title }, spec, log.read());
    const swipe = meta.mode === "swipe";
    // Read from disk and not open: its files are not served again (see owned).
    const quiet = fromDisk && state.status !== "pending";
    const rec = { id: meta.id, dir, meta, spec, log, logFailed: false, state, held: null, idle: false, lastWaiter, specPub: null, deckRef: null, deckPub: null, saved: null, quiet };
    published(rec); // a restarted server registers every asset of the round again
    rec.round = handle(rec);
    recs.set(meta.id, rec);
    handles.set(rec.round, rec);
    return rec;
  }

  // ---- disk: create, load, get

  function nextNumber(parent) {
    let max = 0;
    for (const e of entries(parent)) {
      const m = e.isDirectory() && ROUND_ID.exec(e.name);
      if (m) max = Math.max(max, parseInt(m[1], 36));
    }
    return max + 1;
  }

  function create({ project, spec, raw, outPath = "", source = "", specFile = "", live = false, mode = "questions" } = {}) {
    const dataDir = typeof project?.dataDir === "string" ? resolve(project.dataDir) : "";
    if (!dataDir || !isInside(home, dataDir)) throw refuse("the project's data dir is not inside the decide home");
    const swipe = mode === "swipe";
    if (!(swipe ? spec?.cards?.length : spec?.questions?.length)) throw refuse("spec and outPath required");
    // What load will read back, so a replay from disk equals the state in memory.
    const specText = JSON.stringify(spec);
    const prepared = JSON.parse(specText);
    // Whatever cannot be published cannot be shown: refuse it before anything is on disk.
    try {
      roots.within("create", () => (swipe ? publishDeck(prepared) : roots.publish(prepared)));
    } catch (err) {
      throw refuse(`the spec cannot be shown: ${err.message}`);
    } finally {
      roots.release("create"); // register() publishes it again under the round's own id
    }
    const parent = join(dataDir, "rounds");
    let id;
    let dir;
    try {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      for (let n = nextNumber(parent); ; n++) {
        id = `${n.toString(36)}-${hex(3)}`;
        dir = join(parent, id);
        if (recs.has(id)) continue;
        try {
          mkdirSync(dir, { mode: 0o700 });
          break;
        } catch (err) {
          if (err.code !== "EEXIST") throw err;
        }
      }
    } catch (err) {
      throw diskError(err);
    }
    const meta = {
      format: 3,
      id,
      mode: swipe ? "swipe" : "questions",
      title: String(prepared.title ?? ""),
      project: String(project.root ?? ""),
      top: String(project.top ?? project.root ?? ""),
      source: String(source ?? ""),
      specFile: specFile ? String(specFile) : "",
      outPath: outPath ? String(outPath) : "",
      live: swipe || Boolean(live),
      createdAt: new Date(now()).toISOString(),
    };
    let log = null;
    let rec;
    try {
      writeAtomic(join(dir, "spec.json"), specText, PRIVATE);
      writeAtomic(join(dir, "raw.json"), JSON.stringify(raw ?? null), PRIVATE);
      log = openLogAt(dir);
      log.append("opened", {});
      // Last: a directory without meta.json is a round that was never opened, and load passes it by.
      writeAtomic(join(dir, "meta.json"), pretty(meta), PRIVATE);
      rec = register(dir, meta, prepared, log, now());
    } catch (err) {
      try {
        log?.close();
      } catch {}
      recs.delete(id);
      roots.release(id);
      rmSync(dir, { recursive: true, force: true });
      throw err.code ? diskError(err) : err;
    }
    tell("change");
    return rec.round;
  }

  // The round in `dir`, or null: not a round (no meta.json) or broken (one line on stderr).
  function read(dir) {
    const metaFile = join(dir, "meta.json");
    if (!existsSync(metaFile)) return null;
    let log = null;
    try {
      const meta = JSON.parse(readFileSync(metaFile, "utf8"));
      if (meta?.format !== 3 || meta.id !== basename(dir) || !["questions", "swipe"].includes(meta.mode)) throw new Error("meta.json is not a decide 3 round");
      const spec = JSON.parse(readFileSync(join(dir, "spec.json"), "utf8"));
      if (!Array.isArray(meta.mode === "swipe" ? spec?.cards : spec?.questions)) throw new Error("spec.json has no questions or cards");
      log = openLogAt(dir);
      const rec = register(dir, meta, spec, log, 0, true);
      repair(rec);
      return rec;
    } catch (err) {
      try {
        log?.close();
      } catch {}
      recs.delete(basename(dir));
      roots.release(basename(dir));
      warn(`decide: skipped round ${dir}: ${err.message}`);
      return null;
    }
  }

  // A server killed after the `sent` append, before the files were written: the event has the
  // result, write them now. answers.json in the round dir always; the copy next to the spec only for a
  // round the agent has not acknowledged, and only over a file that is missing, torn or an older round's.
  function repair(rec) {
    const { status, result } = rec.state;
    if (!FINAL.has(status) || !result) return;
    const out = resultFiles(rec);
    const problems = [];
    if (!existsSync(ownAnswers(rec))) problems.push(writeOwn(rec, out));
    if (copied(rec) && pendingItems(rec.state).length && REPLACEABLE.has(copyOwner(rec))) problems.push(writeCopy(rec, out));
    for (const p of problems.filter(Boolean)) warn(`decide: round ${rec.id}: ${p}`);
  }

  function* roundDirs(only) {
    const projects = join(home, "projects");
    for (const p of entries(projects)) {
      if (!p.isDirectory()) continue;
      const rounds = join(projects, p.name, "rounds");
      // 2.1 inline specs (<stamp>-<slug>.questions.json) share rounds/ as files: left alone.
      for (const r of entries(rounds)) if (r.isDirectory() && ROUND_ID.test(r.name) && (!only || r.name === only)) yield join(rounds, r.name);
    }
  }

  // Rounds that are open or owe the agent their answers; returns how many were loaded.
  function load() {
    let count = 0;
    for (const dir of roundDirs()) {
      if (recs.has(basename(dir))) continue;
      const rec = read(dir);
      if (!rec) continue;
      if (rec.state.status === "pending" || pendingItems(rec.state).length) {
        count++;
        continue;
      }
      rec.log.close();
      recs.delete(rec.id);
      roots.release(rec.id); // not open: the page does not show it, so its files are not served
    }
    return count;
  }

  function get(id) {
    const key = String(id ?? "");
    if (recs.has(key)) return recs.get(key).round;
    if (!ROUND_ID.test(key)) return null;
    for (const dir of roundDirs(key)) {
      const rec = read(dir);
      if (rec) return rec.round;
    }
    return null;
  }

  const byAge = (a, b) => Date.parse(a.meta.createdAt) - Date.parse(b.meta.createdAt) || a.id.localeCompare(b.id);
  const pendingRecs = () => [...recs.values()].filter((r) => r.state.status === "pending").sort(byAge);
  const pending = () => pendingRecs().map((r) => r.round);

  // ---- the page's actions

  const noneFlags = (draft) => new Map(Object.entries(draft?.answers ?? {}).filter(([, a]) => a?.flag === "none").map(([qid, a]) => [qid, a.note]));

  function saveDraft(round, draft) {
    const rec = recOf(round);
    sync(rec);
    openOnly(rec);
    const before = noneFlags(rec.state.draft);
    const beforeView = shapeOf(viewRec(rec));
    const drafted = append(rec, "draft", { draft: draft ?? null });
    viewMoved(rec, beforeView, drafted.seq);
    // "None, suggest others" on a question becomes a request for the agent when one is listening; otherwise
    // it stays a flag in the draft. Asked once per press: the flag has to be taken off and set again.
    if (listeningRec(rec) && rec.state.status === "pending") {
      for (const [qid, note] of noneFlags(rec.state.draft)) {
        if (before.has(qid)) continue;
        const q = itemsOf(rec).find((x) => x.id === qid);
        if (q) append(rec, "request", { qid, title: q.title || qid, note: String(note ?? "").slice(0, ASK_MAX) });
      }
    }
    if (rec.state.live || rec.state.outbox.at(-1)?.kind === "request") offer(rec);
  }

  // ---- answers, notes and flags: one question per event, so two pages never wipe each other's

  function questionOf(rec, qid) {
    if (rec.meta.mode !== "questions") throw refuse("not a questions round", 409);
    const id = String(qid ?? "");
    if (!rec.spec.questions.some((q) => q.id === id)) throw refuse("unknown question");
    return id;
  }

  // Appends one per-question event and tells the page: {seq}.
  function perQuestion(round, type, fields) {
    const rec = recOf(round);
    sync(rec);
    openOnly(rec);
    const qid = questionOf(rec, fields.qid);
    const prev = rec.state.patchSeq;
    const before = noneOf(rec.state);
    const beforeView = shapeOf(viewRec(rec));
    const event = append(rec, type, { ...fields, qid });
    viewMoved(rec, beforeView, event.seq);
    tell("round", rec.round, { seq: event.seq, prev, patch: patchOf(event) });
    requestNone(rec, before);
    if (rec.state.live) offer(rec);
    return { seq: event.seq };
  }

  // "None, suggest others" (an answer or a flag event) becomes a request for the agent when one is listening;
  // otherwise it stays a flag. Asked once per press: the flag has to be taken off and set again.
  const noneOf = (state) => {
    const out = new Map(Object.entries(state.answers ?? {}).filter(([, a]) => a?.flag === "none").map(([qid, a]) => [qid, a.note]));
    for (const [qid, f] of Object.entries(state.flags ?? {})) if (f?.flag === "none") out.set(qid, f.note ?? out.get(qid));
    return out;
  };
  function requestNone(rec, before) {
    if (!listeningRec(rec) || rec.state.status !== "pending") return;
    let asked = false;
    for (const [qid, note] of noneOf(rec.state)) {
      if (before.has(qid)) continue;
      const q = itemsOf(rec).find((x) => x.id === qid);
      if (q) (append(rec, "request", { qid, title: q.title || qid, note: String(note ?? "").slice(0, ASK_MAX) }), (asked = true));
    }
    if (asked) offer(rec);
  }

  // answer: the page's answer object for the question, or null to clear it.
  function saveAnswer(round, { qid, answer } = {}) {
    if (answer !== null && (typeof answer !== "object" || Array.isArray(answer))) throw refuse("answer must be an object or null");
    if (answer !== null && JSON.stringify(answer).length > ANSWER_MAX) throw refuse(`an answer may hold ${ANSWER_MAX} bytes`, 413);
    return perQuestion(round, "answer", { qid, answer });
  }

  // Text typed for a question that is not its answer yet (the question for the agent being written).
  function saveNote(round, { qid, text } = {}) {
    if (text !== undefined && text !== null && typeof text !== "string") throw refuse("text must be a string");
    return perQuestion(round, "note", { qid, text: String(text ?? "").slice(0, NOTE_TEXT_MAX) });
  }

  // flag: "none" (none of these, suggest others), "later" (decide later, revisit when …) or null.
  function saveFlag(round, { qid, flag, revisit, note } = {}) {
    if (flag !== null && flag !== undefined && !FLAG_VALUES.includes(flag)) throw refuse(`flag must be ${FLAG_VALUES.join(", ")} or null`);
    const text = (v) => (typeof v === "string" ? v.trim() : "");
    return perQuestion(round, "flag", {
      qid,
      flag: flag ?? null,
      ...(flag && text(revisit) ? { revisit: text(revisit).slice(0, REVISIT_MAX) } : {}),
      ...(flag && text(note) ? { note: text(note).slice(0, NOTE_TEXT_MAX) } : {}),
    });
  }

  // 3.0: what the rules changed, without the answers themselves (the page has those). An answer that makes
  // a rule ghost, restore or mark stale moves the view; the page hears it as a round patch. The answer
  // event (M2 core) calls viewMoved the same way.
  const shapeOf = (view) => (view ? JSON.stringify({ items: view.items, ghosts: view.ghosts, stale: view.stale, staleReasons: view.staleReasons }) : "");
  function viewMoved(rec, before, seq) {
    const view = viewRec(rec);
    if (view && shapeOf(view) !== before) tell("view", rec.round, view, seq);
  }

  // An upload that was not logged leaves nothing behind: not the file, not an empty files/.
  function discard(file, dir) {
    rmSync(file, { force: true });
    try {
      rmdirSync(dir);
    } catch {}
  }

  function saveUpload(round, name, type, buf) {
    const rec = recOf(round);
    sync(rec);
    openOnly(rec);
    const dir = join(rec.dir, "files");
    const safe = basename(String(name || "file")).replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(-80) || "file";
    let file = join(dir, `${now().toString(36)}-${safe}`);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        writeFileSync(file, buf, { flag: "wx", mode: PRIVATE });
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        file = join(dir, `${now().toString(36)}-${hex(2)}-${safe}`);
        writeFileSync(file, buf, { flag: "wx", mode: PRIVATE });
      }
    } catch (err) {
      if (err.code !== "EEXIST") discard(file, dir);
      throw diskError(err);
    }
    try {
      append(rec, "upload", { path: file, name: safe, size: buf.length, mime: String(type ?? "") });
    } catch (err) {
      discard(file, dir);
      throw err;
    }
    return { path: file, url: roots.within(rec.id, () => roots.publishFile(file)), name: safe, size: buf.length, type };
  }

  const entryOut = (rec, id) => dialogOut(rec).find((d) => d.id === id);

  function ask(round, { qid, text } = {}) {
    const rec = recOf(round);
    sync(rec);
    openOnly(rec);
    const item = itemsOf(rec).find((q) => q.id === qid);
    if (!item) throw refuse("unknown question");
    const id = hex(3);
    append(rec, "ask", { id, qid, title: item.title || qid, text: String(text ?? "").trim().slice(0, ASK_MAX) });
    offer(rec);
    tell("dialog", rec.round);
    tell("change");
    return entryOut(rec, id);
  }

  // The agent's explanation answers the ask it names, else the open ask of that question, else starts an entry.
  function explain(round, { qid, askId, text, media } = {}) {
    const rec = recOf(round);
    sync(rec);
    openOnly(rec);
    const q = String(qid ?? "");
    const found = dialogEntry(rec.state, { qid: q, askId });
    if (!found && !itemsOf(rec).some((x) => x.id === q)) throw refuse("unknown question");
    const id = found ? found.id : hex(3);
    append(rec, "reply", { id, qid: q, ...(askId ? { askId: String(askId) } : {}), text: String(text ?? ""), ...(media && typeof media === "object" ? { media } : {}) });
    const entry = entryOut(rec, id);
    tell("dialog", rec.round, entry);
    return entry;
  }

  function swipeAnswer(round, answer = {}) {
    const rec = recOf(round);
    sync(rec);
    openOnly(rec);
    append(rec, "swipe", swipePayload(rec.state, answer));
    tell("deck", rec.round);
    offer(rec);
    tell("change");
    return structuredClone(rec.state.swipe.answers);
  }

  // patch: normalized and unpublished (swipe.mjs normalizePatch); its media is published on the way to the page.
  function push(round, patch = {}) {
    const rec = recOf(round);
    sync(rec);
    openOnly(rec);
    if (!rec.state.swipe) throw refuse("not a swipe round");
    const { deck, answers } = rec.state.swipe;
    const { issues, added } = patchDeck(rec.state, patch);
    const waited = deckStats(deck, answers).left === 0;
    append(rec, "push", { patch });
    // The user ran out of cards and waited: new ones are worth a nudge.
    tell("deck", rec.round, { refilled: waited && added > 0 });
    tell("change");
    const sw = rec.state.swipe;
    return { issues, added, stats: deckStats(sw.deck, sw.answers) };
  }

  // "Dig deeper": logged when pressed, so the deck reopens at once and the press survives a restart.
  function deeper(round, { note } = {}) {
    const rec = recOf(round);
    sync(rec);
    openOnly(rec);
    if (!rec.state.swipe) throw refuse("not a swipe round");
    append(rec, "deeper", deeperPayload(rec.state, note));
    rec.idle = false;
    offer(rec);
    tell("deck", rec.round);
    tell("change");
    return { deeper: rec.state.swipe.deeper.length };
  }

  // ---- the end of a round

  const talkOf = (state) => state.dialog.filter((d) => d.reply).map((d) => ({ question: d.qid, ask: d.ask, answer: d.reply.text }));

  // Every question's answer as the page keeps it: the saved one over a blank one.
  // A field of the wrong type (a page of another version wrote it) is read as blank.
  function pageAnswer(q, saved) {
    const blank = emptyAnswer(q);
    const a = { ...blank, ...(saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {}) };
    for (const [k, v] of Object.entries(blank)) if (v !== null && (typeof a[k] !== typeof v || Array.isArray(a[k]) !== Array.isArray(v))) a[k] = v;
    return a;
  }
  const pageAnswers = (rec) => Object.fromEntries(rec.spec.questions.map((q) => [q.id, pageAnswer(q, rec.state.answers[q.id])]));

  // The flags kept beside the answers go into each question's entry: flag, revisit, and the flag's note with
  // the question's own. A flag replaces an answer the page filled in itself (auto). A "Yes, but…" condition
  // the answer holds is kept as `condition`. Hidden questions (showIf) get nothing.
  function withFlags(rec, answers) {
    const out = { ...answers };
    const { flags, answers: given } = rec.state;
    const conditionOf = (qid) => (typeof given[qid]?.condition === "string" ? given[qid].condition.trim() : "");
    // Nothing kept beside the answers: the page's answers go as they are.
    if (!rec.spec.questions.some((q) => flags[q.id] || conditionOf(q.id))) return out;
    const full = pageAnswers(rec);
    for (const q of rec.spec.questions) {
      if (!isVisible(q, full)) continue;
      let r = out[q.id];
      const f = flags[q.id];
      if (f) {
        const base = r && !r.auto ? r : {};
        const note = [base.note, f.note].filter(Boolean).join("\n");
        r = { ...base, flag: f.flag, ...(f.revisit ? { revisit: f.revisit } : {}), ...(note ? { note } : {}) };
      }
      const condition = conditionOf(q.id);
      if (r && !r.auto && condition && !r.condition) r = { ...r, condition };
      if (r) out[q.id] = r;
    }
    return out;
  }

  function questionsResult(rec, payload, extra) {
    const state = rec.state;
    const base = { version: 2, format: ANSWERS_FORMAT, round: rec.id, source: rec.meta.source, title: state.title, submittedAt: new Date(now()).toISOString() };
    if (payload.cancelled) return { ...base, cancelled: true };
    const talk = talkOf(state);
    const result = {
      ...base,
      ...extra,
      elapsedSec: Number.isFinite(payload.elapsedSec) ? payload.elapsedSec : undefined,
      answers: withFlags(rec, payload.answers && typeof payload.answers === "object" ? payload.answers : {}),
      ...(payload.comment ? { comment: String(payload.comment) } : {}),
      // Answers imported from an exported file: who answered, and from which file.
      ...(typeof payload.name === "string" && payload.name.trim() ? { name: payload.name.trim().slice(0, 80) } : {}),
      ...(typeof payload.importedFrom === "string" && payload.importedFrom ? { importedFrom: payload.importedFrom } : {}),
      ...(payload.attachments?.length ? { attachments: payload.attachments.map(String) } : {}),
      ...(talk.length ? { dialog: talk } : {}),
      ...(rec.spec.leftOut?.length ? { leftOut: rec.spec.leftOut } : {}),
    };
    // R9: a ghost's answer is left out of answers; the file names the ghosts and why.
    const view = viewRec(rec);
    if (view?.ghosts.length) {
      const gone = new Set(view.ghosts.map((g) => g.id));
      result.answers = Object.fromEntries(Object.entries(result.answers).filter(([id]) => !gone.has(id)));
      result.ghosts = view.ghosts;
    }
    result.digest = digest(rec.spec, result);
    return result;
  }

  // The swipe result: every answer, the agent's brief, and (once sent) the brief as markdown next to the answers.
  function swipeResult(rec, payload, extra, briefFile) {
    const state = rec.state;
    const { deck, answers, deeper: presses } = state.swipe;
    const base = { version: 2, format: ANSWERS_FORMAT, mode: "swipe", round: rec.id, source: rec.meta.source, title: state.title, submittedAt: new Date(now()).toISOString() };
    if (payload.cancelled) return { ...base, cancelled: true };
    const note = typeof payload.note === "string" ? payload.note.trim().slice(0, NOTE_MAX) : "";
    const talk = talkOf(state);
    const unread = pendingEntries(state);
    return {
      ...base,
      ...extra,
      goal: deck.goal,
      stoppedBy: deck.done ? "agent" : "user",
      stats: deckStats(deck, answers),
      confidence: deck.confidence,
      answers: Object.fromEntries(
        deck.cards
          .filter((c) => answers[c.id])
          .map((c) => [c.id, { side: answers[c.id].side, label: sideLabel(c, answers[c.id].side, answers[c.id].text), ...(answers[c.id].hesitated ? { hesitated: true } : {}) }]),
      ),
      brief: deck.brief,
      ...(briefFile ? { briefFile } : {}),
      ...(note ? { note } : {}),
      ...(presses.length ? { deeper: { rounds: presses.length, notes: presses.map((d) => d.note).filter(Boolean) } } : {}),
      ...(unread.length ? { unread: batchDigest(deck, unread) } : {}),
      ...(talk.length ? { dialog: talk } : {}),
      digest: finalDigest(deck, answers),
    };
  }

  // Where a sent round's brief goes: next to the answers file of a spec file, else in the round dir.
  const briefPath = (rec) => (rec.meta.specFile && rec.meta.outPath ? `${rec.meta.outPath.replace(/(\.answers)?\.json$/i, "")}.brief.md` : join(rec.dir, "brief.md"));

  const ownAnswers = (rec) => join(rec.dir, "answers.json");
  const ownBrief = (rec) => join(rec.dir, "brief.md");
  // The round came from a spec file: its answers are also copied next to it (`<slug>.answers.json`).
  const copied = (rec) => Boolean(rec.meta.specFile && rec.meta.outPath);
  const notMine = (rec) => `the answers next to the spec file (${rec.meta.outPath}) are not this round's; this round's are saved in ${ownAnswers(rec)}`;

  // Whose answers the file next to the spec holds. Every round of one spec file shares it, so it is this
  // round's copy only when it parses and names this round. "older"/"newer" are told apart only for
  // rounds of this project on disk (by number); anything else (a 2.x round, not a round) is "unknown".
  function copyOwner(rec) {
    let text;
    try {
      text = readFileSync(rec.meta.outPath, "utf8");
    } catch (err) {
      return err.code === "ENOENT" ? "missing" : "unknown";
    }
    let other;
    try {
      other = JSON.parse(text)?.round;
    } catch {
      return "torn";
    }
    if (other === rec.id) return "mine";
    if (typeof other !== "string" || !ROUND_ID.test(other) || !existsSync(join(dirname(rec.dir), other, "meta.json"))) return "unknown";
    return numberOf(other) < numberOf(rec.id) ? "older" : "newer";
  }

  function resultFiles(rec) {
    const { result } = rec.state;
    const brief = rec.meta.mode === "swipe" && !result.cancelled ? briefMarkdown(rec.state.swipe.deck, rec.state.swipe.answers, { note: result.note || "" }) : null;
    return { result, text: pretty(result), brief };
  }

  // brief.md, then answers.json, in the round dir: answers.json there means the brief is there too.
  // A problem string or null.
  function writeOwn(rec, { text, brief }) {
    try {
      if (brief !== null) writeAtomic(ownBrief(rec), brief, PRIVATE);
      writeAtomic(ownAnswers(rec), text, PRIVATE);
      return null;
    } catch (err) {
      return `could not write ${ownAnswers(rec)}: ${err.message}`;
    }
  }

  // The brief beside the spec file, then the copy of the answers: a copy that names this round means its
  // brief is there too, so delivery can tell from the copy alone, after a restart as well. A problem
  // string or null.
  function writeCopy(rec, { result, text, brief }) {
    const { outPath } = rec.meta;
    if (brief !== null && result.briefFile && result.briefFile !== ownBrief(rec)) {
      try {
        writeAtomic(result.briefFile, brief);
      } catch (err) {
        return `could not write the brief next to the spec file (${result.briefFile}): ${err.message}; this round's answers and brief are saved in ${rec.dir}`;
      }
    }
    try {
      writeAtomic(outPath, text);
      return null;
    } catch (err) {
      return `could not write the answers next to the spec file (${outPath}): ${err.message}; they are saved in ${ownAnswers(rec)}`;
    }
  }

  // The end of a round, run once by whatever ended it (finish, dismiss, or sync bringing back their
  // line): the result files for a sent or cancelled round, the held waiter's item, the callbacks.
  // Returns the files' warning, if any.
  function ended(rec) {
    const sent = FINAL.has(rec.state.status);
    const warning = sent ? writeResult(rec).warning : undefined;
    offer(rec);
    if (sent) tell("finish", rec.round, structuredClone(rec.state.result));
    tell("change");
    return warning;
  }

  // After the result is in the log: answers.json (and brief.md) in the round dir, then the copy next to
  // the spec file, unless a newer round of that spec already put its answers there. A copy that cannot
  // be written is a warning, never a lost round.
  function writeResult(rec) {
    const out = resultFiles(rec);
    const problems = [writeOwn(rec, out)];
    if (copied(rec)) problems.push(copyOwner(rec) === "newer" ? notMine(rec) : writeCopy(rec, out));
    const warning = problems.filter(Boolean).join("; ");
    rec.saved = warning ? { warning } : {};
    return rec.saved;
  }

  // payload: the page's submit body ({answers, comment, attachments, elapsedSec}, {note} for a swipe
  // round, {cancelled: true}); an import adds {name, importedFrom} and is logged as `imported`.
  function finish(round, payload = {}) {
    const rec = recOf(round);
    sync(rec);
    if (rec.state.status !== "pending") return structuredClone(rec.state.result);
    const swipe = rec.meta.mode === "swipe";
    // R5: an answer marked for checking is confirmed (answered again or kept) before the round is sent.
    if (!swipe && !payload.cancelled && !payload.importedFrom) {
      const view = viewRec(rec);
      if (view?.stale.length) throw Object.assign(refuse(`answers to check first: ${view.stale.join(", ")}`, 409), { stale: view.stale.map((id) => ({ id, reason: view.staleReasons[id] ?? "" })) });
    }
    const result = swipe ? swipeResult(rec, payload, {}, briefPath(rec)) : questionsResult(rec, payload, {});
    const type = result.cancelled ? "cancelled" : !swipe && result.importedFrom ? "imported" : "sent";
    append(rec, type, { result });
    const warning = ended(rec);
    return { ...structuredClone(rec.state.result), ...(warning ? { warning } : {}) };
  }

  // The user closes the round from the inbox: what was answered so far is kept in the log and nothing
  // is written next to the spec. A waiter gets a `dismissed` item (see take) so no agent hangs on it.
  function dismiss(round) {
    const rec = recOf(round);
    sync(rec);
    if (rec.state.status !== "pending") return structuredClone(rec.state.result);
    const draft = rec.state.draft && typeof rec.state.draft === "object" ? rec.state.draft : {};
    // What was answered so far, as the agent reads answers: questions with nothing in them are left out.
    const something = (v) => !(Array.isArray(v) && !v.length);
    // A spec the page cannot read (not prepared) gives the answers as they were saved.
    const finalized = () => {
      try {
        return finalizeAnswers(rec.spec, pageAnswers(rec));
      } catch {
        return { ...rec.state.answers };
      }
    };
    const answered = () => Object.fromEntries(Object.entries(finalized()).filter(([, r]) => r && typeof r === "object" && Object.values(r).some(something)));
    const result =
      rec.meta.mode === "swipe"
        ? swipeResult(rec, {}, { dismissed: true }, null)
        : questionsResult(rec, { answers: answered(), comment: draft.comment, attachments: Array.isArray(draft.commentFiles) ? draft.commentFiles : undefined, elapsedSec: draft.elapsedSec }, { dismissed: true });
    append(rec, "dismissed", { result });
    ended(rec);
    return structuredClone(rec.state.result);
  }

  // ---- delivery to the agent (Task 8 builds acknowledgement on next and ack)

  // Does this answers file hold this round's answers? (It parses and names the round.)
  function holds(file, rec) {
    try {
      return JSON.parse(readFileSync(file, "utf8"))?.round === rec.id;
    } catch {
      return false;
    }
  }

  // A copy the caller may change. Final and cancel items say where the answers are, and name only a file
  // that holds them: the copy next to the spec while it names this round (another round of the spec may
  // have replaced it), else answers.json in the round dir, else no file. The brief follows the answers:
  // the one beside the spec goes with this round's copy (written before it), else the round dir's.
  function deliverable(rec, item) {
    if (!item) return null;
    const out = structuredClone(item);
    if (FINAL_KINDS.has(out.kind) && out.payload && typeof out.payload === "object") {
      const mine = copied(rec) && copyOwner(rec) === "mine";
      const own = !mine && holds(ownAnswers(rec), rec);
      const problems = [];
      if (copied(rec) && !mine) problems.push(own ? notMine(rec) : `the answers next to the spec file (${rec.meta.outPath}) are not this round's`);
      if (!mine && !own) problems.push(`this round's answers are in no file (${ownAnswers(rec)} could not be written); they are only in this reply`);
      const warning = rec.saved?.warning || problems.join("; ");
      const payload = { ...out.payload, file: mine ? rec.meta.outPath : own ? ownAnswers(rec) : undefined };
      if (!mine && payload.briefFile) payload.briefFile = existsSync(ownBrief(rec)) ? ownBrief(rec) : undefined;
      if (warning) payload.warning = warning;
      for (const key of ["file", "briefFile"]) if (payload[key] === undefined) delete payload[key];
      out.payload = payload;
    }
    return out;
  }

  // Not an outbox item: derived here, so an agent waiting on a round the user dismissed is told at once.
  // Nothing is appended after `dismissed`, so its seq is the last one.
  const dismissal = (rec) => ({ seq: rec.state.lastSeq, kind: "dismissed", payload: structuredClone(rec.state.result) });

  // What a waiter gets now, or null. A batch is cut here: when one is due and a waiter that takes
  // events is there to receive it, so answers given while no agent listens arrive as one batch.
  function take(rec, events) {
    const state = rec.state;
    if (FINAL.has(state.status)) return deliverable(rec, finalItem(state));
    if (state.status === "dismissed") return dismissal(rec);
    if (state.status !== "pending") return null;
    const [first] = pendingItems(state, { events });
    if (first) return deliverable(rec, first);
    if (events && state.live) return takeLive(rec);
    if (!events || !batchReady(state)) return null;
    append(rec, "batch", batchPayload(state));
    rec.idle = false;
    tell("deck", rec.round);
    return deliverable(rec, rec.state.outbox.at(-1));
  }

  // A live questions round: a batch of answers after LIVE_COUNT new ones, or LIVE_PAUSE_MS of quiet. A timer
  // wakes the held waiter when the pause is up. Seams for tests: DECIDE_LIVE_COUNT, DECIDE_LIVE_PAUSE_MS.
  function takeLive(rec) {
    clearTimeout(rec.liveTimer);
    const count = Math.max(1, Number(process.env.DECIDE_LIVE_COUNT) || LIVE_COUNT);
    const pauseMs = Number(process.env.DECIDE_LIVE_PAUSE_MS) >= 0 && process.env.DECIDE_LIVE_PAUSE_MS !== undefined ? Number(process.env.DECIDE_LIVE_PAUSE_MS) : LIVE_PAUSE_MS;
    const due = liveDue(rec.state, now(), { count, pauseMs });
    if (due === null) return null;
    if (due > 0) {
      rec.liveTimer = setTimeout(() => offer(rec), due + 5);
      rec.liveTimer.unref?.();
      return null;
    }
    const answers = pendingAnswers(rec.state);
    const part = { ...rec.spec, questions: rec.spec.questions.filter((q) => answers[q.id]) };
    const total = rec.spec.questions.length;
    append(rec, "batch", { answers, digest: digest(part, { answers }), answered: Object.keys(rec.state.answers ?? {}).filter((k) => rec.state.answers[k] && Object.keys(rec.state.answers[k]).length).length, total });
    return deliverable(rec, rec.state.outbox.at(-1));
  }

  // Something new for the held waiter: hand it over. What could not be handed over is tried again on
  // the next change (a batch that could not be saved is cut then).
  function offer(rec) {
    const w = rec.held;
    if (!w) return;
    let item = null;
    try {
      item = take(rec, w.events);
    } catch (err) {
      const what = err.status === 507 ? "the batch could not be saved, it is cut on the next try" : "the waiting agent's next item could not be prepared, it is tried again on the next change";
      warn(`decide: round ${rec.id}: ${what}: ${err.message}`);
    }
    if (item) release(rec, w, item);
  }

  function release(rec, w, value) {
    if (rec.held !== w) return;
    clearTimeout(w.timer);
    w.signal?.removeEventListener("abort", w.onAbort);
    rec.held = null;
    rec.lastWaiter = now();
    w.resolve(value);
    tell("change");
  }

  // The first item the agent has not acknowledged, or wait for one. One waiter is held per round:
  // a different waiter id supersedes it. A finished round answers at once, acknowledged or not.
  // signal (optional): an AbortSignal that frees the waiter when the agent's request goes away.
  function next(round, { waiter = "", events = false, timeoutMs = WAIT_MS, signal } = {}) {
    let rec;
    let ready;
    const id = String(waiter ?? "");
    try {
      rec = recOf(round);
      // First, so a held waiter gets the end of a round that the reopen brings back. Best effort: a
      // reader still gets what is in memory; a batch to cut needs the log and says 507.
      try {
        sync(rec);
      } catch {}
      if (rec.held) release(rec, rec.held, rec.held.id !== id ? { superseded: true } : null);
      rec.lastWaiter = now();
      ready = take(rec, events);
    } catch (err) {
      return Promise.reject(err);
    }
    if (ready) return Promise.resolve(ready);
    if (signal?.aborted) return Promise.resolve(null);
    // The agent came back without pushing: the page stops showing it as thinking (store memory, not logged).
    if (events && !rec.idle) {
      rec.idle = true;
      if (rec.state.swipe?.thinking) tell("deck", rec.round);
    }
    return new Promise((resolveWait) => {
      const w = { id, events, resolve: resolveWait };
      w.timer = setTimeout(() => release(rec, w, null), Math.max(1_000, Math.min(Number(timeoutMs) || WAIT_MS, WAIT_MS)));
      w.timer.unref?.(); // a held waiter never keeps the process alive
      if (signal) {
        w.signal = signal;
        w.onAbort = () => release(rec, w, null);
        signal.addEventListener("abort", w.onAbort, { once: true });
      }
      rec.held = w;
      tell("change");
    });
  }

  // The agent has every item up to seq. A seq not above the current one (or past the log) is ignored,
  // and so is any ack on a dismissed round: its item is derived, nothing is owed.
  function ack(round, seq, waiter) {
    const rec = recOf(round);
    sync(rec);
    if (rec.state.status === "dismissed") return;
    const upTo = Number(seq);
    const before = rec.state.acked;
    if (!Number.isInteger(upTo) || upTo <= before || upTo > rec.state.lastSeq) return;
    append(rec, "acked", { upTo, waiter: String(waiter ?? "") });
    if (rec.state.dialog.some((d) => d.askSeq !== null && d.askSeq > before && d.askSeq <= upTo)) tell("dialog", rec.round);
    tell("change");
  }

  // ---- 3.0 rounds that react: the view, the agent's patch, the user's restore and keep

  // The question round as it looks now (view.mjs); null for a swipe round. Recomputed per call: pure and cheap.
  function viewRec(rec) {
    if (rec.meta.mode === "swipe") return null;
    return roundView(rec.spec, rec.state.trail ?? []);
  }
  const roundViewOf = (round) => viewRec(recOf(round));

  // patch {ops, reason?, override?, keepAnswers?}: refused (400, with the list) when validatePatch finds errors.
  function patch(round, body = {}) {
    const rec = recOf(round);
    sync(rec);
    openOnly(rec);
    if (rec.meta.mode === "swipe") throw refuse("patch works on question rounds; a swipe deck changes through push", 409);
    const p = { ops: body.ops, ...(body.reason != null ? { reason: String(body.reason) } : {}), ...(body.override === true ? { override: true } : {}), ...(body.keepAnswers === true ? { keepAnswers: true } : {}) };
    const issues = validatePatch(viewRec(rec), p);
    const errors = issues.filter((i) => i.level === "error");
    if (errors.length) throw Object.assign(refuse(`patch refused: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`), { issues });
    const event = append(rec, "patch", p);
    const view = viewRec(rec);
    tell("view", rec.round, view, event.seq);
    tell("change");
    return { seq: event.seq, view, warnings: issues.filter((i) => i.level !== "error").map((i) => `${i.path}: ${i.message}`) };
  }

  function userMark(type, field) {
    return (round, id) => {
      const rec = recOf(round);
      sync(rec);
      openOnly(rec);
      if (rec.meta.mode === "swipe") throw refuse(`${type} works on question rounds`, 409);
      const key = String(id ?? "");
      if (!viewRec(rec).items.some((e) => e.id === key)) throw refuse("unknown question");
      const event = append(rec, type, { [field]: key });
      const view = viewRec(rec);
      tell("view", rec.round, view, event.seq);
      return { seq: event.seq, view };
    };
  }
  const restore = userMark("restore", "id");
  const keep = userMark("keep", "qid");

  // ---- views

  const listening = (round) => listeningRec(recOf(round));

  // `thinking` is the state's, unless an agent came back with nothing to deliver since the last batch.
  function swipeView(round) {
    const rec = recOf(round);
    const view = viewOf(rec.state);
    return view && { ...structuredClone(view), thinking: view.thinking && !rec.idle };
  }

  const publicDialog = (round) => dialogOut(recOf(round));

  // Files the user attached to this round: path → {url, name, type}. Served while the round is open.
  const files = (round) => {
    const rec = recOf(round);
    return owned(rec, () => Object.fromEntries(Object.entries(rec.state.files).filter(([p]) => existsSync(p)).map(([p, f]) => [p, { url: roots.publishFile(p), name: f.name, type: f.mime }])));
  };

  // ---- the inbox: open rounds of every project, the one to answer first on top

  // answered / total as the page counts them (logic.js progressOf): visible questions counted, a flag
  // beside the answer (later, none) counting one too; a deck counts its answered cards.
  function progressOf(rec) {
    if (rec.meta.mode === "swipe") {
      const { deck, answers } = rec.state.swipe;
      return { answered: deck.cards.filter((c) => answers[c.id]).length, total: deck.cards.length };
    }
    try {
      const full = pageAnswers(rec);
      const counted = rec.spec.questions.filter((q) => isVisible(q, full));
      return { answered: counted.filter((q) => rec.state.flags[q.id] || isCounted(q, full[q.id])).length, total: counted.length };
    } catch {
      return { answered: 0, total: rec.spec.questions.length };
    }
  }

  const stakesOf = (rec) => (itemsOf(rec).some((q) => q.stakes === "high") ? "high" : null);
  const nameOf = (root) => basename(String(root || "")) || String(root || "");

  // Not older first: high stakes, then the longest waiting (oldest first); then the older group, the
  // same way. Older: no agent has listened for a day (the last waiter, or the last thing the agent did).
  function inbox() {
    const t = now();
    const rows = pendingRecs().map((rec) => {
      const listens = listeningRec(rec);
      const heard = Math.max(rec.lastWaiter || 0, rec.state.agentAt || 0);
      const createdAt = Date.parse(rec.meta.createdAt);
      return {
        id: rec.id,
        project: rec.meta.project,
        projectName: nameOf(rec.meta.top || rec.meta.project),
        title: rec.state.title,
        mode: rec.meta.mode,
        ...progressOf(rec),
        listening: listens,
        stakes: stakesOf(rec),
        createdAt,
        waitingSince: createdAt,
        older: !listens && t - heard > OLDER_MS,
      };
    });
    const order = (a, b) => Number(a.older) - Number(b.older) || Number(b.stakes === "high") - Number(a.stakes === "high") || a.waitingSince - b.waitingSince || a.id.localeCompare(b.id);
    return { rounds: rows.sort(order) };
  }

  const summary = () => ({
    rounds: pendingRecs().map((r) => ({
      id: r.id,
      title: r.state.title,
      mode: r.meta.mode,
      createdAt: Date.parse(r.meta.createdAt),
      count: itemsOf(r).length,
      live: r.meta.live,
      waiting: r.held !== null,
      listening: listeningRec(r),
      project: r.meta.project,
      stakes: stakesOf(r),
    })),
    // Answers not picked up yet: the page shows whether the agent is still around to take them.
    history: [...recs.values()]
      .filter((r) => FINAL.has(r.state.status))
      .map((r) => ({ r, at: String(r.state.result?.submittedAt ?? "") }))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, HISTORY)
      .map(({ r, at }) => {
        const entry = { id: r.id, title: r.state.title, status: r.state.status, at, digest: r.state.result?.digest || "", delivered: delivered(r), project: r.meta.project };
        return entry.delivered ? entry : { ...entry, listening: listeningRec(r) };
      }),
  });

  // Frees every held waiter and closes the logs; the store is not used after this.
  function close() {
    for (const rec of recs.values()) {
      if (rec.held) release(rec, rec.held, null);
      try {
        rec.log.close();
      } catch {}
    }
    recs.clear();
  }

  // "I have N minutes": the spec keeps the questions that fit; the rest are listed as left out. Saved with the round.
  function refit(round, keep, leftOut, minutes) {
    const rec = recOf(round);
    const ids = new Set(keep);
    rec.spec.questions = rec.spec.questions.filter((q) => ids.has(q.id));
    rec.spec.leftOut = [...(rec.spec.leftOut || []), ...leftOut];
    rec.spec.budget = minutes;
    rec.specPub = null;
    try {
      writeAtomic(join(rec.dir, "spec.json"), JSON.stringify(rec.spec), PRIVATE);
    } catch {}
    tell("change");
  }


  return { load, create, get, pending, summary, refit, inbox, files, saveDraft, saveAnswer, saveNote, saveFlag, saveUpload, ask, explain, swipeAnswer, push, deeper, finish, dismiss, next, ack, listening, swipeView, publicDialog, close, roundView: roundViewOf, patch, restore, keep };
}
