// log.mjs — the append-only event log of one round: one JSON line per event,
// numbered from 1 with no gaps, fsynced before append returns, so a killed
// server loses nothing it had acknowledged. Later code replays the events.

import { closeSync, fstatSync, fsyncSync, openSync, readFileSync, truncateSync, writeSync } from "node:fs";

// The fs functions the log uses; openLog's `fs` option swaps them so tests can inject faults. Not a public feature.
const realFs = { openSync, writeSync, fsyncSync, fstatSync, truncateSync, closeSync, readFileSync };

// Events from the file, plus the byte length of its good part. Anything after
// the last "\n", and a last line that does not parse, is a torn write.
function load(file, fs) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    if (err.code === "ENOENT") return { events: [], good: 0, size: 0 };
    throw err;
  }
  const events = [];
  let good = 0;
  let start = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(0x0a, start);
    if (nl === -1) break; // no newline: torn tail
    const event = parse(buf.toString("utf8", start, nl));
    if (event) events.push(event);
    else if (nl + 1 >= buf.length && buf.toString("utf8", start, nl).trim()) break; // unparsable last line
    start = good = nl + 1;
  }
  return { events, good, size: buf.length };
}

function parse(line) {
  if (!line.trim()) return null;
  try {
    const event = JSON.parse(line);
    return event && typeof event === "object" && Number.isInteger(event.seq) ? event : null;
  } catch {
    return null;
  }
}

export function openLog(file, { fs = realFs } = {}) {
  const { events, good, size: onDisk } = load(file, fs);
  if (good < onDisk) fs.truncateSync(file, good);
  let seq = events.reduce((max, e) => Math.max(max, e.seq), 0);
  let size = good; // bytes of good lines on disk, tracked instead of stat-ing on every append
  let fd = null; // opened on the first append, so a missing directory fails there
  let failed = null;

  // Cut the file back to the last acknowledged line and refuse further appends: reopen to go on.
  function fail(err, started) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
      fd = null;
    }
    if (started) {
      // Rollback is best effort. A torn tail is cut on the next open anyway, but a complete line
      // (fsync failed, file unlinked) that could not be rolled back reappears on reopen.
      try {
        fs.truncateSync(file, size); // by path: ftruncate on an "a" descriptor may be refused on Windows
      } catch {}
    }
    failed = err;
    return err;
  }

  return {
    append(type, data = {}) {
      if (failed) throw Object.assign(new Error("the event log failed on an earlier write and must be reopened", { cause: failed }), { code: "ELOGFAILED" });
      const { seq: _s, at: _a, type: _t, ...rest } = data;
      const line = JSON.stringify({ seq: seq + 1, at: new Date().toISOString(), type, ...rest });
      const buf = Buffer.from(`${line}\n`);
      let started = false;
      try {
        if (fd === null) fd = fs.openSync(file, "a");
        started = true;
        for (let off = 0; off < buf.length; ) {
          const n = fs.writeSync(fd, buf, off, buf.length - off);
          if (!(n > 0)) throw Object.assign(new Error("write wrote no bytes"), { code: "EIO" });
          off += n;
        }
        fs.fsyncSync(fd);
        // The directory was removed under an open file: the line went into an unlinked inode.
        if (fs.fstatSync(fd).nlink === 0) throw Object.assign(new Error(`${file} was removed while the log was open`), { code: "ENOENT" });
      } catch (err) {
        throw fail(err, started);
      }
      size += buf.length;
      seq += 1;
      events.push(JSON.parse(line)); // what a reopen would read, not the caller's object
      return JSON.parse(line);
    },
    read: (after = 0) => events.filter((e) => e.seq > after),
    last: () => seq,
    close() {
      if (fd !== null) fs.closeSync(fd);
      fd = null;
    },
  };
}
