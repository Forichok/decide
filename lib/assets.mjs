// assets.mjs — expose referenced local files to the page without exposing the
// disk. Every referenced file registers its directory as a numbered root and
// is served as /r/<root>/<relative path>; HTML mockups keep relative links.

import { basename, dirname, extname, resolve, sep } from "node:path";

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export const mimeOf = (file) => MIME[extname(file).toLowerCase()] || "application/octet-stream";

export function createRoots() {
  const roots = [];

  function urlFor(absPath) {
    const dir = dirname(absPath);
    let i = roots.indexOf(dir);
    if (i < 0) i = roots.push(dir) - 1;
    return `/r/${i}/${encodeURIComponent(basename(absPath))}`;
  }

  function fileFor(pathname) {
    const m = pathname.match(/^\/r\/(\d+)\/(.+)$/);
    const root = m && roots[Number(m[1])];
    if (!root) return null;
    let rel;
    try {
      rel = decodeURIComponent(m[2]);
    } catch {
      return null;
    }
    const full = resolve(root, rel);
    return full.startsWith(root + sep) ? full : null;
  }

  // Copies one media node (see media.mjs), swapping local paths for served URLs.
  const publishNode = (node) => ({
    ...node,
    images: node.images.map((img) => (img.local ? { ...img, src: urlFor(img.src) } : img)),
    preview: node.preview?.local ? { ...node.preview, src: urlFor(node.preview.src) } : node.preview,
  });

  // Deep-copies a normalized spec with every question and option published.
  function publish(spec) {
    return {
      ...spec,
      questions: spec.questions.map((q) => ({ ...publishNode(q), options: q.options.map(publishNode) })),
    };
  }

  return { urlFor, fileFor, publish, publishNode };
}
