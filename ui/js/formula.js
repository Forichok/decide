/**
 * Formulas for knobs: a tiny arithmetic language, shared by the page and the server.
 *
 * Grammar:
 *   expr   := term (("+" | "-") term)*
 *   term   := unary (("*" | "/" | "%") unary)*
 *   unary  := "-" unary | "+" unary | atom
 *   atom   := number | name | func "(" expr ("," expr)* ")" | "(" expr ")"
 * Numbers: 12, 3.5, .5. Names (knob ids): [a-zA-Z_][a-zA-Z0-9_]*. A hyphen is
 * never part of a name, so `a-b` is a minus b and `a - 1` and `a-1` both
 * subtract. Functions: min, max (one or more arguments), round, abs (one).
 * Function names are reserved and cannot be used as knob names.
 *
 * The source is tokenized by hand, parsed by recursive descent into an AST and
 * evaluated by walking it. No eval, no dynamic code, no regular expressions on
 * the evaluation path.
 *
 * compile(source) never throws. The function it returns gives null on division
 * or modulo by zero, an unknown name, a non-finite result, and always for a
 * source that is too long or does not parse. check(source, knownNames) gives
 * the reason for lint.
 */

export const MAX_SOURCE = 500;
const MAX_DEPTH = 64;
const FUNCS = { min: [1, Infinity], max: [1, Infinity], round: [1, 1], abs: [1, 1] };

const isDigit = (c) => c >= "0" && c <= "9";
const isStart = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isPart = (c) => isStart(c) || isDigit(c);

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] || ""))) {
      let j = i, dots = 0;
      while (j < src.length && (isDigit(src[j]) || src[j] === ".")) { if (src[j] === ".") dots++; j++; }
      if (dots > 1) throw new Error("bad number at " + (i + 1));
      if (j < src.length && isStart(src[j])) throw new Error("bad number at " + (i + 1));
      out.push({ t: "num", v: Number(src.slice(i, j)), at: i });
      i = j;
      continue;
    }
    if (isStart(c)) {
      let j = i + 1;
      while (j < src.length && isPart(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j), at: i });
      i = j;
      continue;
    }
    if ("+-*/%(),".includes(c)) { out.push({ t: c, at: i }); i++; continue; }
    throw new Error("unexpected character '" + c + "' at " + (i + 1));
  }
  out.push({ t: "end", at: src.length });
  return out;
}

function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const names = [];
  const peek = () => toks[p];
  const fail = (msg) => { throw new Error(msg + " at " + (peek().at + 1)); };
  const expect = (t, what) => { if (peek().t !== t) fail("expected " + what); return toks[p++]; };

  function expr(d) {
    if (d > MAX_DEPTH) fail("too deeply nested");
    let left = term(d);
    while (peek().t === "+" || peek().t === "-") {
      const op = toks[p++].t;
      left = { k: "bin", op, l: left, r: term(d) };
    }
    return left;
  }
  function term(d) {
    let left = unary(d);
    while (peek().t === "*" || peek().t === "/" || peek().t === "%") {
      const op = toks[p++].t;
      left = { k: "bin", op, l: left, r: unary(d) };
    }
    return left;
  }
  function unary(d) {
    if (d > MAX_DEPTH) fail("too deeply nested");
    if (peek().t === "-") { p++; return { k: "neg", e: unary(d + 1) }; }
    if (peek().t === "+") { p++; return unary(d + 1); }
    return atom(d);
  }
  function atom(d) {
    const tok = peek();
    if (tok.t === "num") { p++; return { k: "num", v: tok.v }; }
    if (tok.t === "(") {
      p++;
      const e = expr(d + 1);
      expect(")", "')'");
      return e;
    }
    if (tok.t === "id") {
      p++;
      if (Object.hasOwn(FUNCS, tok.v)) {
        if (peek().t !== "(") fail("'" + tok.v + "' is a function, write " + tok.v + "(...)");
        p++;
        const args = [expr(d + 1)];
        while (peek().t === ",") { p++; args.push(expr(d + 1)); }
        expect(")", "')'");
        const [lo, hi] = FUNCS[tok.v];
        if (args.length < lo || args.length > hi) {
          throw new Error(tok.v + " takes " + (hi === Infinity ? "at least " + lo : lo) + " argument" + (lo === 1 ? "" : "s"));
        }
        return { k: "call", f: tok.v, args };
      }
      if (!names.includes(tok.v)) names.push(tok.v);
      return { k: "name", v: tok.v };
    }
    if (tok.t === "end") fail("unexpected end of formula");
    fail("unexpected '" + tok.t + "'");
  }

  if (toks.length === 1) throw new Error("empty formula");
  const ast = expr(0);
  if (peek().t !== "end") fail("unexpected '" + (peek().t === "id" ? toks[p].v : peek().t) + "'");
  return { ast, names };
}

function run(n, values) {
  switch (n.k) {
    case "num": return n.v;
    case "name": {
      if (!Object.hasOwn(values, n.v)) return null;
      const v = values[n.v];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    }
    case "neg": { const v = run(n.e, values); return v === null ? null : -v; }
    case "bin": {
      const a = run(n.l, values);
      if (a === null) return null;
      const b = run(n.r, values);
      if (b === null) return null;
      switch (n.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return b === 0 ? null : a / b;
        default: return b === 0 ? null : a % b;
      }
    }
    default: {
      const xs = [];
      for (const a of n.args) { const v = run(a, values); if (v === null) return null; xs.push(v); }
      if (n.f === "min") return Math.min(...xs);
      if (n.f === "max") return Math.max(...xs);
      if (n.f === "round") return Math.round(xs[0]);
      return Math.abs(xs[0]);
    }
  }
}

function build(source) {
  if (typeof source !== "string") throw new Error("formula must be text");
  if (source.length > MAX_SOURCE) throw new Error("formula is longer than " + MAX_SOURCE + " characters");
  return parse(source);
}

export function compile(source) {
  let parsed;
  try { parsed = build(source); } catch { return () => null; }
  const { ast } = parsed;
  return (values) => {
    try {
      const r = run(ast, values && typeof values === "object" ? values : {});
      return typeof r === "number" && Number.isFinite(r) ? r : null;
    } catch { return null; }
  };
}

export function check(source, knownNames = []) {
  let parsed;
  try { parsed = build(source); } catch (e) {
    return { ok: false, error: String(e && e.message || e), names: [] };
  }
  const known = new Set(knownNames);
  const unknown = parsed.names.filter((n) => !known.has(n));
  if (unknown.length) {
    return { ok: false, error: "unknown name " + unknown.map((n) => "'" + n + "'").join(", "), names: parsed.names };
  }
  return { ok: true, names: parsed.names };
}
