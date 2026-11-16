// images — the gallery: thumbnails that open in the lightbox, and a mark-up button for pictures
// the page itself serves.

import { h, icon } from "../dom.js";
import { attr } from "./shared.js";

export function render(node, ctx, env) {
  if (!node.images?.length) return null;
  const { t, qid, sameOrigin } = env;
  const images = node.images;
  const box = h(`div.gallery.media-stop.n${Math.min(images.length, 3)}`);
  images.forEach((img, i) => {
    const open = (annotate) => (e) => {
      e.stopPropagation();
      ctx.lightbox(images, i, qid, { annotate });
    };
    box.append(
      h(
        "figure.shot",
        {},
        h("button.shot-btn", {
          type: "button",
          title: t("media.zoom"),
          "aria-label": img.caption || t("media.image"),
          onclick: open(false),
          html: `<img src="${attr(img.src)}" alt="${attr(img.caption)}" loading="lazy" decoding="async"><span class="zoom">${icon("expand")}</span>`,
        }),
        sameOrigin(img.src) &&
          !ctx.offline &&
          ctx.canMark &&
          h("button.shot-mark", { type: "button", title: t("media.markTitle"), html: `${icon("pen")}${t("lb.mark")}`, onclick: open(true) }),
        img.caption && h("figcaption", {}, img.caption),
      ),
    );
  });
  return box;
}
