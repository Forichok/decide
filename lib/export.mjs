// export.mjs — one question round as a single self-contained .html file that
// someone else can open from disk and answer. The page, its CSS and its ES
// modules go inline (modules through an import map of data: URLs), net.js is
// swapped for offline.js, and every /r/ file the round shows becomes a data:
// URI. Done in that file downloads an answers JSON; import brings it back.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoots, mimeOf } from "./assets.mjs";

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../ui");
export const EXPORT_LIMIT_MB = 60;
const PREFIX = "@decide/";

const dataUri = (buf, mime, name = "") =>
  `data:${mime.replace(/; charset=utf-8$/, ";charset=utf-8")}${name ? `;name=${encodeURIComponent(name)}` : ""};base64,${buf.toString("base64")}`;

function jsFiles(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? jsFiles(full, base) : name.endsWith(".js") ? [relative(base, full).split(sep).join("/")] : [];
  });
}

// Relative imports become bare @decide/ specifiers: a data: module has no base URL to resolve "./x.js" against.
export function rewriteImports(source, rel) {
  const fix = (spec) => (spec.startsWith(".") ? PREFIX + posix.normalize(posix.join(posix.dirname(rel), spec)) : spec);
  return source.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.{1,2}\/[^"']+)\2/g, (m, head, q, spec) => `${head}${q}${fix(spec)}${q}`);
}

export function importMap() {
  const js = join(UI_DIR, "js");
  const imports = {};
  for (const rel of jsFiles(js)) {
    if (rel === "net.js" || rel === "offline.js") continue;
    imports[PREFIX + rel] = dataUri(Buffer.from(rewriteImports(readFileSync(join(js, rel), "utf8"), rel)), "text/javascript");
  }
  imports[`${PREFIX}net.js`] = dataUri(Buffer.from(rewriteImports(readFileSync(join(js, "offline.js"), "utf8"), "offline.js")), "text/javascript");
  return { imports };
}

// A mockup keeps working from a data: URL once its relative CSS, scripts, images and fonts are inlined too.
const ATTR = /(\b(?:src|href|poster)\s*=\s*)(["'])([^"']+)\2/gi;
const CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
const relativeRef = (ref) => !/^(?:[a-z][\w+.-]*:|\/\/|#|\/)/i.test(ref);

export function inlineHtml(file, read = readFileSync) {
  const dir = dirname(file);
  const local = (ref) => {
    const clean = ref.split(/[?#]/)[0];
    const full = resolve(dir, decodeURIComponent(clean));
    return full.startsWith(dir + sep) ? full : null;
  };
  const inlineCss = (css, cssDir) =>
    css.replace(CSS_URL, (m, q, ref) => {
      if (!relativeRef(ref)) return m;
      const full = resolve(cssDir, ref.split(/[?#]/)[0]);
      try {
        return full.startsWith(dir + sep) ? `url("${dataUri(read(full), mimeOf(full))}")` : m;
      } catch {
        return m;
      }
    });
  let html = read(file, "utf8");
  html = html.replace(/<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*>/gi, (tag) => {
    const ref = tag.match(/\bhref\s*=\s*(["'])([^"']+)\1/i)?.[2];
    const full = ref && relativeRef(ref) && local(ref);
    if (!full) return tag;
    try {
      return `<style>${inlineCss(read(full, "utf8"), dirname(full))}</style>`;
    } catch {
      return tag;
    }
  });
  html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (m, attrs, css) => `<style${attrs}>${inlineCss(css, dir)}</style>`);
  return html.replace(ATTR, (m, head, q, ref) => {
    if (!relativeRef(ref) || /\.html?$/i.test(ref.split(/[?#]/)[0])) return m;
    const full = local(ref);
    try {
      return full ? `${head}${q}${dataUri(read(full), mimeOf(full))}${q}` : m;
    } catch {
      return m;
    }
  });
}

// Swaps every /r/<root>/<file> in the round for a data: URI; fileFor maps a URL path to the file on disk.
export function inlineMedia(view, fileFor) {
  const cache = new Map();
  const missing = [];
  let bytes = 0;
  const json = JSON.stringify(view).replace(/\/r\/\d+\/[^"'\s)\\]+/g, (url) => {
    if (cache.has(url)) return cache.get(url);
    const file = fileFor(url);
    let out = url;
    try {
      const buf = extname(file).match(/^\.html?$/i) ? Buffer.from(inlineHtml(file)) : readFileSync(file);
      bytes += buf.length;
      out = dataUri(buf, mimeOf(file), basename(file));
    } catch {
      missing.push(url);
    }
    cache.set(url, out);
    return out;
  });
  return { view: JSON.parse(json), bytes, missing };
}

const scriptJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

// view: what GET /api/rounds/:id returns; fileFor: the daemon's /r/ resolver.
export function buildExport(view, fileFor, { from = "" } = {}) {
  if (view.mode === "swipe") throw Object.assign(new Error("export works on question rounds; a swipe deck needs the agent between batches"), { user: true, status: 409 });
  const { view: inlined, bytes, missing } = inlineMedia(
    { id: view.id, mode: "questions", status: "pending", spec: view.spec, draft: null, result: null, live: false, listening: false, dialog: [], swipe: null },
    fileFor,
  );
  if (bytes > EXPORT_LIMIT_MB * 1024 * 1024) throw Object.assign(new Error(`the round's pictures and videos come to ${Math.round(bytes / 1048576)} MB; an exported file holds up to ${EXPORT_LIMIT_MB} MB`), { user: true, status: 413 });
  const css = ["tokens", "base", "header", "question", "inputs", "media", "chrome", "overlays", "live", "swipe"].map((n) => readFileSync(join(UI_DIR, "css", `${n}.css`), "utf8")).join("\n");
  const index = readFileSync(join(UI_DIR, "index.html"), "utf8");
  const payload = { round: inlined, from, exportedAt: new Date().toISOString() };
  const html = index
    .replace(/\s*<link rel="stylesheet" href="\/ui\/css\/[\w-]+\.css" \/>/g, "")
    .replace("</head>", `    <style>\n${css}\n    </style>\n    <script type="importmap">${scriptJson(importMap())}</script>\n    <script type="application/json" id="decide-export">${scriptJson(payload)}</script>\n  </head>`)
    .replace('<script type="module" src="/ui/js/main.js"></script>', `<script type="module">import "${PREFIX}main.js";</script>`)
    .replace("<title>decide</title>", `<title>${escapeHtml(view.spec.title)} — decide</title>`);
  return { html, bytes: Buffer.byteLength(html), missing };
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// A spec exported without an open round: published through roots of its own.
export function exportSpec(spec, { id, from = "", out }) {
  const roots = createRoots();
  const built = buildExport({ id, mode: "questions", spec: roots.publish(spec) }, roots.fileFor, { from });
  writeHtml(out, built.html);
  return built;
}

export function writeHtml(file, html) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

// Which spec and answers file an exported round belongs to, so its answers can come back days later.
const recordPath = (dataDir, id) => join(dataDir, "exports", `${String(id).replace(/[^\w-]/g, "_")}.json`);

export function recordExport(dataDir, record) {
  const file = recordPath(dataDir, record.round);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2));
}

export function findExport(dataDir, id) {
  const file = recordPath(dataDir, id);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
