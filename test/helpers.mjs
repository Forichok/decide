// Shared harness for the test suites: every test gets a
// scratch dir that is both the project and (under .home) its DECIDE_HOME, so
// no daemon, journal or screenshot leaks into the real ~/.decide.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const enginePath = path.join(pluginDir, "decide.mjs");
export const WRITE = { "content-type": "application/json", "x-decide": "1" };

export const homeOf = (dir) => path.join(dir, ".home");
export const envOf = (dir, extra = {}) => ({ ...process.env, DECIDE_HOME: homeOf(dir), ...extra });
export const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));

export async function scratchDir(context) {
  const dir = await mkdtemp(path.join(tmpdir(), "decide-test-"));
  context.after(async () => {
    await shutdownDaemon(dir);
    await rm(dir, { force: true, recursive: true });
  });
  return dir;
}

export async function shutdownDaemon(dir) {
  const projects = path.join(homeOf(dir), "projects");
  for (const name of existsSync(projects) ? await readdir(projects) : []) {
    try {
      const info = await readJson(path.join(projects, name, ".decide-daemon.json"));
      await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, { method: "POST", headers: WRITE });
    } catch {
      // daemon already gone
    }
  }
}

export function collect(child) {
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => (output.stdout += c));
  child.stderr.on("data", (c) => (output.stderr += c));
  return output;
}

// Runs decide.mjs for the scratch project; the child dies with the test.
export function runEngine(context, dir, args) {
  const child = spawn(process.execPath, [enginePath, ...args, "--project", dir], {
    stdio: ["ignore", "pipe", "pipe"],
    env: envOf(dir),
  });
  context.after(() => child.kill());
  return { child, output: collect(child) };
}

export function waitForOutput(child, output, pattern, ms = 8_000) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const match = output.stdout.match(pattern);
      if (match) {
        clearInterval(timer);
        clearTimeout(timeout);
        resolve(match);
      }
    }, 25);
    const timeout = setTimeout(() => {
      clearInterval(timer);
      reject(new Error(`no ${pattern} in output: ${output.stderr || output.stdout}`));
    }, ms);
    child.once("exit", (code) => {
      if (code !== 0 && !output.stdout.match(pattern)) {
        clearInterval(timer);
        clearTimeout(timeout);
        reject(new Error(`decide exited with ${code}: ${output.stderr || output.stdout}`));
      }
    });
  });
}

export const waitForReadyUrl = (child, output) =>
  waitForOutput(child, output, /DECIDE ready: (http:\/\/127\.0\.0\.1:\d+\/)#r=([\w-]+)/).then((m) => ({ url: m[1], round: m[2] }));

export const exitOf = (child) =>
  child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise((resolve) => child.once("exit", resolve));
