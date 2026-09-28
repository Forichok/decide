// open.mjs — open the page in the default browser, or nudge the user with a
// desktop notification when the page is already open in a background tab.

import { spawn } from "node:child_process";
import { platform } from "node:os";

function run(cmd, args) {
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function openBrowser(url) {
  const p = platform();
  if (p === "darwin") return run("open", [url]);
  if (p === "win32") return run("cmd", ["/c", "start", "", url]);
  return run("xdg-open", [url]);
}

export function notify(title, message) {
  const p = platform();
  if (p === "darwin") {
    const q = (s) => JSON.stringify(String(s).slice(0, 180));
    return run("osascript", ["-e", `display notification ${q(message)} with title ${q(title)} sound name "Glass"`]);
  }
  if (p === "linux") return run("notify-send", [title, message]);
  return false;
}
