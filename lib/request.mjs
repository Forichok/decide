// request.mjs — one HTTP request to a decide server on 127.0.0.1, over
// node:http. The product makes no request through fetch: on Node 24 its
// undici throws from inside a socket handler when the peer has already reset
// the connection (uncaught: it kills the process), and it reports an answer
// that is not HTTP without a code that says so. Here every outcome is a
// settled promise: a decoded answer, or an error whose kind says what happened.

import { request as httpRequest } from "node:http";

// The most of an answer's body that is read. A ping's answer is a few hundred bytes, so whatever else holds
// a port cannot stream into a probe until its timeout; any other answer is far under the general cap.
export const PING_BODY_MAX = 64 * 1024;
export const BODY_MAX = 64 * 1024 * 1024;

// Resolves { status, data } once the whole answer is read: data is the parsed JSON body, or null when the
// body is empty or not JSON. Rejects with an Error whose `kind` is:
//   "refused" (ECONNREFUSED: nobody listens), "timeout" (no full answer within timeoutMs),
//   "aborted" (signal), or "failed" (anything else: a reset, a socket closed before an answer,
//   an answer that is not HTTP, a body over maxBytes). `code` carries the system or parser code when there is one.
// The address is always the literal 127.0.0.1, never localhost, which may resolve to ::1 first. How fast
// Windows refuses a closed loopback port has not been measured here: it may take up to about 2 s.
// No pooled sockets (agent: false). timeoutMs 0 means no timeout.
export function request(port, path, { method = "GET", headers = {}, body, timeoutMs = 1500, signal, maxBytes = BODY_MAX } = {}) {
  return new Promise((resolve, reject) => {
    const fail = (kind, message, code) => Object.assign(new Error(message), { kind, ...(code && { code }) });
    if (signal?.aborted) return reject(fail("aborted", `${method} ${path}: aborted`));
    const payload = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    let settled = false;
    let timer;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err) {
        req.destroy();
        reject(err);
      } else resolve(value);
    };
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method,
      agent: false,
      headers: { ...headers, ...(payload && { "content-length": payload.length }) },
    });
    const onAbort = () => done(fail("aborted", `${method} ${path}: aborted`));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs) timer = setTimeout(() => done(fail("timeout", `${method} ${path}: no answer within ${timeoutMs} ms`)), timeoutMs);
    req.on("error", (err) =>
      done(err.code === "ECONNREFUSED" ? fail("refused", `${method} ${path}: connection refused`, err.code) : fail("failed", `${method} ${path}: ${err.message}`, err.code)),
    );
    req.on("response", (res) => {
      const chunks = [];
      let size = 0;
      const tooLarge = () => done(fail("failed", `${method} ${path}: the answer is over ${maxBytes} bytes`, "EBODYTOOLARGE"));
      if (Number(res.headers["content-length"]) > maxBytes) return tooLarge();
      res.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) return tooLarge();
        chunks.push(c);
      });
      res.on("error", (err) => done(fail("failed", `${method} ${path}: ${err.message}`, err.code)));
      res.on("aborted", () => done(fail("failed", `${method} ${path}: the answer was cut off`, "ECONNRESET")));
      res.on("end", () => {
        if (!res.complete) return done(fail("failed", `${method} ${path}: the answer was cut off`, "ECONNRESET"));
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {}
        done(null, { status: res.statusCode, data });
      });
    });
    req.end(payload);
  });
}
