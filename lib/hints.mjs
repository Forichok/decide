// hints.mjs — up to three hints for the round just opened: a media kind or a field the spec could have used.
// Read from the normalised spec; each hint names the question and the one thing to do next time.

const MAX = 3;
const LONG_OPTION = 110;

const textLen = (o) => String(o.label || "").length + String(o.detail || "").length;

export function hintsFor(spec) {
  const hints = [];
  const add = (text) => hints.length < MAX && hints.push(text);
  const questions = spec?.questions || [];
  for (const q of questions) {
    if ((q.images || []).length === 2 && !q.compare) add(`[${q.id}] shows two images side by side in text: \`compare\` puts them under one slider.`);
    const opts = q.options || [];
    if (opts.length >= 3 && opts.filter((o) => textLen(o) > LONG_OPTION).length >= 3 && !q.table) add(`[${q.id}] has long option texts: a \`table\` (options as rows, a column per trait) reads faster.`);
    if (opts.length >= 2 && q.type !== "text" && !opts.some((o) => o.recommended)) add(`[${q.id}] has no recommended option: say which one you would pick, with a reason.`);
  }
  if (questions.length > 7 && !(spec.sections || []).length) add(`${questions.length} questions in one flat list: \`sections\` group them, \`budget\` keeps only what fits the user's time.`);
  if (questions.length > 3 && !questions.some((q) => q.stakes || q.priority !== 2)) add("Mark the questions that matter with `stakes` or `priority`, so a short budget cuts the right ones.");
  return hints.slice(0, MAX);
}

export const formatHints = (hints) => (hints.length ? `Hints for next time:\n${hints.map((h) => `- ${h}`).join("\n")}` : "");
