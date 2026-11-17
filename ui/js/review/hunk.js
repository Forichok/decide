// review/hunk.js — one piece of the diff: its bar (file, where, tools), the lines in one column, and
// what was said on them: saved comments, questions with the agent's answers, and the box being typed in.
// A click on a line opens the box there; "Whole file" lays the hunk into the file around it.

import { h } from "../dom.js";
import { t } from "../i18n.js";
import { md } from "../md.js";
import { reviewFile } from "../net.js";
import { toast } from "../overlays.js";

const KINDS = ["fix", "question", "nit"];
const keyOf = (x) => (Number.isInteger(x.line) ? `${x.side === "old" ? "old" : "new"}:${x.line}` : "");

// ---- the lines
function lineRow(l) {
  const side = l.t === "del" ? "old" : "new";
  const line = side === "old" ? l.o : l.n;
  return h(
    `tr.cr-line.${l.t}`,
    { dataset: { key: `${side}:${line}` } },
    h("td.n", {}, l.o ?? ""),
    h("td.n", {}, l.n ?? ""),
    h("td.s", {}, l.t === "add" ? "+" : l.t === "del" ? "−" : ""),
    h("td.t", {}, l.text),
  );
}
const eolRow = () => h("tr.eol", {}, h("td.n"), h("td.n"), h("td.s"), h("td.t", {}, t("cr.noeol")));
// A line of the file outside the hunk: read only, it takes no comment.
const farRow = (text, n, side) => h("tr.far", {}, h("td.n", {}, side === "old" ? n : ""), h("td.n", {}, side === "old" ? "" : n), h("td.s"), h("td.t", {}, text));

function hunkRows(piece) {
  return piece.lines.flatMap((l) => (l.noeol ? [lineRow(l), eolRow()] : [lineRow(l)]));
}

function where(piece) {
  if (piece.kind !== "hunk") return "";
  return `@@ −${piece.oldStart},${piece.oldLines} +${piece.newStart},${piece.newLines} @@${piece.section ? ` ${piece.section}` : ""}`;
}

const STATUS = { added: "cr.status.added", deleted: "cr.status.deleted", renamed: "cr.status.renamed", copied: "cr.status.copied" };
const PLAIN = { binary: "cr.plain.binary", rename: "cr.plain.rename", mode: "cr.plain.mode", empty: "cr.plain.empty" };

// s: the review's state (index.js). Returns the piece's element; its notes are painted by paintNotes.
export function renderPiece(s, piece) {
  const tbody = h("tbody", {}, piece.kind === "hunk" ? hunkRows(piece) : []);
  const whole = piece.kind === "hunk" && h("button.cr-tool", { type: "button", onclick: () => toggleFile() }, t("cr.whole"));
  const el = h(
    "div.cr-hunk",
    { dataset: { hunk: piece.id } },
    h(
      "div.cr-hunk-bar",
      {},
      h("span.cr-path", {}, piece.oldFile && piece.oldFile !== piece.file ? [h("s", {}, piece.oldFile), " → "] : null, piece.file),
      piece.test && h("span.badge.cr-test", {}, t("cr.test")),
      STATUS[piece.status] && h("span.badge", {}, t(STATUS[piece.status])),
      h("span.cr-at", {}, where(piece)),
      h(
        "span.cr-tools",
        {},
        whole,
        h("button.cr-tool", { type: "button", onclick: () => s.compose({ hunk: piece.id, kind: "question" }) }, t("cr.askHunk")),
        h("button.cr-tool", { type: "button", onclick: () => s.compose({ hunk: piece.id, kind: "fix" }) }, t("cr.commentHunk")),
      ),
    ),
    h("div.cr-hunk-notes"),
    piece.kind === "hunk"
      ? h("table.cr-diff", {}, h("colgroup", {}, h("col.n"), h("col.n"), h("col.s"), h("col")), tbody)
      : h("p.cr-plain", {}, t(PLAIN[piece.kind] || "cr.plain.empty")),
  );

  tbody.addEventListener("click", (e) => {
    const row = e.target.closest("tr.cr-line");
    // A click that ends a text selection is a selection, not a comment.
    if (!row || String(getSelection())) return;
    const [side, line] = row.dataset.key.split(":");
    s.compose({ hunk: piece.id, line: Number(line), side, kind: "fix" });
  });

  let open = false;
  let loading = false;
  async function toggleFile() {
    if (loading) return;
    const anchor = tbody.querySelector("tr.cr-line");
    const top = anchor?.getBoundingClientRect().top ?? 0;
    if (open) {
      tbody.replaceChildren(...hunkRows(piece));
    } else {
      const side = piece.status === "deleted" ? "old" : "new";
      loading = true;
      whole.disabled = true;
      let file;
      try {
        file = await reviewFile(s.id, side === "old" ? piece.oldFile || piece.file : piece.file, side);
      } catch {
        file = null;
      }
      loading = false;
      whole.disabled = false;
      if (!file || file.binary || typeof file.text !== "string") return toast(t("cr.wholeFailed"));
      const lines = file.text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const [start, count] = side === "old" ? [piece.oldStart, piece.oldLines] : [piece.newStart, piece.newLines];
      // A hunk with no lines on this side sits after the line git names.
      const first = count ? start : start + 1;
      tbody.replaceChildren(
        ...lines.slice(0, first - 1).map((text, i) => farRow(text, i + 1, side)),
        ...hunkRows(piece),
        ...lines.slice(first - 1 + count).map((text, i) => farRow(text, first + count + i, side)),
      );
    }
    open = !open;
    whole.textContent = t(open ? "cr.wholeBack" : "cr.whole");
    el.classList.toggle("whole", open);
    paintNotes(s, el, piece);
    // The hunk stays where the eye was: the file grows above it.
    const now = tbody.querySelector("tr.cr-line")?.getBoundingClientRect().top ?? top;
    if (now !== top) scrollBy({ top: now - top, behavior: "instant" });
  }

  paintNotes(s, el, piece);
  return el;
}

// ---- what was said on the piece
function saved(s, c) {
  const question = c.kind === "question";
  const line = Number.isInteger(c.line) ? t(c.side === "old" ? "cr.onOldLine" : "cr.onLine", c.line) : t("cr.onHunk");
  return h(
    `div.cr-cm.${c.kind}`,
    { dataset: { cm: c.id } },
    h(
      "div.cr-cm-top",
      {},
      h(`span.cr-kind.${c.kind}`, {}, t(`cr.kind.${c.kind}`)),
      h("span.who", {}, line),
      h("span.spacer"),
      !question && h("button", { type: "button", onclick: () => s.compose({ hunk: c.hunk, line: c.line, side: c.side, kind: c.kind, text: c.text, edit: c.id }) }, t("cr.edit")),
      !question && h("button", { type: "button", onclick: () => s.remove(c.id) }, t("cr.remove")),
    ),
    h("p.cr-cm-text", {}, c.text),
    question &&
      (c.reply
        ? h("div.cr-reply", {}, h("span.from", {}, t("cr.agent")), h("div.cr-md", { html: md(c.reply) }))
        : h("div.cr-reply.pending", {}, t(s.listening ? "cr.replyWait" : "cr.replyAway"))),
  );
}

// The box: the kind, the words, send. One is open at a time (s.draft); it keeps its node, so a repaint
// around it does not take the caret.
export function composer(s) {
  const d = s.draft;
  const text = h("textarea", { rows: 3, "aria-label": t("cr.composeLabel"), placeholder: t(`cr.ph.${d.kind}`) });
  text.value = d.text || "";
  const send = h("button.btn.primary.cr-sm", { type: "button", onclick: () => s.send() });
  const hint = h("span.cr-hint");
  // A saved comment stays a comment: a question is a different thing, sent the moment it is asked.
  const kinds = d.edit ? KINDS.filter((k) => k !== "question") : KINDS;
  const seg = h(
    "div.cr-seg",
    { role: "group", "aria-label": t("cr.kindLabel") },
    kinds.map((k) => h("button", { type: "button", dataset: { kind: k }, onclick: () => pick(k) }, t(`cr.kind.${k}`))),
  );
  function pick(kind) {
    d.kind = kind;
    for (const b of seg.children) b.setAttribute("aria-pressed", String(b.dataset.kind === kind));
    text.placeholder = t(`cr.ph.${kind}`);
    send.textContent = t(d.edit ? "cr.save" : kind === "question" ? "cr.sendAsk" : "cr.add");
    hint.textContent = t(kind === "question" ? (s.listening ? "cr.hintAsk" : "cr.hintAskAway") : "cr.hintKeep");
    s.persist();
  }
  text.addEventListener("input", () => {
    d.text = text.value;
    s.persist();
  });
  text.addEventListener("keydown", (e) => {
    // ⌘↵ here sends the comment; on the page it opens the verdict.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      s.send();
    } else if (e.key === "Escape" && !text.value.trim()) {
      e.stopPropagation();
      s.closeDraft();
    }
  });
  const el = h("div.cr-compose", {}, seg, text, h("div.row", {}, send, h("button.btn.ghost.cr-sm", { type: "button", onclick: () => s.closeDraft() }, t("cr.cancel")), hint));
  pick(d.kind);
  el.focusText = () => text.focus({ preventScroll: true });
  return el;
}

// Lays the piece's comments, questions and the open box under their lines (or under the bar, for the
// ones about the piece as a whole). Rows it made before are reused, so the box is never rebuilt.
export function paintNotes(s, el, piece) {
  const said = s.notesOf(piece.id);
  const d = s.draft?.hunk === piece.id ? s.draft : null;
  const groups = new Map();
  const group = (key) => groups.get(key) || groups.set(key, { list: [], box: false }).get(key);
  for (const c of said) if (c.id !== d?.edit) group(keyOf(c)).list.push(c);
  if (d) group(keyOf(d)).box = true;

  const tbody = el.querySelector("tbody");
  const rows = new Map([...(tbody?.querySelectorAll("tr.cr-line") ?? [])].map((r) => [r.dataset.key, r]));
  // A comment whose line is not on screen falls back to the piece's own notes.
  for (const [key, g] of [...groups]) {
    if (!key || rows.has(key)) continue;
    const top = group("");
    top.list.push(...g.list);
    top.box ||= g.box;
    groups.delete(key);
  }

  const fill = (cell, g) => {
    cell.querySelector(".cr-list").replaceChildren(...g.list.map((c) => saved(s, c)));
    const slot = cell.querySelector(".cr-slot");
    if (g.box) {
      if (s.box.parentNode !== slot) slot.replaceChildren(s.box);
    } else if (slot.firstChild) slot.replaceChildren();
  };
  const cellOf = (host) => {
    if (!host.querySelector(".cr-list")) host.append(h("div.cr-list"), h("div.cr-slot"));
    return host;
  };

  const top = el.querySelector(".cr-hunk-notes");
  const g0 = groups.get("");
  if (g0) fill(cellOf(top), g0);
  else top.replaceChildren();

  for (const note of [...(tbody?.querySelectorAll("tr.cr-note") ?? [])]) if (!groups.has(note.dataset.key) || !rows.has(note.dataset.key)) note.remove();
  for (const [key, g] of groups) {
    if (!key) continue;
    const row = rows.get(key);
    let note = row.nextElementSibling;
    // The "no newline" mark belongs to the line: the note goes under it.
    if (note?.classList.contains("eol")) note = note.nextElementSibling;
    if (!note?.classList.contains("cr-note") || note.dataset.key !== key) {
      const after = row.nextElementSibling?.classList.contains("eol") ? row.nextElementSibling : row;
      note = h("tr.cr-note", { dataset: { key } }, h("td", { colspan: 4 }));
      after.after(note);
    }
    fill(cellOf(note.firstChild), g);
  }
}
