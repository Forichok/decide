// media.js — visuals attached to a question, an option, a swipe card or side. Each kind (images,
// before/after slider, video, mockup, html block, chart, table, diff, diagram, code, links) is one
// module in ./media/; this file holds what they share on the page: the expand button, the
// lightbox hook and the sizes. In a swipe side tile (compact) each kind shrinks to a thumbnail and
// opens large on click.

import { h, icon } from "./dom.js";
import { offline } from "./net.js";
import { t } from "./i18n.js";
import { MEDIA } from "./media/index.js";

// qid: the question these visuals belong to — marks drawn on a picture attach there.
// compact: a swipe side tile; big: the zoomed copy in a modal.
export function renderMedia(node, ctx, qid, { compact = false, big = false } = {}) {
  // What a kind module may use from the page: the strings, the theme, and the expand button, which
  // opens a copy of the same kind large. The modules import none of this (they load under Node).
  const env = {
    qid,
    compact,
    big,
    t,
    offline,
    dark,
    narrow,
    sameOrigin,
    zoom: (kind, el) => (ctx.zoom && !big ? zoomable(el, () => ctx.zoom(renderMedia({ [kind]: node[kind], previewHeight: 640 }, ctx, qid, { big: true }))) : el),
  };
  const parts = [...MEDIA.values()].map((kind) => kind.render(node, ctx, env)).filter(Boolean);
  return parts.length ? h(`div.media${compact ? ".compact" : ""}`, {}, parts) : null;
}

const narrow = () => matchMedia("(max-width: 640px)").matches;

const dark = () => {
  const theme = document.documentElement.dataset.theme;
  return theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};

// An expand button in the corner opens the same visual large.
function zoomable(el, open) {
  el.classList.add("has-zoom");
  el.append(
    h("button.media-zoom", {
      type: "button",
      title: t("media.zoom"),
      "aria-label": t("media.zoom"),
      html: icon("expand"),
      onclick: (e) => {
        e.stopPropagation();
        open();
      },
    }),
  );
  return el;
}

export const sameOrigin = (src) => /^(\/(?!\/)|blob:|data:)/.test(src) || String(src).startsWith(location.origin);
