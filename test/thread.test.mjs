import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store/rounds.mjs';
import { createRoots } from '../lib/assets.mjs';
import { openProject } from '../lib/project.mjs';
import { normalizeSpec } from '../lib/spec.mjs';
import { normalizeDeck } from '../lib/swipe.mjs';
import { normalizeReview } from '../lib/review/spec.mjs';
import * as prepare from '../lib/prepare.mjs';
import { reportCli } from '../lib/commands/ask.mjs';
import { EXIT_ASK } from '../lib/commands/shared.mjs';

const patch = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n';
const specs = {
  questions: normalizeSpec({ title: 'Q', questions: [{ id: 'q', title: 'Q?', options: ['A', 'B'] }] }).spec,
  swipe: normalizeDeck({ title: 'S', cards: [{ id: 'q', title: 'Q?' }] }).deck,
  review: normalizeReview({ title: 'R', summary: 'Edit.', chapters: [{ id: 'q', title: 'Q', summary: 'Edit.', hunks: ['a.js'] }] }).spec,
};
function setup(t, mode = 'questions') {
  const dir = mkdtempSync(join(tmpdir(), 'decide-thread-'));
  const home = join(dir, 'home');
  const project = openProject(dir, home);
  const stores = [];
  const open = () => { const s = createStore({ home, roots: createRoots(), listenGraceMs: 0 }); stores.push(s); return s; };
  const store = open();
  const round = store.create({ project, spec: specs[mode], mode, snapshot: mode === 'review' ? { meta: { format: 1, base: 'a'.repeat(40), head: 'b'.repeat(40) }, patch } : null });
  t.after(() => { stores.forEach(s => s.close()); rmSync(dir, { recursive: true, force: true }); });
  return { store, round, open };
}

for (const mode of Object.keys(specs)) {
  test(`${mode}: messages replay, stay out of per-item dialog, and reach answers and digest`, async t => {
    const { store, round, open } = setup(t, mode);
    const msg = store.message(round, { text: 'Redo the summary' });
    store.explain(round, { askId: msg.id, text: 'Rewritten.', media: { code: { text: 'new()', lang: 'js' } } });
    store.message(round, { text: 'Still unsure' });
    assert.deepEqual(round.dialog, []);
    const later = open();
    later.load();
    const back = later.get(round.id);
    assert.deepEqual(later.publicThread(back), store.publicThread(round));
    assert.equal(back.state.thread.length, 3);
    const result = later.finish(back, mode === 'review' ? { verdict: 'return' } : {});
    assert.equal(result.thread.length, 3);
    assert.deepEqual(result.thread[1].media, { code: { text: 'new()', lang: 'js' } });
    assert.match(result.digest, /The conversation/);
    assert.match(result.digest, /Still unsure.*NOT answered/);
    assert.doesNotMatch(result.digest, /Redo the summary.*NOT answered/);
    assert.deepEqual(JSON.parse(readFileSync(back.answersFile, 'utf8')).thread, result.thread);
  });
  test(`${mode}: a pre-wave log opens with an empty thread`, t => {
    const { store, round, open } = setup(t, mode);
    store.ask(round, { qid: 'q', text: 'Why?' });
    store.explain(round, { qid: 'q', text: 'Because.' });
    const later = open();
    later.load();
    assert.deepEqual(later.publicThread(later.get(round.id)), []);
    assert.deepEqual(later.get(round.id).dialog, round.dialog);
  });
}

test('message queues without an events listener, redelivers until ack, then shows delivered', async t => {
  const { store, round, open } = setup(t);
  const abort = new AbortController();
  const held = store.next(round, { events: false, signal: abort.signal });
  const msg = store.message(round, { text: 'Please change it' });
  assert.equal(store.hearing(round), false);
  assert.equal(store.publicThread(round)[0].status, 'waiting');
  abort.abort();
  assert.equal(await held, null);
  const later = open(); later.load(); const back = later.get(round.id);
  const item = await later.next(back, { events: true });
  assert.equal(item.kind, 'message');
  assert.equal(item.payload.message.id, msg.id);
  assert.equal(item.payload.mode, 'questions');
  assert.deepEqual(await later.next(back, { events: true }), item);
  later.ack(back, item.seq, 'test');
  assert.equal(later.publicThread(back)[0].status, 'delivered');
  later.explain(back, { askId: msg.id, text: 'Changed.' });
  assert.equal(later.publicThread(back)[0].status, 'answered');
});

test('agent can write first with a two-button choice; picks are durable, idempotent messages', async t => {
  const { store, round, open } = setup(t);
  const reply = store.explain(round, { text: 'Try this?', choice: { text: 'Where?', options: ['Here', 'As a card'] } });
  assert.deepEqual(reply.choice.options, ['Here', 'As a card']);
  assert.throws(() => store.pickMessage(round, { id: reply.id, picked: 'Unknown' }), /option/);
  const pick = store.pickMessage(round, { id: reply.id, picked: 'Here' });
  assert.equal(store.pickMessage(round, { id: reply.id, picked: 'Here' }).id, pick.id);
  assert.throws(() => store.pickMessage(round, { id: reply.id, picked: 'As a card' }), /already/);
  const item = await store.next(round, { events: true });
  assert.equal(item.kind, 'message');
  assert.match(item.payload.message.text, /user picked «Here»/);
  assert.equal(item.payload.message.id, pick.id);
  const later = open(); later.load();
  assert.equal(later.publicThread(later.get(round.id))[0].picked, 'Here');
  assert.equal(later.publicThread(later.get(round.id)).length, 2);
});

test('thread replies reject wrong targets and malformed choices before changing the log', t => {
  const { store, round } = setup(t);
  const itemAsk = store.ask(round, { qid: 'q', text: 'Item' });
  for (const body of [{ askId: 'unknown' }, { askId: itemAsk.id }, { choice: { text: 'Q?', options: ['a'] } }, { choice: { text: 'Q?', options: ['a', 'a'] } }]) {
    const seq = round.seq;
    assert.throws(() => store.explain(round, { text: 'Reply', ...body }), { status: 400 });
    assert.equal(round.seq, seq);
  }
});

test('message wait text teaches old agents the protocol and CLI reports the ask exit code', () => {
  const payload = { event: 'message', mode: 'review', round: '1-abcdef', message: { id: 'm1', text: 'Redo it\nand explain' } };
  const text = prepare.formatMessage(payload);
  for (const pattern of [/Redo it/, /askId.*m1/, /no question/i, /at once/i, /proposal/i, /two|choice/i, /next review round/i, /snapshot/i]) assert.match(text, pattern);
  const lines = [];
  assert.equal(reportCli(x => lines.push(x), payload.round)({ kind: 'message', payload }), EXIT_ASK);
  assert.match(lines.join('\n'), /DECIDE message:/);
});

for (const mode of Object.keys(specs)) test(`${mode}: cancelling still returns the conversation to the agent`, t => {
  const { store, round } = setup(t, mode);
  store.message(round, { text: 'Keep this even if I cancel' });
  const result = store.finish(round, { cancelled: true });
  assert.equal(result.thread.length, 1);
  assert.match(result.digest, /The conversation:[\s\S]*Keep this even if I cancel.*NOT answered/);
  assert.match(prepare.formatResult(result, round.answersFile), /Keep this even if I cancel.*NOT answered/);
});
