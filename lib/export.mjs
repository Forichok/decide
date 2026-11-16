// export.mjs — one question round as a single self-contained .html file that
// someone else can open from disk and answer. The page, its CSS and its ES
// modules go inline (modules through an import map of data: URLs), net.js is
// swapped for offline.js, and every /r/ file the round shows becomes a data:
// URI. A round with a mermaid diagram carries the vendored Mermaid, so the
// file draws it with no network. Done in that file downloads an answers JSON;
// import brings it back. What goes in is measured with stat before it is read,
// and the file is written through a stream to a temp file renamed into place.

import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createRoots, fileIn, mimeOf } from "./assets.mjs";
import { UserError } from "./errors.mjs";

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

// locate(rel): the file a "/"-separated path relative to the mockup's directory names, or null. It holds the
// rule a served mockup's directory holds (fileIn: inside the directory once symlinks are followed, web files
// only, no dotfile, no daemon file); inlineMedia hands in the server's own resolver for the mockup's URL.
export function inlineHtml(file, read = readFileSync, locate = (rel) => fileIn(realpathSync.native(dirname(file)), rel)) {
  // A reference as a path from the mockup's directory (base: the directory of the file it is in), or null.
  const relOf = (ref, base) => {
    let clean = ref.split(/[?#]/)[0];
    try {
      clean = decodeURIComponent(clean);
    } catch {
      return null;
    }
    if (clean.includes("\\") || clean.includes("\0")) return null;
    const rel = posix.normalize(posix.join(base, clean));
    return rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel) ? null : rel;
  };
  const local = (ref, base = ".") => {
    const rel = relOf(ref, base);
    return rel === null ? null : locate(rel);
  };
  // cssBase: the directory of the CSS, relative to the mockup's (posix), so url() resolves where the browser would.
  const inlineCss = (css, cssBase) =>
    css.replace(CSS_URL, (m, q, ref) => {
      if (!relativeRef(ref)) return m;
      const full = local(ref, cssBase);
      try {
        return full ? `url("${dataUri(read(full), mimeOf(full))}")` : m;
      } catch (err) {
        if (err instanceof UserError) throw err;
        return m;
      }
    });
  let html = read(file, "utf8");
  html = html.replace(/<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*>/gi, (tag) => {
    const ref = tag.match(/\bhref\s*=\s*(["'])([^"']+)\1/i)?.[2];
    const rel = ref && relativeRef(ref) ? relOf(ref, ".") : null;
    const full = rel !== null && locate(rel);
    if (!full) return tag;
    try {
      return `<style>${inlineCss(read(full, "utf8"), posix.dirname(rel))}</style>`;
    } catch (err) {
      if (err instanceof UserError) throw err;
      return tag;
    }
  });
  html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (m, attrs, css) => `<style${attrs}>${inlineCss(css, ".")}</style>`);
  return html.replace(ATTR, (m, head, q, ref) => {
    if (!relativeRef(ref) || /\.html?$/i.test(ref.split(/[?#]/)[0])) return m;
    const full = local(ref);
    try {
      return full ? `${head}${q}${dataUri(read(full), mimeOf(full))}${q}` : m;
    } catch (err) {
      if (err instanceof UserError) throw err;
      return m;
    }
  });
}

const URL_WHOLE = /^\/r\/[0-9a-f]{8,64}\/[^\s]+$/;
const URL_IN = /\/r\/[0-9a-f]{8,64}\/[^"'\s)\\]+/g;
const tooBig = (bytes) => new UserError(`the pictures, videos and files of the round would take ${Math.round(bytes / 1048576)} MB in the exported page (base64 makes them a third larger); an exported file holds up to ${EXPORT_LIMIT_MB} MB of them`, { status: 413 });
// What a file takes once it is written into the page as a data: URI.
const written = (size) => Math.ceil((size * 4) / 3);

// Every /r/ URL a value holds, whole or inside markdown text, with how many times it appears: each one is written into the page.
function mediaUrls(view) {
  const urls = new Map();
  const count = (u) => urls.set(u, (urls.get(u) || 0) + 1);
  JSON.stringify(view, (k, v) => {
    if (typeof v === "string") {
      if (URL_WHOLE.test(v)) count(v);
      else for (const m of v.matchAll(URL_IN)) count(m[0]);
    }
    return v;
  });
  return urls;
}

const sizeOf = (file) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

// Swaps every /r/<id>/<file> in the round for a data: URI; fileFor maps a URL path to the file on disk. The sizes of
// everything that would go in are added up with stat first, and the round is refused over the limit before a byte is read.
// Sizes are what each file takes once written (base64), plus `extra` bytes the page carries anyway.
export function inlineMedia(view, fileFor, { extra = 0 } = {}) {
  const limit = EXPORT_LIMIT_MB * 1024 * 1024;
  let bytes = extra;
  const addWritten = (n) => {
    bytes += n;
    if (bytes > limit) throw tooBig(bytes);
  };
  const add = (size) => addWritten(written(size));
  const files = new Map();
  const counts = mediaUrls(view);
  // Every occurrence is written into the page, so a picture used in six questions counts six times.
  for (const [url, n] of counts) {
    const file = fileFor(url);
    files.set(url, file);
    if (file) addWritten(written(sizeOf(file)) * n);
  }
  const extras = new Map(); // a mockup's own files, per url: what one more occurrence adds
  const cache = new Map();
  const missing = [];
  const inline = (url) => {
    if (cache.has(url)) {
      if (extras.get(url)) addWritten(extras.get(url));
      return cache.get(url);
    }
    const file = files.get(url);
    const before = bytes;
    let out = url;
    try {
      let buf;
      if (extname(file).match(/^\.html?$/i)) {
        // A mockup's own files (CSS, scripts, pictures) go in too: counted before each is read.
        // Its files are found the way the server finds them under the mockup's URL: a mockup served alone has none.
        const base = url.slice(0, url.lastIndexOf("/") + 1);
        const locate = (rel) => fileFor(base + rel.split("/").map(encodeURIComponent).join("/"));
        buf = Buffer.from(
          inlineHtml(
            file,
            (f, enc) => {
              if (f !== file) add(sizeOf(f));
              return readFileSync(f, enc);
            },
            locate,
          ),
        );
        extras.set(url, bytes - before);
      } else buf = readFileSync(file);
      out = dataUri(buf, mimeOf(file), basename(file));
    } catch (err) {
      if (err instanceof UserError) throw err;
      missing.push(url);
    }
    cache.set(url, out);
    return out;
  };
  const json = JSON.stringify(view, (k, v) => (typeof v !== "string" ? v : URL_WHOLE.test(v) ? inline(v) : v.replace(URL_IN, inline)));
  return { view: JSON.parse(json), bytes, missing };
}

// Does the round draw a diagram anywhere? Then the file carries the Mermaid frame.
function hasMermaid(value) {
  if (Array.isArray(value)) return value.some(hasMermaid);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([k, v]) => (k === "mermaid" ? typeof v === "string" && v.trim() !== "" : hasMermaid(v)));
}

// The frame's document with the vendored bundle inside it as a data: URI: it runs as srcdoc in a sandboxed frame, nothing fetched.
function mermaidFrame() {
  const vendor = join(UI_DIR, "vendor");
  const bundle = readFileSync(join(vendor, "mermaid.min.js"));
  const frame = readFileSync(join(vendor, "mermaid-frame.html"), "utf8");
  const tag = '<script src="/ui/vendor/mermaid.min.js"></script>';
  if (!frame.includes(tag)) throw new Error("mermaid-frame.html does not load the vendored bundle the way export expects");
  return frame.replace(tag, () => `<script src="${dataUri(bundle, "text/javascript")}"></script>`);
}

const scriptJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

// view: what GET /api/rounds/:id returns; fileFor: the daemon's /r/ resolver.
export function buildExport(view, fileFor, { from = "" } = {}) {
  if (view.mode === "swipe") throw new UserError("export works on question rounds; a swipe deck needs the agent between batches", { status: 409 });
  const withMermaid = hasMermaid(view.spec);
  const { view: inlined, missing } = inlineMedia(
    { id: view.id, mode: "questions", status: "pending", spec: view.spec, draft: null, result: null, live: false, listening: false, dialog: [], swipe: null },
    fileFor,
    { extra: withMermaid ? written(sizeOf(join(UI_DIR, "vendor", "mermaid.min.js"))) + sizeOf(join(UI_DIR, "vendor", "mermaid-frame.html")) : 0 },
  );
  // Every stylesheet the page links, in the page's own order: a sheet added to index.html reaches the file too
  // (a hand-kept list had lost forms, tune, states and done, so those questions came out unstyled).
  const index = readFileSync(join(UI_DIR, "index.html"), "utf8");
  const css = [...index.matchAll(/<link rel="stylesheet" href="\/ui\/css\/([\w-]+)\.css" \/>/g)].map((m) => readFileSync(join(UI_DIR, "css", `${m[1]}.css`), "utf8")).join("\n");
  const mermaid = withMermaid ? `\n    <script type="application/json" id="decide-mermaid">${scriptJson({ frame: mermaidFrame() })}</script>` : "";
  const payload = { round: inlined, from, exportedAt: new Date().toISOString() };
  const html = index
    .replace(/\s*<link rel="stylesheet" href="\/ui\/css\/[\w-]+\.css" \/>/g, "")
    .replace("</head>", () => `    <style>\n${css}\n    </style>\n    <script type="importmap">${scriptJson(importMap())}</script>\n    <script type="application/json" id="decide-export">${scriptJson(payload)}</script>${mermaid}\n  </head>`)
    .replace('<script type="module" src="/ui/js/main.js"></script>', () => `<script type="module">import "${PREFIX}main.js";</script>`)
    .replace("<title>decide</title>", () => `<title>${escapeHtml(view.spec.title)} — decide</title>`);
  return { html, bytes: Buffer.byteLength(html), missing };
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// A spec exported without an open round: published through roots of its own.
export async function exportSpec(spec, { id, from = "", out }) {
  const roots = createRoots();
  const built = buildExport({ id, mode: "questions", spec: roots.publish(spec) }, roots.fileFor, { from });
  await writeHtml(out, built.html);
  return built;
}

function* slices(text, size = 1 << 20) {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

// Through a stream to a temp file beside the target, renamed into place: a failed export leaves what was there.
export async function writeHtml(file, html) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}-${randomBytes(3).toString("hex")}.tmp`;
  try {
    await pipeline(Readable.from(slices(html)), createWriteStream(temp));
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

// The real path of a file that may not exist yet: the real path of its nearest existing parent, plus the rest.
function realPath(p) {
  try {
    return realpathSync.native(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(realPath(parent), basename(p));
  }
}
const under = (base, file) => {
  const rel = relative(base, file);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

// An export goes into the project or the decide data dir. Anywhere else needs outside: true (--outside). Judged on
// real paths: a symlink in the project that points out is outside.
export function checkExportTarget(file, project, outside = false) {
  if (outside) return;
  const target = realPath(resolve(file));
  const allowed = [project.top ?? project.root, project.dataDir].filter(Boolean).map((d) => realPath(resolve(d)));
  if (allowed.some((d) => under(d, target))) return;
  throw new UserError(`${file} is outside the project (${allowed[0]}) and the decide data dir; pass outside: true (--outside on the command line) to write it there.`, { status: 422 });
}

// Which spec and answers file an exported round belongs to, so its answers can come back days later.
const recordPath = (dataDir, id) => join(dataDir, "exports", `${String(id).replace(/[^\w-]/g, "_")}.json`);

export function recordExport(dataDir, record) {
  const file = recordPath(dataDir, record.round);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2));
}

// Looks in the project's data dir, then in its 2.x data dirs (a worktree's own, as readAll does for the journal).
// Takes a project ({ dataDir, legacyDirs }) or just a data dir.
export function findExport(project, id) {
  const dirs = typeof project === "string" ? [project] : [project.dataDir, ...(project.legacyDirs || [])];
  for (const dir of dirs) {
    const file = recordPath(dir, id);
    if (!existsSync(file)) continue;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {}
  }
  return null;
}
