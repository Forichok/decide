// md.js — tiny, safe markdown-lite: **bold**, _italic_, `code`, [text](https://…),
// "- " / "1. " lists, blank-line paragraphs; glossary terms become tooltips.
// Input is escaped first, so spec text can never inject markup.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const md = (src, glossary = {}) => render(src, glossary, blocks);
export const mdInline = (src, glossary = {}) => render(src, glossary, (s) => s.replace(/\n/g, "<br>"));

function render(src, glossary, layout) {
  if (!src) return "";
  const codes = [];
  let s = esc(src).replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    )
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/gm, "$1<em>$2</em>");
  s = layout(markTerms(s, glossary));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

function markTerms(html, glossary) {
  const terms = Object.keys(glossary || {}).sort((a, b) => b.length - a.length);
  if (!terms.length) return html;
  const done = new Set();
  let inLink = 0;
  return html
    .split(/(<[^>]+>)/)
    .map((part) => {
      if (part.startsWith("<")) {
        if (/^<a\s/.test(part)) inLink += 1;
        if (part === "</a>") inLink -= 1;
        return part;
      }
      if (inLink) return part;
      for (const term of terms) {
        if (done.has(term)) continue;
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${reEsc(esc(term))}(?![\\p{L}\\p{N}])`, "u");
        if (!re.test(part)) continue;
        done.add(term);
        const def = esc(glossary[term]);
        part = part.replace(re, (m) => `<abbr class="term" tabindex="0" data-def="${def}">${m}</abbr>`);
      }
      return part;
    })
    .join("");
}

function blocks(s) {
  const out = [];
  let para = [];
  let items = null;
  let tag = null;
  const flush = () => {
    if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
    if (items) out.push(`<${tag}>${items.join("")}</${tag}>`);
    para = [];
    items = null;
    tag = null;
  };
  for (const line of s.split("\n")) {
    const m = line.match(/^\s*(?:[-•*]|(\d+)[.)])\s+(.*)$/);
    if (m) {
      const t = m[1] ? "ol" : "ul";
      if (para.length || (tag && tag !== t)) flush();
      tag = t;
      (items ||= []).push(`<li>${m[2]}</li>`);
    } else if (!line.trim()) {
      flush();
    } else {
      if (items) flush();
      para.push(line);
    }
  }
  flush();
  return out.join("");
}
