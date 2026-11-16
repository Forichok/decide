// video — a clip: mp4, webm or gif. Short clips loop muted, long ones get controls.
// Owns `video` and the older `videos`.

import { alias, arrayOf, boolean, object, shared, string, union } from "../shared.mjs";
import { LIMITS, REMOTE, asset, bad, list, sizeMB, str } from "./util.mjs";

const VIDEO = /\.(mp4|webm|gif)$/i;

const CLIP = shared(
  "videoEntry",
  union(
    "A path or URL, or {src, caption?, loop?}.",
    string("A path or URL: mp4, webm or gif."),
    object("One clip.", {
      src: string("A path or a URL: mp4, webm or gif."),
      path: alias("src", "The older spelling of src.", string("A path or a URL.")),
      caption: string("Shown under the clip."),
      loop: boolean("Loop it muted (default for clips up to 20 s) or give it controls."),
    }),
  ),
);

const VIDEOS = arrayOf(CLIP, "A path or URL, {src, caption?, loop?}, or a list of them. mp4, webm or gif. Clips up to 20 s loop muted unless loop is false.", { orOne: true });

export default {
  name: "video",
  summary: "A short clip: mp4, webm or gif. Up to 20 s it loops muted.",
  field: shared("video", VIDEOS),
  extra: { videos: shared("video", alias("video", "The older spelling of video.", VIDEOS)) },
  mistakes: { url: '"src"', title: '"caption"' },
  normalize(out, ctx) {
    const { raw, where } = ctx;
    out.video = list(raw.video ?? raw.videos).map((v, i) => normalizeVideo(v, `${where}.video${i ? `[${i}]` : ""}`, ctx)).filter(Boolean);
  },
  lint() {},
  publish(node, { pub }) {
    node.video = (node.video || []).map(pub);
  },
  example: { video: { src: "clip.mp4", caption: "The flow", loop: true } },
};

function normalizeVideo(raw, where, ctx) {
  const o = typeof raw === "string" ? { src: raw } : raw || {};
  const src = str(o.src || o.path);
  if (!src) return bad(ctx, where, "a video needs src");
  if (!VIDEO.test(src.split("?")[0]) && !REMOTE.test(src)) return bad(ctx, where, `${src}: use mp4, webm or gif — skipped`);
  const v = asset(src, where, ctx, { caption: str(o.caption), loop: o.loop === true ? true : o.loop === false ? false : null, gif: /\.gif$/i.test(src.split("?")[0]) });
  if (v?.local) {
    const mb = sizeMB(v.src, ctx);
    if (mb > LIMITS.videoMB) ctx.add("warn", where, `${mb.toFixed(1)} MB video — over ${LIMITS.videoMB} MB loads slowly; cut it to the few seconds that matter`);
  }
  return v;
}
