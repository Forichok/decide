// http.mjs — small helpers for the loopback daemon: JSON replies, bounded
// body reading, the request guard (Host, Origin, token), the page's and
// the assets' Content-Security-Policy, and path containment.

import { timingSafeEqual } from "node:crypto";
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
// document an opaque origin, so whatever it sends carries `Origin: null`, which guard() refuses.
export const ASSET_CSP = "sandbox allow-scripts allow-popups";

// Routes only an agent calls: the page never does, so its Origin proves nothing for them. [method, path].
const AGENT_ROUTES = [
  ["POST", /^\/api\/(?:stop|handover|rounds)$/],
  ["GET", /^\/api\/rounds\/[\w-]+\/next$/],
  ["POST", /^\/api\/rounds\/[\w-]+\/(?:ack|explain|push|export|import|dismiss)$/],
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
  const origin = req.headers.origin;
  const own = origin !== undefined && (origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`);
  if (origin !== undefined && !own) return refuse("origin not allowed");
  // A browser says how a request relates to the page: only the page itself (or the address bar) may use the API.
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && pathname.startsWith("/api/") && site !== "same-origin" && site !== "none") return refuse("cross-site request");
  const given = req.headers["x-decide-token"];
  const proved = given !== undefined && sameToken(given, token);
  if (given !== undefined && !proved) return refuse("wrong x-decide-token");
  const path = pathname;
  if (!changes(req.method, path)) return { ok: true };
  if (proved) return { ok: true };
  if (own && !AGENT_ROUTES.some(([method, re]) => method === req.method && re.test(path))) return { ok: true };
  return refuse(own ? "this route needs the x-decide-token of daemon.json" : "a change needs the page's own Origin or the x-decide-token");
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

