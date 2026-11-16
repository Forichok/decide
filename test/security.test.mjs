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
 *   - a stale token after a restart: the wait survives, the ack lands; a real refusal is thrown
 * Isolation:  every test has its own DECIDE_HOME; no test binds 47474; every process is stopped by its pid.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { PAGE_CSP, ASSET_CSP, guard } from "../lib/http.mjs";
import { startServer } from "../lib/server.mjs";
import { openProject } from "../lib/project.mjs";
import { roundDir } from "../lib/store/rounds.mjs";
import { ack, api, findServer, waitNext } from "../lib/client.mjs";
import { PROTOCOL } from "../lib/protocol.mjs";
import { alive, asAgent, asPage, fakeServer, homeOf, notePid, pluginDir, scratchDir, spawnServer } from "./helpers.mjs";

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
  assert.ok(js.some((f) => f.includes(`${path.sep}lang${path.sep}`)), "the sub-folders are scanned");
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
  const media = readFileSync(path.join(pluginDir, "ui", "js", "media.js"), "utf8");
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
