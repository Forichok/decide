// spec.mjs — the review spec an agent hands in: the overview (summary, risks, checks), the chapters and
// the mechanical groups. Pure: normalizeReview shapes and lints what does not need the diff; what does
// (a reference that names no hunk, hunks in no chapter) is chapters.mjs's, once the snapshot is taken.

import { ACCEPTANCE_FIELDS, CHAPTER_FIELDS, CHECK_FIELDS, FOCUS_FIELDS, FOCUS_KINDS, MECHANICAL_FIELDS, REVIEW_FIELDS, RISKS, RISK_FIELDS } from "../registry/index.mjs";
import { unknownFields } from "../registry/strict.mjs";
import { specLang, words } from "../words.mjs";
import { FOCUS_MAX, FOCUS_MAX_LINES, placeOf } from "./chapters.mjs";

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
      return { id: `ch${i + 1}`, title: "", summary: "", watch: "", risk: "low", hunks: [], focus: [], skim: "" };
    }
    unknownFields(c, Object.keys(CHAPTER_FIELDS), where, add, { level: fieldLevel });
    const id = str(c.id) || `ch${i + 1}`;
    if (seen.has(id)) add("error", where, `duplicate chapter id "${id}"`);
    // h1, h2, … are the diff's own pieces: a question the user asks is addressed to one of them by that id.
    if (/^h\d+$/.test(id)) add("error", where, `chapter id "${id}" reads as a hunk's id (h1, h2, …): pick a word`);
    // Read marks and the like are kept by chapter id: a name every object has would read as set.
    if (id in Object.prototype) add("error", where, `chapter id "${id}" is a name every object has: pick another word`);
    seen.add(id);
    if (!str(c.title)) add("error", where, `"${id}" needs a title: what this part of the change does`);
    if (!str(c.summary)) add("warn", where, `"${id}" has no summary: say what changed here and why`);
    const risk = str(c.risk).toLowerCase();
    if (risk && !RISKS.includes(risk)) add("warn", where, `risk is one of ${RISKS.join(", ")}, got "${risk}"`);
    // The key places: what a person reads. The rest of the chapter is folded on the page.
    const focus = list(c.focus)
      .map((f, k) => {
        const at = `${where}.focus[${k}]`;
        if (!plain(f)) return add("error", at, 'a key place is an object: {at: "path:from-to", note, kind}'), null;
        unknownFields(f, Object.keys(FOCUS_FIELDS), at, add, { level: fieldLevel });
        const place = placeOf(f.at);
        if (!place && /:(\d+)-(\d+)$/.test(f.at ?? "")) {
          const m = /:(\d+)-(\d+)$/.exec(f.at);
          if (Number(m[2]) < Number(m[1])) return add("error", at, `"${f.at}": the end is before the start`), null;
        }
        if (!place) return add("error", at, `at is "path:from-to" or "path:line", lines of the new file; got ${JSON.stringify(f.at ?? null)}`), null;
        if (!str(f.note)) add("warn", at, "no note: say in one phrase what the reviewer should check here");
        const size = place.to - place.from + 1;
        if (size > FOCUS_MAX_LINES) add("warn", at, `${size} lines is a file, not a key place: name the 10 to 30 lines that matter`);
        const kind = str(f.kind).toLowerCase();
        if (kind && !FOCUS_KINDS.includes(kind)) add("warn", at, `kind is one of ${FOCUS_KINDS.join(", ")}, or left out; got "${kind}"`);
        if (kind === "risk" && !str(f.checkedBy)) add("warn", at, "say which check covers it, or write that nothing does");
        if (kind === "decision" && !str(f.question)) add("warn", at, "a decision place asks the owner a yes/no question: add `question`");
        if (kind !== "decision" && (f.question !== undefined || f.options !== undefined)) add("warn", at, "question/options are ignored on a place of another kind");
        const options = Array.isArray(f.options) && f.options.length === 2 && f.options.every((v) => str(v)) ? f.options.map(str) : null;
        if (kind === "decision" && f.options !== undefined && !options) add("warn", at, "options needs two short labels; using Yes / No");
        return { at: str(f.at), note: str(f.note), ...(FOCUS_KINDS.includes(kind) ? { kind } : {}),
          ...(kind === "risk" && str(f.checkedBy) ? { checkedBy: str(f.checkedBy) } : {}),
          ...(kind === "decision" && str(f.question) ? { question: str(f.question) } : {}),
          ...(kind === "decision" && options ? { options } : {}) };
      })
      .filter(Boolean);
    if (focus.length > FOCUS_MAX) add("warn", where, `"${id}" names ${focus.length} key places: more than ${FOCUS_MAX} and the reviewer is back to reading everything`);
    const skim = str(c.skim);
    if (skim && risk === "high") add("warn", where, `"${id}" is high risk and marked skim: a risky chapter is read, name its key places in focus`);
    return { id, title: str(c.title), summary: str(c.summary), watch: str(c.watch), risk: RISKS.includes(risk) ? risk : "low", hunks: hunksOf(c, where), focus, skim };
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
      if (!str(r.checkedBy)) add("warn", where, "say which check covers it, or write that nothing does");
      const chapter = str(r.chapter);
      if (chapter && !seen.has(chapter)) add("warn", where, `no chapter "${chapter}": the risk will not jump anywhere`);
      return { level: RISKS.includes(level) ? level : "medium", what: str(r.what), ...(str(r.checkedBy) ? { checkedBy: str(r.checkedBy) } : {}), why: str(r.why), chapter: seen.has(chapter) ? chapter : "" };
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

  // A change a person cannot read in one sitting, and nothing says where to look.
  if (chapters.length > 2 && !chapters.some((c) => c.focus.length || c.skim)) add("warn", "chapters", "no chapter names key places (focus) or is marked skim: the reviewer gets every line of every hunk");
  if (!str(raw.summary)) add("warn", "summary", "no summary: the overview opens with what changed and why");
  if (!checks.length) add("warn", "checks", "no checks: list what you ran (command, exit code, seconds), or the reviewer sees nothing was checked");
  const high = chapters.filter((c) => c.risk === "high" && !risks.some((r) => r.chapter === c.id));
  if (high.length) add("warn", "risks", `chapter${high.length === 1 ? "" : "s"} ${high.map((c) => `"${c.id}"`).join(", ")} marked high risk but no risk in the overview points there`);

  let acceptance;
  if (!plain(raw.acceptance)) add("warn", "acceptance", "say what changed for the user and how to check it; for a refactoring: nothing changes from outside");
  else {
    // Acceptance is advice, never a reason to refuse a review.
    unknownFields(raw.acceptance, Object.keys(ACCEPTANCE_FIELDS), "acceptance", add, { level: "warn" });
    acceptance = Object.fromEntries(["changed", "where", "expect"].filter((k) => str(raw.acceptance[k])).map((k) => [k, str(raw.acceptance[k])]));
    if (Array.isArray(raw.acceptance.steps)) acceptance.steps = raw.acceptance.steps.filter((s) => str(s)).map(str);
    if (!acceptance.changed) add("warn", "acceptance.changed", "say what changed for the user; for a refactoring: nothing changes from outside");
  }
  const spec = { ...(acceptance ? { acceptance } : {}), mode: "review", lang, title: str(raw.title) || words(lang).round, summary: str(raw.summary), risks, checks, chapters, mechanical, ...(str(raw.mechanicalWhy) ? { mechanicalWhy: str(raw.mechanicalWhy) } : {}) };
  return { spec, issues };
}
