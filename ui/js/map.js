// map.js — the decision map: the journal's records as a Mermaid flowchart (an edge for dependsOn, for a
// showIf rule, and for a superseded decision). The server builds the source (/api/map); it is drawn by the
// same frame the diagram media uses. Above 40 nodes the server sends the newest ones, or one round's
// neighbourhood (round=…), and the page says so.

import { h } from "./dom.js";
import { t } from "./i18n.js";
import { getMap } from "./net.js";
import { offline } from "./net.js";
import { openLightbox } from "./overlays.js";
import { render as renderDiagram } from "./media/mermaid.js";

const dark = () => {
  const theme = document.documentElement.dataset.theme;
  return theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};

// Paints the map into `box`. round: the round whose neighbourhood to show when the map is too big.
export async function paintMap(box, { round = "" } = {}) {
  box.replaceChildren(h("p.jr-empty", {}, t("map.loading")));
  let graph;
  try {
    graph = await getMap(round);
  } catch {
    box.replaceChildren(h("p.jr-empty", {}, t("journalPage.failed")));
    return;
  }
  if (!graph.nodes.length) return box.replaceChildren(h("p.jr-empty", {}, t("map.none")));
  const note = graph.trimmed
    ? h("p.map-note", {}, graph.trimmed.round ? t("map.near", graph.trimmed.round, graph.nodes.length, graph.total) : t("map.newest", graph.nodes.length, graph.total))
    : h("p.map-note", {}, t("map.count", graph.nodes.length, graph.edges.length));
  const ctx = { lightbox: (images, start) => openLightbox(images, start) };
  const drawing = renderDiagram({ mermaid: graph.mermaid }, ctx, { t, qid: "map", dark, offline });
  box.replaceChildren(note, graph.edges.length ? null : h("p.map-note", {}, t("map.noEdges")), drawing);
}
