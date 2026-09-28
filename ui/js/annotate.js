// annotate.js — draw on a picture inside the lightbox (marker, frame, arrow),
// then attach the marked-up PNG to the question. Works on same-origin images.

import { h, icon } from "./dom.js";
import { t } from "./i18n.js";

const COLOR = "#ff2d55";
const TOOLS = [
  ["pen", "pen", t("anno.pen")],
  ["rect", "square", t("anno.rect")],
  ["arrow", "pointer", t("anno.arrow")],
];

// Renders into root; onDone(file) gets the PNG, onExit() restores the viewer.
export function startAnnotate(root, image, { onDone, onExit, toast }) {
  const shapes = [];
  let tool = "pen";
  let current = null;
  const img = h("img.anno-img", { src: image.src, alt: image.caption || "", draggable: "false" });
  const canvas = h("canvas.anno-canvas", { "aria-label": t("anno.canvas") });
  const ctx2d = canvas.getContext("2d");
  const toolBtns = TOOLS.map(([id, ic, label]) =>
    h("button.anno-tool", { type: "button", dataset: { tool: id }, "aria-pressed": String(id === tool), html: `${icon(ic)}${label}`, onclick: () => pick(id) }),
  );
  const attach = h("button.btn.primary.sm", { type: "button", html: `${t("anno.attach")}${icon("arrow")}`, onclick: save });

  function pick(id) {
    tool = id;
    for (const b of toolBtns) b.setAttribute("aria-pressed", String(b.dataset.tool === id));
  }
  const width = () => Math.max(3, Math.round(canvas.width / 260));
  function draw(s) {
    ctx2d.strokeStyle = COLOR;
    ctx2d.lineWidth = width();
    ctx2d.lineCap = "round";
    ctx2d.lineJoin = "round";
    ctx2d.beginPath();
    const [a, b] = [s.points[0], s.points.at(-1)];
    if (s.tool === "pen") s.points.forEach((p, i) => (i ? ctx2d.lineTo(p.x, p.y) : ctx2d.moveTo(p.x, p.y)));
    else if (s.tool === "rect") ctx2d.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    else {
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const head = width() * 5;
      ctx2d.moveTo(a.x, a.y);
      ctx2d.lineTo(b.x, b.y);
      for (const d of [-0.45, 0.45]) {
        ctx2d.moveTo(b.x, b.y);
        ctx2d.lineTo(b.x - head * Math.cos(ang + d), b.y - head * Math.sin(ang + d));
      }
    }
    ctx2d.stroke();
  }
  function redraw() {
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    [...shapes, current].filter(Boolean).forEach(draw);
    attach.disabled = !shapes.length;
  }
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    current = { tool, points: [at(e)] };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!current) return;
    if (current.tool === "pen") current.points.push(at(e));
    else current.points[1] = at(e);
    redraw();
  });
  canvas.addEventListener("pointerup", () => {
    if (current?.points.length > 1) shapes.push(current);
    current = null;
    redraw();
  });
  const undo = () => (shapes.pop(), redraw());
  const clear = () => ((shapes.length = 0), redraw());

  function save() {
    const out = h("canvas", { width: canvas.width, height: canvas.height });
    const c = out.getContext("2d");
    c.drawImage(img, 0, 0, out.width, out.height);
    c.drawImage(canvas, 0, 0);
    try {
      out.toBlob((blob) => {
        if (!blob) return toast(t("anno.saveFailed"));
        const base = (image.caption || t("anno.image")).replace(/[^\p{L}\p{N} _-]+/gu, "").slice(0, 40) || t("anno.image");
        onDone(new File([blob], t("anno.file", base), { type: "image/png" }));
        exit();
      }, "image/png");
    } catch {
      toast(t("anno.foreign"));
    }
  }

  const onKey = (e) => {
    if (e.key === "Escape") exit();
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") undo();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  function exit() {
    document.removeEventListener("keydown", onKey, true);
    onExit();
  }
  document.addEventListener("keydown", onKey, true);

  root.replaceChildren(
    h(
      "div.lb-top.anno-bar",
      {},
      h("div.anno-tools", { role: "toolbar", "aria-label": t("anno.tools") }, toolBtns),
      h("button.icon-btn", { type: "button", title: t("anno.undoTitle"), "aria-label": t("anno.undo"), html: icon("undo"), onclick: undo }),
      h("button.icon-btn", { type: "button", title: t("anno.clear"), "aria-label": t("anno.clear"), html: icon("trash"), onclick: clear }),
      h("span.spacer"),
      h("button.btn.ghost.sm.anno-cancel", { type: "button", onclick: exit }, t("common.cancel")),
      attach,
    ),
    h("div.lb-stage.anno-stage", {}, h("div.anno-wrap", {}, img, canvas), h("div.lb-cap", {}, t("anno.hint"))),
  );
  const ready = () => {
    canvas.width = img.naturalWidth || 1200;
    canvas.height = img.naturalHeight || 800;
    redraw();
  };
  if (img.complete && img.naturalWidth) ready();
  else img.addEventListener("load", ready, { once: true });
}
