// http.mjs — small helpers for the loopback daemon: JSON replies, bounded
// body reading, the request guard (Host, Origin, token), the page's and
// the assets' Content-Security-Policy, and path containment.

import { createHash, timingSafeEqual } from "node:crypto";
import { resolve, sep } from "node:path";

const MAX_BODY = 25 * 1024 * 1024;

export function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function hostAllowed(host, port) {
  return typeof host === "string" && [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase());
}

// The page's policy: its own scripts and styles only, no CDN, no inline code. Frames are same-origin
// documents (previews under /r/, html blocks under /h/), each carrying ASSET_CSP.
export const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
// Served files a spec points to, and html blocks: the sandbox without allow-same-origin gives the
// document an opaque origin, so whatever it sends carries `Origin: null`, which guard() refuses. They load
// the server's own files, data: and blob: only, inline code included: nothing from the network.
export const ASSET_CSP = "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; sandbox allow-scripts allow-popups";

// The Mermaid frame (ui/vendor/mermaid-frame.html) is a document of its own, framed by the page. Its policy
// travels as a header: nothing is fetched (default-src 'none') but its own scripts, the one inline script it
// has (allowed by its hash) and inline styles, which Mermaid writes into its drawing; the sandbox has no
// allow-same-origin, so the frame has an opaque origin and its requests carry `Origin: null`. frame-ancestors 'self'
// lets only a page of the server's own origin frame it.
export function frameCsp(html) {
  const hashes = [...String(html).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  return `default-src 'none'; script-src 'self' ${hashes.join(" ")}; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; sandbox allow-scripts`.replace(/ ;/g, ";");
}

// Routes only an agent calls: the page never does, so its Origin proves nothing for them. [method, path].
const AGENT_ROUTES = [
  ["POST", /^\/api\/(?:stop|handover|rounds)$/],
  ["GET", /^\/api\/rounds\/[\w-]+\/next$/],
  ["POST", /^\/api\/rounds\/[\w-]+\/(?:ack|explain|push|export|import|dismiss|patch)$/],
];

// A change: any method but GET and HEAD, and the one GET that takes a round's wait over for someone else.
const changes = (method, path) => (method !== "GET" && method !== "HEAD") || /^\/api\/rounds\/[\w-]+\/next$/.test(path);

const sameToken = (given, token) => {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(token));
  return a.length === b.length && timingSafeEqual(a, b);
};

// The request target is read once. A target that two readers could read two ways (the guard and the router,
// a proxy, the file system) is refused before anything reads it: it must start with "/" and carry no "#" or
// "\\", no empty segment ("//") and no dot segment, raw or percent-encoded in any case (%2e, %2f, %5c).
// Returns the parsed URL, or null for a target that is refused (answer 400).
export function parseTarget(target) {
  const raw = String(target ?? "");
  if (!raw.startsWith("/") || /[#\\\u0000-\u001f]/.test(raw)) return null;
  const path = raw.split("?")[0].replace(/%2e/gi, ".").replace(/%2f/gi, "/").replace(/%5c/gi, "\\");
  if (path.includes("\\") || path.includes("//")) return null;
  if (path.split("/").some((seg) => seg === "." || seg === "..")) return null;
  try {
    return new URL(raw, "http://x");
  } catch {
    return null;
  }
}

// First thing every request meets. Host must be this server's own loopback name; a request that names an
// Origin must name this server's own (a GET too: a page of another origin reads nothing); a token that is
// present must be right; and a change needs the page's own Origin or the token (an agent's routes the token).
export function guard(req, { port, token, pathname }) {
  const refuse = (error) => ({ ok: false, status: 403, error });
  if (!hostAllowed(req.headers.host, port)) return refuse("host not allowed");
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const origin = req.headers.origin;
  const own = origin !== undefined && origins.includes(origin);
  if (origin !== undefined && !own) return refuse("origin not allowed");
  // A browser says how a request relates to the page: only the page itself (or the address bar) may use the API.
  const site = req.headers["sec-fetch-site"];
  const sameSite = site === undefined || site === "same-origin" || site === "none";
  if (!sameSite && pathname.startsWith("/api/")) return refuse("cross-site request");
  // A served file or html block is for the page and its own frames. The page's requests name its origin as
  // Referer. A sandboxed frame has an opaque origin: Chrome marks its requests (styles, scripts, images, nested
  // frames, links) cross-site and sends no Referer at all, whatever the referrer policy, so that one shape is let
  // through. A Referer of another origin, and a same-site request from another port, are refused.
  const referer = req.headers.referer;
  const opaqueFrame = site === "cross-site" && (referer === undefined || referer === "");
  if (!sameSite && (pathname.startsWith("/r/") || pathname.startsWith("/h/")) && !opaqueFrame && !origins.includes(originOf(referer))) return refuse("cross-site request");
  const given = req.headers["x-decide-token"];
  const proved = given !== undefined && sameToken(given, token);
  if (given !== undefined && !proved) return refuse("wrong x-decide-token");
  const path = pathname;
  if (!changes(req.method, path)) return { ok: true };
  if (proved) return { ok: true };
  if (own && !AGENT_ROUTES.some(([method, re]) => method === req.method && re.test(path))) return { ok: true };
  return refuse(own ? "this route needs the x-decide-token of daemon.json" : "a change needs the page's own Origin or the x-decide-token");
}

// The origin of a Referer header, or "" when there is none or it is not a URL.
function originOf(referer) {
  try {
    return new URL(String(referer)).origin;
  } catch {
    return "";
  }
}

export function inside(root, rel) {
  const full = resolve(root, safeDecode(rel));
  return full.startsWith(root.endsWith(sep) ? root : root + sep) ? full : null;
}

export function safeDecode(s) {
  try {
    return decodeURIComponent(String(s || ""));
  } catch {
    return String(s || "");
  }
}

export function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function readJson(req) {
  const buf = await readBody(req);
  try {
    return JSON.parse(buf.toString("utf8") || "null");
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

