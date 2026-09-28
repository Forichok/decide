// extras.js — per-question free input: own option, note (paste screenshots
// with ⌘V), attachments strip. Also used for the round-level comment.

import { h, icon, $ } from "./dom.js";
import { t } from "./i18n.js";
import { autosize } from "./inputs.js";

export function renderExtras(q, ctx) {
  const a = ctx.answers[q.id];
  const other = q.allowOther
    ? h(
        "div.other-wrap",
        { hidden: true },
        h("span.other-mark", { html: icon("plus") }),
        h("input.other-input", {
          type: "text",
          placeholder: t("other.placeholder"),
          "aria-label": t("other.label"),
          value: a.other,
          oninput: (e) => {
            const patch = { other: e.target.value };
            if (q.type === "single" && e.target.value.trim()) patch.selected = [];
            if (ctx.answers[q.id].flag !== "explain") patch.flag = null;
            ctx.set(q.id, patch, { quiet: !patch.selected });
          },
        }),
      )
    : null;
  const note = h("div.note-wrap", { hidden: true }, noteArea(q.note || t("note.placeholder"), a.note, ctx, (v) => ctx.set(q.id, { note: v }, { quiet: true }), (file) => ctx.attach(q.id, file)));
  const files = h("div.files", { hidden: true });
  return h("div.extras", {}, other, note, files);
}

export function noteArea(placeholder, value, ctx, onText, onFile) {
  const ta = h("textarea.note", {
    rows: "2",
    placeholder,
    oninput: (e) => {
      autosize(e.target);
      onText(e.target.value);
    },
    onpaste: (e) => {
      const items = [...(e.clipboardData?.files || [])];
      if (!items.length) return;
      e.preventDefault();
      items.forEach(onFile);
    },
  });
  ta.value = value || "";
  requestAnimationFrame(() => autosize(ta));
  return ta;
}

export function syncExtras(card, q, ctx) {
  const a = ctx.answers[q.id];
  const other = $(".other-wrap", card);
  if (other) other.hidden = !(a.other || ctx.ui.other.has(q.id));
  const note = $(".note-wrap", card);
  if (note) note.hidden = !(q.noteOpen || a.note || ctx.ui.note.has(q.id) || a.attachments.length);
  const files = $(".files", card);
  if (files) paintFiles(files, a.attachments, ctx.files, (p) => ctx.removeFile(q.id, p));
}

export function paintFiles(box, paths, meta = new Map(), onRemove) {
  box.hidden = paths.length === 0;
  box.replaceChildren(
    ...paths.map((p) => {
      const m = meta.get(p) || { name: p.split("/").pop(), type: "" };
      const thumb = m.url && m.type.startsWith("image/") ? h("img", { src: m.url, alt: "" }) : h("span.file-ic", { html: icon("clip") });
      return h(
        "div.file",
        { title: p },
        thumb,
        h("span.file-name", {}, m.name),
        onRemove && h("button.icon-btn.sm", { type: "button", "aria-label": t("file.remove"), html: icon("x"), onclick: () => onRemove(p) }),
      );
    }),
  );
}
