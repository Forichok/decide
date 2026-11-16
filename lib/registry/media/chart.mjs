// chart — a bar or line chart. Charts shown next to each other get one y range.

import { alias, any, arrayOf, number, object, shared, string, union } from "../shared.mjs";
import { LIMITS, bad, list, str, text } from "./util.mjs";

export default {
  name: "chart",
  summary: "A bar or line chart; charts on the options of one question share a scale.",
  field: shared(
    "chart",
    object("{type, labels, series: [{name, values}], unit?, title?}, or {series: [1, 2, 3]} for one unnamed series. null is a gap. Up to 12 bars, 60 points, 4 series.", {
      type: string("bar or line. Default bar."),
      labels: arrayOf(any("A label."), "The x labels. Default 1, 2, 3…", { orOne: true }),
      series: arrayOf(
        shared("seriesEntry", union(
          "A series.",
          number("A value of the one unnamed series."),
          string("A value of the one unnamed series."),
          arrayOf(any("A value."), "The values."),
          object("A named series.", {
            name: string("The legend entry. Needed when there are two or more series."),
            label: alias("name", "The older spelling of name.", string("The legend entry.")),
            values: arrayOf(any("A number, or null for a gap."), "The values, one per label.", { orOne: true }),
            data: alias("values", "The older spelling of values.", arrayOf(any("A number."), "", { orOne: true })),
          }),
        )),
        "The series, or the numbers of one.",
        { orOne: true },
      ),
      unit: string("Shown after the values."),
      title: string("Shown above the chart."),
    }, { brief: "{labels, series}; null is a gap" }),
  ),
  mistakes: { data: '"series"', datasets: '"series"', values: '"series"', xLabels: '"labels"' },
  normalize(out, ctx) {
    const { raw, where } = ctx;
    out.chart = raw.chart == null ? null : normalizeChart(raw.chart, `${where}.chart`, ctx);
  },
  lint() {},
  // Charts shown next to each other (two swipe sides, the options of a question) get one y range,
  // so equal bars mean equal values across them.
  beside(nodes) {
    const all = nodes.map((n) => n.chart).filter(Boolean);
    if (all.length < 2) return;
    const values = all.flatMap((c) => c.series.flatMap((s) => s.values)).filter((v) => v !== null);
    const domain = [Math.min(0, ...values), Math.max(0, ...values)];
    for (const c of all) c.domain = domain;
  },
  example: { chart: { type: "bar", labels: ["Mon", "Tue"], series: [{ name: "Visits", values: [4100, 3900] }], unit: "visits", title: "Visits a day" } },
};

function normalizeChart(raw, where, ctx) {
  if (!raw || typeof raw !== "object") return bad(ctx, where, 'expected {"type": "bar", "labels": [...], "series": [...]}');
  let type = str(raw.type) || "bar";
  if (!["bar", "line"].includes(type)) {
    ctx.add("warn", where, `unknown chart type "${type}" (use bar or line), drawing bars`);
    type = "bar";
  }
  const labels = list(raw.labels).map((l) => text(l).trim());
  let series = list(raw.series);
  if (series.length && series.every((v) => typeof v === "number" || typeof v === "string")) series = [{ name: "", values: series }];
  series = series
    .map((s) => (Array.isArray(s) ? { values: s } : s || {}))
    .map((s, i) => {
      const values = list(s.values ?? s.data).map((v) => (v === null || v === "" ? null : Number(v)));
      if (values.some((v) => v !== null && !Number.isFinite(v))) ctx.add("warn", `${where}.series[${i}]`, "non-numeric values are drawn as gaps");
      if (labels.length && values.length !== labels.length) ctx.add("warn", `${where}.series[${i}]`, `${values.length} values for ${labels.length} labels`);
      return { name: str(s.name) || str(s.label), values: values.map((v) => (Number.isFinite(v) ? v : null)) };
    })
    .filter((s) => s.values.some((v) => v !== null));
  if (!series.length) return bad(ctx, where, "a chart needs at least one series of numbers");
  const n = Math.max(labels.length, ...series.map((s) => s.values.length));
  const fullLabels = Array.from({ length: n }, (_, i) => labels[i] ?? String(i + 1));
  if (type === "bar" && n > LIMITS.chartBars) ctx.add("warn", where, `${n} bars — over ${LIMITS.chartBars} can't be read on a card; group them or use a line`);
  if (type === "line" && n > LIMITS.chartPoints) ctx.add("warn", where, `${n} points — over ${LIMITS.chartPoints}, sample the series`);
  if (series.length > LIMITS.chartSeries) ctx.add("warn", where, `${series.length} series — over ${LIMITS.chartSeries} colors blur together`);
  if (series.length > 1 && series.some((s) => !s.name)) ctx.add("warn", where, "name every series: the legend needs it");
  return { type, labels: fullLabels, series, unit: str(raw.unit), title: str(raw.title) };
}
