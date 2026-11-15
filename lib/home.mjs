// home.mjs — where a decide home's server is found. One server serves every
// project of a home (~/.decide, or DECIDE_HOME). It is elected by binding the
// home's port; daemon.json says which process won and where it listens, and
// the lock file elects one when something else holds that port.

import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
