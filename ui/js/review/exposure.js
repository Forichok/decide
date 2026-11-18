// Exact changed-line exposure belongs to the immutable round, across hosts and reloads.
const PREFIX = 'decide:review:exposure:v1:';
const MAX_PIECES = 128;
const MAX_BYTES = 512 * 1024;
const MAX_RANGES = 4096;
const empty = () => ({ old: [], new: [] });
const count = (ranges) => ranges.reduce((n, [a, b]) => n + b - a + 1, 0);
const valid = (value) => value && ['old', 'new'].every(side => Array.isArray(value[side]) && value[side].length <= MAX_RANGES && value[side].every(([a, b], i, ranges) =>
  Number.isSafeInteger(a) && a > 0 && Number.isSafeInteger(b) && b >= a && (!i || ranges[i - 1][1] < a - 1)));

function add(ranges, line) {
  let i = ranges.findIndex(([, b]) => b >= line - 1);
  if (i < 0) i = ranges.length;
  const range = ranges[i];
  if (range && range[0] <= line && range[1] >= line) return false;
  if (range && range[0] <= line + 1) {
    range[0] = Math.min(range[0], line);
    range[1] = Math.max(range[1], line);
  } else ranges.splice(i, 0, [line, line]);
  if (ranges[i + 1]?.[0] === ranges[i][1] + 1) ranges.splice(i, 2, [ranges[i][0], ranges[i + 1][1]]);
  // Eviction loses credit rather than inventing exposure when a cache limit is reached.
  if (ranges.length > MAX_RANGES) ranges.shift();
  return true;
}

export function createExposure(round, storage) {
  const pieces = new Map();
  if (storage === undefined) { try { storage = sessionStorage; } catch {} }
  const keyOf = owner => `${PREFIX}${round}:${owner}`;
  function save(key, value) {
    try {
      const text = JSON.stringify(value);
      storage.removeItem(key);
      const keys = Array.from({length: storage.length}, (_, i) => storage.key(i)).filter(k => k?.startsWith(PREFIX));
      let bytes = keys.reduce((n, k) => n + (storage.getItem(k)?.length ?? 0) * 2, text.length * 2);
      while (keys.length >= MAX_PIECES || bytes > MAX_BYTES) {
        const oldest = keys.shift();
        if (!oldest) return;
        bytes -= (storage.getItem(oldest)?.length ?? 0) * 2;
        storage.removeItem(oldest);
      }
      storage.setItem(key, text);
    } catch {}
  }
  return {
    observe(owner, keys, total) {
      let value = pieces.get(owner);
      const key = keyOf(owner);
      if (!value) {
        try {
          const saved = JSON.parse(storage.getItem(key));
          if (valid(saved)) value = saved;
        } catch {}
        value ??= empty();
        if (pieces.size >= MAX_PIECES) pieces.delete(pieces.keys().next().value);
        pieces.set(owner, value);
      }
      let changed = false;
      for (const key of keys) {
        const match = /^(old|new):([1-9]\d*)$/.exec(key);
        if (match && Number.isSafeInteger(Number(match[2]))) changed = add(value[match[1]], Number(match[2])) || changed;
      }
      if (changed) save(key, value);
      const seen = count(value.old) + count(value.new);
      return seen === total ? 'opened' : seen ? 'part' : null;
    },
  };
}
