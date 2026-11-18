// dialog.js — live questions inside a card: what the user asked, the agent's
// answer with visuals (or a typing indicator), and the ask composer.

import { h, icon, $ } from "./dom.js";
import { t } from "./i18n.js";
import { md } from "./md.js";
import { renderMedia } from "./media.js";
import { autosize } from "./inputs.js";
import { changesOf } from "./logic.js";

export function renderThread(q, ctx) {
  return ctx.live ? h("div.thread", { hidden: true, "aria-live": "polite" }) : null;
}

export function syncThread(card, q, ctx) {
  const box = $(".thread", card);
  if (!box) return;
  const items = ctx.dialog.filter((d) => d.qid === q.id);
  const composing = ctx.ui.ask.has(q.id);
  box.hidden = !items.length && !composing;
  const key = JSON.stringify([items.map((d) => [d.id, d.seen, d.repliedAt || 0]), composing]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(...items.flatMap((d) => entry(d, q, ctx)), composing ? composer(q, ctx) : "");
}

function entry(d, q, ctx) {
  const mine = (d.ask || !d.reply) && h("div.msg.me", {}, h("div.msg-who", {}, t("dlg.you")), h("div.msg-text", {}, d.ask || t("dlg.defaultAsk")));
  if (!d.reply) {
    return [
      mine,
      h(
        "div.msg.agent.typing",
        {},
        h("span.typing-dots", {}, h("i"), h("i"), h("i")),
        h("span", {}, d.seen ? t("dlg.writing") : t("dlg.queued")),
      ),
    ];
  }
  return [
    mine,
    h(
      "div.msg.agent",
      {},
      h("div.msg-who", { html: `${icon("spark")}${t("dlg.reply")}` }),
      d.reply.text && h("div.msg-text.rich", { html: md(d.reply.text, ctx.glossary) }),
      renderMedia(d.reply, ctx, q.id),
      changesList(d.reply),
    ),
  ];
}

// Under a reply: what it changed, one line per question or card (the op and its title).
function changesList(reply) {
  const list = changesOf(reply);
  if (!list.length) return null;
  return h("div.msg-changes", {}, h("div.msg-changes-head", {}, t("dlg.changed")), h("ul", {}, ...list.map((c) => h("li", { class: `op-${c.op}` }, `${t(`dlg.op.${c.op}`)}: ${c.title}`))));
}

function composer(q, ctx) {
  const send = () => ctx.sendAsk(q.id, ta.value.trim());
  const ta = h("textarea.note.ask-input", {
    rows: "2",
    placeholder: t("dlg.placeholder"),
    "aria-label": t("dlg.label"),
    oninput: (e) => {
      autosize(e.target);
      ctx.ui.askDraft.set(q.id, e.target.value);
    },
    onkeydown: (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        send();
      } else if (e.key === "Escape") ctx.closeAsk(q.id);
    },
  });
  ta.value = ctx.ui.askDraft.get(q.id) || "";
  return h(
    "div.ask-box",
    {},
    ta,
    h(
      "div.ask-row",
      {},
      h("p.ask-hint", {}, t("dlg.hint")),
      h("button.btn.ghost.sm", { type: "button", onclick: () => ctx.closeAsk(q.id) }, t("common.cancel")),
      h("button.btn.primary.sm", { type: "button", html: `${t("dlg.ask")}${icon("arrow")}`, onclick: send }),
    ),
  );
}

// The round conversation uses the same markdown and media as per-item explanations, without a qid.
export function roundMessage(m, ctx, pick, pickedOption) {
  const agent = m.from === "agent";
  const choice = m.choice && h("div.round-thread-choice", {},
    h("p", { html: md(m.choice.text) }),
    h("div.round-thread-options", {}, m.choice.options.map(option => h("button.btn.sm", {
      type: "button", "aria-pressed": String(m.picked === option), disabled: m.picked !== undefined || ctx.closed,
      onclick: () => pick(m.id, option),
    }, m.picked === option ? `${t("thread.picked")} ${option}` : option))),
  );
  return h(`article.msg.${agent ? "agent" : "me"}`, { dataset: { message: m.id, from: m.from } },
    h("div.msg-who", {}, agent ? t("dlg.reply") : t("thread.you"), h("time", { datetime: m.at }, new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))),
    agent ? h("div.msg-text.rich", { html: md(m.text) }) : h("div.msg-text", {}, pickedOption === undefined ? m.text : t("thread.pickMessage", pickedOption)),
    m.media && renderMedia(m.media, ctx, ""),
    m.media && changesList(m.media),
    choice,
    !agent && h("p.round-thread-status", { role: "status", dataset: { status: m.status } }, t(`thread.${m.status}`)),
  );
}
