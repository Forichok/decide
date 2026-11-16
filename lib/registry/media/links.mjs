// links — chips that open a page in a new tab. Owns `links` and the older singular `link`.

import { alias, arrayOf, object, shared, string, union } from "../shared.mjs";
import { list, str } from "./util.mjs";

const LINK = shared(
  "linkEntry",
  union(
    "A URL, or {url, label?}.",
    string("A URL."),
    object("One link.", { url: string("An http(s) URL."), label: string("The words on the chip. Default the URL.") }),
  ),
);

const LINKS = arrayOf(LINK, "Links shown with the question: URLs or {label, url}. http(s) only.", { orOne: true });

export default {
  name: "links",
  summary: "Links to a ticket, a page or a doc, shown as chips.",
  field: shared("links", LINKS),
  extra: { link: shared("links", alias("links", "One link; the older spelling of links.", LINKS)) },
  plain: true,
  mistakes: { href: '"url"', title: '"label"', text: '"label"', name: '"label"', src: '"url"' },
  normalize(out, ctx) {
    const { raw } = ctx;
    out.links = [...list(raw.link), ...list(raw.links)]
      .map((l) => (typeof l === "string" ? { url: l, label: l } : l || {}))
      .filter((l) => /^https?:\/\//i.test(str(l.url)))
      .map((l) => ({ url: str(l.url), label: str(l.label) || str(l.url) }));
  },
  lint() {},
  example: { links: [{ label: "Ticket", url: "https://example.com/ticket/1" }, "https://example.com/doc"] },
};
