// code — a block of code with a copy button; added and removed lines are coloured when it is a diff.

import { h } from "../dom.js";

export function render(node, ctx, env) {
  return node.code ? codeBlock(node.code, ctx, env.t) : null;
}

export function codeBlock(code, ctx, t) {
  const lines = code.text.split("\n").map((line) => {
    let cls = "";
    if (code.diff && /^\+(?!\+\+)/.test(line)) cls = "add";
    else if (code.diff && /^-(?!--)/.test(line)) cls = "del";
    else if (code.diff && line.startsWith("@@")) cls = "hunk";
    return h(`span.ln${cls ? `.${cls}` : ""}`, {}, line || " ");
  });
  const copy = h("button.copy", {
    type: "button",
    html: t("code.copy"),
    onclick: (e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(code.text).then(() => ctx?.toast(t("code.copied")));
    },
  });
  return h(
    "div.code.media-stop",
    {},
    h("div.code-bar", {}, h("span", {}, code.diff ? t("code.diff") : code.lang || t("code.code")), copy),
    h("pre", {}, h("code", {}, lines)),
  );
}
