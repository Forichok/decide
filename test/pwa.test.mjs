/**
 * Feature:    installable page: manifest, service worker, badge, fallback-port note
 * Layer:      integration (in-process server over loopback HTTP) and static checks
 * Covers:
 *   - /manifest.webmanifest is served as application/manifest+json and names start_url "/" and display standalone
 *   - /sw.js is served as javascript with Service-Worker-Allowed "/"; the icon in the manifest is served
 *   - sw.js never caches /api/; index.html links the manifest
 *   - pwa.js helpers: badge count, fallback port
 * Isolation:  own DECIDE_HOME per server (helpers); no 47474.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { startServer } from "../lib/server.mjs";
import { badgeCount, setBadge, wrongPort } from "../ui/js/pwa.js";
import { mkdir } from "node:fs/promises";
import { homeOf, scratchDir } from "./helpers.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the server serves the manifest, the worker and the icon with the right types", async (t) => {
  const home = homeOf(await scratchDir(t));
  await mkdir(home, { recursive: true });
  const srv = await startServer({ home, embedded: true });
  t.after(() => srv.stop());
  const get = (p) => fetch(`http://127.0.0.1:${srv.port}${p}`);
  const m = await get("/manifest.webmanifest");
  assert.equal(m.status, 200);
  assert.match(m.headers.get("content-type"), /^application\/manifest\+json/);
  const man = await m.json();
  assert.equal(man.start_url, "/");
  assert.equal(man.display, "standalone");
  const sw = await get("/sw.js");
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get("content-type"), /javascript/);
  assert.equal(sw.headers.get("service-worker-allowed"), "/");
  for (const icon of man.icons) assert.equal((await get(icon.src)).status, 200);
});

test("sw.js leaves /api/ alone and never caches it", () => {
  const sw = read("ui/sw.js");
  assert.match(sw, /startsWith\("\/api\/"\)\) return/);
  assert.doesNotMatch(sw, /SHELL\s*=[^\n]*\/api/);
  assert.doesNotMatch(sw, /addAll\([^)]*api/);
  assert.match(read("ui/index.html"), /<link rel="manifest" href="\/manifest\.webmanifest"/);
});

test("badge count and fallback port", () => {
  assert.equal(badgeCount([{}, {}], { rounds: [] }), 2);
  assert.equal(badgeCount([], { rounds: [{}] }), 1);
  assert.equal(badgeCount(null, null), 0);
  assert.equal(wrongPort("47474"), false);
  assert.equal(wrongPort("51234"), true);
  const calls = [];
  setBadge(3, { setAppBadge: (n) => (calls.push(n), Promise.resolve()), clearAppBadge: () => (calls.push("clear"), Promise.resolve()) });
  setBadge(0, { setAppBadge() {}, clearAppBadge: () => (calls.push("clear"), Promise.resolve()) });
  assert.deepEqual(calls, [3, "clear"]);
});
