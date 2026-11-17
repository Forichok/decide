// spec.mjs — the review spec an agent hands in: the overview (summary, risks, checks), the chapters and
// the mechanical groups. Pure: normalizeReview shapes and lints what does not need the diff; what does
// (a reference that names no hunk, hunks in no chapter) is chapters.mjs's, once the snapshot is taken.

import { CHAPTER_FIELDS, CHECK_FIELDS, MECHANICAL_FIELDS, REVIEW_FIELDS, RISKS, RISK_FIELDS } from "../registry/index.mjs";
import { unknownFields } from "../registry/strict.mjs";
import { specLang, words } from "../words.mjs";

const str = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const plain = (v) => v && typeof v === "object" && !Array.isArray(v);

// How a check went: "ok" (exit 0), "failed" (another exit code), "missing" (not run).
export const checkState = (check) => (check.exit === null ? "missing" : check.exit === 0 ? "ok" : "failed");

// fields: "strict" refuses a name nobody reads, "lenient" only warns (a spec read back from disk).
export function normalizeReview(raw, { fields = "strict" } = {}) {
  const issues = [];
  const add = (level, where, message) => issues.push({ level, where, message });
  const fieldLevel = fields === "lenient" ? "warn" : "error";
  if (!plain(raw) || !Array.isArray(raw.chapters) || raw.chapters.length === 0) {
    add("error", "chapters", 'expected { "chapters": [ ... ] } with at least one chapter');
    return { spec: null, issues };
  }
  unknownFields(raw, Object.keys(REVIEW_FIELDS), "review", add, { level: fieldLevel });
  const lang = specLang({ ...raw, intro: raw.summary, questions: raw.chapters });
  const hunksOf = (node, where) =>
    list(node?.hunks)
      .map((ref, i) => {
        if (typeof ref === "string" && ref.trim()) return ref.trim();
        add("error", `${where}.hunks[${i}]`, 'a hunk reference is a string: "path", "path:from-to", "dir/" or a glob');
        return null;
      })
      .filter(Boolean);

  const seen = new Set();
  const chapters = raw.chapters.map((c, i) => {
    const where = `chapters[${i}]`;
    if (!plain(c)) {
      add("error", where, "a chapter is an object: {id, title, summary, risk, hunks}");
      return { id: `ch${i + 1}`, title: "", summary: "", watch: "", risk: "low", hunks: [] };
    }
    unknownFields(c, Object.keys(CHAPTER_FIELDS), where, add, { level: fieldLevel });
    const id = str(c.id) || `ch${i + 1}`;
    if (seen.has(id)) add("error", where, `duplicate chapter id "${id}"`);
    // h1, h2, … are the diff's own pieces: a question the user asks is addressed to one of them by that id.
    if (/^h\d+$/.test(id)) add("error", where, `chapter id "${id}" reads as a hunk's id (h1, h2, …): pick a word`);
    seen.add(id);
    if (!str(c.title)) add("error", where, `"${id}" needs a title: what this part of the change does`);
    if (!str(c.summary)) add("warn", where, `"${id}" has no summary: say what changed here and why`);
    const risk = str(c.risk).toLowerCase();
    if (risk && !RISKS.includes(risk)) add("warn", where, `risk is one of ${RISKS.join(", ")}, got "${risk}"`);
    return { id, title: str(c.title), summary: str(c.summary), watch: str(c.watch), risk: RISKS.includes(risk) ? risk : "low", hunks: hunksOf(c, where) };
  });

  const mechanical = list(raw.mechanical).map((m, i) => {
    const where = `mechanical[${i}]`;
    if (!plain(m)) {
      add("error", where, "a mechanical group is an object: {title, hunks}");
      return { title: "", hunks: [] };
    }
    unknownFields(m, Object.keys(MECHANICAL_FIELDS), where, add, { level: fieldLevel });
    if (!str(m.title)) add("warn", where, "no title: say what the edit is (a rename, formatting, a lock file)");
    return { title: str(m.title), hunks: hunksOf(m, where) };
  });

  const risks = list(raw.risks)
    .map((r, i) => {
      const where = `risks[${i}]`;
      if (!plain(r)) return add("error", where, "a risk is an object: {level, what, why, chapter}"), null;
      unknownFields(r, Object.keys(RISK_FIELDS), where, add, { level: fieldLevel });
      const level = str(r.level).toLowerCase();
      if (level && !RISKS.includes(level)) add("warn", where, `level is one of ${RISKS.join(", ")}, got "${level}"`);
      if (!str(r.what)) add("error", where, "a risk needs what: what can go wrong, in one line");
      const chapter = str(r.chapter);
      if (chapter && !seen.has(chapter)) add("warn", where, `no chapter "${chapter}": the risk will not jump anywhere`);
      return { level: RISKS.includes(level) ? level : "medium", what: str(r.what), why: str(r.why), chapter: seen.has(chapter) ? chapter : "" };
    })
    .filter(Boolean);

  const checks = list(raw.checks)
    .map((c, i) => {
      const where = `checks[${i}]`;
      if (!plain(c)) return add("error", where, "a check is an object: {command, exit, seconds, note}"), null;
      unknownFields(c, Object.keys(CHECK_FIELDS), where, add, { level: fieldLevel });
      if (!str(c.command)) add("error", where, "a check needs command: the command as you ran it");
      const exit = Number.isInteger(c.exit) ? c.exit : null;
      if (c.exit != null && exit === null) add("warn", where, `exit is the command's exit code, a whole number; got ${JSON.stringify(c.exit)}: shown as not run`);
      const seconds = Number.isFinite(c.seconds) && c.seconds >= 0 ? c.seconds : null;
      return { command: str(c.command), exit, seconds, note: str(c.note) };
    })
    .filter(Boolean);

  if (!str(raw.summary)) add("warn", "summary", "no summary: the overview opens with what changed and why");
  if (!checks.length) add("warn", "checks", "no checks: list what you ran (command, exit code, seconds), or the reviewer sees nothing was checked");
  const high = chapters.filter((c) => c.risk === "high" && !risks.some((r) => r.chapter === c.id));
  if (high.length) add("warn", "risks", `chapter${high.length === 1 ? "" : "s"} ${high.map((c) => `"${c.id}"`).join(", ")} marked high risk but no risk in the overview points there`);

  const spec = { mode: "review", lang, title: str(raw.title) || words(lang).round, summary: str(raw.summary), risks, checks, chapters, mechanical };
  return { spec, issues };
}
