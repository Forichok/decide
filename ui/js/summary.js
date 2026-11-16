// summary.js — the Done screen's readable summary of a questions round, as plain data: for each answered
// question its title, the answer in words, the user's note and what was attached. No DOM and no page
// strings here: `w` carries the words (the page passes its own translation), so Node tests load it.
//   w: explain, skip, delegate, autoSkip, autoDelegate, against(recs), own(text),
//      later(revisit), none, condition(text)

import { describe } from "./logic.js";

const STAR = / ?★$/;

export function summarize(spec, result, w) {
  const answers = result?.answers || {};
  const rows = [];
  for (const q of spec?.questions || []) {
    const r = answers[q.id];
    if (!r) continue;
    let text = describe(q, r, w);
    const recommended = STAR.test(text);
    text = text.replace(STAR, "");
    const lead = [r.flag === "later" && w.later(r.revisit || ""), r.flag === "none" && w.none].filter(Boolean);
    if (lead.length) text = [...lead, text === "—" ? "" : text].filter(Boolean).join(" · ");
    if (r.condition) text = `${text === "—" ? "" : `${text} · `}${w.condition(r.condition)}`;
    const files = (r.attachments || []).map((f) => String(f).split(/[\\/]/).pop());
    const pins = (r.pins || []).map((p) => ({ file: String(p.file || "").split(/[\\/]/).pop(), text: p.text || "" }));
    rows.push({ id: q.id, title: q.title, answer: text, recommended, note: r.note || "", files, pins });
  }
  return {
    rows,
    comment: result?.comment || "",
    leftOut: (result?.leftOut || []).map((q) => q.title),
    commentFiles: (result?.attachments || []).map((f) => String(f).split(/[\\/]/).pop()),
  };
}
