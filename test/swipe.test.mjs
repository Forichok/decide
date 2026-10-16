/**
 * Feature:    swipe interview (/decide:swipe)
 * Layer:      deck normalization and patching (pure), daemon swipe rounds, MCP swipe → wait → push
 * Contract:   skills/swipe/SKILL.md
 * Covers:
 *   - A card has exactly two sides; options, missing sides and bad ids are lint errors
 *   - push adds (next / end), replaces and removes only open cards; answered cards stay as they were
 *   - Batches carry only what changed since the last one: a re-answer counts once, an undo of an unseen answer not at all
 *   - A batch comes early when the deck runs out; the brief and new cards reach the page; done marks the deck finished
 *   - Finishing writes the answers JSON, a markdown brief and a journal entry
 * Why exists: the agent steers the whole interview through these batches; a lost or doubled answer derails it.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { applyPatch, batchDigest, briefMarkdown, normalizeDeck, normalizePatch } from "../lib/swipe.mjs";
import { envOf, pluginDir, scratchDir, WRITE } from "./helpers.mjs";

const card = (id, title, rec = "left") => ({ id, title, left: { label: `${id}-L` }, right: { label: `${id}-R` }, recommended: rec });
const deckRaw = {
  title: "Worms с акулами",
  goal: "Игра в духе Worms с акулами hexhaven",
  batch: 2,
  cards: [card("turns", "Ходы по очереди?"), card("land", "Акулы ходят по суше?", "right"), card("online", "Играть онлайн?")],
};

test("a deck card has exactly two sides", () => {
  const { deck, issues } = normalizeDeck(deckRaw);
  assert.equal(issues.filter((i) => i.level === "error").length, 0);
  assert.deepEqual([deck.mode, deck.lang, deck.batch, deck.cards.length], ["swipe", "ru", 2, 3]);
  assert.equal(deck.cards[1].recommended, "right");

  const bad = normalizeDeck({ cards: [{ id: "x", title: "?", options: [{ label: "a" }] }, { id: "x", title: "", left: "да", right: "нет" }] });
  const errors = bad.issues.filter((i) => i.level === "error").map((i) => i.message);
  assert.ok(errors.some((m) => /exactly two sides/.test(m)));
  assert.ok(errors.some((m) => /needs a left side/.test(m)));
  assert.ok(errors.some((m) => /duplicate card id "x"/.test(m)));
  assert.ok(errors.some((m) => /needs a title/.test(m)));
  assert.equal(bad.deck.cards[1].left.label, "да", "a side may be a bare string");
  assert.equal(normalizeDeck({ title: "t" }).deck, null);
});

test("push touches only open cards", () => {
  const { deck } = normalizeDeck(deckRaw);
  const answered = new Set(["turns"]);
  const { patch } = normalizePatch({
    add: [card("weapons", "Своё оружие?")],
    position: "next",
    replace: [card("turns", "Другой текст"), card("land", "Акулы выходят на сушу?")],
    remove: ["online", "turns", "nope"],
    brief: [{ kind: "risk", text: "Тач-прицеливание" }, "Пошаговый бой"],
    confidence: 140,
  });
  const res = applyPatch(deck, answered, patch);
  assert.deepEqual(res.deck.cards.map((c) => c.id), ["turns", "weapons", "land"]);
  assert.equal(res.deck.cards[0].title, "Ходы по очереди?", "answered cards are history");
  assert.equal(res.deck.cards[2].title, "Акулы выходят на сушу?");
  assert.equal(res.deck.confidence, 100);
  assert.deepEqual(res.deck.brief.map((b) => [b.kind, b.text]), [["risk", "Тач-прицеливание"], ["decision", "Пошаговый бой"]]);
  const warned = res.issues.map((i) => i.message).join("\n");
  assert.match(warned, /replace: "turns" is already answered/);
  assert.match(warned, /remove: "turns" is already answered/);
  assert.match(warned, /remove: no card "nope"/);
  assert.equal(applyPatch(res.deck, answered, normalizePatch({ add: [card("weapons", "?")] }).patch).added, 0, "an existing id is not added twice");
  assert.equal(res.deck.cards[2].rev, 1, "a replaced card gets a new revision");
  assert.match(normalizePatch({ add: [{ title: "?", left: "a", right: "b" }] }).issues[0].message, /needs an id/);

  const md = briefMarkdown(res.deck, { turns: { side: "left" }, land: { side: "skip" } });
  assert.match(md, /^# Worms с акулами/);
  assert.match(md, /## Риски\n\n- Тач-прицеливание/);
  assert.match(md, /- Ходы по очереди\? → turns-L/);
  assert.match(md, /- Акулы выходят на сушу\? → _пропущено_/);
  assert.match(batchDigest(res.deck, [{ card: "land", side: "right" }]), /\(against the recommendation\)/);
});

function rpcClient(child) {
  const pending = new Map();
  let buf = "";
  let next = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) {
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    }
  });
  return (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
}

test("MCP: swipe → batches → push → finish", async (context) => {
  const dir = await scratchDir(context);
  const child = spawn(process.execPath, [path.join(pluginDir, "mcp.mjs")], { cwd: pluginDir, env: envOf(dir, { CLAUDE_PROJECT_DIR: "" }), stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => child.kill());
  const rpc = rpcClient(child);
  const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
  const text = (result) => result.content.map((c) => c.text).join("\n");
  const post = (url, route, body) => fetch(`${url}${route}`, { method: "POST", headers: WRITE, body: JSON.stringify(body) });

  const bad = await call("swipe", { project: dir, spec: { title: "t", cards: [{ id: "a", title: "?", left: "x" }] }, open: false });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /needs a right side/);

  const opened = await call("swipe", { project: dir, spec: deckRaw, open: false });
  assert.equal(opened.isError, undefined, text(opened));
  const [, round, url] = text(opened).match(/Swipe round (\S+) .+: (http:\/\/127\.0\.0\.1:\d+\/)/);
  const swipe = (body) => post(url, `api/rounds/${round}/swipe`, body);
  const view = async () => (await fetch(`${url}api/rounds/${round}`)).json();

  assert.equal((await view()).mode, "swipe");
  assert.equal((await swipe({ card: "nope", side: "left" })).status, 400);
  assert.equal((await swipe({ card: "turns", side: "up" })).status, 400);
  assert.equal((await post(url, `api/rounds/${round}/ask`, { question: "land", text: "А что за суша?" })).status, 200, "swipe rounds are always live");
  assert.match(text(await call("wait", { project: dir, round, timeoutSec: 5 })), /\[land\][\s\S]+А что за суша\?/);
  await call("explain", { project: dir, round, question: "land", text: "Острова посреди моря." });

  // turns: left → right (counts once); land: left then undone before the agent saw it (counts not at all).
  await swipe({ card: "turns", side: "left" });
  await swipe({ card: "turns", side: "right" });
  await swipe({ card: "land", side: "left" });
  await swipe({ card: "land", undo: true });
  assert.match(text(await call("wait", { project: dir, round, timeoutSec: 1 })), /Still waiting/, "one real answer is under the batch size");
  await swipe({ card: "online", side: "skip" });
  const first = text(await call("wait", { project: dir, round, timeoutSec: 5 }));
  assert.match(first, /Batch 1 .+: 2 new answers; 2 answered, 1 left in the deck of 3/);
  assert.match(first, /1\. \[turns\] Ходы по очереди\? → turns-R \(right\) \(against the recommendation\)/);
  assert.match(first, /2\. \[online\] Играть онлайн\? → skipped/);
  assert.doesNotMatch(first, /\[land\]/);
  assert.equal((await view()).swipe.thinking, true, "the page shows the agent thinking");

  const pushed = text(
    await call("push", {
      project: dir,
      round,
      add: [card("weapons", "Своё акулье оружие?")],
      position: "next",
      remove: ["turns"],
      brief: [{ kind: "decision", text: "Ходы в реальном времени" }, { kind: "open", text: "Онлайн отложен" }],
      confidence: 40,
    }),
  );
  assert.match(pushed, /1 card added; 2 answered, 2 left of 4/);
  assert.match(pushed, /remove: "turns" is already answered/);
  // The page showed land before the push replaced it: that answer is refused, not pinned to the new text.
  await call("push", { project: dir, round, replace: [card("land", "Акулы ходят по суше?", "right")] });
  assert.equal((await swipe({ card: "land", side: "left", rev: 0 })).status, 412);
  const after = await view();
  assert.deepEqual(after.spec.cards.map((c) => c.id), ["turns", "weapons", "land", "online"]);
  assert.deepEqual([after.spec.confidence, after.spec.brief.length, after.swipe.thinking, after.swipe.fresh], [40, 2, false, []]);
  assert.equal(after.spec.cards[2].rev, 1);

  // Two cards left: answering both empties the deck, and that batch comes at once.
  await swipe({ card: "weapons", side: "left" });
  await call("push", { project: dir, round, brief: [{ kind: "decision", text: "Ходы в реальном времени" }] });
  assert.deepEqual((await view()).swipe.fresh, ["weapons"], "a brief covers only answers the agent has seen");
  const waiting = call("wait", { project: dir, round, timeoutSec: 10 });
  await swipe({ card: "land", side: "right" });
  const second = text(await waiting);
  assert.match(second, /Batch 2 .+: 2 new answers; 4 answered, 0 left/);
  assert.match(second, /The deck is empty/);

  assert.match(text(await call("push", { project: dir, round, done: true, confidence: 90 })), /marked the interview done/);
  assert.equal((await view()).spec.done, true);
  await post(url, `api/rounds/${round}/submit`, {});
  const done = text(await call("wait", { project: dir, round, timeoutSec: 5 }));
  assert.match(done, /finished by the agent: 4 of 4 cards answered \(1 skipped\), confidence 90%/);
  assert.match(done, /\[land\] Акулы ходят по суше\? → land-R \(right\) ★/);
  const briefFile = done.match(/Brief \(markdown\): (.+)/)[1];
  const md = await readFile(briefFile, "utf8");
  assert.match(md, /\*\*Цель:\*\* Игра в духе Worms/);
  assert.match(md, /## Решения\n\n- Ходы в реальном времени/);
  const json = JSON.parse(await readFile(done.match(/Full JSON: (.+)/)[1], "utf8"));
  assert.deepEqual(json.answers.weapons, { side: "left", label: "weapons-L" });
  assert.deepEqual(json.dialog, [{ question: "land", ask: "А что за суша?", answer: "Острова посреди моря." }]);
  assert.match(text(await call("history", { project: dir, query: "worms" })), /Акулы ходят по суше/);
  assert.equal((await call("push", { project: dir, round, done: true })).isError, true, "push after the end is refused");
});
