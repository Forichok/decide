// stopped.js — a stopped server said in words: what happened, that nothing typed is lost, and the command that starts it.
// The page keeps trying to reconnect by itself; the banner goes away when it does.

import { h } from "./dom.js";
import { t } from "./i18n.js";
import { wrongPort } from "./pwa.js";

let timer = null;

// state.engine (the server's decide.mjs path) is used when the server reports it.
export function showStopped(stopped, state) {
  const box = document.getElementById("stopped");
  if (!box) return;
  clearTimeout(timer);
  if (!stopped) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  // A dropped stream often comes back within a second: say it only if it stays down.
  timer = setTimeout(() => {
    const cmd = `node ${state?.engine || "decide.mjs"} open`;
    box.replaceChildren(
      h(
        "div.stopped-body",
        {},
        h("strong", {}, t("stopped.title")),
        h("p", {}, t("stopped.body")),
        ...(wrongPort(globalThis.location?.port) ? [h("p", {}, t("pwa.port"))] : []),
        h("div.paste-line", {}, h("code", {}, cmd), h("button.link-btn", { type: "button", onclick: () => navigator.clipboard?.writeText(cmd).catch(() => {}) }, t("listen.copy"))),
      ),
    );
    box.hidden = false;
  }, 1500);
}
