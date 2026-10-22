// shot.mjs — screenshots of a running page with the local headless Chrome
// (or Chromium, Edge, Brave), and of a running iOS simulator or Android
// emulator. Used by the "shot" and "sim" image entries of a spec and by the
// screenshot tool, so the agent can show the real screen it means.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { slugify, stamp } from "./project.mjs";
import { specLang, words } from "./words.mjs";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, scale: 1 },
  mobile: { width: 390, height: 844, scale: 2, ua: IPHONE_UA },
};

export function findChrome() {
  if (process.env.DECIDE_CHROME) return existsSync(process.env.DECIDE_CHROME) ? process.env.DECIDE_CHROME : null;
  const os = platform();
  let candidates;
  if (os === "darwin") {
    const apps = ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser", "Google Chrome Canary"];
    candidates = ["/Applications", join(homedir(), "Applications")].flatMap((d) => apps.map((a) => `${d}/${a}.app/Contents/MacOS/${a}`));
  } else if (os === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
    const exes = ["Google\\Chrome\\Application\\chrome.exe", "Microsoft\\Edge\\Application\\msedge.exe", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"];
    candidates = roots.flatMap((r) => exes.map((e) => join(r, e)));
  } else {
    const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
    candidates = (process.env.PATH || "").split(delimiter).flatMap((d) => names.map((n) => join(d, n)));
  }
  return candidates.find((p) => existsSync(p)) || null;
}

export function shotArgs({ url, out, profile, viewport = "desktop", waitMs = 1500 }) {
  const v = VIEWPORTS[viewport];
  if (!v) throw new Error(`unknown viewport "${viewport}" (use ${Object.keys(VIEWPORTS).join(", ")})`);
  if (!/^https?:\/\//i.test(url)) throw new Error(`only http(s) pages can be captured: ${url}`);
  return [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--mute-audio",
    `--user-data-dir=${profile}`,
    `--window-size=${v.width},${v.height}`,
    `--force-device-scale-factor=${v.scale}`,
    `--virtual-time-budget=${Math.max(0, Math.min(Number(waitMs) || 0, 20_000))}`,
    `--screenshot=${out}`,
    ...(v.ua ? [`--user-agent=${v.ua}`] : []),
    url,
  ];
}

// Captures one viewport; resolves to the PNG path.
export function capture({ url, dir, name, viewport = "desktop", waitMs }) {
  const chrome = findChrome();
  if (!chrome) return Promise.reject(new Error("no Chrome, Chromium, Edge or Brave found (set DECIDE_CHROME)"));
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${slugify(name || url.replace(/^https?:\/\//, ""), "shot")}-${viewport}-${stamp()}.png`);
  const profile = mkdtempSync(join(tmpdir(), "decide-shot-"));
  const args = shotArgs({ url, out, profile, viewport, waitMs });
  return new Promise((resolveShot, reject) => {
    const child = spawn(chrome, args, { stdio: "ignore" });
    const started = Date.now();
    let lastSize = -1;
    // Some Chrome builds linger after writing the file; stop once it is complete.
    const poll = setInterval(() => {
      const size = existsSync(out) ? statSync(out).size : -1;
      if ((size > 0 && size === lastSize) || Date.now() - started > 30_000) child.kill("SIGKILL");
      lastSize = size;
    }, 250);
    const done = (err) => {
      clearInterval(poll);
      rmSync(profile, { recursive: true, force: true });
      if (!err && existsSync(out)) resolveShot(out);
      else reject(err || new Error(`screenshot of ${url} failed`));
    };
    child.once("error", done);
    child.once("exit", () => done());
  });
}

// The booted iOS simulator (xcrun simctl) or the connected Android emulator (adb). DECIDE_SIMCTL / DECIDE_ADB
// point at another binary; DECIDE_SIMCTL replaces "xcrun simctl" as a whole.
export const SIMULATORS = ["ios", "android"];

export function simCommand(simulator, out, device = "") {
  if (simulator === "ios") {
    const target = device || "booted";
    return process.env.DECIDE_SIMCTL
      ? { bin: process.env.DECIDE_SIMCTL, args: ["io", target, "screenshot", out] }
      : { bin: "xcrun", args: ["simctl", "io", target, "screenshot", out] };
  }
  if (simulator === "android") return { bin: process.env.DECIDE_ADB || "adb", args: [...(device ? ["-s", device] : []), "exec-out", "screencap", "-p"], stdout: out };
  throw new Error(`unknown simulator "${simulator}" (use ${SIMULATORS.join(" or ")})`);
}

const SIM_HELP = {
  ios: "is an iOS simulator booted? Start one from Xcode or with xcrun simctl boot <device>",
  android: "is an Android emulator running? Check adb devices",
};

export function captureSim({ simulator, dir, name, device }) {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${slugify(name || simulator, "sim")}-${simulator}-${stamp()}.png`);
  let cmd;
  try {
    cmd = simCommand(simulator, out, device ? String(device) : "");
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise((resolveShot, reject) => {
    const child = spawn(cmd.bin, cmd.args, { stdio: ["ignore", cmd.stdout ? "pipe" : "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    const file = cmd.stdout && createWriteStream(out);
    if (file) child.stdout.pipe(file);
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    let settled = false;
    const fail = (why) => {
      if (settled) return;
      settled = true;
      // The stream opens the file asynchronously: remove it only once the stream is done with it.
      const rm = () => rmSync(out, { force: true });
      if (file && !file.closed) file.once("close", rm).end();
      else rm();
      reject(new Error(`${simulator} screenshot failed (${why}): ${SIM_HELP[simulator]}`));
    };
    child.once("error", (e) => (clearTimeout(timer), fail(e.code === "ENOENT" ? `${cmd.bin} not found` : e.message)));
    child.once("close", (code) => {
      clearTimeout(timer);
      const finish = () => (code === 0 && existsSync(out) && statSync(out).size > 0 ? ((settled = true), resolveShot(out)) : fail(err.trim().split("\n").pop() || `exit ${code}`));
      if (file) file.end(finish);
      else finish();
    });
  });
}

export const viewportsOf = (v) => (v === "both" ? ["desktop", "mobile"] : [v || "desktop"]);

// Replaces { "shot": url, "viewport": ... } and { "sim": "ios" | "android" } image entries of a raw spec with captured files.
export async function resolveShots(raw, { dir }) {
  const issues = [];
  const w = words(specLang(raw));
  const nodes = (raw?.questions || []).flatMap((q) => [q, ...(Array.isArray(q?.options) ? q.options : [])]).filter(Boolean);
  for (const node of nodes) {
    for (const key of ["image", "images"]) {
      const list = Array.isArray(node[key]) ? node[key] : node[key] ? [node[key]] : [];
      if (!list.some((img) => img && typeof img === "object" && (img.shot || img.sim))) continue;
      const out = [];
      for (const img of list) {
        if (img && typeof img === "object" && img.sim && !img.shot) {
          try {
            const src = await captureSim({ simulator: String(img.sim), dir, name: img.name, device: img.device });
            out.push({ src, caption: img.caption || w[img.sim] || String(img.sim) });
          } catch (e) {
            issues.push({ level: "warn", where: `sim ${img.sim}`, message: e.message });
          }
          continue;
        }
        if (!img || typeof img !== "object" || !img.shot) {
          out.push(img);
          continue;
        }
        for (const viewport of viewportsOf(img.viewport)) {
          try {
            const src = await capture({ url: String(img.shot), dir, name: img.name, viewport, waitMs: img.waitMs });
            out.push({ src, caption: img.caption || `${viewport === "mobile" ? w.mobile : w.desktop} · ${img.shot}` });
          } catch (e) {
            issues.push({ level: "warn", where: `shot ${img.shot}`, message: e.message });
          }
        }
      }
      node[key] = out;
    }
  }
  return issues;
}
