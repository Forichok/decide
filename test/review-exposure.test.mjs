import assert from 'node:assert/strict';
import test from 'node:test';
import { createExposure } from '../ui/js/review/exposure.js';

function memoryStorage() {
  const values = new Map();
  return { get length() { return values.size; }, key: i => [...values.keys()][i], getItem: k => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
}

test('exact exposure survives reload, separates sides and isolates immutable rounds and pieces', () => {
  const storage = memoryStorage();
  const first = createExposure('round', storage);
  assert.equal(first.observe('h1', ['new:1', 'new:2'], 4), 'part');
  assert.equal(first.observe('h1', ['new:2', 'old:1'], 4), 'part');
  const resumed = createExposure('round', storage);
  assert.equal(resumed.observe('h1', ['new:3'], 4), 'opened');
  assert.equal(resumed.observe('h2', ['new:3'], 4), 'part');
  assert.equal(createExposure('other-round', storage).observe('h1', [], 4), null);
  assert.equal(JSON.parse(storage.getItem(storage.key(0))).new.length, 1);
});

test('blocked or corrupt browser storage keeps exposure usable in memory', () => {
  const blocked = { getItem() { throw Error('blocked'); }, removeItem() { throw Error('blocked'); } };
  const exposure = createExposure('round', blocked);
  assert.equal(exposure.observe('h1', ['new:1'], 2), 'part');
  assert.equal(exposure.observe('h1', ['new:2'], 2), 'opened');
  const storage = memoryStorage();
  storage.setItem('decide:review:exposure:v1:round:h1', '{bad');
  assert.equal(createExposure('round', storage).observe('h1', ['new:1'], 2), 'part');
});

test('browser cache retains at most 128 pieces and stores long contiguous exposure as intervals', () => {
  const storage = memoryStorage();
  const exposure = createExposure('round', storage);
  assert.equal(exposure.observe('large', Array.from({length: 10000}, (_, i) => `new:${i + 1}`), 10000), 'opened');
  assert.ok(storage.getItem(storage.key(0)).length < 50);
  for (let i = 0; i < 140; i++) exposure.observe(`h${i}`, ['new:1'], 2);
  assert.equal(storage.length, 128);
});
