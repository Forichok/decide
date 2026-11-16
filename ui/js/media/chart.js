// chart — a bar or line chart, drawn as SVG by ../chart.js.

import { h } from "../dom.js";
import { chartSvg } from "../chart.js";

export function render(node, ctx, env) {
  const c = node.chart;
  if (!c) return null;
  const small = env.compact;
  const legend = c.series.length > 1 && h("div.ch-legend", {}, c.series.map((s, k) => h("span.ch-key", {}, h(`i.s${k + 1}`), s.name)));
  return env.zoom("chart", h("figure.chart.media-stop", {}, c.title && h("figcaption.ch-title", {}, c.title), legend, h("div.ch-plot", { html: chartSvg(c, small ? "small" : "full") })));
}
