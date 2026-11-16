// assets.mjs — expose referenced local files to the page without exposing the
// disk. Every referenced file registers its directory as a numbered root and
// is served as /r/<root>/<relative path>; HTML mockups keep relative links.

import { createHash } from "node:crypto";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { MEDIA } from "./registry/index.mjs";

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

// The document an html block is served as, under /h/<id>.html. It is its own page: the sandbox policy it is
// served with (ASSET_CSP) lets its inline script run and gives it an opaque origin, so it can reach nothing of
// the page's. The script reports the block's height to the page and takes the page's colour scheme.
const REPORT = `(()=>{const b=document.body,s=()=>parent.postMessage({decideHeight:Math.ceil(b.getBoundingClientRect().height)+2},"*");new ResizeObserver(s).observe(b);addEventListener("load",s);addEventListener("message",e=>{if(e.source!==parent||!e.data)return;if(e.data.decideScheme)document.documentElement.style.colorScheme=e.data.decideScheme;if(e.data.decideMeasure)s()});s()})()`;
export const htmlDocument = (source) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><base target="_blank"><style>:root{color-scheme:light dark}html,body{margin:0;background:transparent}body{font:14.5px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:1px}</style></head><body>${source}<script>${REPORT}</script></body></html>`;

export function createRoots() {
  const roots = [];
  // Html blocks by id (a hash of the source): registered when a round is published, which a server does for
  // every round it loads, so the block's source (kept in the round's spec.json) is served again after a restart.
  const blocks = new Map();

  function htmlUrl(source) {
    const id = createHash("sha256").update(source).digest("hex").slice(0, 32);
    blocks.set(id, source);
    return `/h/${id}.html`;
  }

  // The document of an html block's URL, or null.
  function htmlFor(pathname) {
    const m = pathname.match(/^\/h\/([0-9a-f]{32})\.html$/);
    const source = m && blocks.get(m[1]);
    return typeof source === "string" ? htmlDocument(source) : null;
  }

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

  // Copies one media node (see media.mjs), swapping local paths for served URLs; each kind says what to swap.
  const pub = (a) => (a?.local ? { ...a, src: urlFor(a.src) } : a);
  const publishNode = (node) => {
    const out = { ...node };
    for (const def of MEDIA.values()) def.publish?.(out, { pub, htmlUrl });
    return out;
  };

  // Deep-copies a normalized spec with every question and option published.
  function publish(spec) {
    return {
      ...spec,
      questions: spec.questions.map((q) => ({ ...publishNode(q), options: q.options.map(publishNode) })),
    };
  }

  return { urlFor, fileFor, htmlFor, publish, publishNode };
}
