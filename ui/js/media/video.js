// video — clips. Short ones play muted on a loop while on screen; longer ones wait for the play
// button; a gif is a picture that opens in the lightbox.

import { h, icon } from "../dom.js";
import { attr } from "./shared.js";

const SHORT_SEC = 20;

// One observer for every clip, made when the first one is drawn (the module itself touches nothing at load).
let watcher;
const watch = () =>
  (watcher ??=
    typeof IntersectionObserver === "function" &&
    new IntersectionObserver((entries) => {
      for (const e of entries) {
        const v = e.target;
        if (!v.loop) continue;
        if (e.isIntersecting) v.play().catch(() => {});
        else v.pause();
      }
    }));

export function render(node, ctx, env) {
  if (!node.video?.length) return null;
  const { t, qid } = env;
  const list = node.video;
  return h(
    `div.videos.media-stop.n${Math.min(list.length, 2)}`,
    {},
    list.map((v) => {
      if (v.gif) {
        return h(
          "figure.shot",
          {},
          h("button.shot-btn", { type: "button", title: t("media.zoom"), onclick: (e) => (e.stopPropagation(), ctx.lightbox([{ src: v.src, caption: v.caption }], 0, qid)), html: `<img src="${attr(v.src)}" alt="${attr(v.caption)}" loading="lazy"><span class="zoom">${icon("expand")}</span>` }),
          v.caption && h("figcaption", {}, v.caption),
        );
      }
      const el = h("video", { src: v.src, controls: true, playsinline: true, preload: "metadata" });
      el.muted = true;
      el.addEventListener("loadedmetadata", () => {
        if (!(v.loop ?? el.duration <= SHORT_SEC)) return void (el.muted = false);
        el.loop = true;
        const w = watch();
        w ? w.observe(el) : el.play().catch(() => {});
      });
      return h("figure.video", {}, el, v.caption && h("figcaption", {}, v.caption));
    }),
  );
}
