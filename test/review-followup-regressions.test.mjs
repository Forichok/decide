import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeReview } from '../lib/review/spec.mjs';
import { reviewResult } from '../lib/review/digest.mjs';
import { replay, reviewView } from '../lib/store/state.mjs';
import { previousItems, reconcile, itemLabel } from '../lib/review/resolved.mjs';
import { buildReview, takeSnapshot } from '../lib/review/snapshot.mjs';
import { createStore } from '../lib/store/rounds.mjs';
import { createRoots } from '../lib/assets.mjs';
import { openProject } from '../lib/project.mjs';
const raw = () => ({ chapters: [{ id: 'code', title: 'Code', hunks: ['a.js'], focus: ['Ship it?', 'Delete it?'].map(question => ({ at: 'a.js:1', kind: 'decision', question })) }] });
const resultInput = spec => ({ base: {}, spec, meta: {}, placed: { where: {}, sorted: 0, total: 0 }, review: { comments: [], read: {}, decisions: { code: { 'a.js:1': 'yes' } } }, dialog: [] });
const patch = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n';
test('duplicate decisions are refused and saved ambiguous answers cannot claim consent', t => {
  const { spec, issues } = normalizeReview(raw());
  assert.ok(issues.some(i => i.level === 'error' && /duplicate decision/.test(i.message)));
  const state = replay({ id: 'r', mode: 'review' }, spec, [{ type: 'decision', seq: 1, chapter: 'code', place: 'a.js:1', answer: 'yes' }]);
  assert.deepEqual(reviewView(state).decisions, {});
  assert.deepEqual(reviewResult(resultInput(spec)).decisions.map(d => d.answer), [null, null]);
  const dir = mkdtempSync(join(tmpdir(), 'decide-ambiguous-'));
  const store = createStore({ home: join(dir, 'home'), roots: createRoots() });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const round = store.create({ project: openProject(dir, join(dir, 'home')), mode: 'review', spec, snapshot: { meta: { format: 1, base: 'a'.repeat(40), head: 'b'.repeat(40) }, patch } });
  assert.throws(() => store.answerDecision(round, { chapter: 'code', at: 'a.js:1', answer: 'yes' }), /ambiguous|unknown decision/);
});
test('deleting the offending file supplies a fixed anchor on its old side', () => {
  const deleted = 'diff --git a/a.js b/a.js\ndeleted file mode 100644\n--- a/a.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-old\n-bad\n';
  const { spec } = normalizeReview({ chapters: [{ id: 'code', title: 'Code', hunks: ['a.js'] }] });
  const built = buildReview(spec, deleted);
  for (const at of ['a.js', 'a.js:2']) {
    const out = reconcile([{ ref: 'c1', how: 'fixed', at, note: 'Removed the file.' }], [{ ref: 'c1', kind: 'fix', required: true, original: { file: 'a.js', line: 2, text: 'Remove unsafe code.' } }], built);
    assert.deepEqual(out.issues, []);
    assert.deepEqual(out.resolved[0].anchor, { hunk: 'h1', line: at === 'a.js' ? 1 : 2, side: 'old' });
  }
});
test('follow-up comments retain the diff side', () => {
  const item = previousItems({ comments: [{ id: 'c1', kind: 'fix', text: 'Remove it.', file: 'a.js', line: 2, side: 'old' }] })[0];
  assert.equal(item.original.side, 'old');
  assert.match(itemLabel(item), /a.js:2 \(old\)/);
});
test('reviewer findings retain rationale and the quoted source line in the verdict', () => {
  const { spec } = normalizeReview({ chapters: [{ id: 'code', title: 'Code', hunks: ['a.js'] }], reviewers: { findings: [{ id: 'f1', role: 'correctness', severity: 'major', at: 'a.js:1', text: 'Bad branch.', why: 'Fails on empty input.', line: 'new' }] } });
  const finding = reviewResult(resultInput(spec)).reviewers.findings[0];
  assert.equal(finding.why, 'Fails on empty input.');
  assert.equal(finding.line, 'new');
});
test('verified prior head allows follow-up without a default branch', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'decide-prior-base-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const out = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.org', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr); return out.stdout.trim();
  };
  git('init', '-qb', 'feature');
  const commit = value => { writeFileSync(join(dir, 'a.js'), value); git('add', '.'); git('commit', '-qm', value); return git('rev-parse', 'HEAD'); };
  const base = commit('base'); const priorHead = commit('first'); commit('fixed');
  const prior = { id: '1-abcdef', head: priorHead, base, baseRef: 'removed-base', number: 1, result: { verdict: 'return' } };
  const snapshot = await takeSnapshot({ top: dir, previous: prior.id, lookupPrevious: () => prior });
  assert.equal(snapshot.meta.base, priorHead);
  assert.equal(snapshot.meta.wholeStats.files, 1);
});
