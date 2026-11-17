// review/chapters.js — the chapters as cards, the mechanical groups and "The rest" as folded lines.
// A chapter's hunks are fetched when it scrolls near the screen, a folded group's when it is opened.

import { h, icon } from "../dom.js";
import { t } from "../i18n.js";
import { md, mdInline } from "../md.js";
import { reviewPieces } from "../net.js";
import { paintNotes, renderPiece } from "./hunk.js";

const fileList = (names, max = 3) => (names.length > max ? `${names.slice(0, max).join(", ")} ${t("cr.moreFiles", names.length - max)}` : names.join(", "));
const sizeOf = (g) => [t("cr.pieces", g.pieces), t("cr.files", g.files), `+${g.added} −${g.removed}`].join(" · ");

export function createChapters(s) {
  const cards = new Map(); // chapter id → {el, num, read, body}
  const groups = new Map(); // group key → {body, state: "idle" | "loading" | "ready" | "failed"}

  async function load(key) {
    const g = groups.get(key);
    if (!g || g.state === "loading" || g.state === "ready") return;
    g.state = "loading";
    g.body.replaceChildren(h("div.cr-wait", {}, t("cr.loading")));
    try {
      const { pieces } = await reviewPieces(s.id, key);
      g.state = "ready";
      g.body.replaceChildren(
        ...pieces.map((p) => {
          const el = renderPiece(s, p);
          s.loaded.set(p.id, { piece: p, el, group: key });
          return el;
        }),
      );
      if (!pieces.length) g.body.replaceChildren(h("div.cr-wait", {}, t("cr.noPieces")));
      // A chapter of code with no test in it: the reader should see that before the diff.
      if (key.startsWith("ch:") && pieces.length && !pieces.some((p) => p.test)) cards.get(key.slice(3))?.badges.append(h("span.badge.soft", {}, t("cr.noTests")));
    } catch {
      g.state = "failed";
      g.body.replaceChildren(h("div.cr-wait", {}, t("cr.loadFailed"), h("button.btn.cr-sm", { type: "button", onclick: () => load(key) }, t("cr.retry"))));
    }
  }

  // The space a chapter will take, so that loading one above the screen moves the page as little as it can.
  const reserve = (g) => `min-height: ${Math.min(2400, 90 * g.pieces + 21 * (g.added + g.removed + 6 * g.pieces))}px`;

  const near = "IntersectionObserver" in window ? new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && (near.unobserve(e.target), load(e.target.dataset.group))), { rootMargin: "700px 0px" }) : null;

  const chapterCards = s.spec.chapters.map((c, i) => {
    const stat = s.rv.chapters[i];
    const key = `ch:${c.id}`;
    const body = h("div.cr-body", { dataset: { group: key } }, h("div.cr-wait", { style: reserve(stat) }, t("cr.loading")));
    groups.set(key, { body, state: "idle" });
    const num = h("span.cr-ch-n", { "aria-hidden": "true" }, i + 1);
    const read = h("button.btn.cr-sm", { type: "button", onclick: () => s.toggleRead(c.id) });
    const badges = h(
      "div.cr-ch-badges",
      {},
      c.risk !== "low" && h(`span.badge.cr-${c.risk}`, {}, t(`cr.risk.${c.risk}`)),
      h("span.cr-files", {}, `${t("cr.pieces", stat.pieces)} · ${fileList(stat.names)} · +${stat.added} −${stat.removed}`),
    );
    const el = h(
      "section.cr-card.cr-chapter.glass",
      { id: `cr-ch-${c.id}`, tabindex: "-1", dataset: { stop: key } },
      h("div.cr-ch-head", {}, num, h("div.cr-ch-titles", {}, h("h2", { html: mdInline(c.title) }), badges)),
      c.summary && h("div.cr-ch-why.cr-md", { html: md(c.summary) }),
      c.watch && h(`div.cr-watch.${c.risk}`, {}, h("b", {}, t("cr.watch")), " ", h("span", { html: mdInline(c.watch) })),
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
      h("summary", {}, h("span.cr-count", {}, stat.pieces), h("span", { html: title }), h("span.what", {}, sizeOf(stat)), h("span.cr-chev", { html: icon("chevron") })),
      body,
    );
    el.addEventListener("toggle", () => el.open && load(key));
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
      for (const [id, card] of cards) {
        const read = Boolean(s.rv.read[id]);
        card.el.classList.toggle("read", read);
        card.num.textContent = read ? "✓" : card.index + 1;
        card.read.textContent = read ? t("cr.readDone") : t("cr.readMark");
        card.read.classList.toggle("cr-read-on", read);
        card.read.setAttribute("aria-pressed", String(read));
      }
      for (const { piece, el: pieceEl } of s.loaded.values()) paintNotes(s, pieceEl, piece);
    },
    paintPiece(id) {
      const hit = s.loaded.get(id);
      if (hit) paintNotes(s, hit.el, hit.piece);
    },
    // Opens the group a piece lives in (a folded one too) and resolves once it is on screen.
    async show(key) {
      const fold = key.startsWith("ch:") ? null : groups.get(key)?.body.parentNode;
      if (fold) fold.open = true;
      await load(key);
    },
    stop() {
      near?.disconnect();
    },
  };
}
