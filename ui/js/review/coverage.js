// Coverage records exposure of unfolded changes, independently of the chapter's manual mark.
import { h } from '../dom.js';
import { t } from '../i18n.js';
import { openModal } from '../overlays.js';

export function counts(ids, states = {}) {
  const opened = ids.filter((id) => states[id] === 'opened').length;
  const part = ids.filter((id) => states[id] === 'part').length;
  return { total: ids.length, opened, part, unopened: ids.length - opened - part };
}
export const summary = (c) => t('cr.coverage', c.opened, c.total, c.part, c.unopened);
export const coverageCounts = (s) => counts((s.rv.files ?? []).flatMap((f) => f.ids), s.rv.coverage);
const fileNames = (files) => files.slice(0, 3).join(', ') + (files.length > 3 ? ` ${t('cr.coverage.moreFiles', files.length - 3)}` : '');
const groupOf = (at) => at.chapter !== undefined ? `ch:${at.chapter}` : at.mechanical !== undefined ? `mech:${at.mechanical}` : 'rest';

export function coverageWarning(s, openFiles) {
  const c = coverageCounts(s);
  if (c.opened === c.total) return null;
  const groups = [
    ...s.rv.chapters.map((g, i) => ({ ...g, title: s.spec.chapters[i].title })),
    ...s.rv.mechanical.map((g, i) => ({ ...g, title: t('cr.inMechanical', s.spec.mechanical[i].title) })),
    { ...s.rv.rest, title: t('cr.rest') },
  ];
  const missing = groups.filter((g) => counts(g.ids, s.rv.coverage).opened < g.ids.length);
  const rows = missing.slice(0, 6).map((g) => {
    const files = (s.rv.files ?? []).filter((f) => f.ids.some((id) => g.ids.includes(id) && s.rv.coverage?.[id] !== 'opened')).map((f) => f.file);
    const c = counts(g.ids, s.rv.coverage);
    return h('li', {}, `${g.title}: ${t('cr.coverage.missing', c.unopened, c.part)} (${fileNames(files)})`);
  });
  const files = h('button.link-btn', { type: 'button', onclick: openFiles }, t('cr.fileList'));
  if (missing.length > 6) rows.push(h('li', {}, t('cr.coverage.more', missing.length - 6), ' ', files));
  return h('div.cr-alert', { dataset: { alert: 'coverage' } }, h('b', {}, summary(c)), h('ul', {}, rows), missing.length <= 6 && files);
}

export function showFiles(s) {
  const states = s.rv.coverage ?? {};
  const close = openModal(h('div.cr-file-list', {},
    h('h2.modal-title', {}, t('cr.fileList')),
    h('p.cr-coverage-summary', {}, summary(coverageCounts(s))),
    h('ul', {}, (s.rv.files ?? []).map((f) => {
      const c = counts(f.ids, states);
      const labels = [...new Set(f.ids.map((id) => {
        const at = s.rv.owners?.[id] ?? {};
        return at.mechanical !== undefined ? t('cr.inMechanical', s.spec.mechanical[at.mechanical].title) : at.chapter === undefined ? t('cr.rest') : '';
      }).filter(Boolean))];
      const state = c.opened === c.total ? 'opened' : c.opened || c.part ? 'part' : 'unopened';
      const mark = { opened: '✓', part: '◐', unopened: '○' }[state];
      const path = f.file.split('/').flatMap((part, i) => i ? ['/', h('wbr'), part] : [part]);
      return h('li', {}, h('button', { type: 'button', onclick: () => {
        close();
        const id = f.ids.find((id) => states[id] !== 'opened') ?? f.ids[0];
        s.goPiece(id, groupOf(s.rv.owners?.[id] ?? {}));
      } }, h('code', {}, path), h('span.cr-file-meta', {},
        h('span.cr-file-coverage', {}, h('span', { 'aria-hidden': 'true' }, mark), ' ', t(`cr.coverage.${state}`)),
        ` · +${f.added} −${f.removed} · ${t('cr.pieces', f.pieces)}`,
        labels.length > 0 && ` · ${labels.join(' · ')}`,
      )));
    })),
    h('div.modal-actions', {}, h('button.btn', { type: 'button', onclick: () => close() }, t('cr.close'))),
  ));
}

export function trackCoverage(s, onError) {
  let timer, frame, sending = null, stopped = false;
  let pending = {};
  const rank = (v) => v === 'opened' ? 2 : v === 'part' ? 1 : 0;
  function measure() {
    frame = null;
    if (stopped || document.visibilityState !== 'visible') return;
    const next = { ...s.rv.coverage };
    let changed = false;
    for (const [id, { el }] of s.loaded) {
      if (!el.isConnected || !el.getClientRects().length) continue;
      let parent = el.parentElement;
      let hidden = false;
      while (parent) {
        if (parent.tagName === 'DETAILS' && !parent.open) { hidden = true; break; }
        parent = parent.parentElement;
      }
      if (hidden) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) continue;
      const value = el.coverageState();
      if (rank(value) <= rank(next[id])) continue;
      next[id] = pending[id] = value;
      changed = true;
    }
    if (changed) {
      s.rv.coverage = next;
      s.paint();
      clearTimeout(timer);
      timer = setTimeout(() => flush().catch(onError), 200);
    }
  }
  const schedule = () => { if (!frame && !stopped) frame = requestAnimationFrame(measure); };
  async function flush() {
    clearTimeout(timer);
    if (sending) { await sending; return flush(); }
    if (!Object.keys(pending).length) return;
    const pieces = pending;
    pending = {};
    sending = fetch(`/api/rounds/${s.id}/coverage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pieces }), keepalive: true }).then(async (res) => {
      if (!res.ok) throw Object.assign(new Error('coverage was not saved'), { status: res.status });
      const result = await res.json();
      s.seq = Math.max(s.seq, result.seq || 0);
    }).catch((e) => {
      for (const [id, value] of Object.entries(pieces)) if (rank(value) > rank(pending[id])) pending[id] = value;
      throw e;
    }).finally(() => { sending = null; });
    await sending;
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.querySelector('.cr-view'), { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule);
  document.addEventListener('visibilitychange', schedule);
  const leaving = () => flush().catch(() => {});
  addEventListener('pagehide', leaving);
  schedule();
  return { flush: async () => { measure(); await flush(); }, stop() {
    stopped = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    observer.disconnect();
    removeEventListener('scroll', schedule);
    removeEventListener('resize', schedule);
    document.removeEventListener('visibilitychange', schedule);
    removeEventListener('pagehide', leaving);
    leaving();
  } };
}
