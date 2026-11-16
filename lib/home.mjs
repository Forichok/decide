// home.mjs — where a decide home's server is found. One server serves every
// project of a home (~/.decide, or DECIDE_HOME). It is elected by binding the
// home's port; daemon.json says which process won and where it listens, and
// the lock file elects one when something else holds that port.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fnv1a } from "./project.mjs";

export const DEFAULT_PORT = 47474;

// DECIDE_PORT wins; ~/.decide gets the default port; any other home a stable port of its own.
export function portForHome(home) {
  const env = Number(process.env.DECIDE_PORT);
  if (Number.isInteger(env) && env > 0 && env < 65536) return env;
  const dir = resolve(home);
  if (dir === resolve(homedir(), ".decide")) return DEFAULT_PORT;
  return 44000 + (fnv1a(dir) % 2000);
}

export const infoPath = (home) => join(home, "daemon.json");
export const lockPath = (home) => join(home, "daemon.lock");

// Info = { pid, port, protocol, version, home, token, startedAt }, or null when there is none.
export function readInfo(home) {
  try {
    const info = JSON.parse(readFileSync(infoPath(home), "utf8"));
    return info && typeof info === "object" ? info : null;
  } catch {
    return null;
  }
}

// Whether a process with this pid exists (EPERM: it does, it belongs to someone else).
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// The home holds the token and every round: it is created 0700, an existing one of ours is tightened to
// 0700, and one that is someone else's, or stays writable by others, is refused before anything is written
// there. POSIX only. Test seams, not features: uid (the owner to expect) and chmod.
export function ensureHome(home, { uid = process.getuid?.(), chmod = chmodSync } = {}) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  const owner = statSync(home).uid;
  const refuse = (message) => Object.assign(new Error(message), { user: true });
  if (owner !== uid) throw refuse(`the decide home ${home} belongs to uid ${owner}, not to this user (uid ${uid}): decide keeps its token and every round there, so it does not use a directory someone else owns. Set DECIDE_HOME to a directory of your own.`);
  if (statSync(home).mode & 0o077) chmod(home, 0o700);
  const mode = statSync(home).mode & 0o777;
  if (mode & 0o022) throw refuse(`the decide home ${home} is writable by group or others (mode ${mode.toString(8)}) and could not be made private: run chmod 700 ${home} and try again.`);
}

// Temp file + rename, readable by the user only: it carries the token that stops the server.
export function writeInfo(home, info) {
  const file = infoPath(home);
  const tmp = `${file}.${process.pid}-${randomBytes(3).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
