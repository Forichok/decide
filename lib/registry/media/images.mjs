// images — pictures: paths, URLs, or a capture of a running page or simulator.
// Owns `images` and the older singular `image`.

import { alias, arrayOf, number, object, oneOf, shared, string, union } from "../shared.mjs";
import { asset, list, str } from "./util.mjs";

const IMAGE = shared(
  "imageEntry",
  union(
    "A path or URL, or an object.",
    string("A path (relative to the spec file) or a URL."),
    object("One picture, or a capture.", {
      src: string("A path or a URL."),
      path: alias("src", "The older spelling of src.", string("A path or a URL.")),
      caption: string("Shown under the picture."),
      alt: alias("caption", "The older spelling of caption.", string("The caption.")),
      shot: string("An http(s) page to capture with the local Chrome when the round opens."),
      sim: oneOf(["ios", "android"], "Capture the booted iOS simulator (xcrun simctl io booted screenshot) or the Android emulator (adb exec-out screencap -p) when the round opens. DECIDE_SIMCTL and DECIDE_ADB point at other binaries.", { loose: true }),
      viewport: oneOf(["desktop", "mobile", "both"], "With shot: the screen size. Default desktop.", { loose: true }),
      waitMs: number("With shot: how long to let the page settle. Default 1500."),
      name: string("With shot or sim: a name for the file."),
      device: string("With sim: the device id."),
    }),
  ),
);

const IMAGES = arrayOf(IMAGE, "Paths (relative to the spec file; to project for an inline spec), URLs, {src, caption}, {shot: url, viewport?, …} to capture a page, or {sim: ios|android, …} to capture a simulator.", { orOne: true, brief: "Paths, URLs, or {src, caption} / {shot} / {sim}" });

export default {
  name: "images",
  summary: "Pictures that open large and can be marked up; or a capture of a running page or a simulator.",
  field: shared("images", IMAGES),
  extra: { image: shared("images", alias("images", "One picture; the older spelling of images.", IMAGES)) },
  mistakes: { url: '"src"', file: '"src"', href: '"src"', title: '"caption"', description: '"caption"', label: '"caption"' },
  normalize(out, ctx) {
    const { raw, where } = ctx;
    out.images = [...list(raw.image), ...list(raw.images)]
      .map((img) => (typeof img === "string" ? { src: img } : img || {}))
      .map((img) => asset(str(img.src || img.path), where, ctx, { caption: str(img.caption || img.alt) }))
      .filter(Boolean);
  },
  lint() {},
  publish(node, { pub }) {
    node.images = (node.images || []).map(pub);
  },
  example: { images: [{ src: "before.png", caption: "Today" }, "https://example.com/screen.png"] },
};
