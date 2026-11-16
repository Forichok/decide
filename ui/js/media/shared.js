// shared.js — what several media modules share: escaping for the one place markup is built,
// and the frames a mockup (a preview, a live compare) is laid out in. Imports no page module
// that reads the DOM at load: `t` comes in as an argument.

import { h, icon } from "../dom.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const attr = esc;

// A mockup is laid out at a chosen width (a phone, a tablet, a laptop) and scaled down when
// the box is narrower. A swipe side tile always lays it out at phone width: it is narrower
// than any phone, and reflowing would make a column of words.
export const FIT_WIDTH = 390;

// A page on the web cannot be framed here (frame-src 'self'): it is a link that opens in a new tab.
export const isRemote = (src) => /^https?:\/\//i.test(src);

// Links to remote mockups: `items` are {src, text}; `text(host)` is the words of the chip.
export function remoteLinks(items) {
  return h(
    "div.links.media-stop",
    {},
    items.map(({ src, text }) => {
      let host = src;
      try {
        host = new URL(src).host;
      } catch {}
      return h("a.link-chip", { href: src, target: "_blank", rel: "noopener noreferrer", title: src, html: `${icon("link")}${esc(text(host))}` });
    }),
  );
}
const WIDTHS = [375, 768, 1440];

// Sizes frames (and their wrappers) to the box: want = virtual width or null for the box width.
export function fitFrames(box, wraps, frames, height, want) {
  const w = box.clientWidth;
  if (!w) return;
  const z = want ? Math.min(1, w / want) : 1;
  for (const f of frames) {
    f.style.width = want ? `${want}px` : "100%";
    f.style.height = `${height / z}px`;
    f.style.zoom = z < 1 ? String(z) : "";
  }
  for (const el of wraps) el.style.width = want ? `${Math.min(w, want)}px` : "";
}

export function widthSwitch(onPick, t) {
  let current = null;
  const buttons = WIDTHS.map((w) =>
    h("button.pv-w", {
      type: "button",
      "aria-pressed": "false",
      title: t("preview.width", w),
      onclick: (e) => {
        e.stopPropagation();
        current = current === w ? null : w;
        for (const b of buttons) b.setAttribute("aria-pressed", String(Number(b.textContent) === current));
        onPick(current);
      },
    }, String(w)),
  );
  return h("span.pv-widths", { role: "group", "aria-label": t("preview.widths") }, buttons);
}

export function previewBar(p, extra, t) {
  return h(
    "div.preview-bar",
    {},
    h("span.dots3", {}, h("i"), h("i"), h("i")),
    h("span.pv-live", {}, t("preview.live")),
    ...extra,
    p && h("a.preview-open", { href: p.src, target: "_blank", rel: "noopener", html: `${t("preview.open")}${icon("expand")}` }),
  );
}

export const frameOf = (src, t) =>
  h("iframe", { src, sandbox: "allow-scripts allow-popups", loading: "lazy", title: t("preview.title"), referrerpolicy: "no-referrer" });
