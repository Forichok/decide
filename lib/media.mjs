// media.mjs — normalize visual attachments of a question or option:
// images, HTML mockup preview, code/diff, mermaid diagram, links.

const REMOTE = /^(https?:|data:)/i;
const str = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);

export function collectMedia(node, where, ctx) {
  const images = [...list(node.image), ...list(node.images)]
    .map((img) => (typeof img === "string" ? { src: img } : img || {}))
    .map((img) => asset(str(img.src || img.path), where, ctx, { caption: str(img.caption || img.alt) }))
    .filter(Boolean);

  const preview = str(node.preview) ? asset(str(node.preview), where, ctx, {}) : null;
  const code = normalizeCode(node.code);
  const links = [...list(node.link), ...list(node.links)]
    .map((l) => (typeof l === "string" ? { url: l, label: l } : l || {}))
    .filter((l) => /^https?:\/\//i.test(str(l.url)))
    .map((l) => ({ url: str(l.url), label: str(l.label) || str(l.url) }));

  return {
    images,
    preview,
    previewHeight: Number.isInteger(node.previewHeight) ? node.previewHeight : 360,
    code,
    mermaid: str(node.mermaid),
    links,
  };
}

function asset(src, where, ctx, extra) {
  if (!src) return null;
  if (REMOTE.test(src)) return { src, ...extra, local: false };
  const abs = ctx.abs(src);
  if (!ctx.exists(abs)) {
    ctx.add("warn", where, `missing file ${abs} — skipped`);
    return null;
  }
  return { src: abs, ...extra, local: true };
}

function normalizeCode(code) {
  if (!code) return null;
  if (typeof code === "string") return { text: code, lang: "", diff: looksLikeDiff(code) };
  const text = str(code.text) || str(code.source);
  if (!text) return null;
  const lang = str(code.lang);
  return { text, lang, diff: code.diff === true || lang === "diff" || looksLikeDiff(text) };
}

function looksLikeDiff(text) {
  const lines = text.split("\n");
  return lines.length > 1 && lines.filter((l) => /^[+-](?![+-])/.test(l)).length >= 2;
}
