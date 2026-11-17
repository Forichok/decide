/**
 * Feature:    the knobs bridge (K2): knob values reach a tune question's mockup
 * Layer:      Unit (injection, the bridge script in a fake frame, knobs.js) and integration (an in-process server)
 * Covers:
 *   - injectBridge puts the script first in <head>, never before the doctype
 *   - only a file published with the bridge flag (a tune question's preview) gets the bridge; another mockup does not
 *   - the served tune mockup contains the bridge and keeps ASSET_CSP; a plain mockup is served byte for byte
 *   - in the frame: messages from the parent only; --knob-<id> vars with units; [data-knob] text and src;
 *     data-theme and color-scheme; a decide:knobs event with the values; a ready message to the parent
 *   - postKnobs sends a clean payload to the frame's window with target "*"
 * Isolation:  every test has its own DECIDE_HOME (test/helpers.mjs) and stops its server.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createRoots } from "../lib/assets.mjs";
import { BRIDGE, hasBridge, injectBridge } from "../lib/bridge.mjs";
import { ASSET_CSP } from "../lib/http.mjs";
import { startServer } from "../lib/server.mjs";
import { openProject } from "../lib/project.mjs";
import { prepareSpec } from "../lib/prepare.mjs";
import { asAgent, homeOf, scratchDir } from "./helpers.mjs";
import { knobPayload, postKnobs } from "../ui/js/knobs.js";

const MOCKUP = "<!doctype html><html><head><title>card</title></head><body><h1 data-knob=\"names\">x</h1><img data-knob=\"photo\"></body></html>";

test("injectBridge: first in head, after the doctype when there is no head", () => {
  const out = injectBridge(MOCKUP);
  assert.ok(out.startsWith("<!doctype html><html><head><script data-decide-bridge>"));
  assert.ok(hasBridge(out));
  assert.ok(injectBridge("<!DOCTYPE html><p>x</p>").startsWith("<!DOCTYPE html><script data-decide-bridge>"));
  assert.ok(injectBridge("<p>x</p>").startsWith("<script data-decide-bridge>"));
  assert.ok(injectBridge("<html><header>h</header></html>").startsWith("<html><script"), "<header> is not <head>");
  assert.doesNotThrow(() => new vm.Script(BRIDGE), "the bridge parses");
});

test("only a tune question's preview is marked for the bridge", async (t) => {
  const dir = await scratchDir(t);
  const home = homeOf(dir);
  mkdirSync(path.join(dir, "m"), { recursive: true });
  writeFileSync(path.join(dir, "m", "card.html"), MOCKUP);
  writeFileSync(path.join(dir, "m", "other.html"), MOCKUP);
  const roots = createRoots({ home });
  const plain = roots.publishNode({ type: "single", preview: { src: path.join(dir, "m", "other.html"), local: true } }).preview.src;
  const tune = roots.publishNode({ type: "tune", preview: { src: path.join(dir, "m", "card.html"), local: true } }).preview.src;
  assert.equal(roots.bridgeFor(tune), true);
  assert.equal(roots.bridgeFor(plain), false, "a mockup of another question gets no bridge, even in the same directory");
  assert.equal(roots.bridgeFor(tune.replace("card.html", "missing.html")), false);
  assert.equal(roots.bridgeFor(roots.publishFile(path.join(dir, "m", "other.html"))), false);
  assert.equal(roots.bridgeFor(roots.publishDir(path.join(dir, "m", "other.html"), { bridge: true })), true, "the flag on publishDir");
});

test("the server injects the bridge into a tune mockup only and keeps ASSET_CSP", async (t) => {
  const dir = await scratchDir(t);
  const home = homeOf(dir);
  await mkdir(home, { recursive: true });
  writeFileSync(path.join(dir, "card.html"), MOCKUP);
  writeFileSync(path.join(dir, "plain.html"), MOCKUP);
  const started = await startServer({ home, embedded: true });
  t.after(() => started.stop());
  const project = openProject(dir, home);
  const two = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
  const raw = { title: "T", questions: [{ id: "q", title: "Q", preview: "card.html", options: two }, { id: "p", title: "P", preview: "plain.html", options: two }] };
  const { spec, errors } = await prepareSpec(raw, { specDir: dir, dataDir: project.dataDir, shots: false });
  assert.deepEqual(errors, []);
  // The tune type comes from another chunk: mark the prepared question as one, as its normalize will.
  spec.questions[0].type = "tune";
  const base = `http://127.0.0.1:${started.port}`;
  const res = await fetch(`${base}/api/rounds`, { method: "POST", headers: asAgent(started.port), body: JSON.stringify({ project: dir, spec, outPath: path.join(dir, "c.answers.json"), open: false, live: true }) });
  assert.equal(res.status, 200, await res.clone().text());
  const { id } = await res.json();
  const view = await (await fetch(`${base}/api/rounds/${id}`)).json();
  const [tuneSrc, plainSrc] = view.spec.questions.map((q) => q.preview.src);

  const tuned = await fetch(base + tuneSrc);
  assert.equal(tuned.status, 200);
  assert.equal(tuned.headers.get("content-security-policy"), ASSET_CSP, "the policy is unchanged");
  assert.match(ASSET_CSP, /sandbox allow-scripts allow-popups$/);
  assert.doesNotMatch(ASSET_CSP, /allow-same-origin|https?:|\*/, "opaque origin, no network");
  const text = await tuned.text();
  assert.ok(hasBridge(text), "the tune mockup carries the bridge");
  assert.ok(text.includes("<h1 data-knob=\"names\">x</h1>"), "the mockup itself is untouched");

  const plain = await fetch(base + plainSrc);
  assert.equal(plain.headers.get("content-security-policy"), ASSET_CSP);
  assert.equal(await plain.text(), MOCKUP, "a mockup without the flag is served byte for byte");
});

// A fake frame: just enough DOM for the bridge script.
function frame() {
  const parent = { posted: [], postMessage(m, o) { this.posted.push([m, o]); } };
  const vars = {};
  const attrs = {};
  const style = { colorScheme: "", setProperty: (k, v) => (vars[k] = v) };
  const els = [
    { tagName: "H1", knob: "names", textContent: "x", setAttribute() {} },
    { tagName: "IMG", knob: "photo", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
  ];
  const events = [];
  const listeners = {};
  const document = {
    readyState: "complete",
    documentElement: { style, setAttribute: (k, v) => (attrs[k] = v) },
    querySelectorAll: (sel) => els.filter((el) => sel === `[data-knob="${el.knob}"]`),
    dispatchEvent: (e) => events.push(e),
    addEventListener() {},
  };
  class CustomEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
  const ctx = { parent, document, CustomEvent, addEventListener: (type, fn) => (listeners[type] = fn) };
  ctx.window = ctx;
  vm.runInNewContext(BRIDGE, ctx);
  const send = (data, source = parent) => listeners.message({ source, data });
  return { parent, vars, attrs, style, els, events, send };
}

test("the bridge in a frame: parent only, vars, text, src, theme, event, ready", () => {
  const f = frame();
  assert.deepEqual(JSON.parse(JSON.stringify(f.parent.posted)), [[{ type: "decide:knobs-ready" }, "*"]]);
  f.send({ type: "decide:knobs", values: { density: 4 } }, {});
  assert.deepEqual(f.vars, {}, "a message from anyone but the parent is ignored");
  f.send({ type: "other", values: { density: 4 } });
  assert.deepEqual(f.vars, {});
  f.send({ type: "decide:knobs", values: { density: { value: 4, unit: "px" }, accent: "#3b6cff", names: "Аня и Миша", photo: "data:image/png;base64,AA", "bad id\"]": 1 }, theme: "dark" });
  assert.equal(f.vars["--knob-density"], "4px");
  assert.equal(f.vars["--knob-accent"], "#3b6cff");
  assert.equal(f.vars["--knob-photo"], 'url("data:image/png;base64,AA")');
  assert.equal(Object.keys(f.vars).some((k) => k.includes("bad")), false, "an id that is not a plain name is skipped");
  assert.equal(f.els[0].textContent, "Аня и Миша");
  assert.equal(f.els[1].attrs.src, "data:image/png;base64,AA");
  assert.equal(f.attrs["data-theme"], "dark");
  assert.equal(f.style.colorScheme, "dark");
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, "decide:knobs");
  assert.equal(f.events[0].bubbles, true);
  assert.equal(f.events[0].detail.values.names, "Аня и Миша");
  f.send({ type: "decide:knobs", values: { density: 2 }, theme: "sepia" });
  assert.equal(f.vars["--knob-density"], "2");
  assert.equal(f.attrs["data-theme"], "dark", "an unknown theme changes nothing");
});

test("postKnobs sends a clean payload to the frame's window", () => {
  const sent = [];
  const iframe = { contentWindow: { postMessage: (m, o) => sent.push([m, o]) } };
  assert.equal(postKnobs(iframe, { density: 4, on: true, gap: { value: 8, unit: "px" }, "x y": 1, none: null }, "light"), true);
  assert.deepEqual(sent, [[{ type: "decide:knobs", values: { density: 4, on: 1, gap: { value: 8, unit: "px" } }, theme: "light" }, "*"]]);
  assert.equal(postKnobs({}, { a: 1 }), false);
  assert.deepEqual(knobPayload({ a: { value: 3 } }), { a: 3 });
});
