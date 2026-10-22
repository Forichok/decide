// md.js — tiny, safe markdown-lite: **bold**, _italic_, `code`, [text](https://…),
// "- " / "1. " lists, "### " headings, "> " quotes, pipe tables, blank-line
// paragraphs; glossary terms become tooltips.
// Input is escaped first, so spec text can never inject markup.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const md = (src, glossary = {}) => render(src, glossary, blocks);
export const mdInline = (src, glossary = {}) => render(src, glossary, (s) => s.replace(/\n/g, "<br>"));

// Code spans and links wait outside as placeholders while the blocks are laid
// out, so a "|" inside them never splits a table cell.
function render(src, glossary, layout) {
  if (!src) return "";
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let s = esc(src).replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${c}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, href) => hold(`<a href="${href}" target="_blank" rel="noopener noreferrer">${emphasis(text)}</a>`));
  s = layout(markTerms(emphasis(s), glossary));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[i]);
}

const emphasis = (s) =>
  s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/gm, "$1<em>$2</em>");

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

// Block layout of already-escaped text: paragraphs, "- " / "1. " lists,
// "### " headings, "> " quotes (escaped to "&gt; ") and pipe tables.
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
// "\\|" keeps a pipe inside a cell, as in GitHub markdown.
const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

function blocks(s) {
  const lines = s.split("\n");
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
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("|") && TABLE_SEP.test(lines[i + 1] || "") && lines[i + 1].includes("|")) {
      flush();
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : ""));
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(cells(lines[i]));
      i -= 1;
      const td = (tagName, c, j) => `<${tagName}${align[j] ? ` style="text-align:${align[j]}"` : ""}>${c}</${tagName}>`;
      out.push(
        `<div class="md-table"><table><thead><tr>${head.map((c, j) => td("th", c, j)).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, j) => td("td", r[j] ?? "", j)).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    if (/^\s*&gt;( |$)/.test(line)) {
      flush();
      const quoted = [];
      for (; i < lines.length && /^\s*&gt;( |$)/.test(lines[i]); i++) quoted.push(lines[i].replace(/^\s*&gt; ?/, ""));
      i -= 1;
      out.push(`<blockquote>${blocks(quoted.join("\n"))}</blockquote>`);
      continue;
    }
    const head = line.match(/^\s*(#{1,4})\s+(.+)$/);
    if (head) {
      flush();
      const level = head[1].length === 4 ? 4 : 3;
      out.push(`<h${level}>${head[2]}</h${level}>`);
      continue;
    }
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
