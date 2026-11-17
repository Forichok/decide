// Offsets are UTF-16 for token slicing; comparisons use whole grapheme clusters.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const units = (text) => [...segmenter.segment(text)].map(x => x.segment);
export function changedSpans(oldText, newText) {
  if (oldText === newText || oldText.length > 2000 || newText.length > 2000) return null;
  const a = units(oldText), b = units(newText);
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  while (suffix < Math.min(a.length, b.length) - prefix && a.at(-1 - suffix) === b.at(-1 - suffix)) suffix++;
  const whitespace = oldText.replace(/\s/g, '') === newText.replace(/\s/g, '');
  if (!whitespace && (a.length - prefix - suffix) > a.length * .7 && (b.length - prefix - suffix) > b.length * .7) return null;
  if (whitespace) {
    // Compare whitespace at the same position among non-whitespace code points.
    const gaps = (text) => {
      const out = new Map();
      let at = 0, position = 0;
      for (const char of text) {
        if (/\s/u.test(char)) {
          const gap = out.get(position) ?? { from: at, to: at, text: '' };
          gap.to += char.length; gap.text += char; out.set(position, gap);
        } else position++;
        at += char.length;
      }
      return out;
    };
    const oldGaps = gaps(oldText), newGaps = gaps(newText);
    return [oldGaps, newGaps].map((map, i) => ({ whitespace: true, ranges: [...map].filter(([position, gap]) => gap.text !== [newGaps, oldGaps][i].get(position)?.text).map(([, gap]) => ({ from: gap.from, to: gap.to })) }));
  }
  return [a, b].map(list => ({ from: list.slice(0, prefix).join('').length, to: list.slice(0, list.length - suffix).join('').length, whitespace }));
}
export function intraline(lines) {
  const marks = new Map();
  for (let i = 0; i < lines.length;) {
    if (lines[i].t !== 'del') { i++; continue; }
    const start = i;
    while (lines[i]?.t === 'del') i++;
    const added = i;
    while (lines[i]?.t === 'add') i++;
    const count = added - start;
    if (count > 40 || i - added !== count) continue;
    for (let k = 0; k < count; k++) {
      const pair = changedSpans(lines[start + k].text, lines[added + k].text);
      if (pair) { marks.set(start + k, pair[0]); marks.set(added + k, pair[1]); }
    }
  }
  return marks;
}
export function splitTokens(tokens, mark) {
  let at = 0;
  const ranges = mark?.ranges ?? (mark ? [mark] : []);
  return tokens.flatMap(([cls, text]) => {
    const start = at; at += text.length;
    const cuts = [...new Set([start, at, ...ranges.flatMap(x => [x.from, x.to]).filter(n => n > start && n < at)])].sort((a,b) => a-b);
    return cuts.slice(0, -1).map((from, i) => [cls, text.slice(from - start, cuts[i + 1] - start), ranges.some(x => from >= x.from && from < x.to)]);
  });
}
