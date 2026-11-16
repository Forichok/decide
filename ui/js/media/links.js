// links — chips that open a page in a new tab.

import { h, icon } from "../dom.js";
import { esc } from "./shared.js";

export function render(node) {
  if (!node.links?.length) return null;
  return h(
    "div.links",
    {},
    node.links.map((l) => h("a.link-chip", { href: l.url, target: "_blank", rel: "noopener noreferrer", html: `${icon("link")}${esc(l.label)}` })),
  );
}
