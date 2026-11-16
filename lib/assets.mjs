// assets.mjs — expose referenced local files to the page without exposing the
// disk. A picture or video is served as /r/<id>/<name>: that file and nothing beside it. An HTML mockup is
// served with its own directory, so its relative links work. <id> is the FNV-1a hash of the real path in
// eight hex digits, so a URL is the same in every process and after every restart.

import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
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

// FNV-1a over the UTF-8 bytes of a path, eight hex digits.
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(String(text))) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};
const inside = (base, file) => {
  const rel = relative(base, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const HTML_FILE = /\.html?$/i;

export function createRoots() {
  // Everything served by id: {kind: "file" | "dir", real, owners, kept}. A file entry serves that file; a dir
  // entry the tree under it. `owners` are the rounds that showed it; `kept` is set by a publish with no owner.
  const entries = new Map();
  const idOf = new Map(); // real path → id
  // Html blocks by id (a hash of the source): the block's source is kept in the round's spec.json and
  // registered again whenever a round is published, which a server does for every round it loads.
  const blocks = new Map();
  let scope = null;

  // Runs fn with every publish inside it belonging to `owner`, so release(owner) can take it back.
  function within(owner, fn) {
    const before = scope;
    scope = owner;
    try {
      return fn();
    } finally {
      scope = before;
    }
  }

  const claim = (entry) => {
    if (scope === null) entry.kept = true;
    else entry.owners.add(scope);
    return entry;
  };

  // The shortest id that is free or is already this path's: eight digits, then longer ones of the path's sha256.
  function register(kind, path) {
    let id = idOf.get(path);
    if (!id) {
      const full = createHash("sha256").update(path).digest("hex");
      id = [fnv1a(path), ...[12, 16, 24, 32, 48, 64].map((n) => full.slice(0, n))].find((candidate) => !entries.has(candidate));
      entries.set(id, { kind, real: path, owners: new Set(), kept: false });
      idOf.set(path, id);
    }
    claim(entries.get(id));
    return id;
  }

  function htmlUrl(source) {
    const id = createHash("sha256").update(source).digest("hex").slice(0, 32);
    const block = blocks.get(id) ?? { source, owners: new Set(), kept: false };
    claim(block);
    blocks.set(id, block);
    return `/h/${id}.html`;
  }

  // The document of an html block's URL, or null.
  function htmlFor(pathname) {
    const m = pathname.match(/^\/h\/([0-9a-f]{32})\.html$/);
    const block = m && blocks.get(m[1]);
    return block ? htmlDocument(block.source) : null;
  }

  // The URL of one file: this file is served and no other.
  function publishFile(abs) {
    const file = real(abs);
    return `/r/${register("file", file)}/${encodeURIComponent(basename(file))}`;
  }

  // The URL of an html mockup: it is served with the directory it sits in, so ./card.css and ./img/x.png load.
  function publishDir(absHtml) {
    const dir = real(dirname(resolve(absHtml)));
    return `/r/${register("dir", dir)}/${encodeURIComponent(basename(absHtml))}`;
  }

  // The file on disk a /r/ path names, or null. Checked again on every request: a file turned into a symlink
  // since it was published is not followed out.
  function fileFor(pathname) {
    const m = String(pathname).match(/^\/r\/([0-9a-f]{8,64})\/(.+)$/);
    const entry = m && entries.get(m[1]);
    if (!entry) return null;
    let rel;
    try {
      rel = decodeURIComponent(m[2]);
    } catch {
      return null;
    }
    if (entry.kind === "file") return rel === basename(entry.real) && real(entry.real) === entry.real && isFile(entry.real) ? entry.real : null;
    const parts = rel.split("/");
    if (parts.some((seg) => seg === "" || seg === "." || seg === ".." || seg.includes("\\"))) return null;
    const full = resolve(entry.real, ...parts);
    if (!inside(entry.real, full)) return null;
    const actual = real(full);
    return inside(entry.real, actual) && isFile(actual) ? actual : null;
  }

  // A round no longer open gives its files and blocks back, unless another round (or an unowned publish) still shows them.
  function release(owner) {
    for (const [id, entry] of entries) {
      entry.owners.delete(owner);
      if (!entry.kept && !entry.owners.size) {
        entries.delete(id);
        idOf.delete(entry.real);
      }
    }
    for (const [id, block] of blocks) {
      block.owners.delete(owner);
      if (!block.kept && !block.owners.size) blocks.delete(id);
    }
  }

  // Copies one media node (see media.mjs), swapping local paths for served URLs; each kind says what to swap.
  const pub = (a) => (a?.local ? { ...a, src: HTML_FILE.test(a.src) ? publishDir(a.src) : publishFile(a.src) } : a);
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

  return { publishFile, publishDir, fileFor, htmlFor, publish, publishNode, within, release };
}
