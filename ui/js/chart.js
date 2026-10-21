// chart.js — a simple bar or line chart as inline SVG: one y axis from zero
// (or from the lowest value when it is negative), a recessive grid, colors from
// the --chart-N tokens, a legend for two or more series and a <title> on every
// mark for hover. Pure string output, so the tests can render it in node.

const W = 640;
const H = 260;
const PAD = { top: 16, right: 12, bottom: 34, left: 46 };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function chartSvg(chart) {
  const { type, labels, series, unit = "" } = chart;
  const all = series.flatMap((s) => s.values).filter((v) => v !== null);
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  const ticks = niceTicks(lo, hi);
  const y0 = ticks[0];
  const y1 = ticks.at(-1);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const y = (v) => PAD.top + plotH - ((v - y0) / (y1 - y0 || 1)) * plotH;
  const n = labels.length;
  const band = plotW / Math.max(n, 1);
  const fmt = (v) => `${formatNum(v)}${unit}`;
  const out = [];

  for (const t of ticks) {
    out.push(`<line class="ch-grid${t === 0 ? " zero" : ""}" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(t)}" y2="${y(t)}"/>`);
    out.push(`<text class="ch-tick" x="${PAD.left - 8}" y="${y(t) + 4}" text-anchor="end">${esc(fmt(t))}</text>`);
  }
  const every = Math.ceil(n / 12);
  labels.forEach((l, i) => {
    if (i % every) return;
    out.push(`<text class="ch-label" x="${PAD.left + band * (i + 0.5)}" y="${H - PAD.bottom + 18}" text-anchor="middle">${esc(clip(l, Math.max(4, Math.floor(band / 7))))}</text>`);
  });

  if (type === "line") {
    series.forEach((s, k) => {
      const pts = s.values.map((v, i) => (v === null ? null : [PAD.left + band * (i + 0.5), y(v)]));
      const path = pts.reduce((d, p, i) => (p ? `${d}${d && pts[i - 1] ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}` : d), "");
      out.push(`<path class="ch-line s${k + 1}" d="${path}"/>`);
      pts.forEach((p, i) => {
        if (!p) return;
        out.push(`<g class="ch-pt"><circle class="s${k + 1}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4"/><circle class="ch-hit" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="11"/><title>${esc(tip(s, labels[i], s.values[i], fmt))}</title></g>`);
      });
      const last = pts.findLastIndex((p) => p);
      if (series.length > 1 && last >= 0 && series.length <= 4) {
        out.push(`<text class="ch-direct" x="${Math.min(pts[last][0] + 6, W - 2)}" y="${pts[last][1] - 8}" text-anchor="end">${esc(clip(s.name, 14))}</text>`);
      }
    });
  } else {
    const gap = 2;
    const groupW = band * 0.72;
    const barW = Math.max(3, (groupW - gap * (series.length - 1)) / series.length);
    const zero = y(Math.max(y0, Math.min(0, y1)));
    const labelBars = n * series.length <= 12;
    series.forEach((s, k) => {
      s.values.forEach((v, i) => {
        if (v === null) return;
        const x = PAD.left + band * i + (band - groupW) / 2 + k * (barW + gap);
        const top = Math.min(y(v), zero);
        const h = Math.max(1, Math.abs(y(v) - zero));
        const r = Math.min(4, barW / 2, h);
        out.push(`<g class="ch-bar"><path class="s${k + 1}" d="${barPath(x, top, barW, h, r, v < 0)}"/><rect class="ch-hit" x="${x}" y="${PAD.top}" width="${barW}" height="${plotH}"/><title>${esc(tip(s, labels[i], v, fmt))}</title></g>`);
        if (labelBars) out.push(`<text class="ch-val" x="${x + barW / 2}" y="${v < 0 ? top + h + 13 : top - 5}" text-anchor="middle">${esc(fmt(v))}</text>`);
      });
    });
  }
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(chart.title || series.map((s) => s.name).join(", ") || "chart")}">${out.join("")}</svg>`;
}

// The bar's data end is rounded; the end on the baseline stays square.
function barPath(x, top, w, h, r, down) {
  if (down) return `M${x},${top}h${w}v${h - r}q0,${r} ${-r},${r}h${-(w - 2 * r)}q${-r},0 ${-r},${-r}z`;
  return `M${x},${top + h}v${-(h - r)}q0,${-r} ${r},${-r}h${w - 2 * r}q${r},0 ${r},${r}v${h - r}z`;
}

const tip = (s, label, v, fmt) => `${s.name ? `${s.name} · ` : ""}${label}: ${fmt(v)}`;
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

export function niceTicks(lo, hi, count = 4) {
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const start = Math.floor(lo / step) * step;
  const ticks = [];
  for (let v = start; v <= hi + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  if (ticks.at(-1) < hi) ticks.push(Number((ticks.at(-1) + step).toFixed(10)));
  return ticks;
}

function formatNum(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toFixed(1)}k`;
  return String(+v.toFixed(2));
}
