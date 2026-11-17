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

// Paints the map into `box`. round: the round whose neighbourhood to show when the map is too big; project: one
// project's decisions (omitted: all). When the map is trimmed the page offers a round picker and a way back.
export async function paintMap(box, { round = "", project = "" } = {}) {
  box.replaceChildren(h("p.jr-empty", {}, t("map.loading")));
  let graph;
  try {
    graph = await getMap(round, project);
  } catch {
    box.replaceChildren(h("p.jr-empty", {}, t("journalPage.failed")));
    return;
  }
  if (!graph.nodes.length) return box.replaceChildren(h("p.jr-empty", {}, t("map.none")));
  const go = (r) => paintMap(box, { round: r, project });
  const note = graph.trimmed
    ? h("p.map-note", {}, graph.trimmed.round ? t("map.near", graph.trimmed.round, graph.nodes.length, graph.total) : t("map.newest", graph.nodes.length, graph.total))
    : h("p.map-note", {}, t("map.count", graph.nodes.length, graph.edges.length));
  const ctx = { lightbox: (images, start) => openLightbox(images, start) };
  const drawing = renderDiagram({ mermaid: graph.mermaid }, ctx, { t, qid: "map", dark, offline });
  const bits = [note];
  if (graph.trimmed) {
    if (graph.trimmed.round) bits.push(h("button.chip.map-back", { type: "button", onclick: () => go("") }, t("map.back")));
    bits.push(picker(graph.rounds || [], go, graph.trimmed.round));
  }
  if (!graph.edges.length) bits.push(h("p.map-note", {}, t("map.noEdges")));
  bits.push(drawing);
  if (graph.trimmed) bits.push(centres(graph.nodes, go));
  box.replaceChildren(...bits);
}

// Search by title, newest first; picking a round draws its neighbourhood.
function picker(rounds, go, current) {
  const input = h("input.jr-search.map-find", { type: "search", placeholder: t("map.pick"), "aria-label": t("map.pickLabel") });
  const list = h("ul.map-rounds");
  const fill = () => {
    const q = input.value.trim().toLowerCase();
    const hits = rounds.filter((r) => !q || String(r.title).toLowerCase().includes(q) || r.round.toLowerCase().includes(q)).slice(0, 8);
    list.replaceChildren(...(hits.length
      ? hits.map((r) => h("li", {}, h("button.map-round", { type: "button", "aria-current": String(r.round === current), "data-round": r.round, onclick: () => go(r.round) }, r.title || r.round)))
      : [h("li.jr-empty", {}, t("map.pickNone"))]));
  };
  input.addEventListener("input", fill);
  fill();
  return h("div.map-picker", {}, input, list);
}

// The drawing is a sandboxed frame, so a node cannot be clicked: its round can be, in a list under it.
function centres(nodes, go) {
  const seen = new Set();
  const rows = [];
  for (const n of [...nodes].reverse()) {
    if (seen.has(n.round)) continue;
    seen.add(n.round);
    rows.push(h("li", {}, h("button.map-round", { type: "button", title: t("map.centre"), "data-round": n.round, onclick: () => go(n.round) }, n.title || n.round)));
  }
  return h("details.map-centres", {}, h("summary", {}, t("map.centre")), h("ul.map-rounds", {}, ...rows));
}
