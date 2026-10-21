// diff.js — line diff for the side-by-side diff view. Pure, so the daemon's
// tests import it too. Common head and tail are trimmed first, the middle goes
// through a longest-common-subsequence table; when the middle is too big for
// that, it is shown as one changed block instead of freezing the page.

const LCS_CELLS = 4_000_000;

// Rows for two columns: same | del (left only) | add (right only) | mod (a deleted
// line paired with an added one). Line numbers are 1-based; a missing side is null.
export function lineDiff(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const ops = [];
  for (let i = 0; i < head; i++) ops.push(["same", i, i]);
  ops.push(...middle(a, b, head, a.length - tail, head, b.length - tail));
  for (let k = tail; k > 0; k--) ops.push(["same", a.length - k, b.length - k]);
  return pair(ops, a, b);
}

const splitLines = (s) => (s === "" ? [] : String(s).replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

function middle(a, b, a0, a1, b0, b1) {
  const n = a1 - a0;
  const m = b1 - b0;
  const ops = [];
  if (!n || !m || n * m > LCS_CELLS) {
    for (let i = a0; i < a1; i++) ops.push(["del", i, null]);
    for (let j = b0; j < b1; j++) ops.push(["add", null, j]);
    return ops;
  }
  // len[i][j]: LCS of a[a0+i..] and b[b0+j..], flattened.
  const w = m + 1;
  const len = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i * w + j] = a[a0 + i] === b[b0 + j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[a0 + i] === b[b0 + j]) ops.push(["same", a0 + i++, b0 + j++]);
    else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) ops.push(["del", a0 + i++, null]);
    else ops.push(["add", null, b0 + j++]);
  }
  for (; i < n; i++) ops.push(["del", a0 + i, null]);
  for (; j < m; j++) ops.push(["add", null, b0 + j]);
  return ops;
}

// A run of deletions followed by additions becomes side-by-side "mod" rows.
function pair(ops, a, b) {
  const rows = [];
  const row = (type, i, j) => ({ type, left: i == null ? null : { n: i + 1, text: a[i] }, right: j == null ? null : { n: j + 1, text: b[j] } });
  for (let k = 0; k < ops.length; ) {
    if (ops[k][0] === "same") {
      rows.push(row("same", ops[k][1], ops[k][2]));
      k++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (k < ops.length && ops[k][0] !== "same") {
      if (ops[k][0] === "del") dels.push(ops[k][1]);
      else adds.push(ops[k][2]);
      k++;
    }
    for (const [i, j] of alignRun(dels, adds, a, b)) rows.push(row(i != null && j != null ? "mod" : i != null ? "del" : "add", i, j));
  }
  return rows;
}

// Pairs inside a changed run: each deleted line goes next to the added line it
// most resembles, in order, so one inserted line does not shift every pair
// after it. A run too big to align, or with nothing alike, pairs by position.
const ALIGN_CELLS = 2500;
const ALIKE = 0.4;

function alignRun(dels, adds, a, b) {
  const byPosition = () => Array.from({ length: Math.max(dels.length, adds.length) }, (_, x) => [dels[x] ?? null, adds[x] ?? null]);
  const n = dels.length;
  const m = adds.length;
  if (!n || !m || n * m > ALIGN_CELLS || (n === 1 && m === 1)) return byPosition();
  const w = m + 1;
  const score = new Float64Array((n + 1) * w);
  const sims = new Float64Array(n * m);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sim = similarity(a[dels[i - 1]], b[adds[j - 1]]);
      sims[(i - 1) * m + j - 1] = sim;
      const diag = sim >= ALIKE ? score[(i - 1) * w + j - 1] + sim : -1;
      score[i * w + j] = Math.max(score[(i - 1) * w + j], score[i * w + j - 1], diag);
    }
  }
  if (!score[n * w + m]) return byPosition();
  const pairs = [];
  let i = n;
  let j = m;
  while (i && j) {
    const sim = sims[(i - 1) * m + j - 1];
    if (sim >= ALIKE && score[i * w + j] === score[(i - 1) * w + j - 1] + sim) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (score[i * w + j] === score[(i - 1) * w + j]) i--;
    else j--;
  }
  pairs.reverse();
  const out = [];
  let di = 0;
  let aj = 0;
  for (const [pi, pj] of [...pairs, [n, m]]) {
    while (di < pi) out.push([dels[di++], null]);
    while (aj < pj) out.push([null, adds[aj++]]);
    if (pi < n) out.push([dels[di++], adds[aj++]]);
  }
  return out;
}

// Shared head and tail as a share of the longer line, ignoring indentation.
function similarity(x, y) {
  x = x.trim();
  y = y.trim();
  const len = Math.max(x.length, y.length);
  if (!len) return 1;
  const { left } = inlineSpan(x, y);
  return (left[0].length + left[2].length) / len;
}

// The changed span inside a modified line: [prefix, changed, suffix] of each side.
export function inlineSpan(left, right) {
  let p = 0;
  while (p < left.length && p < right.length && left[p] === right[p]) p++;
  let s = 0;
  while (s < left.length - p && s < right.length - p && left[left.length - 1 - s] === right[right.length - 1 - s]) s++;
  return {
    left: [left.slice(0, p), left.slice(p, left.length - s), left.slice(left.length - s)],
    right: [right.slice(0, p), right.slice(p, right.length - s), right.slice(right.length - s)],
  };
}

export const diffStats = (rows) => ({
  added: rows.filter((r) => r.type === "add" || r.type === "mod").length,
  removed: rows.filter((r) => r.type === "del" || r.type === "mod").length,
});
