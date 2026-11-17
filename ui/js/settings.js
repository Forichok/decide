// settings.js — how much to ask: the two buttons under an answered question ("don't ask about this again",
// "always ask me") and the #settings page with the level and the rules.

import { h } from "./dom.js";
import { t } from "./i18n.js";
import { addRuleTo, getSettings, removeRuleFrom, setLevel } from "./net.js";
import { credit, eyebrow } from "./header.js";

// The rule's text, prefilled from the question and the answer; the user may edit it before it is saved.
export const ruleText = (title, answer, mode) => (mode === "never" ? t("rule.neverText", title, answer) : t("rule.alwaysText", title));

// Under a row of the summary: one tap opens an editable line, a second saves it.
export function ruleButtons(project, row) {
  if (!project) return null;
  const box = h("div.rule-row");
  const state = h("span.rule-state");
  const open = (mode) => {
    const input = h("textarea.rule-input", { rows: 2, "aria-label": t("rule.edit") });
    input.value = ruleText(row.title, row.answer, mode);
    const save = h("button.btn.sm.primary", { type: "button" }, t("rule.save"));
    save.onclick = async () => {
      save.disabled = true;
      try {
        await addRuleTo(project, input.value.replace(/\s+/g, " ").trim(), mode, row.title);
        box.replaceChildren(h("span.rule-state", {}, t(mode === "never" ? "rule.savedNever" : "rule.savedAlways")), h("a.link-btn", { href: "#settings" }, t("rule.manage")));
      } catch {
        save.disabled = false;
        state.textContent = t("rule.failed");
      }
    };
    // a rule is one line: Enter saves it, as it did in the single-line field
    input.onkeydown = (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      save.click();
    };
    box.replaceChildren(input, save, state);
    input.focus();
  };
  box.append(
    h("button.link-btn", { type: "button", onclick: () => open("never") }, t("rule.never")),
    h("button.link-btn", { type: "button", onclick: () => open("always") }, t("rule.always")),
  );
  return box;
}

// The #settings page.
export function renderSettings(env) {
  const body = h("div.set-body");
  const project = env.project;
  async function load() {
    if (!project) return body.replaceChildren(h("p.jr-empty", {}, t("settings.noProject")));
    let data;
    try {
      data = await getSettings(project);
    } catch {
      return body.replaceChildren(h("p.jr-empty", {}, t("settings.failed")));
    }
    const levels = h(
      "div.set-levels",
      { role: "radiogroup", "aria-label": t("settings.level") },
      data.levels.map((level) =>
        h(
          "button.set-level",
          {
            type: "button",
            role: "radio",
            "aria-checked": String(level === data.level),
            onclick: async () => {
              await setLevel(project, level);
              load();
            },
          },
          h("strong", {}, t(`settings.level.${level}`)),
          h("span", {}, t(`settings.level.${level}.sub`)),
        ),
      ),
    );
    const rules = data.rules.length
      ? h(
          "ul.set-rules",
          {},
          data.rules.map((r) =>
            h(
              "li",
              {},
              h("span.set-rule-mode", {}, t(r.mode === "never" ? "rule.never" : "rule.always")),
              h("span.set-rule-text", {}, r.text),
              h("button.link-btn", { type: "button", onclick: async () => (await removeRuleFrom(project, r.id), load()) }, t("settings.remove")),
            ),
          ),
        )
      : h("p.jr-empty", {}, t("settings.noRules"));
    body.replaceChildren(h("h3.sum-h", {}, t("settings.level")), levels, h("h3.sum-h", {}, t("settings.rules")), rules);
  }
  load();
  return h("section.done-view", {}, eyebrow(env), h("h2.set-title", {}, t("settings.title")), body, credit());
}
