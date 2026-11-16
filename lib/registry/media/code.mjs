// code — a block of code with a copy button; lines that look like a diff are coloured.

import { alias, boolean, object, shared, string, union } from "../shared.mjs";
import { str } from "./util.mjs";

export default {
  name: "code",
  summary: "A code block with a copy button; a unified diff is coloured.",
  field: shared(
    "code",
    union(
      "A string, or {text, lang?, diff?}.",
      string("The code."),
      object("The code and what it is.", {
        text: string("The code."),
        source: alias("text", "The older spelling of text.", string("The code.")),
        lang: string("The language; shown in the bar."),
        diff: boolean("Colour added and removed lines. Found by itself when lang is diff or the lines look like one."),
      }),
    ),
  ),
  mistakes: { content: '"text"', code: '"text"', language: '"lang"' },
  normalize(out, ctx) {
    out.code = normalizeCode(ctx.raw.code);
  },
  lint() {},
  example: { code: { text: "- old\n+ new\n+ newer", lang: "diff" } },
};

function normalizeCode(code) {
  if (!code) return null;
  if (typeof code === "string") return { text: code, lang: "", diff: looksLikeDiff(code) };
  const text = str(code.text) || str(code.source);
  if (!text) return null;
  const lang = str(code.lang);
  return { text, lang, diff: code.diff === true || lang === "diff" || looksLikeDiff(text) };
}

function looksLikeDiff(text) {
  const lines = text.split("\n");
  return lines.length > 1 && lines.filter((l) => /^[+-](?![+-])/.test(l)).length >= 2;
}
