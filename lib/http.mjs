// http.mjs — small helpers for the loopback daemon: JSON replies, bounded
// body reading, Host allow-list and path containment.

import { resolve, sep } from "node:path";

const MAX_BODY = 25 * 1024 * 1024;

export function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function hostAllowed(host, port) {
  return typeof host === "string" && [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase());
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
