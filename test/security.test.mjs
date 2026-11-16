/**
 * Feature:    only the page and token holders can change a round
 * Layer:      Unit (guard) and integration (in-process servers over loopback HTTP, a held wait across a restart)
 * Covers:
 *   - guard(): Host, then Origin (every method), then Origin or token for a change; agent routes take the token only
 *   - a refused request changes nothing: no event is appended
 *   - the page is served with PAGE_CSP and nothing in ui/ needs inline script or style
 *   - an html block is served from a URL of its own with the sandbox policy, survives a restart, and its
 *     opaque origin ("null") is refused by the guard
 *   - the request target is read once: a target that reads two ways (dot segments, \\, #, //, absolute form) is refused 400
 *   - the page cannot be framed (frame-ancestors, X-Frame-Options); an /api request marked cross-site or same-site is refused
 *   - x-decide is gone; the legacy no-round routes are gone
 *   - served files: an image publishes itself only, a mockup its own directory; URLs are the same after a restart;
 *     two paths with one hash never serve each other; a round's roots are dropped with the round
 *   - the Mermaid frame: a policy header of its own with a sandbox, nothing under ui/ names a CDN host
 *   - a stale token after a restart: the wait survives, the ack lands; a real refusal is thrown
 * Isolation:  every test has its own DECIDE_HOME; no test binds 47474; every process is stopped by its pid.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { PAGE_CSP, ASSET_CSP, guard } from "../lib/http.mjs";
import { startServer } from "../lib/server.mjs";
import { createRoots, fnv1a } from "../lib/assets.mjs";
import { prepareSpec } from "../lib/prepare.mjs";
import { openProject } from "../lib/project.mjs";
import { roundDir } from "../lib/store/rounds.mjs";
import { ack, api, findServer, waitNext } from "../lib/client.mjs";
import { PROTOCOL } from "../lib/protocol.mjs";
import { alive, asAgent, asPage, fakeServer, hasGit, homeOf, notePid, pluginDir, repoWithWorktree, scratchDir, spawnServer } from "./helpers.mjs";
import { exportRound } from "../lib/transfer.mjs";
import { exportSpec } from "../lib/export.mjs";

delete process.env.DECIDE_PORT;
process.env.DECIDE_NOTIFY = "0";

const BLOCK = '<p id="x">hello</p><script>document.getElementById("x").textContent = "ran"</script>';
const spec = {
  title: "Colour",
  questions: [
    { id: "color", title: "Which colour?", options: [{ id: "pink", label: "Pink" }, { id: "blue", label: "Blue" }] },
    { id: "mock", title: "Which mockup?", html: { source: BLOCK, maxHeight: 640 }, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
  ],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (port, route) => `http://127.0.0.1:${port}${route}`;
const body = (value) => (value === undefined ? undefined : JSON.stringify(value));

async function until(check, what, ms = 5_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

// An in-process server of a scratch home with one open round.
async function served(t) {
  const dir = await scratchDir(t);
  const home = homeOf(dir);
  await mkdir(home, { recursive: true });
  const started = await startServer({ home, embedded: true });
  assert.ok(started);
  t.after(() => started.stop());
  const { port, token } = started;
  const res = await fetch(url(port, "/api/rounds"), { method: "POST", headers: asAgent(port), body: body({ project: dir, spec, outPath: path.join(dir, "c.answers.json"), open: false, live: true }) });
  assert.equal(res.status, 200);
  const { id } = await res.json();
  return { dir, home, port, token, id };
}

const eventsOf = (dir, home, id) =>
  readFileSync(path.join(roundDir(openProject(dir, home).dataDir, id), "events.jsonl"), "utf8").trim().split("\n");

// ---- guard() on its own

const req = (method, pathname, headers = {}) => ({ method, url: pathname, headers: { host: "127.0.0.1:5000", ...headers } });
const opts = { port: 5000, token: "t".repeat(32) };
// The server parses the target once and hands the guard its pathname; the unit tests do the same.
const guardOf = (r, o = opts) => guard(r, { ...o, pathname: String(r.url).split("?")[0] });
const verdict = (r) => (r.ok ? "ok" : r.status);

test("guard: the host must be loopback and own port, and a refusal says so", () => {
  assert.deepEqual(guardOf(req("GET", "/api/state")), { ok: true });
  assert.equal(verdict(guardOf(req("GET", "/api/state", { host: "evil.example:5000" }))), 403);
  assert.equal(verdict(guardOf(req("GET", "/api/state", { host: "127.0.0.1:5001" }))), 403);
  assert.equal(verdict(guardOf({ method: "GET", url: "/", headers: {} })), 403);
  const refused = guardOf(req("GET", "/api/state", { host: "evil.example:5000" }));
  assert.deepEqual([refused.ok, refused.status, typeof refused.error], [false, 403, "string"]);
});

test("guard: an Origin that is not this server's own is refused for every method, GET included", () => {
  for (const origin of ["https://evil.example", "http://127.0.0.1:5001", "http://localhost:5001", "null", "http://127.0.0.1", "https://127.0.0.1:5000", "http://127.0.0.1:5000.evil.example", ""]) {
    for (const method of ["GET", "HEAD", "POST", "PUT", "OPTIONS"]) assert.equal(verdict(guardOf(req(method, "/api/state", { origin }))), 403, `${method} ${origin}`);
  }
  for (const origin of ["http://127.0.0.1:5000", "http://localhost:5000"]) assert.equal(verdict(guardOf(req("GET", "/api/state", { origin }))), "ok");
});

test("guard: a change needs a same-origin Origin or the token; a wrong token is refused whatever the Origin says", () => {
  const own = "http://127.0.0.1:5000";
  assert.equal(verdict(guardOf(req("POST", "/api/rounds/1-abcdef/submit"))), 403, "neither");
  assert.equal(verdict(guardOf(req("POST", "/api/rounds/1-abcdef/submit", { origin: own }))), "ok", "the page");
  assert.equal(verdict(guardOf(req("POST", "/api/rounds/1-abcdef/submit", { "x-decide-token": opts.token }))), "ok", "an agent");
  assert.equal(verdict(guardOf(req("POST", "/api/rounds/1-abcdef/submit", { "x-decide-token": "x".repeat(32) }))), 403, "wrong token");
  assert.equal(verdict(guardOf(req("POST", "/api/rounds/1-abcdef/submit", { "x-decide-token": "short" }))), 403, "wrong length");
  assert.equal(verdict(guardOf(req("POST", "/api/rounds/1-abcdef/submit", { origin: own, "x-decide-token": "x".repeat(32) }))), 403, "wrong token beside a good Origin");
  assert.equal(verdict(guardOf(req("GET", "/api/state", { "x-decide-token": "x".repeat(32) }))), 403, "wrong token on a read");
});

test("guard: the routes only an agent calls take the token and nothing else, and a held wait counts as a change", () => {
  const own = "http://127.0.0.1:5000";
  const agent = [
    ["POST", "/api/stop"],
    ["POST", "/api/handover"],
    ["POST", "/api/rounds"],
    ["GET", "/api/rounds/1-abcdef/next?waiter=a"],
    ["POST", "/api/rounds/1-abcdef/ack"],
    ["POST", "/api/rounds/1-abcdef/explain"],
    ["POST", "/api/rounds/1-abcdef/push"],
    ["POST", "/api/rounds/1-abcdef/export"],
    ["POST", "/api/rounds/1-abcdef/import"],
    ["POST", "/api/rounds/1-abcdef/dismiss"],
  ];
  for (const [method, route] of agent) {
    assert.equal(verdict(guardOf(req(method, route, { origin: own }))), 403, `${method} ${route} with only the page's Origin`);
    assert.equal(verdict(guardOf(req(method, route))), 403, `${method} ${route} with nothing`);
    assert.equal(verdict(guardOf(req(method, route, { "x-decide-token": opts.token }))), "ok", `${method} ${route} with the token`);
  }
  // Reads and the page's own writes take either proof.
  assert.equal(verdict(guardOf(req("GET", "/api/rounds/1-abcdef"))), "ok");
  assert.equal(verdict(guardOf(req("GET", "/api/events"))), "ok");
  assert.equal(verdict(guardOf(req("PUT", "/api/rounds/1-abcdef/draft", { origin: own }))), "ok");
  assert.equal(verdict(guardOf(req("POST", "/api/watching", { origin: own }))), "ok");
});

// ---- the server

test("a POST from another origin is refused and no event is appended", async (t) => {
  const { dir, home, port, id } = await served(t);
  const before = eventsOf(dir, home, id).length;
  for (const origin of ["https://evil.example", "null", "http://127.0.0.1:9", "http://localhost:9"]) {
    const res = await fetch(url(port, `/api/rounds/${id}/draft`), { method: "PUT", headers: asPage(port, { origin }), body: body({ answers: { color: { selected: ["pink"] } } }) });
    assert.equal(res.status, 403, origin);
    const res2 = await fetch(url(port, `/api/rounds/${id}/submit`), { method: "POST", headers: asPage(port, { origin }), body: body({ answers: {} }) });
    assert.equal(res2.status, 403, origin);
  }
  assert.equal(eventsOf(dir, home, id).length, before, "the log is as it was");
  assert.equal((await (await fetch(url(port, `/api/rounds/${id}`))).json()).status, "pending");
});

test("a POST with no Origin and no token is refused", async (t) => {
  const { dir, home, port, id } = await served(t);
  const before = eventsOf(dir, home, id).length;
  const res = await fetch(url(port, `/api/rounds/${id}/submit`), { method: "POST", headers: { "content-type": "application/json" }, body: body({ answers: {} }) });
  assert.equal(res.status, 403);
  assert.equal(eventsOf(dir, home, id).length, before);
});

test("a POST with the token passes; a wrong token does not, even beside the page's own Origin", async (t) => {
  const { dir, home, port, id } = await served(t);
  const draft = body({ answers: { color: { selected: ["pink"] } } });
  const before = eventsOf(dir, home, id).length;
  assert.equal((await fetch(url(port, `/api/rounds/${id}/draft`), { method: "PUT", headers: asPage(port, { "x-decide-token": "0".repeat(32) }), body: draft })).status, 403);
  assert.equal((await fetch(url(port, `/api/rounds/${id}/draft`), { method: "PUT", headers: asPage(port, { "x-decide-token": "short" }), body: draft })).status, 403);
  assert.equal(eventsOf(dir, home, id).length, before);
  assert.equal((await fetch(url(port, `/api/rounds/${id}/draft`), { method: "PUT", headers: asAgent(port), body: draft })).status, 200);
  assert.equal(eventsOf(dir, home, id).length, before + 1);
});

test("GET /api/state with a foreign Origin is refused, and so is the event stream", async (t) => {
  const { port } = await served(t);
  for (const origin of ["https://evil.example", "null"]) {
    assert.equal((await fetch(url(port, "/api/state"), { headers: { origin } })).status, 403, origin);
    assert.equal((await fetch(url(port, "/api/events"), { headers: { origin } })).status, 403, origin);
    assert.equal((await fetch(url(port, "/api/journal"), { headers: { origin } })).status, 403, origin);
  }
  assert.equal((await fetch(url(port, "/api/state"), { headers: { origin: `http://127.0.0.1:${port}` } })).status, 200);
  assert.equal((await fetch(url(port, "/api/state"))).status, 200, "no Origin: a plain GET");
});

test("a Host header that is not loopback is refused", async (t) => {
  const { port } = await served(t);
  const asked = (host) =>
    new Promise((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, path: "/api/state", headers: { host } }, (res) => (res.resume(), resolve(res.statusCode)));
      r.on("error", reject);
      r.end();
    });
  assert.equal(await asked("evil.example"), 403);
  assert.equal(await asked(`evil.example:${port}`), 403);
  assert.equal(await asked(`localhost:${port}`), 200);
});

test("the agent's routes take the token only: the page's own Origin is not enough", async (t) => {
  const { dir, port, id } = await served(t);
  const send = (headers, route, method = "POST", payload) => fetch(url(port, route), { method, headers, body: body(payload) });
  const page = asPage(port);
  const agent = asAgent(port);
  const newRound = { project: dir, spec, open: false };
  assert.equal((await send(page, "/api/rounds", "POST", newRound)).status, 403, "a new round");
  assert.equal((await send(agent, "/api/rounds", "POST", newRound)).status, 200);
  assert.equal((await send(page, `/api/rounds/${id}/ack`, "POST", { seq: 1, waiter: "a" })).status, 403, "ack");
  assert.equal((await send(agent, `/api/rounds/${id}/ack`, "POST", { seq: 1, waiter: "a" })).status, 200);
  assert.equal((await send(page, `/api/rounds/${id}/explain`, "POST", { question: "color", text: "x" })).status, 403, "explain");
  assert.equal((await send(agent, `/api/rounds/${id}/explain`, "POST", { question: "color", text: "x" })).status, 200);
  assert.equal((await send(page, `/api/rounds/${id}/next?waiter=a&timeout=1000`, "GET")).status, 403, "a wait takes the round over");
  assert.equal((await send(agent, `/api/rounds/${id}/next?waiter=a&timeout=1000`, "GET")).status, 204, "nothing came, and the token was enough");
  assert.equal((await send(page, `/api/rounds/${id}/dismiss`, "POST")).status, 403, "dismiss");
  assert.equal((await send(page, "/api/stop", "POST")).status, 403, "stop");
  assert.equal((await send(page, "/api/handover", "POST")).status, 403, "handover");
  // What the page does keeps working with the Origin alone, and with the token alone.
  assert.equal((await send(page, `/api/rounds/${id}/ask`, "POST", { question: "color", text: "why?" })).status, 200);
  assert.equal((await send(page, `/api/rounds/${id}/draft`, "PUT", { answers: {} })).status, 200);
  assert.equal((await send(page, "/api/watching", "POST", { page: "p", watching: true })).status, 200);
});

test("the 2.1 page saves a draft from its own origin, whichever loopback name it was opened by", async (t) => {
  const { dir, home, port, id } = await served(t);
  const before = eventsOf(dir, home, id).length;
  for (const name of ["127.0.0.1", "localhost"]) {
    const res = await fetch(`http://${name}:${port}/api/rounds/${id}/draft`, { method: "PUT", headers: { "content-type": "application/json", origin: `http://${name}:${port}` }, body: body({ answers: { color: { selected: ["blue"] } } }) });
    assert.equal(res.status, 200, name);
  }
  assert.equal(eventsOf(dir, home, id).length, before + 2);
});

test("the legacy routes without a round id are gone", async (t) => {
  const { port, id } = await served(t);
  assert.equal((await fetch(url(port, "/submit"), { method: "POST", headers: asPage(port), body: body({ answers: {} }) })).status, 404);
  assert.equal((await fetch(url(port, "/cancel"), { method: "POST", headers: asPage(port) })).status, 404);
  assert.equal((await (await fetch(url(port, `/api/rounds/${id}`))).json()).status, "pending", "nothing settled the round");
});

// ---- one reading of the request target

// The wire bytes, verbatim: fetch and http.request would tidy some of these targets, a socket does not.
function raw(port, target, { method = "GET", headers = {}, bodyText = "" } = {}) {
  return new Promise((resolve, reject) => {
    const lines = [`${method} ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: close", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    if (bodyText) lines.push(`Content-Length: ${Buffer.byteLength(bodyText)}`, "Content-Type: application/json");
    const socket = net.connect(port, "127.0.0.1", () => socket.write(`${lines.join("\r\n")}\r\n\r\n${bodyText}`));
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (d) => (data += d));
    socket.on("error", reject);
    socket.on("close", () => resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1]), text: data.split("\r\n\r\n").slice(1).join("\r\n\r\n") }));
  });
}

const attacks = (port, id) => [
  ["POST", "/api/x/../stop"],
  ["POST", "/api/x/../rounds"],
  ["POST", "/api/%2e%2e/api/rounds"],
  ["POST", "/api/%2E%2e/api/rounds"],
  ["POST", "/api/.%2e/api/rounds"],
  ["POST", "/api/x/%2e%2e/stop"],
  ["POST", "/api/x/..%2fstop"],
  ["GET", `/api/rounds/${id}/z/../next?waiter=evil&timeout=1000`],
  ["GET", `/api/rounds/${id}/z/..\\next?waiter=evil&timeout=1000`],
  ["GET", `/api/rounds/${id}/next#?waiter=evil&timeout=1000`],
  ["GET", `/api/rounds/${id}/next#`],
  ["GET", `http://127.0.0.1:${port}/api/rounds/${id}/next?waiter=evil&timeout=1000`],
  ["GET", `/api/rounds/${id}/./next?waiter=evil&timeout=1000`],
  ["GET", `/api/rounds/${id}/next/.`],
  ["GET", `/api/rounds/${id}/next/..`],
  ["GET", `//api/rounds/${id}/next?waiter=evil`],
  ["GET", `/api//rounds/${id}/next?waiter=evil`],
  ["GET", "api/state"],
  ["POST", `/api/rounds/${id}/ack#x`],
  ["POST", `/api/rounds/${id}/x/../explain`],
  ["POST", `/api/rounds/${id}/..\\explain`],
];

test("a request target that reads two ways is refused with 400, and nothing happens", async (t) => {
  const { dir, home, port, id } = await served(t);
  // An agent holds the round's wait.
  const hold = new AbortController();
  let held = "pending";
  const waiting = fetch(url(port, `/api/rounds/${id}/next?waiter=mine&timeout=20000`), { headers: asAgent(port), signal: hold.signal }).then((r) => (held = r.status), () => (held = "aborted"));
  t.after(() => hold.abort());
  await sleep(150);
  const rounds = async () => (await (await fetch(url(port, "/api/state"))).json()).rounds?.length ?? JSON.stringify(await (await fetch(url(port, "/api/state"))).json());
  const before = { events: eventsOf(dir, home, id).length, rounds: await rounds() };
  for (const [method, target] of attacks(port, id)) {
    const res = await raw(port, target, { method, bodyText: method === "POST" ? body({ project: dir, spec, open: false, images: [path.join(home, "daemon.json")] }) : "" });
    assert.equal(res.status, 400, `${method} ${target}`);
    assert.ok(res.text.length < 200, "a short body");
  }
  assert.equal((await fetch(url(port, "/api/ping"))).status, 200, "the server still runs");
  assert.equal(await rounds(), before.rounds, "no round was created");
  assert.equal(eventsOf(dir, home, id).length, before.events, "the log is as it was");
  assert.equal(held, "pending", "the held wait was not replaced");
  assert.equal((await fetch(url(port, "/r/0/daemon.json"))).status, 404, "nothing new is published under /r/");
});

test("the tidy forms of the same targets still work, and a target with a dot in a name is fine", async (t) => {
  const { port, id } = await served(t);
  assert.equal((await raw(port, "/api/state")).status, 200);
  assert.equal((await raw(port, `/api/rounds/${id}`)).status, 200);
  assert.equal((await raw(port, "/api/state?a=../b#c".replace("#c", ""))).status, 200, "dots in the query are the query's");
  assert.equal((await raw(port, "/ui/js/main.js")).status, 200);
  assert.equal((await raw(port, "/api/journal?x=%2e%2e")).status, 200);
});

// ---- the page

const filesUnder = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test("the page is served with the CSP, and no other file carries it", async (t) => {
  const { port } = await served(t);
  const expected =
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
  assert.equal(PAGE_CSP, expected);
  for (const route of ["/", "/ui/index.html"]) {
    const res = await fetch(url(port, route));
    assert.equal(res.status, 200, route);
    assert.equal(res.headers.get("content-security-policy"), expected, route);
    assert.match(res.headers.get("content-type"), /^text\/html/);
  }
  assert.equal((await fetch(url(port, "/ui/js/main.js"))).headers.get("content-security-policy"), null);
  assert.doesNotMatch(PAGE_CSP, /cdn|unsafe|\*/i, "no CDN host, no unsafe-*, no wildcard");
});

test("no site can frame the page: frame-ancestors and X-Frame-Options on the page, and on nothing the page frames", async (t) => {
  const { port, id } = await served(t);
  for (const route of ["/", "/ui/index.html"]) {
    const res = await fetch(url(port, route));
    assert.match(res.headers.get("content-security-policy"), /; frame-ancestors 'none'$/, route);
    assert.equal(res.headers.get("x-frame-options"), "DENY", route);
  }
  assert.equal((await fetch(url(port, "/ui/js/main.js"))).headers.get("x-frame-options"), null);
  const block = (await (await fetch(url(port, `/api/rounds/${id}`))).json()).spec.questions[1].html;
  const frame = await fetch(url(port, block.src));
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get("x-frame-options"), null, "the page frames its html blocks");
  assert.doesNotMatch(frame.headers.get("content-security-policy"), /frame-ancestors/);
});

test("an /api request that a browser marks cross-site or same-site is refused, whatever the method", async (t) => {
  const { dir, home, port, id } = await served(t);
  const before = eventsOf(dir, home, id).length;
  const draft = body({ answers: { color: { selected: ["pink"] } } });
  for (const site of ["cross-site", "same-site", "Cross-Site", "", "bogus"]) {
    const h = { "sec-fetch-site": site };
    assert.equal((await fetch(url(port, "/api/state"), { headers: h })).status, 403, `state ${site}`);
    assert.equal((await fetch(url(port, "/api/journal"), { headers: h })).status, 403, `journal ${site}`);
    const events = await fetch(url(port, "/api/events?page=evil&watching=1"), { headers: h });
    assert.equal(events.status, 403, `events ${site}`);
    await events.body?.cancel();
    assert.equal((await fetch(url(port, `/api/rounds/${id}/draft`), { method: "PUT", headers: asPage(port, h), body: draft })).status, 403, `draft ${site}`);
    assert.equal((await fetch(url(port, `/api/rounds/${id}/draft`), { method: "PUT", headers: asAgent(port, h), body: draft })).status, 403, `agent ${site}`);
  }
  assert.equal(eventsOf(dir, home, id).length, before);
  for (const site of ["same-origin", "none", undefined]) {
    const h = site === undefined ? {} : { "sec-fetch-site": site };
    assert.equal((await fetch(url(port, "/api/state"), { headers: h })).status, 200, `state ${site}`);
    assert.equal((await fetch(url(port, `/api/rounds/${id}/draft`), { method: "PUT", headers: asPage(port, h), body: draft })).status, 200, `draft ${site}`);
  }
  const stream = await fetch(url(port, "/api/events"), { headers: { "sec-fetch-site": "same-origin" } });
  assert.equal(stream.status, 200);
  await stream.body?.cancel();
  // Pages and assets are not API: a cross-site navigation or frame may load them (the frames carry their own policy).
  for (const route of ["/", "/ui/js/main.js"]) assert.equal((await fetch(url(port, route), { headers: { "sec-fetch-site": "cross-site" } })).status, 200, route);
});

test("nothing in ui/ needs an inline script or style, and the page sends no x-decide", () => {
  const ui = path.join(pluginDir, "ui");
  const index = readFileSync(path.join(ui, "index.html"), "utf8");
  assert.doesNotMatch(index, /<script(?![^>]*\bsrc=)/i, "an inline script");
  assert.doesNotMatch(index, /<style\b/i, "an inline style element");
  assert.doesNotMatch(index, /\sstyle\s*=/i, "a style attribute");
  assert.doesNotMatch(index, /\son\w+\s*=/i, "an inline handler");
  const js = filesUnder(path.join(ui, "js")).filter((f) => f.endsWith(".js"));
  assert.ok(js.length > 10);
  assert.ok(js.some((f) => f.includes(`${path.sep}lang${path.sep}`)) && js.some((f) => f.includes(`${path.sep}types${path.sep}`)), "the sub-folders are scanned");
  for (const full of js) {
    const file = path.relative(ui, full);
    const source = readFileSync(full, "utf8");
    // A style written through an HTML string or setAttribute is blocked by style-src; the CSSOM is not.
    assert.doesNotMatch(source, /\sstyle=["'\\]/, `${file}: a style attribute in an HTML string`);
    assert.doesNotMatch(source, /setAttribute\(\s*["']style["']/, `${file}: setAttribute("style")`);
    assert.doesNotMatch(source, /x-decide(?![-\w])/, `${file}: x-decide`);
    assert.doesNotMatch(source, /sendBeacon|<form\b|XMLHttpRequest/, `${file}: a write the Origin check would not see`);
  }
  const server = [...filesUnder(path.join(pluginDir, "lib")), path.join(pluginDir, "decide.mjs"), path.join(pluginDir, "mcp.mjs")].filter((f) => /\.m?js$/.test(f));
  assert.ok(server.length > 10 && server.some((f) => f.includes(`${path.sep}store${path.sep}`)), "lib/ is scanned with its sub-folders");
  for (const file of server) assert.doesNotMatch(readFileSync(file, "utf8"), /x-decide(?![-\w])/, path.relative(pluginDir, file));
});

// ---- the html block

test("an html block is served from its own URL with the sandbox policy, not as srcdoc", async (t) => {
  const { port, id } = await served(t);
  const round = await (await fetch(url(port, `/api/rounds/${id}`))).json();
  const block = round.spec.questions[1].html;
  assert.equal(block.source, BLOCK);
  assert.match(block.src, /^\/h\/[0-9a-f]{16,}\.html$/, "its own URL, not under /r/ or /ui/");
  const res = await fetch(url(port, block.src));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-security-policy"), ASSET_CSP);
  assert.equal(ASSET_CSP, "sandbox allow-scripts allow-popups", "no allow-same-origin: the document gets an opaque origin");
  assert.match(res.headers.get("content-type"), /^text\/html/);
  const doc = await res.text();
  assert.ok(doc.includes(BLOCK), "the snippet is in the document");
  assert.match(doc, /<script>/, "the height report is inline in the document, which the sandbox policy lets run");
  assert.equal((await fetch(url(port, "/h/0000000000000000.html"))).status, 404);
  assert.equal((await fetch(url(port, "/h/..%2Fdaemon.json"))).status, 400, "a dot segment is refused before anything reads it");
  const media = readFileSync(path.join(pluginDir, "ui", "js", "media", "html.js"), "utf8");
  assert.equal([...media.matchAll(/\.srcdoc\b/g)].length, 1, "one srcdoc left in the page's code");
  assert.match(media, /if \(offline \|\| !x\.src\) frame\.srcdoc/, "and it is for an exported file, which has no server");
  assert.match(media, /frame\.src = x\.src/);
});

test("an html block served from a tab, or from its frame, has an opaque origin: its requests are refused", async (t) => {
  const { dir, home, port, id } = await served(t);
  const before = eventsOf(dir, home, id).length;
  // A sandboxed document without allow-same-origin sends Origin: null.
  assert.equal((await fetch(url(port, `/api/rounds/${id}/submit`), { method: "POST", headers: { "content-type": "application/json", origin: "null" }, body: body({ answers: {} }) })).status, 403);
  assert.equal((await fetch(url(port, "/api/state"), { headers: { origin: "null" } })).status, 403);
  assert.equal((await fetch(url(port, "/api/rounds"), { headers: { origin: "null" } })).status, 403);
  assert.equal(eventsOf(dir, home, id).length, before);
});

test("an html block is kept in the round's directory: its URL is served again by the next server", async (t) => {
  const { dir, home, port, id, token } = await served(t);
  const src = (await (await fetch(url(port, `/api/rounds/${id}`))).json()).spec.questions[1].html.src;
  const first = await (await fetch(url(port, src))).text();
  assert.ok(first.includes(BLOCK));
  const stopped = await fetch(url(port, "/api/stop"), { method: "POST", headers: asAgent(port) });
  assert.equal(stopped.status, 200);
  await until(async () => (await fetch(url(port, "/api/ping")).catch(() => null)) === null, "the server to stop");
  assert.ok(readFileSync(path.join(roundDir(openProject(dir, home).dataDir, id), "spec.json"), "utf8").includes("hello"), "the source is in spec.json");
  const second = await startServer({ home, embedded: true });
  assert.ok(second);
  t.after(() => second.stop());
  assert.notEqual(second.token, token);
  const again = await fetch(url(second.port, src));
  assert.equal(again.status, 200);
  assert.equal(await again.text(), first);
});

// ---- a stale token after a restart

test("a wait survives a restart that changed the token, and its ack lands (skipped on win32: needs SIGKILL)", { skip: process.platform === "win32" }, async (t) => {
  const dir = await scratchDir(t);
  const home = homeOf(dir);
  await mkdir(home, { recursive: true });
  const first = await spawnServer(t, home);
  assert.equal(first.exited, null, first.output.stderr);
  const s = await findServer(home);
  const oldToken = s.token;
  const { id } = await api(s, "/api/rounds", { method: "POST", body: { project: dir, spec, open: false, live: true } });
  const held = waitNext(s, id, { waiter: "a", events: true, timeoutMs: 30_000 });
  await until(async () => (await (await fetch(url(first.port, "/api/state"))).json()).rounds.find((r) => r.id === id)?.waiting, "the wait to be held");

  process.kill(first.pid, "SIGKILL");
  await until(() => !alive(first.pid), "the server to die");
  const second = await spawnServer(t, home);
  assert.equal(second.exited, null, second.output.stderr);
  notePid(second.pid);
  const fresh = await findServer(home);
  assert.notEqual(fresh.token, oldToken, "a server that came back has a new token");
  assert.equal(fresh.port, first.port, "and the same port: the old token meets the new guard");

  await until(async () => (await (await fetch(url(second.port, "/api/state"))).json()).rounds.find((r) => r.id === id)?.waiting, "the wait to come back on the new server", 15_000);
  await fetch(url(second.port, `/api/rounds/${id}/ask`), { method: "POST", headers: asPage(second.port), body: body({ question: "color", text: "Still there?" }) });
  const item = await held;
  assert.deepEqual([item.kind, item.payload.ask.text], ["ask", "Still there?"]);
  assert.equal(s.token, fresh.token, "the handle was updated in place");
  await ack(s, id, item.seq, "a");
  const view = await (await fetch(url(second.port, `/api/rounds/${id}`))).json();
  assert.equal(view.dialog[0].seen, true, "the ack landed");
});

test("a 403 that a fresh token does not cure is a refusal: the token is read again once, then it is thrown", async (t) => {
  const { home, port, id } = await served(t);
  const server = await findServer(home);
  const wrong = { ...server, token: "0".repeat(32) };
  // The handle holds a token daemon.json does not name: one re-read gives the real token and the call lands.
  assert.equal((await api(wrong, `/api/rounds/${id}/ack`, { method: "POST", body: { seq: 1, waiter: "a" } })).ok, true);
  assert.equal(wrong.token, server.token, "renewed in place");
  // A handle with no home cannot look again: the refusal is thrown at once.
  const lost = { port, token: "0".repeat(32), protocol: server.protocol };
  await assert.rejects(() => api(lost, `/api/rounds/${id}/ack`, { method: "POST", body: { seq: 1, waiter: "a" } }), (err) => err.status === 403);

  // A server that refuses even the token daemon.json names: asked twice (the old token, the fresh one), then thrown.
  const dir = await scratchDir(t);
  const other = homeOf(dir);
  const seen = [];
  await fakeServer(t, other, PROTOCOL, (r, res) => {
    seen.push(r.headers["x-decide-token"]);
    res.writeHead(403, { "content-type": "application/json" }).end('{"error":"no"}');
  });
  const handle = { port: 1, token: "old", protocol: PROTOCOL, home: other };
  const real = await findServer(other);
  handle.port = real.port;
  await assert.rejects(() => api(handle, "/api/rounds/1-abcdef/ack", { method: "POST", body: { seq: 1 } }), (err) => err.status === 403);
  assert.deepEqual(seen, ["old", "fake-token"]);
  assert.equal(handle.token, "fake-token");
});


// ---- served files (Task 15)

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// A server with one round over files written into the scratch project.
async function servedFiles(t, files, rawSpec) {
  const dir = await scratchDir(t);
  const home = homeOf(dir);
  await mkdir(home, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  const started = await startServer({ home, embedded: true });
  t.after(() => started.stop());
  const project = openProject(dir, home);
  const { spec, errors } = await prepareSpec(rawSpec, { specDir: dir, dataDir: project.dataDir, shots: false });
  assert.deepEqual(errors, []);
  const res = await fetch(url(started.port, "/api/rounds"), { method: "POST", headers: asAgent(started.port), body: body({ project: dir, spec, outPath: path.join(dir, "c.answers.json"), open: false, live: true }) });
  assert.equal(res.status, 200);
  const { id } = await res.json();
  const view = await (await fetch(url(started.port, `/api/rounds/${id}`))).json();
  return { dir, home, started, port: started.port, id, view };
}

const two = [{ id: "a", label: "A" }, { id: "b", label: "B" }];

test("an image publishes itself, not its neighbours", async (t) => {
  const { port, view } = await servedFiles(t, { "a.png": PNG, "b.png": PNG, "notes.txt": "private" }, { title: "T", questions: [{ id: "q", title: "Q", images: ["a.png"], options: two }] });
  const src = view.spec.questions[0].images[0].src;
  assert.match(src, /^\/r\/[0-9a-f]{8}\/a\.png$/);
  const own = await fetch(url(port, src));
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("content-security-policy"), ASSET_CSP);
  for (const name of ["b.png", "notes.txt", "..%2Fa.png", "a.png%00", "A.PNG"]) assert.ok([400, 404].includes((await fetch(url(port, src.replace("a.png", name)))).status), name);
  assert.equal((await fetch(url(port, src.replace(/\/r\/[0-9a-f]{8}/, "/r/00000000")))).status, 404);
  assert.equal((await fetch(url(port, src.replace(/\/a\.png$/, "")))).status, 404, "the id alone lists nothing");
});

test("a mockup publishes its own directory", async (t) => {
  const files = {
    "mock/card.html": '<link rel="stylesheet" href="card.css"><img src="img/dot.png"><p>x</p>',
    "mock/card.css": "p{color:red}",
    "mock/img/dot.png": PNG,
    "secret.txt": "outside the mockup",
  };
  const { dir, port, view } = await servedFiles(t, files, { title: "T", questions: [{ id: "q", title: "Q", preview: "mock/card.html", options: two }] });
  const src = view.spec.questions[0].preview.src;
  assert.match(src, /^\/r\/[0-9a-f]{8}\/card\.html$/);
  assert.equal((await fetch(url(port, src))).status, 200);
  const base = src.replace(/card\.html$/, "");
  assert.equal((await fetch(url(port, `${base}card.css`))).status, 200, "./card.css loads");
  assert.equal((await fetch(url(port, `${base}img/dot.png`))).status, 200, "a file in a sub-directory loads");
  assert.equal((await fetch(url(port, `${base}..%2Fsecret.txt`))).status, 400);
  assert.equal((await fetch(url(port, `${base}img/..%2f..%2fsecret.txt`))).status, 400);
  assert.equal((await fetch(url(port, `${base}img`))).status, 404, "a directory is not listed");
  if (process.platform !== "win32") {
    symlinkSync(path.join(dir, "secret.txt"), path.join(dir, "mock", "leak.txt"));
    assert.equal((await fetch(url(port, `${base}leak.txt`))).status, 404, "a symlink that leads out of the directory is not followed");
  }
});

test("asset URLs are the same after a restart, and answer before the page asks for the round again", async (t) => {
  const { dir, home, port, started, id, view } = await servedFiles(t, { "a.png": PNG, "mock/card.html": "<p>x</p>" }, { title: "T", questions: [{ id: "q", title: "Q", images: ["a.png"], preview: "mock/card.html", options: two }] });
  const urls = [view.spec.questions[0].images[0].src, view.spec.questions[0].preview.src];
  const stop = await fetch(url(port, "/api/stop"), { method: "POST", headers: asAgent(port) });
  assert.equal(stop.status, 200);
  await until(async () => (await fetch(url(port, "/api/ping")).catch(() => null)) === null, "the server to stop");
  const second = await startServer({ home, embedded: true });
  t.after(() => second.stop());
  for (const u of urls) assert.equal((await fetch(url(second.port, u))).status, 200, u);
  const again = await (await fetch(url(second.port, `/api/rounds/${id}`))).json();
  assert.deepEqual([again.spec.questions[0].images[0].src, again.spec.questions[0].preview.src], urls);
  void dir;
  void started;
});

test("a path has one URL: two spellings share it, and the URL is the same in every roots", async (t) => {
  const dir = await scratchDir(t);
  mkdirSync(path.join(dir, "real"));
  writeFileSync(path.join(dir, "real", "a.png"), PNG);
  const roots = createRoots();
  const first = roots.publishFile(path.join(dir, "real", "a.png"));
  assert.equal(roots.publishFile(path.join(dir, "real", "..", "real", "a.png")), first);
  if (process.platform !== "win32") {
    symlinkSync(path.join(dir, "real"), path.join(dir, "alias"));
    assert.equal(roots.publishFile(path.join(dir, "alias", "a.png")), first, "a symlinked spelling is the same file");
  }
  assert.equal(createRoots().publishFile(path.join(dir, "real", "a.png")), first, "no counter: another process names it the same");
  assert.equal(roots.fileFor(first).endsWith("a.png"), true);
  assert.equal(roots.fileFor(`${first.slice(0, first.lastIndexOf("/"))}/other.png`), null);
});

test("two paths with the same eight digits never serve each other's file", async (t) => {
  const dir = await scratchDir(t);
  const seen = new Map();
  let pair = null;
  for (let n = 0; !pair; n++) {
    const p = path.join(realpathSync.native(dir), `f${n}.bin`);
    const id = fnv1a(p);
    if (seen.has(id)) pair = [seen.get(id), p];
    else seen.set(id, p);
  }
  for (const f of pair) writeFileSync(f, `file ${path.basename(f)}`);
  const roots = createRoots();
  const [u1, u2] = pair.map((f) => roots.publishFile(f));
  assert.notEqual(u1.split("/")[2], u2.split("/")[2], "the second id is longer or different");
  assert.equal(roots.fileFor(u1), pair[0]);
  assert.equal(roots.fileFor(u2), pair[1]);
  // The name does not rescue a wrong id: the first id with the second's name is not a file.
  assert.equal(roots.fileFor(`/r/${u1.split("/")[2]}/${path.basename(pair[1])}`), null);
});

test("a round's roots go when the round is released, and stay for another round that shares them", async (t) => {
  const dir = await scratchDir(t);
  writeFileSync(path.join(dir, "a.png"), PNG);
  const roots = createRoots();
  const a = roots.within("1-aaaaaa", () => roots.publishFile(path.join(dir, "a.png")));
  const b = roots.within("2-bbbbbb", () => roots.publishFile(path.join(dir, "a.png")));
  assert.equal(a, b);
  const h1 = roots.within("1-aaaaaa", () => roots.publishNode({ html: { source: "<b>x</b>" } })).html.src;
  roots.release("1-aaaaaa");
  assert.ok(roots.fileFor(a), "round 2 still shows it");
  assert.equal(roots.htmlFor(h1), null, "an html block only round 1 had is gone");
  roots.release("2-bbbbbb");
  assert.equal(roots.fileFor(a), null);
});

// ---- a mockup's directory (final fix wave A1)

test("a mockup's directory serves web files only: no dotfile, no daemon file, no type a browser would only download", async (t) => {
  const files = {
    "mock/card.html": '<link rel="stylesheet" href="card.css"><script src="app.js"></script><img src="img/dot.png">',
    "mock/card.css": "p{color:red}",
    "mock/app.js": "1",
    "mock/app.mjs": "export {}",
    "mock/data.json": "{}",
    "mock/img/dot.png": PNG,
    "mock/.env": "SECRET=1",
    "mock/.decide/daemon.json": '{"token":"t"}',
    "mock/.ssh/id_rsa": "key",
    "mock/.ssh/id_rsa.txt": "key",
    "mock/daemon.json": '{"token":"t"}',
    "mock/daemon.lock": "1",
    "mock/blob.bin": "x",
    "mock/key.pem": "x",
    "mock/noext": "x",
  };
  const { port, view } = await servedFiles(t, files, { title: "T", questions: [{ id: "q", title: "Q", preview: "mock/card.html", options: two }] });
  const base = view.spec.questions[0].preview.src.replace(/card\.html$/, "");
  for (const name of ["card.html", "card.css", "app.js", "app.mjs", "data.json", "img/dot.png"]) assert.equal((await fetch(url(port, base + name))).status, 200, name);
  assert.match((await fetch(url(port, `${base}app.mjs`))).headers.get("content-type"), /^text\/javascript/);
  for (const name of [".env", ".decide/daemon.json", ".ssh/id_rsa", ".ssh/id_rsa.txt", "daemon.json", "daemon.lock", "DAEMON.JSON", "blob.bin", "key.pem", "noext"]) {
    assert.equal((await fetch(url(port, base + name))).status, 404, name);
  }
});

test("a mockup in a directory that is or holds the decide home, $HOME, the temp dir or the root is published alone", async (t) => {
  const dir = realpathSync.native(await scratchDir(t));
  const home = path.join(dir, "dhome");
  mkdirSync(path.join(home, "projects", "p"), { recursive: true });
  writeFileSync(path.join(home, "projects", "p", "spec.json"), "{}");
  writeFileSync(path.join(dir, "mock.html"), "<p>x</p>");
  writeFileSync(path.join(dir, "notes.txt"), "private");
  const roots = createRoots({ home });
  const alone = (file) => roots.publishDir(file) === roots.publishFile(file);
  const src = roots.publishDir(path.join(dir, "mock.html"));
  assert.equal(alone(path.join(dir, "mock.html")), true, "a directory that holds the decide home");
  assert.ok(roots.fileFor(src), "the mockup itself is served");
  assert.equal(roots.fileFor(src.replace(/mock\.html$/, "notes.txt")), null, "nothing beside it");
  assert.equal(roots.fileFor(src.replace(/mock\.html$/, "dhome/projects/p/spec.json")), null, "nothing of the home");
  assert.equal(alone(path.join(home, "mock.html")), true, "the decide home itself");
  // $HOME (os.homedir() reads HOME, or USERPROFILE on Windows, on every call).
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const user = path.join(dir, "user");
  mkdirSync(path.join(user, "sub"), { recursive: true });
  process.env.HOME = user;
  process.env.USERPROFILE = user;
  try {
    assert.equal(alone(path.join(user, "mock.html")), true, "$HOME itself");
    assert.equal(alone(path.join(dir, "mock.html")), true, "a directory that holds $HOME");
    assert.equal(alone(path.join(user, "sub", "mock.html")), false, "a directory inside $HOME is served whole");
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
  assert.equal(alone(path.join(realpathSync.native(tmpdir()), "mock.html")), true, "the temp dir");
  assert.equal(alone(path.join(path.parse(dir).root, "mock.html")), true, "the root of the file system");
  const plain = path.join(dir, "plain");
  mkdirSync(plain);
  assert.equal(alone(path.join(plain, "mock.html")), false, "an ordinary directory is served whole");
});

test("a finished round's view is read without publishing its files again", async (t) => {
  const files = { "mock/card.html": "<p>x</p>", "mock/card.css": "p{}", "a.png": PNG };
  const { home, port, id, view } = await servedFiles(t, files, { title: "T", questions: [{ id: "q", title: "Q", images: ["a.png"], preview: "mock/card.html", options: two }] });
  const urls = [view.spec.questions[0].preview.src, view.spec.questions[0].preview.src.replace(/card\.html$/, "card.css"), view.spec.questions[0].images[0].src];
  for (const u of urls) assert.equal((await fetch(url(port, u))).status, 200, u);
  assert.equal((await fetch(url(port, `/api/rounds/${id}/submit`), { method: "POST", headers: asPage(port), body: body({ answers: { q: { selected: ["a"] } } }) })).status, 200);
  // The agent collects the answers: the next server does not load the round, it reads it from disk when asked.
  const item = await (await fetch(url(port, `/api/rounds/${id}/next?waiter=a`), { headers: asAgent(port) })).json();
  assert.equal(item.kind, "final");
  assert.equal((await fetch(url(port, `/api/rounds/${id}/ack`), { method: "POST", headers: asAgent(port), body: body({ seq: item.seq, waiter: "a" }) })).status, 200);
  assert.equal((await fetch(url(port, "/api/stop"), { method: "POST", headers: asAgent(port) })).status, 200);
  await until(async () => (await fetch(url(port, "/api/ping")).catch(() => null)) === null, "the server to stop");
  const second = await startServer({ home, embedded: true });
  t.after(() => second.stop());
  for (const u of urls) assert.equal((await fetch(url(second.port, u))).status, 404, `not served after a restart: ${u}`);
  // A token-less read of the finished round (anyone on the machine can make it) publishes nothing.
  const again = await fetch(url(second.port, `/api/rounds/${id}`));
  assert.equal(again.status, 200);
  assert.equal((await again.json()).status, "answered");
  for (const u of urls) assert.equal((await fetch(url(second.port, u))).status, 404, `not served after the read: ${u}`);
  assert.equal((await fetch(url(second.port, `/api/rounds/${id}`))).status, 200, "a second read finds it in memory");
  for (const u of urls) assert.equal((await fetch(url(second.port, u))).status, 404, `not served after a second read: ${u}`);
});

test("export inlines a mockup's own files only: no symlink out of its directory, no dotfile (skipped on win32: symlinks need privileges)", { skip: process.platform === "win32" }, async (t) => {
  const dir = realpathSync.native(await scratchDir(t));
  const mk = path.join(dir, "mk");
  const away = path.join(dir, "away");
  mkdirSync(path.join(mk, ".private"), { recursive: true });
  mkdirSync(away);
  writeFileSync(path.join(away, "id_rsa"), "SECRET-KEY-ONE");
  writeFileSync(path.join(away, "bg.png"), "SECRET-KEY-TWO");
  writeFileSync(path.join(mk, ".env.png"), "SECRET-KEY-THREE");
  writeFileSync(path.join(mk, ".private", "x.css"), "p{color:SECRET-KEY-FOUR}");
  symlinkSync(path.join(away, "id_rsa"), path.join(mk, "logo.png"));
  symlinkSync(path.join(away, "bg.png"), path.join(mk, "bg.png"));
  writeFileSync(path.join(mk, "ok.png"), PNG);
  writeFileSync(path.join(mk, "style.css"), "body{background:url(bg.png)} i{background:url(ok.png)}");
  writeFileSync(path.join(mk, "card.html"), '<link rel="stylesheet" href="style.css"><link rel="stylesheet" href=".private/x.css"><img src="logo.png"><img src=".env.png"><img src="ok.png"><style>b{background:url(bg.png)}</style>');
  const { spec, errors } = await prepareSpec({ title: "T", questions: [{ id: "q", title: "Q", preview: "mk/card.html", options: two }] }, { specDir: dir, dataDir: dir, shots: false });
  assert.deepEqual(errors, []);
  const out = path.join(dir, "e.decide.html");
  await exportSpec(spec, { id: "x1", out });
  const html = readFileSync(out, "utf8");
  // The mockup is inlined base64 inside a data: URI: decode every one and look inside.
  const decoded = [...html.matchAll(/base64,([A-Za-z0-9+/=]+)/g)].map((m) => Buffer.from(m[1], "base64").toString("latin1")).join("\n");
  assert.ok(decoded.includes(`data:image/png;base64,${PNG.toString("base64")}`), "the mockup's own picture is inlined");
  for (const secret of ["SECRET-KEY-ONE", "SECRET-KEY-TWO", "SECRET-KEY-THREE", "SECRET-KEY-FOUR"]) {
    assert.equal(html.includes(secret) || decoded.includes(secret), false, secret);
    assert.equal(decoded.includes(Buffer.from(secret).toString("base64")), false, `${secret} in base64`);
  }
});

// ---- the Mermaid frame

test("no file under ui/ names a CDN host", () => {
  const ui = path.join(pluginDir, "ui");
  const files = filesUnder(ui).filter((f) => /\.(?:m?js|html|css|json|md)$/.test(f));
  assert.ok(files.length > 30);
  // Upstream's bundle is not ours to edit; its own text is checked by the frame's policy (default-src 'none'), pinned below.
  const bundle = path.join(ui, "vendor", "mermaid.min.js");
  assert.ok(files.includes(bundle), "the vendored bundle is there");
  for (const full of files.filter((f) => f !== bundle)) assert.doesNotMatch(readFileSync(full, "utf8"), /jsdelivr|unpkg|cdnjs|googleapis|gstatic|esm\.sh|skypack/i, path.relative(pluginDir, full));
});

test("the vendored Mermaid is upstream's file, and the README says which", () => {
  const dir = path.join(pluginDir, "ui", "vendor");
  const sum = createHash("sha256").update(readFileSync(path.join(dir, "mermaid.min.js"))).digest("hex");
  const readme = readFileSync(path.join(dir, "README.md"), "utf8");
  assert.ok(readme.includes(sum), "the README names the sha256 of the file");
  assert.match(readme, /mermaid@11\.\d+\.\d+/);
  assert.match(readme, /sha512-[A-Za-z0-9+/=]{80,}/, "the registry's integrity");
  assert.match(readFileSync(path.join(dir, "mermaid.LICENSE"), "utf8"), /Copyright \(c\) 2014 - 2022 Knut Sveidqvist/);
});

test("the Mermaid frame is served with its own policy header, sandboxed and fetching nothing", async (t) => {
  const { port } = await served(t);
  const res = await fetch(url(port, "/ui/vendor/mermaid-frame.html"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  const policy = res.headers.get("content-security-policy");
  const html = await res.text();
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  assert.equal(inline.length, 1, "one inline script, allowed by its hash");
  assert.equal(policy, `default-src 'none'; script-src 'self' ${inline[0]}; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; sandbox allow-scripts`);
  assert.doesNotMatch(policy, /allow-same-origin|https?:|\*/);
  assert.match(html, /<script src="\/ui\/vendor\/mermaid\.min\.js"><\/script>/, "a classic script: a module would be fetched with Origin: null");
  assert.doesNotMatch(html, /type="module"/);
  assert.equal((await fetch(url(port, "/ui/vendor/mermaid.min.js"))).status, 200);
  assert.equal((await fetch(url(port, "/ui/vendor/mermaid.min.js"))).headers.get("content-security-policy"), null);
  // Only a page of the same origin may frame it (frame-ancestors 'self'). X-Frame-Options stays off: it would also block the page.
  assert.match(policy, /frame-ancestors 'self'/);
  assert.equal(res.headers.get("x-frame-options"), null);
  assert.equal(PAGE_CSP.includes("frame-src 'self'"), true);
});

// A case-insensitive file system finds /ui/Vendor/... for /ui/vendor/...: the policy must not depend on the spelling.
const caseInsensitive = existsSync(path.join(pluginDir, "UI", "INDEX.HTML"));
const spellingSkip = caseInsensitive ? false : "this file system is case-sensitive, a mis-cased path is already 404";

test(`a mis-cased /ui/ path is not served at all (skipped when the file system is case-sensitive)`, { skip: spellingSkip }, async (t) => {
  const { port } = await served(t);
  for (const route of ["/ui/Vendor/mermaid-frame.html", "/ui/VENDOR/MERMAID-FRAME.HTML", "/ui/Index.html", "/ui/JS/main.js", "/ui/vendor/Mermaid.min.js"]) {
    assert.equal((await fetch(url(port, route))).status, 404, route);
  }
  assert.equal((await fetch(url(port, "/ui/vendor/mermaid-frame.html"))).status, 200);
  assert.equal((await fetch(url(port, "/ui/index.html"))).status, 200);
});

test("every html file under /ui/ is the page, the frame, or not served; both carry their policy", async (t) => {
  const { port } = await served(t);
  const ui = path.join(pluginDir, "ui");
  const found = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(d, e.name)) : /\.html?$/i.test(e.name) && found.push(path.relative(ui, path.join(d, e.name)).split(path.sep).join("/")));
  };
  walk(ui);
  assert.ok(found.length >= 2);
  for (const rel of found) {
    const res = await fetch(url(port, `/ui/${rel}`));
    if (rel === "index.html") {
      assert.equal(res.headers.get("content-security-policy"), PAGE_CSP);
      assert.equal(res.headers.get("x-frame-options"), "DENY");
    } else if (rel === "vendor/mermaid-frame.html") assert.match(res.headers.get("content-security-policy"), /sandbox allow-scripts/);
    else assert.equal(res.status, 404, rel);
  }
});

test("export through the server is held to the project and the data dir unless outside: true", async (t) => {
  const { dir, port, id } = await served(t);
  const elsewhere = await scratchDir(t);
  const target = path.join(elsewhere, "out.decide.html");
  const refused = await fetch(url(port, `/api/rounds/${id}/export`), { method: "POST", headers: asAgent(port), body: body({ out: target }) });
  assert.ok(refused.status >= 400 && refused.status < 500, `status ${refused.status}`);
  assert.match((await refused.json()).error, /outside/);
  assert.equal(existsSync(target), false, "nothing was written");
  const inside = path.join(dir, "in.decide.html");
  assert.equal((await fetch(url(port, `/api/rounds/${id}/export`), { method: "POST", headers: asAgent(port), body: body({ out: inside }) })).status, 200);
  assert.equal(existsSync(inside), true);
  const allowed = await fetch(url(port, `/api/rounds/${id}/export`), { method: "POST", headers: asAgent(port), body: body({ out: target, outside: true }) });
  assert.equal(allowed.status, 200);
  assert.equal(existsSync(target), true);
});

test("export from a linked worktree outside the main checkout: the route, the CLI and MCP judge against the worktree (skipped without git)", { skip: !hasGit && "git is not installed" }, async (t) => {
  const { dir, main, wt } = await repoWithWorktree(t);
  const home = homeOf(dir);
  await mkdir(home, { recursive: true });
  const started = await startServer({ home, embedded: true });
  t.after(() => started.stop());
  const project = openProject(wt, home);
  assert.notEqual(project.root, project.top, "the identity root is the main checkout");
  const res = await fetch(url(started.port, "/api/rounds"), { method: "POST", headers: asAgent(started.port), body: body({ project: project.top, spec, outPath: path.join(wt, "c.answers.json"), open: false, live: true }) });
  assert.equal(res.status, 200);
  const { id } = await res.json();
  const post = (payload) => fetch(url(started.port, `/api/rounds/${id}/export`), { method: "POST", headers: asAgent(started.port), body: body(payload) });
  // The route: an absolute path in the worktree, then a relative one (it starts at the round's working tree, not the server's cwd).
  assert.equal((await post({ out: path.join(wt, "abs.html") })).status, 200);
  assert.equal(existsSync(path.join(wt, "abs.html")), true);
  assert.equal((await post({ out: "rel.html" })).status, 200);
  assert.equal(existsSync(path.join(wt, "rel.html")), true, "a relative out lands in the worktree");
  assert.equal(existsSync(path.join(process.cwd(), "rel.html")), false, "not in the server's cwd");
  // Outside both the worktree and the main checkout: refused.
  const away = path.join(dir, "away.html");
  assert.equal((await post({ out: away })).status, 422);
  assert.equal(existsSync(away), false);
  // The CLI and MCP path (exportRound) goes through the same route and the same root.
  const server = { port: started.port, token: started.token, home };
  const done = await exportRound({ project, round: id, out: "page.html", getServer: async () => server });
  assert.equal(done.file, path.join(wt, "page.html"));
  assert.equal(existsSync(done.file), true);
  await assert.rejects(exportRound({ project, round: id, out: away, getServer: async () => server }), /outside/);
  assert.equal(existsSync(path.join(main, "page.html")), false);
});

test("the page and the frame only take what their own window sent", () => {
  const page = readFileSync(path.join(pluginDir, "ui", "js", "media", "mermaid.js"), "utf8");
  const frame = readFileSync(path.join(pluginDir, "ui", "vendor", "mermaid-frame.html"), "utf8");
  assert.match(page, /contentWindow\s*===\s*e\.source/, "the page checks the sender");
  assert.match(frame, /e\.source\s*!==\s*parent/, "the frame checks the sender");
  assert.doesNotMatch(page, /import\(\s*["'`]https?:/);
  assert.match(frame, /securityLevel:\s*["']strict["']/);
  assert.doesNotMatch(frame, /innerHTML\s*=\s*e\.data|insertAdjacentHTML\([^)]*e\.data/, "nothing received goes into the DOM as HTML");
});
