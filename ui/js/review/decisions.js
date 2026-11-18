// Both copies read the server's answers; a button changes or clears one answer.
import { h } from '../dom.js';
import { mdInline } from '../md.js';
import { lang, t } from '../i18n.js';

export const decisionsOf = (s) => s.spec.chapters.flatMap((c) => c.focus.flatMap((f, index) => f.kind === 'decision' && f.question ? [{ ...f, chapter: c.id, index }] : []));
export const answerOf = (s, d) => s.rv.decisions?.[d.chapter]?.[d.at] ?? null;

export function renderDecision(s, d) {
  const answer = answerOf(s, d);
  return h('div.cr-decision', {},
    h('span.cr-decision-question', { html: mdInline(d.question) }),
    h('span.cr-decision-buttons', { role: 'group', 'aria-label': d.question }, ['yes', 'no'].map((value, i) =>
      h('button.chip', { type: 'button', dataset: { decisionChapter: d.chapter, decisionAt: d.at, answer: value }, 'aria-pressed': String(answer === value), onclick: () => s.answerDecision(d, value) }, d.options?.[i] ?? t(`cr.decision.${value}`)))),
  );
}

export function paintDecisions(s) {
  for (const button of document.querySelectorAll('[data-decision-at]')) {
    const { decisionChapter, decisionAt, answer } = button.dataset;
    button.disabled = s.isAnswerSaving(decisionChapter, decisionAt);
    button.setAttribute('aria-pressed', String((s.rv.decisions?.[decisionChapter]?.[decisionAt] ?? null) === answer));
  }
}

export async function saveDecision(id, payload) {
  const res = await fetch(`/api/rounds/${id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, lang }) });
  if (!res.ok) throw Object.assign(new Error('Decision was not saved'), { status: res.status });
  return res.json();
}
