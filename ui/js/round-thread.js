// One conversation control for the questions, swipe and review top bars. Only the mounted button listens.
import { h, icon } from './dom.js';
import { t } from './i18n.js';
import { getThread, sendMessage, pickMessage, onEvent, holdReload } from './net.js';
import { openModal, openLightbox, toast } from './overlays.js';
import { roundMessage } from './dialog.js';

let active = null;
const drafts = new Map();
const read = (key) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const seenKey = (id) => `decide-thread-seen:${id}`;
const draftKey = (id) => `decide-thread-draft:${id}`;
const visible = () => document.visibilityState === 'visible' && document.hasFocus();

export function roundThreadButton(id) {
  const button = h('button.chip.ghost.round-thread-button', {
    type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => open(s),
  }, h('span', {}, t('thread.button')), h('span.round-thread-unread', { hidden: true, 'aria-hidden': 'true' }));
  const s = { id, button, thread: [], listening: false, status: 'pending', panel: null, loaded: false, version: 0 };
  active = s;
  refresh(s);
  return button;
}

function adopt(s, data) {
  s.thread = data.thread || [];
  s.listening = data.listening === true;
  s.status = data.status || s.status;
  s.loaded = true;
  if (s.panel) paint(s);
  mark(s);
}
async function refresh(s) {
  const version = ++s.version;
  try {
    const data = await getThread(s.id);
    if (active === s && s.version === version) adopt(s, data);
  } catch {
    if (s.panel) s.error.textContent = t('thread.loadFailed');
  }
}
function mark(s) {
  const agent = s.thread.filter(m => m.from === 'agent');
  const last = agent.at(-1)?.id || '';
  const latest = s.panel && [...s.log.querySelectorAll('[data-from="agent"]')].at(-1);
  const bounds = latest?.getBoundingClientRect();
  const logBounds = s.panel && s.log.getBoundingClientRect();
  if (visible() && bounds && bounds.top < logBounds.bottom && bounds.bottom > logBounds.top) write(seenKey(s.id), last);
  const unread = Boolean(last && last !== read(seenKey(s.id)));
  s.button.classList.toggle('unread', unread);
  s.button.querySelector('.round-thread-unread').hidden = !unread;
  s.button.setAttribute('aria-label', t(unread ? 'thread.unread' : 'thread.button'));
}
function draft(s) {
  return drafts.get(s.id) || read(draftKey(s.id));
}
function keepDraft(s, text) {
  drafts.set(s.id, text);
  write(draftKey(s.id), text);
}
function open(s) {
  if (s.panel) return s.input.focus();
  s.log = h('div.round-thread-log', { role: 'log', 'aria-live': 'polite', 'aria-label': t('thread.conversation'), tabindex: '0', onscroll: () => mark(s) });
  s.presence = h('p.round-thread-presence', { role: 'status' });
  s.error = h('p.round-thread-error', { role: 'alert' });
  s.input = h('textarea.note.round-thread-input', {
    rows: '3', maxlength: '4000', 'data-autofocus': true, 'aria-label': t('thread.label'), placeholder: t('thread.placeholder'),
    oninput: () => { keepDraft(s, s.input.value); s.send.disabled = !s.input.value.trim(); },
    onkeydown: e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); send(s); }
    },
  });
  s.input.value = draft(s);
  s.send = h('button.btn.primary.sm', { type: 'button', disabled: !s.input.value.trim(), onclick: () => send(s) }, t('thread.send'));
  s.composer = h('div.round-thread-composer', {}, s.input, h('div.round-thread-send', {}, h('span', {}, t('thread.hint')), s.send));
  const closeButton = h('button.icon-btn', { type: 'button', 'aria-label': t('thread.close'), html: icon('x'), onclick: () => close() });
  s.panel = h('section.round-thread-panel', { 'aria-label': t('thread.conversation'), onkeydown: e => trapFocus(e, s.panel) },
    h('div.round-thread-head', {}, h('h2.modal-title', { id: 'round-thread-title' }, t('thread.conversation')), closeButton),
    s.presence, s.log, s.error, s.composer);
  s.button.setAttribute('aria-expanded', 'true');
  const close = openModal(s.panel, { wide: true, onClose: () => {
    s.button.setAttribute('aria-expanded', 'false');
    s.panel = null;
    s.button.focus({ preventScroll: true });
  } });
  s.panel.parentElement.setAttribute('aria-labelledby', 'round-thread-title');
  paint(s);
  refresh(s);
}
function trapFocus(e, panel) {
  if (e.key !== 'Tab') return;
  const items = [...panel.querySelectorAll('button:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')];
  const first = items[0], last = items.at(-1);
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
}
function paint(s) {
  s.presence.textContent = !s.loaded ? t('thread.loading') : s.listening ? t('thread.listening') : t('thread.away');
  s.presence.classList.toggle('away', !s.listening);
  const closed = s.status !== 'pending';
  s.composer.hidden = closed;
  const key = JSON.stringify([s.thread, closed]);
  if (s.log.dataset.key !== key) {
    const atBottom = s.log.scrollHeight - s.log.scrollTop - s.log.clientHeight < 48;
    const ctx = { toast, closed, lightbox: (images, start) => openLightbox(images, start) };
    const pickedByReply = new Map(s.thread.filter(m => m.choice && m.picked !== undefined).map(m => [m.id, m.picked]));
    const messages = s.thread.map(m => roundMessage(m, ctx, (id, picked) => pick(s, id, picked), pickedByReply.get(m.replyTo)));
    s.log.replaceChildren(...(messages.length ? messages : [h('p.round-thread-empty', {}, t('thread.empty'))]));
    s.log.dataset.key = key;
    if (atBottom) s.log.scrollTop = s.log.scrollHeight;
  }
  mark(s);
}
async function send(s) {
  const text = s.input.value.trim();
  if (!text || s.sending || s.status !== 'pending') return;
  s.sending = true;
  s.error.textContent = '';
  s.input.disabled = s.send.disabled = true;
  // Keep this id after a lost response, including a reload, so a retry cannot duplicate a saved message.
  const retryKey = `decide-thread-retry:${s.id}`;
  let retry;
  try { retry = JSON.parse(read(retryKey) || 'null'); } catch {}
  if (retry?.text !== text) retry = { id: crypto.randomUUID(), text };
  write(retryKey, JSON.stringify(retry));
  try {
    await sendMessage(s.id, retry);
    keepDraft(s, '');
    write(retryKey, '');
    s.input.value = '';
    await refresh(s);
  } catch {
    s.error.textContent = t('thread.sendFailed');
  } finally {
    s.sending = false;
    s.input.disabled = false;
    s.send.disabled = !s.input.value.trim();
    if (s.panel) s.input.focus();
  }
}
async function pick(s, id, picked) {
  if (s.picking) return;
  s.picking = true;
  s.error.textContent = '';
  try { await pickMessage(s.id, { id, picked }); await refresh(s); }
  catch { s.error.textContent = t('thread.pickFailed'); }
  finally { s.picking = false; }
}
onEvent('thread', data => {
  const s = active;
  if (s?.id !== data.round || !s.button.isConnected) return;
  s.version++; // A slower GET must not overwrite this event with an older conversation.
  adopt(s, data);
});
for (const name of ['reconnect', 'state']) onEvent(name, () => {
  if (active?.button.isConnected) refresh(active);
});
for (const name of ['focus', 'visibilitychange']) (name === 'focus' ? window : document).addEventListener(name, () => {
  if (active?.button.isConnected) mark(active);
});
holdReload('thread', () => Boolean(active?.sending || (active?.panel && active.input.value.trim())));
