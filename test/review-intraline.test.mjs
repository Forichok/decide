import test from 'node:test';
import assert from 'node:assert/strict';
import { changedSpans, intraline, splitTokens } from '../ui/js/review/intraline.js';

test('prefix and suffix leave only the changed word', () => {
  assert.deepEqual(changedSpans('const cat = 1;', 'const dog = 1;'), [{ from: 6, to: 9, whitespace: false }, { from: 6, to: 9, whitespace: false }]);
});
test('unicode boundaries keep emoji and combining sequences whole', () => {
  assert.deepEqual(changedSpans('hello 😀 é!', 'hello 😁 è!').map(x => [x.from, x.to]), [[6, 11], [6, 11]]);
  assert.deepEqual(changedSpans('hello é!', 'hello è!').map(x => [x.from, x.to]), [[6, 8], [6, 8]]);
});
test('rewrites and long lines are skipped, including the strict 70 percent boundary', () => {
  assert.equal(changedSpans('abc', 'xyz'), null);
  assert.ok(changedSpans('abc1234567', 'abc7654321'));
  assert.equal(changedSpans('a123456789', 'a987654321'), null);
  assert.equal(changedSpans('x'.repeat(2001), 'x'.repeat(2000) + 'y'), null);
});
test('whitespace differences remain marks on original whitespace', () => {
  const marks = changedSpans('a b c', 'ab  c');
  assert.ok(marks.every(x => x.whitespace));
  for (const [i, text] of ['a b c', 'ab  c'].entries()) {
    const highlighted = splitTokens([['', text]], marks[i]).filter(x => x[2]).map(x => x[1]).join('');
    assert.match(highlighted, /^\s*$/);
  }
  assert.equal(changedSpans('same', 'same'), null);
});
test('only balanced consecutive runs of at most forty pairs are marked', () => {
  const l = (t, text) => ({t, text});
  assert.equal(intraline([l('del', 'hello cat'), l('add', 'hello dog')]).size, 2);
  assert.equal(intraline([l('del', 'hello cat'), l('add', 'hello dog'), l('add', 'hello pig')]).size, 0);
  assert.equal(intraline([...Array(41).fill(l('del', 'hello cat')), ...Array(41).fill(l('add', 'hello dog'))]).size, 0);
});
test('token splitting preserves syntax and exact text', () => {
  const result = splitTokens([['k', 'const'], ['', ' cat']], {from: 3, to: 7, whitespace: false});
  assert.deepEqual(result, [['k', 'con', false], ['k', 'st', true], ['', ' c', true], ['', 'at', false]]);
  assert.equal(result.map(x => x[1]).join(''), 'const cat');
});
