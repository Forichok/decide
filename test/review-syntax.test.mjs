// The colours of the diff: a small lexer by file extension, with no parser behind it.
import test from "node:test";
import assert from "node:assert/strict";
import { lexer, langOf } from "../ui/js/review/syntax.js";

const show = (pairs) => pairs.map(([cls, text]) => (cls ? `${cls}(${text})` : text)).join("");
const join = (pairs) => pairs.map((p) => p[1]).join("");

test("the lexer never loses or adds a character", () => {
  const lines = ["const a = `x ${1} y`; // done", "  * b / 2 /* c", "still */ return /[/'\"`]+/g.test(s) ? 'a\\'b' : \"\";", "", "\t<div class=\"x\">don't</div>"];
  for (const path of ["a.mjs", "a.json", "a.css", "a.py", "a.html", "a.md", "a.unknown", "Makefile"]) {
    const read = lexer(path);
    for (const [i, line] of lines.entries()) assert.equal(join(read(line, ["ctx", "add", "del"][i % 3])), line, `${path}: ${line}`);
  }
});

test("JavaScript: keywords, strings, numbers, calls, comments, a regular expression", () => {
  const read = lexer("lib/a.mjs");
  assert.equal(show(read('export function checkRef(ref, what = "ref") { // why')), 'k(export) k(function) f(checkRef)(ref, what = s("ref")) { c(// why)');
  assert.equal(show(read("  if (x.length > 0x1f || y === null) return a / 2;")), "  k(if) (x.length > n(0x1f) || y === n(null)) k(return) a / n(2);");
  // A quote or a backtick inside a regular expression opens nothing.
  assert.equal(show(read("const re = /[\"'`]\\//g;")), "k(const) re = s(/[\"'`]\\//g);");
  assert.equal(show(read("next();")), "f(next)();");
  // A member or an object key spelled like a keyword is a name; `default:` in a switch stays a keyword.
  assert.equal(show(read('h("b", { type: "button" }, sides.new.open, x.delete(1));')), 'f(h)(s("b"), { type: s("button") }, sides.new.open, x.f(delete)(n(1)));');
  assert.equal(show(read("default: return new Map();")), "k(default): k(return) k(new) f(Map)();");
});

test("what a line ended inside goes on in the next one, on each side of the diff by itself", () => {
  const read = lexer("a.ts");
  assert.equal(show(read("const s = `one")), "k(const) s = s(`one)");
  assert.equal(show(read("two", "del")), "s(two)");
  assert.equal(show(read("deux` + 1;", "add")), "s(deux`) + n(1);");
  // The old side is still inside the string; a context line closes it for both.
  assert.equal(show(read("three` + 2;", "del")), "s(three`) + n(2);");
  assert.equal(show(read("/* a")), "c(/* a)");
  assert.equal(show(read("b */ let x;")), "c(b */) k(let) x;");
  assert.equal(show(read("let y;", "del")), "k(let) y;");
});

test("a hunk that starts inside a doc comment", () => {
  assert.equal(show(lexer("a.js")("   * @param {string} ref */ go();")), "c(   * @param {string} ref */) f(go)();");
});

test("JSON keys, CSS, Python, markup, markdown", () => {
  assert.equal(show(lexer("a.json")('  "name": "decide", "n": 3, "ok": true')), '  p("name"): s("decide"), p("n"): n(3), p("ok"): n(true)');
  assert.equal(show(lexer("a.css")("@media (min-width: 10px) { color: var(--x); } /* c */")), "k(@media) (min-width: n(10px)) { color: f(var)(--x); } c(/* c */)");
  assert.equal(show(lexer("a.py")("def f(x): return None  # no")), "k(def) f(f)(x): k(return) n(None)  c(# no)");
  assert.equal(show(lexer("a.html")("<p class=\"a\">it's</p> <!-- c -->")), "<k(p) class=\"a\">it's</k(p)> c(<!-- c -->)");
  const md = lexer("README.md");
  assert.equal(show(md("# Title")), "k(# Title)");
  assert.equal(show(md("Run `npm test` now")), "Run s(`npm test`) now");
  assert.equal(show(md("```js")), "c(```js)");
  assert.equal(show(md("const a = 1;")), "s(const a = 1;)");
});

test("a file of an unknown kind stays plain", () => {
  assert.equal(langOf("logo.png"), null);
  assert.equal(langOf("src/App.TSX"), "js");
  assert.deepEqual(lexer("notes.txt")("const a = 1;"), [["", "const a = 1;"]]);
});
