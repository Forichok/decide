import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeReview } from '../lib/review/spec.mjs';
import { buildReview, reviewIndex } from '../lib/review/snapshot.mjs';
import { reviewResult } from '../lib/review/digest.mjs';
import { replay, reviewView } from '../lib/store/state.mjs';

const patch = `diff --git a/a.mjs b/a.mjs
--- a/a.mjs
+++ b/a.mjs
@@ -10,3 +10,3 @@
 a
-b
+B
 c
diff --git a/b.mjs b/b.mjs
--- a/b.mjs
+++ b/b.mjs
@@ -20,2 +20,2 @@
-d
-e
+D
+E
`;
const raw = { summary: 'Two edits.', checks: [{ command: 'node --test', exit: 0 }], chapters: [{ id: 'a', title: 'A', summary: 'Edit A.', hunks: ['a.mjs'] }] };
const specOf = (extra = {}) => normalizeReview({ ...raw, ...extra }).spec;
const errors = (built) => built.issues.filter(i => i.level === 'error').map(i => i.message).join('\n');

test('lost focus is an error naming its owner or the chapter ranges; clipping only warns', () => {
  for (const [at, expected] of [['b.mjs:20', /The rest.*move the place or the hunk/i], ['a.mjs:50', /10-12/]]) {
    const built = buildReview(specOf({ chapters: [{ ...raw.chapters[0], focus: [{ at, note: 'Check.' }] }] }), patch);
    assert.match(errors(built), expected);
  }
  const clipped = buildReview(specOf({ chapters: [{ ...raw.chapters[0], focus: [{ at: 'a.mjs:8-9999', note: 'Check.' }] }] }), patch);
  assert.equal(errors(clipped), '');
  assert.match(clipped.issues.map(i => i.message).join('\n'), /shown.*10-12/);
  assert.match(normalizeReview({ ...raw, chapters: [{ ...raw.chapters[0], focus: [{ at: 'a.mjs:40-25' }] }] }).issues.map(i => i.message).join('\n'), /the end is before the start/);
});

test('mechanical over one third needs mechanicalWhy and keeps a warning with it', () => {
  const extra = { mechanical: [{ title: 'Generated', hunks: ['b.mjs'] }] };
  assert.match(errors(buildReview(specOf(extra), patch)), /mechanical groups hold 4 of 6 changed lines \(67%\).*mechanicalWhy/);
  const built = buildReview(specOf({ ...extra, mechanicalWhy: 'The generator changed its output.' }), patch);
  assert.equal(errors(built), '');
  assert.match(built.issues.filter(i => i.level === 'warn').map(i => i.message).join('\n'), /mechanical groups hold 4 of 6/);
  assert.equal(built.mechanicalShare.percent, 67);
});

test('coverage grows through part and opened, replays, and reaches the result and digest', () => {
  const spec = specOf();
  const meta = { id: 'r', mode: 'review' };
  assert.deepEqual(reviewView(replay(meta, spec, [])).coverage, {});
  const ev = (seq, pieces) => ({ seq, type: 'coverage', at: '2026-11-17T12:00:00Z', pieces });
  const events = [ev(1, { h1: 'part' }), ev(2, { h1: 'opened', h2: 'part' }), ev(3, { h1: 'part' })];
  const view = reviewView(replay(meta, spec, events));
  assert.deepEqual(view.coverage, { h1: 'opened', h2: 'part' });
  const built = buildReview(spec, patch);
  const index = reviewIndex(spec, {}, built);
  assert.deepEqual(index.files.map(f => [f.file, f.ids]), [['a.mjs', ['h1']], ['b.mjs', ['h2']]]);
  const result = reviewResult({ base: {}, spec, meta: {}, placed: built.placed, pieces: built.pieces, review: view, dialog: [], payload: { verdict: 'approve' } });
  assert.deepEqual(result.coverage, { total: 2, opened: 1, part: 1, unopened: 0, files: [{ file: 'b.mjs', pieces: 1, opened: 0, part: 1 }] });
  assert.match(result.digest, /Opened 1 of 2 pieces; in part 1; not opened 0 \(b.mjs\)\./);
  assert.match(result.digest, /Chapters viewed: 0 of 1/);
});

test('one chapter for the branch and every focus kind risk remain lint: ok', () => {
  // Owner decision, 2026-11-17: neither chapter concentration nor all-risk places merits a warning.
  const input = { ...raw, acceptance: { changed: 'Nothing changes from outside.' }, chapters: [{ ...raw.chapters[0], hunks: ['*.mjs'], focus: [{ at: 'a.mjs:11', note: 'Check A.', kind: 'risk', checkedBy: 'npm test' }, { at: 'b.mjs:20', note: 'Check B.', kind: 'risk', checkedBy: 'npm test' }] }] };
  const normalized = normalizeReview(input);
  assert.deepEqual(normalized.issues, [{ level: "warn", where: "focus", message: 'key places have no `text`: after another commit they can point at other lines unnoticed; `outline` prints the text' }]);
  assert.deepEqual(buildReview(normalized.spec, patch).issues, []);
});


test('Russian review coverage uses pieces with the right plural forms', async () => {
  const { default: ru } = await import('../ui/js/lang/ru.js');
  for (const [key, value] of Object.entries(ru).filter(([key]) => key.startsWith('cr.'))) {
    assert.doesNotMatch(String(value), /фрагмент/i, key);
  }
  for (const [n, word] of [[1, 'куска'], [2, 'кусков'], [5, 'кусков'], [11, 'кусков'], [21, 'куска'], [22, 'кусков']]) {
    assert.equal(ru['cr.coverage'](0, n, 0, n), `Показано 0 из ${n} ${word} · частично 0 · не показано ${n}`);
    assert.equal(ru['cr.coverage.short'](0, n, 0), `Показано кусков: 0 из ${n}`);
    assert.equal(ru['cr.coverage.short'](0, n, 1), `Показано кусков: 0 из ${n}, частично 1`);
  }
});
