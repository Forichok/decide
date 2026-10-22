// adr.mjs — a finished decision as an architecture decision record in the
// repo: docs/decisions/NNNN-slug.md with context, options, decision and
// consequences. The journal stays in ~/.decide; the ADR is the copy the team
// reads and reviews. One file per round: writing it again updates it in place.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { normalizeSpec } from "./spec.mjs";
import { normalizeDeck } from "./swipe.mjs";
import { slugify } from "./project.mjs";
import { describe } from "../ui/js/logic.js";

export const ADR_DIR = "docs/decisions";
const roundLine = (id) => `- Round: \`${id}\` (decide)`;

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

// The spec of a journal entry: recorded since 2.1, else found next to the answers file.
export function specFileOf(entry) {
  if (entry.spec && existsSync(entry.spec)) return entry.spec;
  const base = String(entry.answers || "").replace(/\.answers\.json$/i, "");
  return [`${base}.questions.json`, `${base}.json`].find((f) => base && existsSync(f)) || null;
}

export function existingAdr(root, round, dir = ADR_DIR) {
  const abs = resolve(root, dir);
  if (!existsSync(abs)) return null;
  for (const name of readdirSync(abs).filter((n) => /^\d{4}-.*\.md$/.test(n)).sort()) {
    const file = join(abs, name);
    if (readFileSync(file, "utf8").includes(roundLine(round))) return file;
  }
  return null;
}

function nextNumber(abs) {
  const nums = existsSync(abs) ? readdirSync(abs).map((n) => Number(n.match(/^(\d{4})-/)?.[1])).filter(Number.isFinite) : [];
  return String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, "0");
}

// Builds the markdown. entry: a journal entry; result: its answers file; raw: its spec file (or null).
export function adrMarkdown({ number, entry, result, raw, consequences = "" }) {
  const swipe = entry.mode === "swipe" || result?.mode === "swipe";
  const date = String(entry.at || result?.submittedAt || new Date().toISOString()).slice(0, 10);
  const status = entry.superseded ? `Superseded${entry.superseded.by ? ` by round \`${entry.superseded.by}\`` : ""}${entry.superseded.reason ? `: ${entry.superseded.reason}` : ""}` : "Accepted";
  const out = [`# ${number}. ${entry.title}`, "", `- Status: ${status}`, `- Date: ${date}`, roundLine(entry.round), ""];
  const spec = raw ? (swipe ? normalizeDeck(raw, { specDir: "." }).deck : normalizeSpec(raw, { specDir: "." }).spec) : null;

  out.push("## Context", "");
  const context = spec ? (swipe ? [spec.goal, spec.intro] : [spec.intro, spec.recap, spec.context]).filter(Boolean) : [];
  out.push(context.length ? context.join("\n\n") : "_The round gave no context._", "");

  if (spec) {
    out.push("## Options", "");
    if (swipe) {
      for (const c of spec.cards.filter((c) => result?.answers?.[c.id])) {
        out.push(`### ${c.title}`, "", ...["left", "right"].map((s) => `- ${c[s].label}${c.recommended === s ? " (recommended)" : ""}${c[s].detail ? ` — ${c[s].detail}` : ""}`), "");
      }
    } else {
      for (const q of spec.questions.filter((q) => result?.answers?.[q.id])) {
        out.push(`### ${q.title}`, "");
        if (!q.options.length) out.push(`_${q.type === "text" ? "Free text" : q.type === "scale" ? "A scale" : "No options"}._`);
        for (const o of q.options) {
          const extra = [o.detail, o.pros.length && `pros: ${o.pros.join("; ")}`, o.cons.length && `cons: ${o.cons.join("; ")}`].filter(Boolean).join(". ");
          out.push(`- ${o.label}${o.recommended ? " (recommended)" : ""}${extra ? ` — ${extra}` : ""}`);
        }
        out.push("");
      }
    }
  }

  out.push("## Decision", "");
  if (spec && !swipe) {
    for (const q of spec.questions.filter((q) => result?.answers?.[q.id])) {
      const r = result.answers[q.id];
      out.push(`- **${q.title}** → ${describe(q, r)}`);
      if (r.note) out.push(`  ${r.note.replace(/\n/g, "\n  ")}`);
    }
    if (result?.comment) out.push("", result.comment);
  } else if (swipe && result) {
    const decided = (result.brief || []).filter((b) => b.kind === "decision");
    out.push(...(decided.length ? decided.map((b) => `- ${b.text}`) : [result.digest || entry.digest]));
    if (result.note) out.push("", result.note);
  } else {
    out.push(entry.digest || "_No answers recorded._");
  }
  out.push("");

  out.push("## Consequences", "");
  const derived = [];
  if (spec && !swipe) {
    for (const q of spec.questions) {
      const picked = new Set(result?.answers?.[q.id]?.selected || []);
      for (const o of q.options.filter((o) => picked.has(o.id))) {
        for (const p of o.pros) derived.push(`- ${o.label}: ${p}`);
        for (const c of o.cons) derived.push(`- ${o.label}, cost: ${c}`);
      }
    }
  }
  if (swipe) for (const b of (result?.brief || []).filter((b) => ["risk", "problem", "open"].includes(b.kind))) derived.push(`- ${b.kind === "open" ? "Open" : b.kind === "risk" ? "Risk" : "Problem"}: ${b.text}`);
  const text = String(consequences || "").trim();
  out.push(...(text ? [text] : []), ...(text && derived.length ? [""] : []), ...derived);
  if (!text && !derived.length) out.push("_Not recorded. Add what this makes easier and what it makes harder._");
  out.push("");
  return out.join("\n");
}

// Writes (or rewrites) the ADR of one journal entry; returns {file, created}.
export function writeAdr({ root, entry, consequences, dir = ADR_DIR }) {
  const abs = resolve(root, dir);
  const existing = existingAdr(root, entry.round, dir);
  const number = existing ? existing.match(/(\d{4})-[^/\\]*$/)[1] : nextNumber(abs);
  const file = existing || join(abs, `${number}-${slugify(entry.title, "decision")}.md`);
  const result = entry.answers ? readJson(entry.answers) : null;
  const specFile = specFileOf(entry);
  const md = adrMarkdown({ number, entry, result, raw: specFile ? readJson(specFile) : null, consequences });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, md);
  return { file, created: !existing, md };
}

// A superseded decision's ADR gets its status line rewritten, if it has one.
export function markAdrSuperseded(root, entry, dir = ADR_DIR) {
  const file = existingAdr(root, entry.round, dir);
  if (!file) return null;
  const s = entry.superseded;
  const status = `- Status: Superseded${s.by ? ` by round \`${s.by}\`` : ""}${s.reason ? `: ${s.reason}` : ""}`;
  writeFileSync(file, readFileSync(file, "utf8").replace(/^- Status: .*$/m, status));
  return file;
}
