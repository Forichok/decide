// review/chapters.js — the chapters as cards, the mechanical groups and "The rest" as folded lines.
// A chapter's hunks are fetched when it scrolls near the screen, a folded group's when it is opened.

import { h, icon } from "../dom.js";
import { t } from "../i18n.js";
import { md, mdInline } from "../md.js";
import { reviewPieces } from "../net.js";
import { mechanicalLine } from "./overview.js";
import { paintOpenCount } from "./reviewers.js";
import { renderPiece } from "./hunk.js";

const fileList = (names, max = 3) => (names.length > max ? `${names.slice(0, max).join(", ")} ${t("cr.moreFiles", names.length - max)}` : names.join(", "));
const sizeOf = (g) => [t("cr.pieces", g.pieces), t("cr.files", g.files), `+${g.added} −${g.removed}`].join(" · ");

export function createChapters(s) {
  const cards = new Map(); // chapter id → {el, num, read, body}
  const groups = new Map(); // group key → {body, state: "idle" | "loading" | "ready" | "failed"}

  // A chapter with key places (or one to skim) opens on those: its other pieces wait in one folded line.
  const quiet = (key) => {
    const i = key.startsWith("ch:") ? s.spec.chapters.findIndex((c) => c.id === key.slice(3)) : -1;
    return i >= 0 && (s.rv.chapters[i].focus.length > 0 || Boolean(s.spec.chapters[i].skim));
  };
  const others = new Map(); // group key → the fold with the chapter's other pieces

  function load(key) {
    const g = groups.get(key);
    if (!g || g.state === "ready") return Promise.resolve();
    if (g.pending) return g.pending;
    g.pending = loadGroup(key, g).finally(() => { g.pending = null; });
    return g.pending;
  }

  async function loadGroup(key, g) {
    g.state = "loading";
    g.body.replaceChildren(h("div.cr-wait", {}, t("cr.loading")));
    try {
      const { pieces } = await reviewPieces(s.id, key);
      g.state = "ready";
      const draw = (p, folded) => {
        const el = renderPiece(s, p, { folded });
        s.loaded.set(p.id, { piece: p, el, group: key });
        return el;
      };
      const lead = quiet(key) ? pieces.filter((p) => s.focusOf(p.id).length) : pieces;
      const tail = pieces.filter((p) => !lead.includes(p));
      const fold =
        tail.length > 0 &&
        h(
          "details.cr-others",
          {},
          h("summary", {}, h("span.cr-count", {}, tail.length), h("span", {}, t(lead.length ? "cr.others" : "cr.allPieces")), h("span.what", {}, `${t("cr.files", new Set(tail.map((p) => p.file)).size)} · +${tail.reduce((a, p) => a + p.added, 0)} −${tail.reduce((a, p) => a + p.removed, 0)}`), h("span.cr-chev", { html: icon("chevron") })),
          tail.map((p) => draw(p, true)),
        );
      g.body.replaceChildren(...lead.map((p) => draw(p, false)), ...(fold ? [fold] : []));
      if (fold) {
        others.set(key, { fold, ids: tail.map((p) => p.id) });
        openOthers(key);
      }
      if (!pieces.length) g.body.replaceChildren(h("div.cr-wait", {}, t("cr.noPieces")));
    } catch {
      g.state = "failed";
      g.body.replaceChildren(h("div.cr-wait", {}, t("cr.loadFailed"), h("button.btn.cr-sm", { type: "button", onclick: () => load(key) }, t("cr.retry"))));
    } finally {
      s.progress?.();
    }
  }
  // The fold opens by itself for the whole diff and for a piece somebody wrote on; the reader closes it.
  const hasNotes = (id) => s.notesOf(id).length || s.draft?.hunk === id || s.findingsOf(id).length;
  function openOthers(key) {
    const o = others.get(key);
    if (!o) return;
    if (s.full || o.ids.some(hasNotes)) o.fold.open = true;
  }

  // The space a chapter will take, so that loading one above the screen moves the page as little as it can.
  const reserve = (g, key) => `min-height: ${quiet(key) ? Math.min(1400, 120 + 380 * g.focus.length) : Math.min(2400, 90 * g.pieces + 21 * Math.min(g.added + g.removed + 6 * g.pieces, 26 * g.pieces))}px`;

  const near = "IntersectionObserver" in window ? new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && (near.unobserve(e.target), load(e.target.dataset.group))), { rootMargin: "700px 0px" }) : null;

  const chapterCards = s.spec.chapters.map((c, i) => {
    const stat = s.rv.chapters[i];
    const key = `ch:${c.id}`;
    const body = h("div.cr-body", { dataset: { group: key } }, h("div.cr-wait", { style: reserve(stat, key) }, t("cr.loading")));
    groups.set(key, { body, state: "idle" });
    const num = h("span.cr-ch-n", { "aria-hidden": "true" }, i + 1);
    const read = h("button.btn.cr-sm", { type: "button", onclick: () => s.toggleRead(c.id) });
    const badges = h(
      "div.cr-ch-badges",
      {},
      c.risk !== "low" && h(`span.badge.cr-${c.risk}`, {}, t(`cr.risk.${c.risk}`)),
      h("span.cr-open-findings", { hidden: true }),
      h("span.cr-files", {}, `${t("cr.pieces", stat.pieces)} · ${fileList(stat.names)} · +${stat.added} −${stat.removed}`),
    );
    const el = h(
      "section.cr-card.cr-chapter.glass",
      { id: `cr-ch-${c.id}`, tabindex: "-1", dataset: { stop: key } },
      h("div.cr-ch-head", {}, num, h("div.cr-ch-titles", {}, h("h2", { html: mdInline(c.title) }), badges)),
      c.summary && h("div.cr-ch-why.cr-md", { html: md(c.summary) }),
      c.watch && h(`div.cr-watch.${c.risk}`, {}, h("b", {}, t("cr.watch")), " ", h("span", { html: mdInline(c.watch) })),
      c.skim && h("div.cr-skim", {}, h("b", {}, t("cr.skim")), " ", h("span", { html: mdInline(c.skim) })),
      stat.focus.length > 0 &&
        h(
          "div.cr-places",
          {},
          h("b", {}, t("cr.places", stat.focus.length)),
          h("ol", {}, stat.focus.map((f, k) => h("li", {}, h(`button${f.kind ? `.kind-${f.kind}` : ""}`, { type: "button", onclick: () => s.goPlace(c.id, k) }, f.kind && h("span.cr-kind", {}, t(`cr.placeKind.${f.kind}`)), h("code", {}, `${f.file}:${f.from === f.to ? f.from : `${f.from}–${f.to}`}`), f.note && h("span", { html: mdInline(f.note) }))))),
        ),
      body,
      h("div.cr-ch-foot", {}, read, h("span.cr-hint", {}, t("cr.readHint"))),
    );
    cards.set(c.id, { el, num, read, badges, index: i });
    if (near) near.observe(body);
    else load(key);
    return el;
  });

  function fold(key, { title, stat, cls = "" }) {
    const body = h("div.cr-fold-body");
    groups.set(key, { body, state: "idle" });
    const el = h(
      `details.cr-fold.glass${cls}`,
      { dataset: { stop: key } },
      h("summary", {}, h("span.cr-count", {}, stat.pieces), h("span", { html: title }), h("span.what", {}, sizeOf(stat)), h("span.cr-chev", { html: icon("chevron") }), key.startsWith("mech:") && h("span.cr-mechanical-account", {}, mechanicalLine(s))),
      body,
    );
    el.addEventListener("toggle", () => el.open && load(key));
    el.open = s.full || stat.ids.some(hasNotes);
    return el;
  }
  const mech = s.spec.mechanical.map((m, i) => fold(`mech:${i}`, { title: mdInline(m.title), stat: s.rv.mechanical[i] }));
  const rest = s.rv.rest.pieces > 0 && fold("rest", { title: t("cr.rest"), stat: s.rv.rest, cls: ".rest" });

  const el = [
    chapterCards,
    (mech.length > 0 || rest) && h("h2.cr-folds-h", { id: "cr-folds" }, t("cr.folds")),
    mech,
    rest && [h("p.cr-hint.cr-rest-why", {}, t("cr.restWhy", s.rv.rest.pieces)), rest],
  ];

  return {
    el,
    cards,
    // Read marks and everything said on the pieces already on screen.
    paint() {
      const findings = s.openCounts();
      for (const [id, card] of cards) {
        const read = Object.hasOwn(s.rv.read, id);
        paintOpenCount(card.badges.querySelector(".cr-open-findings"), findings.get(`ch:${id}`));
        card.el.classList.toggle("read", read);
        card.num.textContent = read ? "✓" : card.index + 1;
        card.read.textContent = read ? t("cr.readDone") : t("cr.readMark");
        card.read.classList.toggle("cr-read-on", read);
        card.read.setAttribute("aria-pressed", String(read));
      }
      for (const { el: pieceEl } of s.loaded.values()) pieceEl.paint();
      for (const key of others.keys()) openOthers(key);
    },
    openFindingGroups() {
      for (const [key, g] of groups) {
        if (!key.startsWith("ch:") && g.body.parentNode && g.body.parentNode.dataset.stop === key) {
          const ids = key === "rest" ? s.rv.rest.ids : s.rv.mechanical[Number(key.slice(5))].ids;
          if (ids.some(id => s.findingsOf(id).length)) g.body.parentNode.open = true;
        }
        openOthers(key);
      }
    },
    paintPiece(id) {
      const hit = s.loaded.get(id);
      for (const { el } of s.loaded.values()) el.paint();
      if (hit) openOthers(hit.group);
    },
    // "The whole diff" went on or off: every piece on screen is drawn again, the folds follow.
    async redraw() {
      if (s.full) {
        for (const [key, g] of groups) if (!key.startsWith("ch:")) g.body.parentNode.open = true;
        await Promise.all([...groups.keys()].map(load));
      }

      for (const { el: pieceEl } of s.loaded.values()) pieceEl.update();
      for (const o of others.values()) o.fold.open = s.full || o.ids.some(hasNotes);
      if (!s.full) {
        for (const [key, g] of groups) if (!key.startsWith("ch:")) g.body.parentNode.open = false;
        this.openFindingGroups();
      }
      return [...groups.values()].every((g) => g.state === "ready");
    },
    // Load every chapter above the destination before measuring its scroll position.
    async prepare(key) {
      const keys = [...groups.keys()];
      const end = keys.indexOf(key);
      if (end < 0) return;
      await Promise.all(keys.slice(0, end + 1).filter((k) => k.startsWith("ch:")).map(load));
    },
    // The row that opens a key place, once its chapter is on screen; the fold it may sit in is opened.
    async place(chapter, k) {
      await load(`ch:${chapter}`);
      return cards.get(chapter)?.el.querySelector(`tr.cr-place[data-focus="${CSS.escape(`${chapter}:${k}`)}"]`) ?? null;
    },
    async piece(id, key, { unfold = true } = {}) {
      await this.prepare(key);
      await this.show(key);
      const other = others.get(key);
      if (other?.ids.includes(id)) other.fold.open = true;
      const hit = s.loaded.get(id);
      if (unfold) hit?.el.unfold();
      return hit?.el;
    },
    // Opens the group a piece lives in (a folded one too) and resolves once it is on screen.
    async show(key) {
      const fold = key.startsWith("ch:") ? null : groups.get(key)?.body.parentNode;
      if (fold) fold.open = true;
      await load(key);
      openOthers(key);
    },
    stop() {
      near?.disconnect();
    },
  };
}
