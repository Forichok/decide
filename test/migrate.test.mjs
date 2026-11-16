// Format numbers and migrate-on-read: 2.0 and 2.1 specs, answers files and journals keep opening, and
// reading never writes. Fixtures: test/fixtures/2.0 and 2.1 (examples of v2.0.0 and f62a924, and the
// answers files and journal those versions wrote in a scratch home).

import "./helpers.mjs";
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkAnswers } from "../lib/answers.mjs";
import { appendJournal, findDecision, overlaps, readJournal, supersedeJournal } from "../lib/journal.mjs";
import { ANSWERS_FORMAT, JOURNAL_FORMAT, SPEC_FORMAT, migrateAnswers, migrateEntry, migrateSpec } from "../lib/migrate.mjs";
import { normalizeSpec } from "../lib/spec.mjs";
import { normalizeDeck } from "../lib/swipe.mjs";
import { digest } from "../ui/js/logic.js";
import { readJournal as readJournal21 } from "./fixtures/2.1/journal-reader.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");
const examples = path.join(here, "..", "examples");
const VERSIONS = ["2.0", "2.1"];
const fx = (v, name) => path.join(fixtures, v, name);
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const errorsOf = (issues) => issues.filter((i) => i.level === "error").map((i) => `${i.where}: ${i.message}`);

function scratch(context) {
  const dir = mkdtempSync(path.join(tmpdir(), "decide-migrate-"));
  context.after(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
}

// A directory holding a fixture's journal as journal.jsonl, the way a 2.x data dir has it.
function legacyDir(context, version) {
  const dir = path.join(scratch(context), version);
  mkdirSync(dir);
  copyFileSync(fx(version, "journal.jsonl"), path.join(dir, "journal.jsonl"));
  return dir;
}

// Name, size, mtime and content of every file under a directory.
function snapshot(dir) {
  const out = {};
  for (const name of readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, name);
    const st = statSync(file);
    out[name] = st.isDirectory() ? "dir" : `${st.size}:${st.mtimeMs}:${readFileSync(file, "utf8")}`;
  }
  return out;
}

test("the format numbers are 3 and the plugin version is 2.2.0", async () => {
  assert.deepEqual([SPEC_FORMAT, ANSWERS_FORMAT, JOURNAL_FORMAT], [3, 3, 3]);
  const { VERSION } = await import("../lib/server.mjs");
  assert.equal(VERSION, "2.2.0");
});

test("every 2.0 and 2.1 spec fixture opens with no error", () => {
  for (const v of VERSIONS) {
    for (const name of ["showcase.questions.json", "showcase.ru.questions.json"]) {
      const raw = json(fx(v, name));
      const { spec, issues } = normalizeSpec(raw, { specDir: examples });
      assert.deepEqual(errorsOf(issues), [], `${v}/${name}`);
      assert.ok(spec.questions.length > 5, `${v}/${name}`);
      const lenient = normalizeSpec(raw, { specDir: examples, fields: "lenient" });
      assert.deepEqual(errorsOf(lenient.issues), [], `${v}/${name} lenient`);
    }
    const deck = normalizeDeck(json(fx(v, "swipe.deck.json")), { specDir: examples });
    assert.deepEqual(errorsOf(deck.issues), [], `${v}/swipe.deck.json`);
    assert.ok(deck.deck.cards.length > 5);
  }
});

test("migrateSpec: pure, says where the spec came from, and stamps format 3", () => {
  const plain = { title: "T", questions: [{ id: "a", title: "A", options: ["x", "y"] }] };
  const before = JSON.stringify(plain);
  const { spec, from } = migrateSpec(plain);
  assert.equal(JSON.stringify(plain), before, "the input is untouched");
  assert.equal(from, 2, "a spec with no format and no 1.x spelling is a 2.x spec");
  assert.equal(spec.format, 3);
  assert.notEqual(spec, plain);
  assert.equal(migrateSpec({ ...plain, format: 3 }).from, 3);
  assert.equal(migrateSpec({ ...plain, format: 2 }).from, 2);
  assert.equal(migrateSpec({ ...plain, format: 1 }).from, 1);
});

test("migrateSpec step 1 to 2: the older singular image of an option becomes images, everything else stays", () => {
  const raw = {
    $schema: "https://example.com/decide.schema.json",
    title: "T",
    questions: [
      { id: "a", title: "A", note: true, options: [{ id: "x", label: "X", recommended: true, image: "a.png" }, { id: "y", label: "Y", image: "b.png", images: ["c.png"] }] },
    ],
  };
  const { spec, from } = migrateSpec(raw);
  assert.equal(from, 1);
  const [x, y] = spec.questions[0].options;
  assert.deepEqual(x.images, ["a.png"]);
  assert.equal("image" in x, false);
  assert.deepEqual(y.images, ["b.png", "c.png"], "image first, then images: the order the engine reads them in");
  assert.equal(spec.$schema, raw.$schema, "$schema is left alone");
  assert.equal(spec.questions[0].note, true);
  assert.equal(x.recommended, true);
  assert.equal(raw.questions[0].options[0].image, "a.png", "the input is untouched");
});

test("migrateSpec step 2 to 3: what, how, goal and then become one more, why stays, the input is untouched", () => {
  const raw = {
    title: "T",
    questions: [
      { id: "a", title: "A", why: "Because", what: "It is X.", how: "By Y.", goal: "For Z.", then: "We build W.", options: ["x", "y"] },
      { id: "b", title: "B", more: "Already here.", what: "W", options: ["x", "y"] },
      { id: "c", title: "C", why: "Only why", options: ["x", "y"] },
    ],
  };
  const before = JSON.stringify(raw);
  const { spec, from } = migrateSpec(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(from, 2);
  const [a, b, c] = spec.questions;
  assert.equal(a.why, "Because");
  assert.equal(a.more, "**What.** It is X.\n\n**How.** By Y.\n\n**Goal.** For Z.\n\n**What happens next.** We build W.");
  for (const k of ["what", "how", "goal", "then"]) assert.equal(k in a, false, k);
  assert.equal(b.more, "Already here.\n\n**What.** W", "a `more` already there comes first");
  assert.equal("more" in c, false);
  assert.equal(c.why, "Only why");
  // A spec that says it is format 3 is not rewritten.
  assert.equal(migrateSpec({ ...raw, format: 3 }).spec.questions[0].what, "It is X.");
  // Russian text gets Russian labels.
  const ru = migrateSpec({ title: "Т", questions: [{ id: "a", title: "Что делаем?", what: "Это X.", then: "Дальше W.", options: ["x"] }] }).spec;
  assert.equal(ru.questions[0].more, "**Что.** Это X.\n\n**Что будет дальше.** Дальше W.");
});

test("the 2.0 and 2.1 showcases keep their folded points: they open as `more`, in both languages", () => {
  for (const v of VERSIONS) {
    for (const name of ["showcase.questions.json", "showcase.ru.questions.json"]) {
      const raw = json(fx(v, name));
      const folded = raw.questions.filter((q) => q.what || q.how || q.goal || q.then);
      assert.ok(folded.length, `${v}/${name} has folded points`);
      const { spec, issues } = normalizeSpec(raw, { specDir: examples });
      assert.deepEqual(errorsOf(issues), [], `${v}/${name}`);
      for (const q of folded) {
        const now = spec.questions.find((x) => x.id === q.id);
        for (const k of ["what", "how", "goal", "then"]) if (q[k]) assert.ok(now.more.includes(q[k].trim()), `${v}/${name} ${q.id}: ${k} is in more`);
        assert.equal(now.why, (q.why || "").trim(), "why stays");
        assert.equal("what" in now, false);
      }
    }
  }
});

test("a 1.x spelling and the migrated spelling normalise to the same round, with no unknown-field issue", () => {
  const old = { title: "T", questions: [{ id: "a", title: "A", note: true, options: [{ id: "x", label: "X", recommended: true, image: "showcase.assets/home-list.png" }, "y"] }] };
  const fresh = JSON.parse(JSON.stringify(old));
  fresh.questions[0].options[0].images = [fresh.questions[0].options[0].image];
  delete fresh.questions[0].options[0].image;
  const a = normalizeSpec(old, { specDir: examples });
  const b = normalizeSpec(fresh, { specDir: examples });
  assert.deepEqual(a.spec, b.spec);
  assert.deepEqual(a.issues.filter((i) => /unknown field/.test(i.message)), []);
});

test("migrateSpec runs before the strict check: a format stamp is not an unknown field, a misspelling still is", () => {
  const ok = normalizeSpec({ format: 3, title: "T", questions: [{ id: "a", title: "A", options: ["x", "y"] }] });
  assert.deepEqual(errorsOf(ok.issues), []);
  const bad = normalizeSpec({ title: "T", questions: [{ id: "a", title: "A", options: [{ label: "x", descripton: "d" }, "y"] }] });
  assert.match(errorsOf(bad.issues)[0], /unknown field "descripton"/);
  // Names 2.1 ignored are not rewritten into known ones: no alias.
  const desc = normalizeSpec({ title: "T", questions: [{ id: "a", title: "A", options: [{ label: "x", description: "d" }, "y"] }] });
  assert.match(errorsOf(desc.issues)[0], /unknown field "description"/);
});

test("a spec of a newer format says to update decide, not that format is an unknown field", () => {
  for (const fields of ["strict", "lenient"]) {
    const out = normalizeSpec({ format: 4, title: "T", questions: [{ id: "a", title: "A", options: ["x", "y"] }] }, { fields });
    const errors = errorsOf(out.issues);
    assert.deepEqual(errors, ["round: format 4 is newer than this decide (3); update decide"], fields);
    assert.doesNotMatch(JSON.stringify(out.issues), /unknown field "format"/, fields);
  }
  // A number that is no format at all is still a name nobody reads.
  assert.match(errorsOf(normalizeSpec({ format: "x", title: "T", questions: [{ id: "a", title: "A", options: ["x", "y"] }] }).issues)[0], /unknown field "format"/);
});

test("2.x answers files read as format 3 and are not rewritten", (t) => {
  const dir = scratch(t);
  for (const v of VERSIONS) {
    for (const name of ["showcase.answers.json", "swipe.answers.json"]) {
      const file = path.join(dir, `${v}-${name}`);
      copyFileSync(fx(v, name), file);
      const before = { text: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs };
      const raw = JSON.parse(before.text);
      const out = migrateAnswers(raw);
      assert.equal(out.format, 3, `${v}/${name}`);
      assert.equal(out.version, 2, "the 2.x stamp stays");
      assert.deepEqual(out.answers, raw.answers);
      assert.equal(raw.format, undefined, "pure: the input is not changed");
      assert.equal(readFileSync(file, "utf8"), before.text);
      assert.equal(statSync(file).mtimeMs, before.mtime);
    }
  }
  assert.deepEqual(migrateAnswers({ format: 3, answers: {} }), { format: 3, answers: {} });
  assert.equal(migrateAnswers(null), null);
});

test("checkAnswers takes a 2.x answers file for its round", () => {
  for (const v of VERSIONS) {
    const { spec } = normalizeSpec(json(fx(v, "showcase.questions.json")), { specDir: examples });
    const file = json(fx(v, "showcase.answers.json"));
    const checked = checkAnswers(spec, file);
    assert.deepEqual(checked.errors, []);
    assert.deepEqual(Object.keys(checked.answers).sort(), Object.keys(file.answers).sort());
  }
});

test("a 2.0 and a 2.1 journal read as format 3 with one record per question, and are not rewritten", (t) => {
  for (const v of VERSIONS) {
    const dir = legacyDir(t, v);
    const before = snapshot(dir);
    const entries = readJournal({ dataDir: dir, legacyDirs: [] });
    assert.equal(entries.length, 2, v);
    for (const e of entries) {
      assert.equal(e.format, 3);
      assert.ok(e.records.length >= 1);
      for (const r of e.records) {
        assert.equal(typeof r.id, "string");
        assert.ok(r.id.startsWith(`${e.round}/`), r.id);
        assert.equal(typeof r.answer, "string");
        assert.ok(!r.answer.includes("\n"));
      }
    }
    const tour = entries.find((e) => e.mode !== "swipe" && /tour/.test(e.title));
    const goal = tour.records.find((r) => r.id === `${tour.round}/goal`);
    assert.match(goal.answer, /Due/i);
    assert.deepEqual(snapshot(dir), before, `${v}: reading wrote nothing`);
  }
});

test("a 2.1 journal reads; a 3.0 line is readable by the 2.1 reader", (t) => {
  const dir = scratch(t);
  const raw = json(fx("2.1", "showcase.questions.json"));
  const { spec } = normalizeSpec(raw, { specDir: examples });
  const result = { round: "9-abcdef", title: spec.title, source: "x.questions.json", submittedAt: "2026-11-16T10:00:00.000Z", answers: { goal: { selected: ["due"] } } };
  result.digest = digest(spec, result);
  appendJournal(dir, { mode: "questions", spec, specFile: "/s/x.questions.json", outPath: "/s/x.answers.json" }, result);
  const line = JSON.parse(readFileSync(path.join(dir, "journal.jsonl"), "utf8").trim());
  assert.equal(line.format, JOURNAL_FORMAT);
  // The 2.x fields are what they were.
  assert.deepEqual(Object.keys(line).filter((k) => !["format", "records", "edges"].includes(k)), ["at", "round", "title", "mode", "source", "spec", "answers", "questions", "digest"]);
  const old = readJournal21(dir);
  assert.equal(old.length, 1);
  assert.equal(old[0].round, "9-abcdef");
  assert.equal(old[0].digest, result.digest);
  assert.deepEqual(old[0].questions, spec.questions.map((q) => q.title));
  // And the 2.1 journal of the fixture is read by the 3.0 reader the same way.
  assert.equal(readJournal({ dataDir: legacyDir(t, "2.1"), legacyDirs: [] }).length, readJournal21(legacyDir(t, "2.1")).length);
});

test("a journal entry carries one record per question with a stable id", (t) => {
  const dir = scratch(t);
  const { spec } = normalizeSpec(json(fx("2.1", "showcase.questions.json")), { specDir: examples });
  const result = {
    round: "3-0a0a0a",
    title: spec.title,
    submittedAt: "2026-11-16T10:00:00.000Z",
    answers: { goal: { selected: ["due"], note: "n" }, rollout: { flag: "delegate" }, share: { flag: "skip" }, features: { selected: ["remind", "share"] } },
  };
  result.digest = digest(spec, result);
  appendJournal(dir, { mode: "questions", spec, specFile: "/s/x.questions.json", outPath: "/s/x.answers.json" }, result);
  const [entry] = readJournal({ dataDir: dir, legacyDirs: [] });
  assert.equal(entry.format, 3);
  assert.deepEqual(entry.records.map((r) => r.id), spec.questions.map((q) => `3-0a0a0a/${q.id}`), "one per question, in spec order, ids are round/question");
  assert.deepEqual(entry.records.map((r) => r.title), spec.questions.map((q) => q.title));
  const by = Object.fromEntries(entry.records.map((r) => [r.id.split("/")[1], r]));
  // The answer is what the agent's digest line says after the arrow.
  for (const id of ["goal", "rollout", "share", "features"]) {
    const line = result.digest.split("\n").find((l) => l.includes(`[${id}]`));
    assert.equal(line.split(" → ")[1].replace(/ \(theirs to decide.*$/, ""), by[id].answer, id);
  }
  assert.equal(by.rollout.flag, "delegate");
  assert.equal(by.share.flag, "skip");
  assert.equal("flag" in by.goal, false);
  assert.equal(by.order.answer, "—", "an unanswered question has a record too");
  // Same entry written again gets the same ids.
  const again = scratch(t);
  appendJournal(again, { mode: "questions", spec, specFile: "/s/x.questions.json", outPath: "/s/x.answers.json" }, result);
  assert.deepEqual(readJournal({ dataDir: again, legacyDirs: [] })[0].records, entry.records);
});

test("a swipe entry has a record per answered card", (t) => {
  const dir = scratch(t);
  const { deck } = normalizeDeck(json(fx("2.1", "swipe.deck.json")), { specDir: examples });
  const answers = JSON.parse(readFileSync(fx("2.1", "swipe.answers.json"), "utf8"));
  appendJournal(dir, { mode: "swipe", spec: deck, specFile: "/s/d.json", outPath: "/s/d.answers.json" }, answers);
  const [entry] = readJournal({ dataDir: dir, legacyDirs: [] });
  const ids = Object.keys(answers.answers);
  assert.deepEqual(entry.records.map((r) => r.id), ids.map((id) => `${answers.round}/${id}`));
  assert.equal(entry.records.find((r) => r.id.endsWith("/onboarding")).flag, "skip");
  assert.match(entry.records.find((r) => r.id.endsWith("/home")).answer, /List/);
  assert.ok(entry.records.every((r) => !r.answer.includes("\n")));
});

test("a swipe own answer keeps the user's text in its record, as the digest says it", (t) => {
  const { deck } = normalizeDeck(json(fx("2.1", "swipe.deck.json")), { specDir: examples });
  const answers = json(fx("2.1", "swipe.answers.json"));
  const dir = scratch(t);
  appendJournal(dir, { mode: "swipe", spec: deck, specFile: "/s/d.json", outPath: "/s/d.answers.json" }, answers);
  const [entry] = readJournal({ dataDir: dir, legacyDirs: [] });
  const line = answers.digest.split("\n").find((l) => l.includes("[density]"));
  const rec = entry.records.find((r) => r.id.endsWith("/density"));
  assert.equal(rec.answer, line.split(" → ")[1]);
  assert.match(rec.answer, /Neither: ask in the first run\./);
  // A 3.0 result stores an own answer as {side: "own", label: text}, the same.
  const own = { ...answers, round: "7-abcdef", answers: { density: { side: "own", label: "Compact, but ask me" } } };
  const other = scratch(t);
  appendJournal(other, { mode: "swipe", spec: deck, specFile: "/s/d.json", outPath: "/s/d.answers.json" }, own);
  assert.match(readJournal(other)[0].records[0].answer, /«Compact, but ask me»/);
});

test("migrateEntry: pure, adds format and records, keeps a 3.0 entry as it is", () => {
  const old = JSON.parse(readFileSync(fx("2.1", "journal.jsonl"), "utf8").split("\n")[0]);
  const before = JSON.stringify(old);
  const out = migrateEntry(old);
  assert.equal(JSON.stringify(old), before);
  assert.equal(out.format, 3);
  assert.equal(out.digest, old.digest);
  assert.ok(out.records.length > 0);
  assert.deepEqual(migrateEntry(out), out);
});

test("a worktree's old journal is merged in and de-duplicated by round id", (t) => {
  const main = scratch(t);
  const legacy = legacyDir(t, "2.1");
  const second = legacyDir(t, "2.0");
  const project = { dataDir: main, legacyDirs: [legacy, second] };
  const old = readJournal21(legacy);
  assert.equal(readJournal(project).length, 2 + 2, "two from each legacy directory");
  // The same round id in the main dir: the main entry wins, once.
  const dup = { at: "2026-11-17T09:00:00.000Z", round: old[0].round, title: "Main wins", mode: "questions", questions: ["Q"], digest: "1. [q] Q → A", format: 3, records: [] };
  writeFileSync(path.join(main, "journal.jsonl"), `${JSON.stringify(dup)}\n`);
  const all = readJournal(project, { limit: 50 });
  assert.equal(all.length, 4);
  assert.equal(all.filter((e) => e.round === old[0].round).length, 1);
  assert.equal(all.find((e) => e.round === old[0].round).title, "Main wins");
  assert.equal(all[0].round, old[0].round, "newest first across directories");
  assert.equal(findDecision(project, old[1].round).round, old[1].round);
  assert.equal(findDecision(project, "nope"), null);
  assert.equal(findDecision({ dataDir: main, legacyDirs: [] }, old[1].round), null, "without the legacy dir it is not there");
  const older = readJournal21(second)[0];
  const asked = older.questions[0];
  assert.ok(overlaps(project, [asked]).some((h) => h.entry.round === older.round), "a decision of a legacy dir warns about a question like it");
  assert.equal(overlaps({ dataDir: main, legacyDirs: [] }, [asked]).length, 0);
});

test("a supersede line in the main dir folds onto an entry that lives in a legacy dir", (t) => {
  const main = scratch(t);
  const legacy = legacyDir(t, "2.1");
  const project = { dataDir: main, legacyDirs: [legacy] };
  const target = readJournal(project).find((e) => !e.superseded);
  const marked = supersedeJournal(project, { round: target.round, reason: "changed" });
  assert.equal(marked.superseded.reason, "changed");
  assert.equal(readJournal(project).find((e) => e.round === target.round).superseded.reason, "changed");
  assert.equal(readJournal(project, { status: "live" }).some((e) => e.round === target.round), false);
});

test("3.0 never writes into a legacy dir", (t) => {
  const main = scratch(t);
  const legacy = legacyDir(t, "2.1");
  const before = snapshot(legacy);
  const project = { dataDir: main, legacyDirs: [legacy] };
  const { spec } = normalizeSpec(json(fx("2.1", "showcase.questions.json")), { specDir: examples });
  const result = { round: "4-111111", title: spec.title, submittedAt: "2026-11-17T10:00:00.000Z", answers: { goal: { selected: ["due"] } } };
  result.digest = digest(spec, result);
  readJournal(project);
  findDecision(project, "x");
  overlaps(project, ["anything at all about the screens"]);
  appendJournal(project.dataDir, { mode: "questions", spec, specFile: "/s/x", outPath: "/s/x.a" }, result);
  supersedeJournal(project, { round: readJournal21(legacy)[0].round, reason: "r" });
  assert.deepEqual(snapshot(legacy), before);
  const written = readFileSync(path.join(main, "journal.jsonl"), "utf8").trim().split("\n");
  assert.equal(written.length, 2, "the entry and the supersede line");
  assert.deepEqual(readdirSync(path.dirname(legacy)).sort(), ["2.1"]);
});

test("appendJournal still appends to a plain data dir path and a torn line does not hide the rest", (t) => {
  const dir = scratch(t);
  appendFileSync(path.join(dir, "journal.jsonl"), '{"at":"2026-01-01T00:00:00.000Z","round":"1-aaaaaa","title":"Old","questions":["Q"],"digest":"1. [q] Q → A"}\n{"at":"2026-01\n');
  assert.equal(readJournal(dir).length, 1, "a data dir path is still accepted");
  assert.equal(readJournal({ dataDir: dir, legacyDirs: [] })[0].format, 3);
});
