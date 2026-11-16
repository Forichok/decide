/**
 * Feature:    decide-core-event-log
 * Layer:      Core unit (one file on disk, no server)
 * Contract:   lib/store/log.mjs
 * Covers:
 *   - append numbers events from 1 without gaps; read(after) returns the later ones in order
 *   - a reopened log continues the numbering
 *   - a torn last line is cut off and the next append is intact
 *   - a broken line in the middle is skipped, numbering continues from the highest good seq
 *   - a write that fails throws and adds nothing
 *   - data fields cannot overwrite seq, at or type
 *   - a failed fsync, a short write, a disk-full error and a vanished directory throw, cut the file back, and fail the log until reopened
 *   - multi-byte text round-trips; a tail torn inside a character is cut at open
 * Why exists: every answer is an event; a killed server must never lose or corrupt one.
 */

import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "./helpers.mjs"; // a scratch DECIDE_HOME for a test that names none
import { fileURLToPath } from "node:url";

const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { openLog } = await import(path.join(toolDir, "lib/store/log.mjs"));

// A scratch dir and a log in it; both are cleaned up after the test, the log closed first.
function scratch(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "decide-log-"));
  const opened = [];
  t.after(() => {
    for (const log of opened) log.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const open = (file, options) => {
    const log = openLog(file, options);
    opened.push(log);
    return log;
  };
  return { dir, file: path.join(dir, "events.jsonl"), open };
}

const seqs = (log, after) => log.read(after).map((e) => e.seq);

test("append numbers events and read returns them in order", (t) => {
  const { file, open } = scratch(t);
  const log = open(file);
  assert.equal(log.last(), 0);
  const first = log.append("opened", { title: "T" });
  log.append("answer", { id: "q1", value: "a" });
  log.append("answer", { id: "q2", value: "b" });
  assert.equal(first.seq, 1);
  assert.equal(first.type, "opened");
  assert.equal(first.title, "T");
  assert.match(first.at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.equal(log.last(), 3);
  assert.deepEqual(seqs(log), [1, 2, 3]);
  assert.deepEqual(seqs(log, 1), [2, 3]);
  assert.deepEqual(seqs(log, 3), []);
  assert.deepEqual(Object.keys(first).slice(0, 3), ["seq", "at", "type"]);
  const lines = readFileSync(file, "utf8").split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[3], "");
  assert.deepEqual(JSON.parse(lines[0]), first);
});

test("a log reopened continues the numbering", (t) => {
  const { file, open } = scratch(t);
  const a = open(file);
  a.append("one");
  a.append("two");
  a.append("three");
  a.close();
  const b = open(file);
  assert.equal(b.last(), 3);
  assert.equal(b.append("four").seq, 4);
  assert.deepEqual(seqs(open(file)), [1, 2, 3, 4]);
});

test("a torn last line is dropped and the next append is intact", (t) => {
  const { file, open } = scratch(t);
  const first = open(file);
  first.append("a");
  first.append("b");
  first.append("c");
  first.close();
  appendFileSync(file, '{"seq":4,"at":"2026-11-15T10:00:00.000Z","type":"dra'); // no newline: a killed write
  const log = open(file);
  assert.equal(log.last(), 3);
  assert.equal(log.append("draft", { draft: {} }).seq, 4);
  assert.deepEqual(seqs(open(file)), [1, 2, 3, 4]);
  assert.equal(readFileSync(file, "utf8").split("\n").length, 5);
});

test("a last line that ends with a newline but does not parse is dropped too", (t) => {
  const { file, open } = scratch(t);
  writeFileSync(file, '{"seq":1,"at":"x","type":"a"}\n{"seq":2,"at":"x","ty\n');
  const log = open(file);
  assert.equal(log.last(), 1);
  assert.equal(log.append("b").seq, 2);
  assert.deepEqual(seqs(open(file)), [1, 2]);
});

test("a broken line in the middle is skipped and numbering continues", (t) => {
  const { file, open } = scratch(t);
  writeFileSync(file, '{"seq":1,"at":"x","type":"a"}\nnot json\n\n{"seq":3,"at":"x","type":"c"}\n');
  const log = open(file);
  assert.deepEqual(seqs(log), [1, 3]);
  assert.equal(log.last(), 3);
  assert.equal(log.append("d").seq, 4);
});

test("a write that fails throws and adds nothing", (t) => {
  const { dir, open } = scratch(t);
  const log = open(path.join(dir, "never-created", "events.jsonl")); // the directory does not exist: a missing file is an empty log
  assert.equal(log.last(), 0);
  assert.throws(() => log.append("x", { a: 1 }), { code: "ENOENT" });
  assert.equal(log.last(), 0);
  assert.deepEqual(log.read(), []);
});

test("data fields cannot overwrite seq, at or type", (t) => {
  const { file, open } = scratch(t);
  const log = open(file);
  const e = log.append("real", { seq: 99, at: "yesterday", type: "fake", keep: 1 });
  assert.equal(e.seq, 1);
  assert.equal(e.type, "real");
  assert.notEqual(e.at, "yesterday");
  assert.equal(e.keep, 1);
  assert.deepEqual(open(file).read(), [e]);
});

const faultFs = (over) => ({ ...realFs, ...over });
const eio = (msg = "injected") => Object.assign(new Error(msg), { code: "EIO" });

test("a failed fsync throws, cuts the line off, and fails the log until reopened", (t) => {
  const { file, open } = scratch(t);
  let boom = false;
  const log = open(file, {
    fs: faultFs({
      fsyncSync(fd) {
        if (boom) throw eio("fsync");
        realFs.fsyncSync(fd);
      },
    }),
  });
  log.append("a");
  boom = true;
  assert.throws(() => log.append("b"), { code: "EIO" });
  assert.equal(log.last(), 1);
  assert.deepEqual(seqs(log), [1]);
  boom = false;
  assert.throws(() => log.append("c"), (e) => e.code === "ELOGFAILED" && e.cause.code === "EIO");
  assert.deepEqual(seqs(open(file)), [1]);
  const again = open(file);
  assert.equal(again.append("d").seq, 2);
  assert.deepEqual(open(file).read().map((e) => e.type), ["a", "d"]);
  assert.equal(readFileSync(file, "utf8").split("\n").length, 3);
});

test("a short write is finished, not glued to the next line", (t) => {
  const { file, open } = scratch(t);
  let short = true;
  const log = open(file, {
    fs: faultFs({
      writeSync(fd, buf, off, len) {
        if (short) {
          short = false;
          return realFs.writeSync(fd, buf, off, Math.ceil(len / 2));
        }
        return realFs.writeSync(fd, buf, off, len);
      },
    }),
  });
  log.append("a", { text: "x".repeat(50) });
  log.append("b");
  assert.deepEqual(seqs(open(file)), [1, 2]);
});

test("a write that fails after part of the line cuts the part off", (t) => {
  const { file, open } = scratch(t);
  let full = false;
  const log = open(file, {
    fs: faultFs({
      writeSync(fd, buf, off, len) {
        if (full) {
          realFs.writeSync(fd, buf, off, Math.ceil(len / 2));
          throw Object.assign(new Error("no space"), { code: "ENOSPC" });
        }
        return realFs.writeSync(fd, buf, off, len);
      },
    }),
  });
  log.append("a");
  const sizeAfterFirst = statSync(file).size;
  full = true;
  assert.throws(() => log.append("b"), { code: "ENOSPC" });
  assert.equal(statSync(file).size, sizeAfterFirst, "the half line is rolled back at once, not on the next open");
  assert.equal(log.last(), 1);
  assert.deepEqual(seqs(open(file)), [1]);
  assert.equal(open(file).append("c").seq, 2);
  assert.deepEqual(open(file).read().map((e) => e.type), ["a", "c"]);
});

test("a write of zero bytes is an error, not a spin", (t) => {
  const { file, open } = scratch(t);
  const log = open(file, { fs: faultFs({ writeSync: () => 0 }) });
  assert.throws(() => log.append("a"), { code: "EIO" });
  assert.equal(log.last(), 0);
  assert.equal(statSync(file).size, 0);
});

test("a directory removed under an open log makes append throw (skipped on win32: an open file blocks removing its directory)", { skip: process.platform === "win32" }, (t) => {
  const { dir, file, open } = scratch(t);
  const log = open(file);
  log.append("a");
  rmSync(dir, { recursive: true, force: true });
  assert.throws(() => log.append("b"), { code: "ENOENT" });
  assert.equal(log.last(), 1);
  assert.deepEqual(seqs(log), [1]);
});

test("the returned event is what a reopen reads, and the caller cannot change the log", (t) => {
  const { file, open } = scratch(t);
  const log = open(file);
  const e = log.append("a", { when: new Date(0), gone: undefined, nested: { x: 1 } });
  assert.deepEqual(e, { seq: 1, at: e.at, type: "a", when: "1970-01-01T00:00:00.000Z", nested: { x: 1 } });
  e.nested.x = 2;
  e.type = "changed";
  assert.deepEqual(log.read()[0].nested, { x: 1 });
  assert.deepEqual(log.read(), open(file).read());
});

test("multi-byte text round-trips and a tail torn inside a character is cut at open", (t) => {
  const { file, open } = scratch(t);
  const a = open(file);
  const e = a.append("a", { text: "привет 🙂 世界" });
  a.close();
  const goodSize = statSync(file).size;
  const torn = Buffer.from(`${JSON.stringify({ seq: 2, at: "x", type: "b", text: "🙂" })}\n`);
  appendFileSync(file, torn.subarray(0, torn.indexOf(0xf0) + 2)); // stops inside the 4-byte emoji
  const log = open(file);
  assert.equal(statSync(file).size, goodSize); // cut right after open, before any append
  assert.deepEqual(log.read(), [e]);
  assert.equal(log.append("c").seq, 2);
  assert.deepEqual(open(file).read().map((x) => x.type), ["a", "c"]);
});
