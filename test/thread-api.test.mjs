import assert from 'node:assert/strict';
import test from 'node:test';
import { startDecide, spec } from '../e2e/helpers.mjs';
import explain from '../lib/commands/explain.mjs';
import wait from '../lib/commands/wait.mjs';
import { EXIT_ASK } from '../lib/commands/shared.mjs';

async function setup(t) {
  const s = await startDecide({ name: 'thread-node' });
  t.after(() => s.stop());
  const id = await s.open(spec());
  const lines = [];
  const ctx = { cli: false, hasProject: true, project: { top: s.project }, server: async () => ({ port: s.port, token: s.token }), say: x => lines.push(x), warn: x => lines.push(x) };
  return { s, id, ctx, lines };
}

test('HTTP saves messages on a non-live round; explain and wait tools support the thread with every media kind', async t => {
  const { s, id, ctx } = await setup(t);
  const msg = await s.must('POST', `/api/rounds/${id}/message`, { text: 'Please redo it', id: 'retry-message-id' });
  assert.equal((await s.must('POST', `/api/rounds/${id}/message`, { text: 'Please redo it', id: 'retry-message-id' })).id, msg.id);
  assert.equal((await s.round(id)).thread[0].status, 'waiting');
  const got = await wait.run({ round: id, timeoutSec: 5 }, ctx);
  assert.match(got.text, /Please redo it/);
  await got.delivered();
  assert.equal((await s.round(id)).thread[0].status, 'delivered');
  const media = {
    images: ['https://example.com/a.png'], mermaid: 'graph TD; A-->B', code: 'const x = 1;',
    diff: { before: 'a', after: 'b' }, compare: { before: 'https://example.com/a.png', after: 'https://example.com/b.png' },
    table: { columns: ['A'], rows: [['B']] }, chart: { type: 'bar', labels: ['A'], series: [{ name: 'N', values: [1] }] },
    html: '<p>Preview</p>', video: 'https://example.com/a.mp4', links: [{ url: 'https://example.com', label: 'Source' }],
  };
  const reply = await explain.run({ round: id, askId: msg.id, text: '**Changed.**', choice: { text: 'Where next?', options: ['Here', 'Card'] }, ...media }, ctx);
  assert.match(reply.text, /round dialog/);
  const view = await s.round(id);
  assert.equal(view.thread[0].status, 'answered');
  assert.deepEqual(view.dialog, []);
  for (const kind of Object.keys(media)) assert.ok(view.thread[1].media[kind], kind);
  const pick = await s.must('POST', `/api/rounds/${id}/message-pick`, { id: view.thread[1].id, picked: 'Card' });
  assert.equal((await s.next(id)).payload.message.id, pick.id);
  await s.must('POST', `/api/rounds/${id}/submit`, { answers: {} });
  assert.equal((await s.round(id)).result.thread.length, 3);
});

test('CLI live wait prints DECIDE message and exits like a per-item ask', async t => {
  const { s, id, ctx, lines } = await setup(t);
  await s.must('POST', `/api/rounds/${id}/message`, { text: 'New options' });
  const result = await wait.run({ round: id, live: true, timeoutSec: 5 }, { ...ctx, cli: true });
  assert.equal(result.exit, EXIT_ASK);
  assert.match(lines.join('\n'), /DECIDE message:/);
  assert.equal((await s.round(id)).thread[0].status, 'delivered');
});

test('CLI without live keeps the message queued and includes it in the final result', async t => {
  const { s, id, ctx, lines } = await setup(t);
  await s.must('POST', `/api/rounds/${id}/message`, { text: 'Keep this request' });
  const waiting = wait.run({ round: id, timeoutSec: 5 }, { ...ctx, cli: true });
  await new Promise(resolve => setTimeout(resolve, 100));
  const thread = await s.must('GET', `/api/rounds/${id}/thread`);
  assert.equal(thread.listening, false);
  assert.equal(thread.thread[0].status, 'waiting');
  await s.must('POST', `/api/rounds/${id}/submit`, { answers: {} });
  assert.equal((await waiting).exit, 0);
  assert.match(lines.join('\n'), /The conversation:[\s\S]*Keep this request.*NOT answered/);
});

test('a review accepts messages and choices; thread actions keep its saved snapshot unchanged', async t => {
  const { s, ctx } = await setup(t);
  const { createStore } = await import('../lib/store/rounds.mjs');
  const { createRoots } = await import('../lib/assets.mjs');
  const { openProject } = await import('../lib/project.mjs');
  const { normalizeReview } = await import('../lib/review/spec.mjs');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const home = join(s.dir, 'dh');
  const store = createStore({ home, roots: createRoots() });
  const { spec } = normalizeReview({ title: 'R', summary: 'One change.', chapters: [{ id: 'c', title: 'C', summary: 'Edit.', hunks: ['a.js'] }] });
  const patch = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n';
  const round = store.create({ project: openProject(s.project, home), mode: 'review', spec, snapshot: { meta: { format: 1, base: 'a'.repeat(40), head: 'b'.repeat(40) }, patch } });
  const id = round.id;
  store.close();
  const before = await s.must('GET', `/api/rounds/${id}/pieces?group=ch:c`);
  const msg = await s.must('POST', `/api/rounds/${id}/message`, { text: 'Change the working tree' });
  const got = await wait.run({ round: id, timeoutSec: 5 }, ctx);
  assert.match(got.text, /next review round/); await got.delivered();
  await explain.run({ round: id, askId: msg.id, text: 'Changed in the working tree for the next review round.', choice: { text: 'Continue?', options: ['Yes', 'No'] } }, ctx);
  const reply = (await s.round(id)).thread[1];
  await s.must('POST', `/api/rounds/${id}/message-pick`, { id: reply.id, picked: 'Yes' });
  assert.deepEqual(await s.must('GET', `/api/rounds/${id}/pieces?group=ch:c`), before);
  assert.equal(readFileSync(join(round.dir, 'review', 'diff.patch'), 'utf8'), patch);
  const guarded = await s.call('POST', `/api/rounds/${id}/words`, { qid: 'c', text: 'x' });
  assert.equal(guarded.status, 409);
  await s.must('POST', `/api/rounds/${id}/submit`, { verdict: 'return' });
  assert.equal((await s.round(id)).result.thread.length, 3);
});

test('a refused thread reply cannot apply its accompanying patch', async t => {
  const { s, id } = await setup(t);
  for (const extra of [
    { choice: { text: 'Q?', options: ['One'] } },
    { askId: 'not-a-thread-message' },
    { question: 'db', choice: { text: 'Q?', options: ['One', 'Two'] } },
  ]) {
    const before = await s.round(id);
    const out = await s.call('POST', `/api/rounds/${id}/explain`, { text: 'Reply', ...extra, patch: { reason: 'Rewrite title', ops: [{ set: { id: 'db', title: 'Changed by a refused reply' } }] } });
    assert.equal(out.status, 400);
    assert.equal((await s.round(id)).seq, before.seq);
  }
});
