// index.js — the media kinds the page can draw, in the order they are drawn: a node's pictures first,
// then a diagram, code and links. Each module exports render(node, ctx, env) and returns an element or
// null; env is built by ../media.js (see there). To add a kind, write the module and list it here.

import * as images from "./images.js";
import * as compare from "./compare.js";
import * as video from "./video.js";
import * as preview from "./preview.js";
import * as html from "./html.js";
import * as chart from "./chart.js";
import * as table from "./table.js";
import * as diff from "./diff.js";
import * as mermaid from "./mermaid.js";
import * as code from "./code.js";
import * as links from "./links.js";

export const MEDIA = new Map(Object.entries({ images, compare, video, preview, html, chart, table, diff, mermaid, code, links }));
