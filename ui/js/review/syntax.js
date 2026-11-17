// syntax.js — colours for the code in a diff, without a parser and without a library: comments, strings,
// numbers, keywords and the names of called functions, chosen by the file's extension. It reads a hunk
// line by line and carries one thing from line to line: the block comment or the multi-line string a
// line ended inside. A hunk may start in the middle of one; then the first lines are coloured as code
// until it closes. A file of an unknown kind stays plain. No DOM here: lexer() returns pairs.

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

const C_BLOCK = [["/*", "*/"]];
const JS = {
  line: ["//"],
  block: C_BLOCK,
  strings: ['"', "'"],
  multi: ["`"],
  regex: true,
  words: words(
    "abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield",
  ),
  lits: words("true false null undefined NaN Infinity"),
};
const C_LIKE = (list, extra = {}) => ({ line: ["//"], block: C_BLOCK, strings: ['"', "'"], words: words(list), lits: words("true false null nil None"), ...extra });
const LANGS = {
  js: JS,
  json: { strings: ['"'], keys: true, lits: words("true false null") },
  css: { block: C_BLOCK, strings: ['"', "'"], at: true },
  py: {
    line: ["#"],
    strings: ['"', "'"],
    multi: ['"""', "'''"],
    words: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield"),
    lits: words("True False None"),
  },
  sh: { line: ["#"], strings: ['"', "'"], words: words("case do done elif else esac export fi for function if in local return then until while") },
  yaml: { line: ["#"], strings: ['"', "'"], lits: words("true false null yes no on off") },
  sql: {
    line: ["--"],
    block: C_BLOCK,
    strings: ["'"],
    fold: true,
    words: words("add alter and as asc begin by case check column commit constraint create default delete desc distinct drop else end exists foreign from group having if in index insert into is join key left limit not on or order primary references returning right select set table then union unique update values where with"),
    lits: words("null true false"),
  },
  go: C_LIKE("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var", { multi: ["`"] }),
  rs: C_LIKE("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while"),
  c: C_LIKE(
    "abstract auto break case catch class const continue default delete do else enum extends extern final finally for fun func goto if implements import inline interface internal let namespace new operator override package private protected public return sizeof static struct super switch template this throw throws try typedef union using val var virtual void volatile when while",
  ),
  html: { block: [["<!--", "-->"]], tags: true },
  md: { md: true },
};
const EXT = {
  js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", mts: "js", cts: "js", tsx: "js",
  json: "json", jsonc: "json", webmanifest: "json",
  css: "css", scss: "css", less: "css",
  py: "py", sh: "sh", bash: "sh", zsh: "sh", yml: "yaml", yaml: "yaml", toml: "yaml", sql: "sql",
  go: "go", rs: "rs",
  c: "c", h: "c", cc: "c", cpp: "c", hpp: "c", cs: "c", java: "c", kt: "c", kts: "c", swift: "c", php: "c", dart: "c",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html",
  md: "md", markdown: "md",
};

export function langOf(path) {
  const name = String(path ?? "").split("/").pop().toLowerCase();
  if (name === "dockerfile" || name === "makefile") return "sh";
  return EXT[name.includes(".") ? name.split(".").pop() : ""] ?? null;
}

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)[a-zA-Z%]*/y;
const TAG = /<\/?[A-Za-z][\w:-]*/y;
const AT = /@[a-z-]+/y;
const at = (re, text, i) => ((re.lastIndex = i), re.exec(text)?.[0] ?? "");

// The end of a quoted thing that starts at `from` (past its opening): the index after its close, or -1.
function closeOf(text, from, end, escapes = true) {
  for (let i = from; i < text.length; i++) {
    if (escapes && text[i] === "\\") i++;
    else if (text.startsWith(end, i)) return i + end.length;
  }
  return -1;
}

// A regular expression literal that starts at i: the index after its flags, or -1 when the line has no
// such thing (then the slash is a division).
function regexEnd(text, i) {
  let inClass = false;
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\\") j++;
    else if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      j++;
      while (/[a-z]/.test(text[j] ?? "")) j++;
      return j;
    }
  }
  return -1;
}

function markdown(state) {
  return (text) => {
    if (/^\s*(```|~~~)/.test(text)) {
      state.open = state.open ? null : { fence: true };
      return [["c", text]];
    }
    if (state.open) return [["s", text]];
    if (/^#{1,6}\s/.test(text)) return [["k", text]];
    const out = [];
    let last = 0;
    for (const m of text.matchAll(/`[^`]+`/g)) {
      if (m.index > last) out.push(["", text.slice(last, m.index)]);
      out.push(["s", m[0]]);
      last = m.index + m[0].length;
    }
    if (last < text.length || !out.length) out.push(["", text.slice(last)]);
    return out;
  };
}

// One line of `lang` → [[class, text], …]; class is "" (plain), c, s, k, n, f or p. state.open is what
// the line before ended inside.
function lineOf(lang, state) {
  if (lang.md) return markdown(state);
  const starts = [
    ...(lang.block ?? []).map(([a, b]) => ({ a, b, cls: "c", carry: true, escapes: false })),
    ...(lang.multi ?? []).map((q) => ({ a: q, b: q, cls: "s", carry: true, escapes: true })),
    ...(lang.strings ?? []).map((q) => ({ a: q, b: q, cls: "s", carry: false, escapes: true })),
  ];
  return (text) => {
    const out = [];
    const push = (cls, s) => {
      if (!s) return;
      if (out.length && out.at(-1)[0] === cls) out.at(-1)[1] += s;
      else out.push([cls, s]);
    };
    let i = 0;
    let value = false; // the last thing was a value: a slash after it divides
    if (state.open) {
      const end = closeOf(text, 0, state.open.b, state.open.escapes);
      if (end < 0) return [[state.open.cls, text]];
      push(state.open.cls, text.slice(0, end));
      state.open = null;
      i = end;
      value = true;
    } else if (lang.block === C_BLOCK && /^\s*\*(\s|\/|$)/.test(text)) {
      // A hunk that starts inside a doc comment: " * like this".
      const end = text.indexOf("*/");
      if (end < 0) return [["c", text]];
      push("c", text.slice(0, end + 2));
      i = end + 2;
    }
    scan: while (i < text.length) {
      const ch = text[i];
      if (ch === " " || ch === "\t") {
        push("", ch);
        i++;
        continue;
      }
      for (const mark of lang.line ?? []) {
        if (text.startsWith(mark, i)) {
          push("c", text.slice(i));
          break scan;
        }
      }
      for (const st of starts) {
        if (!text.startsWith(st.a, i)) continue;
        const end = closeOf(text, i + st.a.length, st.b, st.escapes);
        if (end < 0) {
          push(st.cls, text.slice(i));
          if (st.carry) state.open = st;
          break scan;
        }
        const key = lang.keys && /^\s*:/.test(text.slice(end));
        push(key ? "p" : st.cls, text.slice(i, end));
        i = end;
        value = true;
        continue scan;
      }
      if (lang.regex && ch === "/" && !value) {
        const end = regexEnd(text, i);
        if (end > 0) {
          push("s", text.slice(i, end));
          i = end;
          value = true;
          continue;
        }
      }
      if (lang.tags && ch === "<") {
        const tag = at(TAG, text, i);
        if (tag) {
          push("", tag[1] === "/" ? "</" : "<");
          push("k", tag.slice(tag[1] === "/" ? 2 : 1));
          i += tag.length;
          continue;
        }
      }
      if (lang.at && ch === "@") {
        const rule = at(AT, text, i);
        if (rule) {
          push("k", rule);
          i += rule.length;
          continue;
        }
      }
      if (!lang.tags && /\d/.test(ch)) {
        const num = at(NUMBER, text, i);
        push("n", num);
        i += num.length;
        value = true;
        continue;
      }
      const word = lang.tags ? "" : at(IDENT, text, i);
      if (word) {
        const w = lang.fold ? word.toLowerCase() : word;
        const called = /^\s*\(/.test(text.slice(i + word.length));
        const cls = lang.words?.has(w) ? "k" : lang.lits?.has(w) ? "n" : called ? "f" : "";
        push(cls, word);
        i += word.length;
        value = cls !== "k";
        continue;
      }
      push("", ch);
      value = ch === ")" || ch === "]" || ch === "}";
      i++;
    }
    return out;
  };
}

// A reader for the lines of one file's diff, in the order they are shown. kind is the line's own:
// "add" lives on the new side, "del" on the old one, anything else on both.
export function lexer(path) {
  const lang = LANGS[langOf(path)];
  if (!lang) return (text) => [["", String(text ?? "")]];
  const sides = { old: { open: null }, new: { open: null } };
  const read = { old: lineOf(lang, sides.old), new: lineOf(lang, sides.new) };
  return (text, kind = "ctx") => {
    const side = kind === "del" ? "old" : "new";
    const out = read[side](String(text ?? ""));
    if (kind !== "add" && kind !== "del") sides.old.open = sides.new.open;
    return out.length ? out : [["", ""]];
  };
}
