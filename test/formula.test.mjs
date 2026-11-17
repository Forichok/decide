/**
 * Feature:    knob formulas (ui/js/formula.js)
 * Layer:      Unit
 * Covers:     precedence, associativity, unary minus, functions, errors give null, 500-char limit, never throws, no eval
 * Isolation:  pure functions, no files written, no home
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { compile, check } from "../ui/js/formula.js";

const ev = (s, v = {}) => compile(s)(v);

test("numbers and precedence", () => {
  assert.equal(ev("1 + 2 * 3"), 7);
  assert.equal(ev("(1 + 2) * 3"), 9);
  assert.equal(ev("2.5 * 2"), 5);
  assert.equal(ev(".5 + .5"), 1);
  assert.equal(ev("10 % 4 * 2"), 4);
  assert.equal(ev("1 + 10 % 4"), 3);
});

test("left associativity", () => {
  assert.equal(ev("10 - 3 - 2"), 5);
  assert.equal(ev("100 / 10 / 5"), 2);
  assert.equal(ev("20 % 7 % 4"), 2);
});

test("unary minus", () => {
  assert.equal(ev("-3"), -3);
  assert.equal(ev("--3"), 3);
  assert.equal(ev("2 * -3"), -6);
  assert.equal(ev("-(1 + 2)"), -3);
  assert.equal(ev("5 - -2"), 7);
  assert.equal(ev("-a * 2", { a: 4 }), -8);
});

test("names and hyphen as minus", () => {
  assert.equal(ev("a-b", { a: 5, b: 2 }), 3);
  assert.equal(ev("a - 1", { a: 5 }), 4);
  assert.equal(ev("a-1", { a: 5 }), 4);
  assert.equal(ev("density_2 * 2", { density_2: 3 }), 6);
});

test("functions", () => {
  assert.equal(ev("min(3, 1, 2)"), 1);
  assert.equal(ev("max(3)"), 3);
  assert.equal(ev("max(1, a * 2)", { a: 4 }), 8);
  assert.equal(ev("round(2.5)"), 3);
  assert.equal(ev("round(a / 3)", { a: 10 }), 3);
  assert.equal(ev("abs(-4.5)"), 4.5);
  assert.equal(ev("min(max(1, 5), 3)"), 3);
});

test("errors give null, never a throw", () => {
  assert.equal(ev("1 / 0"), null);
  assert.equal(ev("1 % 0"), null);
  assert.equal(ev("a / (b - b)", { a: 1, b: 2 }), null);
  assert.equal(ev("missing + 1"), null);
  assert.equal(ev("a", { a: NaN }), null);
  assert.equal(ev("a", { a: "3" }), null);
  assert.equal(ev("a", { a: Infinity }), null);
  assert.equal(ev("10 ** 400"), null);
  assert.equal(ev("9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999 * 9999999999"), null);
  for (const bad of ["", "1 +", "(1", "1)", "1 2", "max()", "round(1, 2)", "abs()", "min", "foo(1)", "1.2.3", "3a", "a $ b", "@"]) {
    assert.equal(ev(bad, { a: 1 }), null, bad);
    assert.equal(check(bad, ["a"]).ok, false, bad);
  }
  assert.equal(ev("a", null), null);
  assert.equal(compile(undefined)({}), null);
  assert.equal(ev("constructor", {}), null);
  assert.equal(ev("__proto__", {}), null);
});

test("500 character limit", () => {
  const ok = "1" + "+1".repeat(249); // 499 chars
  assert.equal(ok.length, 499);
  assert.equal(ev(ok), 250);
  const exact = "1" + " ".repeat(499);
  assert.equal(exact.length, 500);
  assert.equal(ev(exact), 1);
  const long = "1" + " ".repeat(500);
  assert.equal(long.length, 501);
  assert.equal(ev(long), null);
  const c = check(long, []);
  assert.equal(c.ok, false);
  assert.match(c.error, /500/);
});

test("deep nesting is an error, not a stack overflow", () => {
  const s = "(".repeat(200) + "1" + ")".repeat(200);
  assert.equal(ev(s), null);
  assert.equal(check(s, []).ok, false);
  assert.equal(ev("-".repeat(300) + "1"), null);
});

test("check reports names and unknown ones", () => {
  assert.deepEqual(check("a * 2 + max(b, a)", ["a", "b"]), { ok: true, names: ["a", "b"] });
  const r = check("a + c", ["a"]);
  assert.equal(r.ok, false);
  assert.match(r.error, /'c'/);
  assert.deepEqual(r.names, ["a", "c"]);
  assert.equal(check("min", []).ok, false);
});

test("fuzz: random token strings never throw", () => {
  const parts = ["1", "2.5", ".", "a", "b", "min", "max", "round", "abs", "(", ")", ",", "+", "-", "*", "/", "%", " ", "x_1", "0", "$", "é", "1e3", "--"];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 5000; i++) {
    let s = "";
    const n = Math.floor(rnd() * 14);
    for (let j = 0; j < n; j++) s += parts[Math.floor(rnd() * parts.length)];
    const f = compile(s);
    const r = f({ a: 3, b: 0, x_1: -2 });
    assert.ok(r === null || Number.isFinite(r), s);
    const c = check(s, ["a", "b"]);
    assert.equal(typeof c.ok, "boolean");
  }
});

test("module source has no eval or Function constructor", () => {
  const src = readFileSync(new URL("../ui/js/formula.js", import.meta.url), "utf8");
  assert.ok(!/\beval\s*\(/.test(src));
  assert.ok(!/\bFunction\s*\(/.test(src));
  assert.ok(!/new\s+Function/.test(src));
});
