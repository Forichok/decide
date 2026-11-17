// review/hunk.js — one piece of the diff: its bar (file, where, tools), the lines in one column, and
// what was said on them: saved comments, questions with the agent's answers, and the box being typed in.
// A click on a line opens the box there.
//
// A piece opens on what a person should read: the key places the agent named, with a few lines around
// each. Its other lines are folded into gaps, and three things bring them back:
//   a gap's own buttons       20 more lines of the hunk, or all of them
//   "Lines around"            20 more lines of the file above and below the hunk
//   "Whole file"              the file with every hunk of its diff laid in
// A piece with no key place is shown whole when it is short, by its first lines when it is long, and
// folded when its chapter has key places elsewhere. A long test file lists the names of its tests.

import { h } from "../dom.js";
import { t } from "../i18n.js";
import { md, mdInline } from "../md.js";
import { reviewFile } from "../net.js";
import { toast } from "../overlays.js";

const KINDS = ["fix", "question", "nit"];
const keyOf = (x) => (Number.isInteger(x.line) ? `${x.side === "old" ? "old" : "new"}:${x.line}` : "");

const CONTEXT = 3; // lines kept around a key place
const NOTE_CONTEXT = 2; // and around a line somebody wrote on
const LONG = 60; // a hunk longer than this opens on its first lines
const HEAD = 20;
const STEP = 20; // what one press of "more" shows
const TEST_LIST = 30; // a test file longer than this opens as a list of its tests
const TEST_NAME = /^\s*(?:test|it|describe)(?:\.\w+)*\(\s*(["'`])(.+?)\1/;

// ---- the lines
const lineKey = (l) => (l.t === "del" ? `old:${l.o}` : `new:${l.n}`);
const sign = (kind) => (kind === "add" ? "+" : kind === "del" ? "−" : "");
function lineRow(l, focus) {
  return h(`tr.cr-line.${l.t}${focus ? ".focus" : ""}`, { dataset: { key: lineKey(l) } }, h("td.n", {}, l.o ?? ""), h("td.n", {}, l.n ?? ""), h("td.s", {}, sign(l.t)), h("td.t", {}, l.text));
}
const eolRow = () => h("tr.eol", {}, h("td.n"), h("td.n"), h("td.s"), h("td.t", {}, t("cr.noeol")));
// A line of the file outside the piece: read only, it takes no comment. Another hunk's line keeps its mark.
const farRow = (l) => h(`tr.far${l.t === "ctx" ? "" : `.${l.t}`}`, {}, h("td.n", {}, l.o ?? ""), h("td.n", {}, l.n ?? ""), h("td.s", {}, sign(l.t)), h("td.t", {}, l.text));

const fill = (set, from, to, n) => {
  for (let i = Math.max(0, from); i <= Math.min(n - 1, to); i++) set.add(i);
};

// Where a key place sits in the piece's lines: { first, at, last }, at its first line of the new file;
// null when none of its lines is here.
function spanOf(lines, place) {
  const inside = lines.map((l, i) => (l.t !== "del" && l.n >= place.from && l.n <= place.to ? i : -1)).filter((i) => i >= 0);
  if (!inside.length) return null;
  let first = inside[0];
  // The lines removed just above belong to the place: they are what the new lines replaced.
  while (first > 0 && lines[first - 1].t === "del") first--;
  return { first, at: inside[0], last: inside.at(-1), place };
}

// The tests a piece adds or touches, by name: [{ i, name }].
const testNames = (lines) => lines.map((l, i) => (l.t === "del" ? null : { i, name: TEST_NAME.exec(l.text)?.[2] })).filter((x) => x?.name);

// The file around the piece: what comes before its lines and what comes after, every other hunk of the
// file with its own marks.
function layFile(file, piece) {
  const text = file.text.split("\n");
  if (text.at(-1) === "") text.pop();
  const before = [];
  const after = [];
  if (file.side === "old") {
    const first = piece.oldLines ? piece.oldStart : piece.oldStart + 1;
    text.forEach((line, i) => (i + 1 < first ? before : i + 1 >= first + piece.oldLines ? after : []).push({ t: "ctx", text: line, o: i + 1 }));
    return { before, after };
  }
  const hunks = (file.hunks ?? []).some((x) => x.id === piece.id) ? [...file.hunks].sort((a, b) => a.newStart - b.newStart) : [{ id: piece.id, newStart: piece.newStart, newLines: piece.newLines, lines: [] }];
  let into = before;
  let at = 1;
  const plain = (upTo) => {
    for (; at < upTo && at <= text.length; at++) into.push({ t: "ctx", text: text[at - 1], n: at });
  };
  for (const hunk of hunks) {
    // A hunk with no lines on this side sits after the line git names.
    const first = hunk.newLines ? hunk.newStart : hunk.newStart + 1;
    plain(first);
    if (hunk.id === piece.id) into = after;
    else for (const l of hunk.lines) into.push(l.t === "ctx" ? { t: "ctx", text: l.text, n: l.n } : l);
    at = first + hunk.newLines;
  }
  plain(text.length + 1);
  return { before, after };
}

function where(piece) {
  if (piece.kind !== "hunk") return "";
  return `@@ −${piece.oldStart},${piece.oldLines} +${piece.newStart},${piece.newLines} @@${piece.section ? ` ${piece.section}` : ""}`;
}

const STATUS = { added: "cr.status.added", deleted: "cr.status.deleted", renamed: "cr.status.renamed", copied: "cr.status.copied" };
const PLAIN = { binary: "cr.plain.binary", rename: "cr.plain.rename", mode: "cr.plain.mode", empty: "cr.plain.empty" };

// s: the review's state (index.js). folded: the piece's chapter has key places elsewhere, or is one to
// skim: the piece opens as one folded line. Returns the piece's element; el.paint() lays what was said.
export function renderPiece(s, piece, { folded = false } = {}) {
  const isHunk = piece.kind === "hunk";
  const lines = isHunk ? piece.lines : [];
  const n = lines.length;
  const index = new Map(lines.map((l, i) => [lineKey(l), i]));
  const spans = isHunk ? s.focusOf(piece.id).map((place) => spanOf(lines, place)).filter(Boolean) : [];
  const inPlace = new Set();
  for (const sp of spans) fill(inPlace, sp.first, sp.last, n);
  const names = piece.test && !spans.length && n > TEST_LIST ? testNames(lines) : [];
  const listed = names.length > 0;

  // What the piece opens on, before anybody asked for more.
  const base = new Set();
  for (const sp of spans) fill(base, sp.first - CONTEXT, sp.last + CONTEXT, n);
  if (!spans.length && !folded && !listed) fill(base, 0, n > LONG ? HEAD - 1 : n - 1, n);
  const st = { all: false, more: new Set(), above: 0, below: 0, file: null, busy: false };

  // The lines on screen; null when it is all of them.
  function visible() {
    if (s.full || st.all || st.above === Infinity) return null;
    const set = new Set([...base, ...st.more]);
    // What was said on a line is never folded away, nor the line being written on.
    const said = s.notesOf(piece.id).map(keyOf);
    if (s.draft?.hunk === piece.id) said.push(keyOf(s.draft));
    for (const key of said) if (index.has(key)) fill(set, index.get(key) - NOTE_CONTEXT, index.get(key) + NOTE_CONTEXT, n);
    return set.size >= n ? null : set;
  }

  const tbody = h("tbody");
  const tool = (label, onclick, title) => h("button.cr-tool", { type: "button", onclick, ...(title ? { title } : {}) }, label);
  // "The whole piece" unfolds every line of the hunk; "Fold" takes it back to what it opened on.
  const expand =
    isHunk &&
    tool("", () => {
      st.all = visible() !== null;
      if (!st.all) st.more.clear();
      update();
    });
  // A new or a deleted file is one hunk: there is no file around it, "the whole piece" is the whole file.
  const lone = piece.status === "added" || piece.status === "deleted";
  const around = isHunk && !lone && tool(t("cr.around"), () => moreFile(false), t("cr.aroundTitle", STEP));
  const whole = isHunk && !lone && tool(t("cr.whole"), () => moreFile(true));
  const tests =
    listed &&
    h(
      "div.cr-tests",
      {},
      h("b", {}, t("cr.tests", names.length)),
      h("ol", {}, names.map((x, k) => h("li", {}, h("button", { type: "button", onclick: () => showTest(k) }, x.name)))),
    );
  const el = h(
    "div.cr-hunk",
    { dataset: { hunk: piece.id } },
    h(
      "div.cr-hunk-bar",
      {},
      h("span.cr-path", {}, piece.oldFile && piece.oldFile !== piece.file ? [h("s", {}, piece.oldFile), " → "] : null, piece.file),
      piece.test && h("span.badge.cr-test", {}, t("cr.test")),
      STATUS[piece.status] && h("span.badge", {}, t(STATUS[piece.status])),
      piece.modes && h("span.badge", {}, t("cr.modes", piece.modes[0], piece.modes[1])),
      h("span.cr-at", {}, where(piece)),
      h("span.cr-tools", {}, expand, around, whole, tool(t("cr.askHunk"), () => s.compose({ hunk: piece.id, kind: "question" })), tool(t("cr.commentHunk"), () => s.compose({ hunk: piece.id, kind: "fix" }))),
    ),
    h("div.cr-hunk-notes"),
    tests,
    isHunk ? h("table.cr-diff", {}, h("colgroup", {}, h("col.n"), h("col.n"), h("col.s"), h("col")), tbody) : h("p.cr-plain", {}, t(PLAIN[piece.kind] || "cr.plain.empty")),
  );

  // "⋯ 140 lines": the folded lines a to b, with what shows more of them.
  function gapRow(a, b) {
    const count = b - a + 1;
    const show = (from, to, hold) => () => (fill(st.more, from, to, n), update(hold));
    const below = b + 1 < n ? lineKey(lines[b + 1]) : "";
    const acts =
      count <= STEP
        ? [tool(t("cr.gapShow", count), show(a, b))]
        : [
            a > 0 && tool(t("cr.gapDown", STEP), show(a, a + STEP - 1, below), t("cr.gapDownTitle")),
            b < n - 1 && tool(t("cr.gapUp", STEP), show(b - STEP + 1, b), t("cr.gapUpTitle")),
            a === 0 && b === n - 1 && tool(t("cr.gapFirst", STEP), show(0, STEP - 1)),
            tool(t("cr.gapAll", count), show(a, b)),
          ];
    return h("tr.cr-gap", { dataset: { from: a, to: b } }, h("td", { colspan: 4 }, h("div.cr-gap-in", {}, h("span.cr-gap-n", {}, t("cr.gap", count)), acts)));
  }
  // The row over a key place: why the agent named it, and the two things to do about it. A question or
  // a comment made here sits on the place's first line.
  const onPlace = (sp, kind) => () => s.compose({ hunk: piece.id, line: lines[sp.at].n, side: "new", kind });
  const placeRow = (sp) =>
    h(
      "tr.cr-place",
      { dataset: { focus: sp.place.key } },
      h(
        "td",
        { colspan: 4 },
        h(
          "div.cr-place-in",
          {},
          h("span.cr-place-note", { html: mdInline(sp.place.note || t("cr.placeNoNote")) }),
          h("span.cr-place-acts", {}, tool(t("cr.askHunk"), onPlace(sp, "question")), tool(t("cr.commentHunk"), onPlace(sp, "fix"))),
        ),
      ),
    );

  function rows() {
    const vis = visible();
    const out = [];
    for (let i = 0; i < n; ) {
      if (vis && !vis.has(i)) {
        let j = i;
        while (j < n && !vis.has(j)) j++;
        out.push(gapRow(i, j - 1));
        i = j;
        continue;
      }
      for (const sp of spans) if (sp.first === i) out.push(placeRow(sp));
      out.push(lineRow(lines[i], inPlace.has(i)));
      if (lines[i].noeol) out.push(eolRow());
      i++;
    }
    const above = st.file && st.above ? st.file.before.slice(-st.above) : [];
    const below = st.file && st.below ? st.file.after.slice(0, st.below) : [];
    return [...above.map(farRow), ...out, ...below.map(farRow)];
  }

  // Draws the lines again. hold: the key of a line that should stay where it is on the screen.
  function update(hold) {
    const typing = s.box?.contains(document.activeElement);
    const at = (key) => (key ? tbody.querySelector(`tr.cr-line[data-key="${key}"]`)?.getBoundingClientRect().top : undefined);
    const top = at(hold);
    tbody.replaceChildren(...rows());
    const vis = visible();
    if (expand) {
      expand.hidden = base.size >= n || s.full || st.above === Infinity;
      expand.textContent = t(vis ? (lone ? "cr.whole" : "cr.pieceAll") : "cr.pieceFold");
    }
    if (whole) {
      const far = st.file ? st.file.before.length + st.file.after.length : -1;
      around.hidden = st.above === Infinity || far === 0 || (far > 0 && st.above >= st.file.before.length && st.below >= st.file.after.length);
      whole.textContent = t(st.above === Infinity ? "cr.wholeBack" : "cr.whole");
      el.classList.toggle("whole", st.above === Infinity);
    }
    if (tests) tests.hidden = !vis;
    paintNotes(s, el, piece);
    if (typing) s.box.focusText();
    const now = at(hold);
    if (top !== undefined && now !== undefined && now !== top) scrollBy({ top: now - top, behavior: "instant" });
  }

  // More of the file around the piece: 20 lines each way, or all of it; "Only the change" takes it back.
  async function moreFile(all) {
    if (st.busy) return;
    const first = tbody.querySelector("tr.cr-line")?.dataset.key;
    if (all && st.above === Infinity) {
      st.above = st.below = 0;
      return update(first);
    }
    if (!st.file) {
      const side = piece.status === "deleted" ? "old" : "new";
      st.busy = true;
      let file;
      try {
        file = await reviewFile(s.id, side === "old" ? piece.oldFile || piece.file : piece.file, side);
      } catch {
        file = null;
      }
      st.busy = false;
      if (!file || file.binary || typeof file.text !== "string") return toast(t("cr.wholeFailed"));
      st.file = layFile(file, piece);
    }
    if (all) st.above = st.below = Infinity;
    else [st.above, st.below] = [st.above + STEP, st.below + STEP];
    update(first);
  }

  function showTest(k) {
    fill(st.more, names[k].i, (names[k + 1]?.i ?? n) - 1, n);
    update();
    tbody.querySelector(`tr.cr-line[data-key="${lineKey(lines[names[k].i])}"]`)?.scrollIntoView({ block: "center" });
  }

  tbody.addEventListener("click", (e) => {
    const row = e.target.closest("tr.cr-line");
    // A click that ends a text selection is a selection, not a comment.
    if (!row || String(getSelection())) return;
    const [side, line] = row.dataset.key.split(":");
    s.compose({ hunk: piece.id, line: Number(line), side, kind: "fix" });
  });

  el.update = update;
  // What was said changed: the notes are laid again, and a line that got one while folded is unfolded.
  el.paint = () => {
    const vis = isHunk && visible();
    const hidden = vis && [...s.notesOf(piece.id).map(keyOf), s.draft?.hunk === piece.id ? keyOf(s.draft) : ""].some((key) => index.has(key) && !tbody.querySelector(`tr.cr-line[data-key="${key}"]`));
    if (hidden) update();
    else paintNotes(s, el, piece);
  };
  // Is there something here the reader was not shown: folded lines.
  el.folded = () => isHunk && visible() !== null;
  if (isHunk) update();
  else paintNotes(s, el, piece);
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
  el.pick = pick;
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

  const lay = (cell, g) => {
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
  if (g0) lay(cellOf(top), g0);
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
    lay(cellOf(note.firstChild), g);
  }
}
