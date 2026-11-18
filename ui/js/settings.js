// settings.js — how much to ask: the two buttons under an answered question ("don't ask about this again",
// "always ask me") and the #settings page with the level and the rules.

import { h, icon } from "./dom.js";
import { t } from "./i18n.js";
import { addRuleTo, getSettings, removeRuleFrom, setLevel, holdReload } from "./net.js";
import { credit, eyebrow } from "./header.js";
import { toast } from "./overlays.js";
import { settingsChoice } from "./settings-choice.js";
import { reviewerRoleDisplay } from "./reviewer-display.js";

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

// The #settings page. File-backed settings retain failed drafts until saved.
export function renderSettings(env) {
  const body = h("div.set-body", {}, h("p.jr-empty", {}, t("boot")));
  const project = env.project;
  let data;
  const updates = [];
  const drafts = new Set();
  holdReload("view", () => drafts.size > 0);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const button = (text, action) => h("button.btn.sm", { type: "button", onclick: action }, t(text));
  let fieldId = 0;
  const field = (key, input, help = null) => {
    const id = `set4-field-${++fieldId}`;
    const control = input.trigger ?? input;
    control.id = id;
    if (help) control.setAttribute("aria-describedby", `${id}-help`);
    return h("div.set-field", {}, h("label", { for: id }, t(key)), input.el ?? input,
      help && h("span.set-help", { id: `${id}-help` }, t(help)));
  };
  const hint = (key) => h("p.set-help", {}, t(key));

  // Submit callbacks return only after disk acknowledged the change. No refetch replaces typed fields.
  function formFor(name, scope, saveValue) {
    const status = h("span.set-save-state", { role: "status", "aria-live": "polite" });
    const save = h("button.btn.sm.primary", { type: "submit" }, t("settings4.save"));
    const form = h("form.set-form", { dataset: { setting: name, scope } });
    let revision = 0;
    save.hidden = true;
    const dirty = () => {
      save.hidden = false;
      revision++;
      drafts.add(form);
      status.textContent = t("settings4.unsaved");
      status.classList.remove("failed");
    };
    form.addEventListener("input", dirty);
    form.addEventListener("change", dirty);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const savingRevision = revision;
      save.disabled = true;
      status.textContent = t("settings4.saving");
      status.classList.remove("failed");
      try {
        await saveValue();
        if (revision === savingRevision) { drafts.delete(form); save.hidden = true; }
        status.textContent = t(revision === savingRevision ? "settings4.saved" : "settings4.unsaved");
      } catch (err) {
        status.textContent = t("settings4.saveFailed", err.message);
        status.classList.add("failed");
      } finally { save.disabled = false; }
    };
    return { form, dirty, footer: h("div.set-actions", {}, save, status) };
  }

  function levelFields(value) {
    const input = settingsChoice(data.levels.map((level) => [level, t(`settings.level.${level}`)]), value);
    const note = h("p.set-help", {}, t(`settings.level.${input.trigger.value}.sub`));
    input.trigger.onchange = () => { note.textContent = t(`settings.level.${input.trigger.value}.sub`); };
    return {
      el: h("div", {}, field("settings.level", input), note),
      read: () => input.trigger.value,
      set(value) { input.select(value); input.trigger.onchange(); },
    };
  }

  function reviewerFields(value, dirty) {
    const mode = settingsChoice(["always", "large", "request"].map((key) => [key, t(`settings4.mode.${key}`)]), value.mode);
    const lines = h("input.set-input", { type: "number", min: 1, max: 100000, step: 1, required: true, value: value.lines });
    const list = h("div.set-role-list");
    let rows = [];
    const readRoles = () => rows.map((row) => Object.fromEntries(Object.entries(row.inputs).map(([key, input]) => [key, input.value])));
    const draw = (roles, opened = -1) => {
      rows = roles.map((role, index) => {
        const inputs = {};
        for (const [key, max] of [["id", 32], ["title", 80], ["brief", 600], ["model", 80]]) {
          inputs[key] = h(key === "brief" ? "textarea.set-input" : "input.set-input", {
            ...(key === "brief" ? { rows: 3 } : { type: "text" }), maxlength: max,
            ...(key === "id" ? { pattern: "[a-zA-Z][a-zA-Z0-9_\\-]{0,31}" } : {}),
            required: key === "id" || key === "title",
          });
          inputs[key].value = role[key];
        }
        const title = h("span.set-role-title");
        const showTitle = () => {
          const display = reviewerRoleDisplay({ ...role, id: inputs.id.value, title: inputs.title.value }, data.defaults.reviewers.roles);
          title.textContent = display.title || t("settings4.newRole");
        };
        inputs.id.oninput = inputs.title.oninput = showTitle;
        showTitle();
        const move = (delta) => {
          const next = readRoles();
          [next[index], next[index + delta]] = [next[index + delta], next[index]];
          draw(next, index + delta);
          dirty();
          rows[index + delta].el.querySelector("summary").focus();
        };
        const up = button("settings4.up", () => move(-1));
        up.disabled = index === 0;
        const down = button("settings4.down", () => move(1));
        down.disabled = index === roles.length - 1;
        const remove = button("settings4.removeRole", () => {
          const next = readRoles(); next.splice(index, 1); draw(next); dirty(); add.focus();
        });
        const el = h("details.set-role", { open: index === opened },
          h("summary", {}, title, h("span.set-help", {}, t("settings4.edit"))),
          h("div.set-role-fields", {},
            field("settings4.roleId", inputs.id, "settings4.idHelp"),
            field("settings4.roleTitle", inputs.title), field("settings4.roleBrief", inputs.brief),
            field("settings4.roleModel", inputs.model, "settings4.modelHelp"),
            h("div.set-actions", {}, up, down, remove)));
        return { inputs, el };
      });
      list.replaceChildren(...rows.map((r) => r.el));
      add.disabled = rows.length >= 8;
    };
    const add = button("settings4.addRole", () => {
      const roles = readRoles();
      let n = 1;
      while (roles.some((r) => r.id === `role${n}`)) n++;
      roles.push({ id: `role${n}`, title: t("settings4.newRole"), brief: "", model: "" });
      draw(roles, roles.length - 1); dirty(); rows.at(-1).inputs.title.focus();
    });
    const reset = button("settings4.resetRoles", () => { draw(clone(data.defaults.reviewers.roles)); dirty(); });
    const advanced = h("details.set-advanced", {}, h("summary", {}, t("settings4.advanced")),
      field("settings4.lines", lines, "settings4.linesHelp"),
      h("h4", {}, t("settings4.roles")), hint("settings4.rolesHelp"), list, h("div.set-actions", {}, add, reset));
    const el = h("div", {}, field("settings4.reviewMode", mode), advanced);
    draw(clone(value.roles));
    return {
      el, read: () => ({ mode: mode.trigger.value, lines: Number(lines.value), roles: readRoles() }),
      set(value) { mode.select(value.mode); lines.value = value.lines; draw(clone(value.roles)); },
    };
  }

  function sectionHeading(title, symbol, description) {
    return h("div.set-section-heading", {},
      h("span.set-symbol", { "aria-hidden": "true", html: icon(symbol) }),
      h("div", {}, h("h3.sum-h", {}, t(title)), description && hint(description)));
  }

  function scoped(name, title, makeFields) {
    const level = name === "level";
    const box = h("section.set-section.set-row", {},
      sectionHeading(title, level ? "help" : "check", level ? "settings4.askDescription" : "settings4.reviewDescription"));
    for (const scope of project ? ["global", "project"] : ["global"]) {
      let fields;
      let inherit;
      const form = formFor(name, scope, async () => {
        data = await setLevel(project, {
          scope,
          ...(scope === "project" && inherit.trigger.value === "inherit" ? { clear: [name] } : { set: { [name]: fields.read() } }),
        });
        updates.forEach((update) => update());
      });
      fields = makeFields(scope === "global" ? data.settings[name].global : data.settings[name].value, form.dirty);
      const source = h("p.set-help.set-source");
      const fieldset = h("fieldset.set-editor", {}, h("legend.sr-only", {}, t(title)), fields.el);
      if (scope === "project") {
        inherit = settingsChoice([["inherit", t("settings4.inherit")], ["own", t("settings4.own")]],
          data.settings[name].from === "project" ? "own" : "inherit");
        const change = () => {
          fieldset.disabled = inherit.trigger.value === "inherit";
          fieldset.hidden = fieldset.disabled;
        };
        inherit.trigger.onchange = () => {
          if (inherit.trigger.value === "inherit") fields.set(data.settings[name].global);
          change();
          update();
        };
        change();
        form.form.append(field("settings4.projectSource", inherit));
      }
      form.form.append(fieldset, source, form.footer);
      const update = () => {
        const from = scope === "global" ? data.settings[name].globalFrom : data.settings[name].from;
        if (scope === "project" && inherit.trigger.value === "inherit") {
          const value = data.settings[name].global;
          source.textContent = t("settings4.inheritedValue", name === "level" ? t(`settings.level.${value}`) : t(`settings4.mode.${value.mode}`));
        } else {
          source.textContent = scope === "global" && from === "default" ? t("settings4.source.default") : "";
        }
        source.hidden = !source.textContent;
        if (scope === "project" && inherit.trigger.value === "inherit") fields.set(data.settings[name].global);
      };
      updates.push(update); update();
      box.append(form.form);
    }
    return box;
  }

  function rulesSection() {
    const list = h("ul.set-rules");
    const form = formFor("rules", "project", async () => {
      // Track each successful removal, so a retry after a partial failure removes only what remains.
      for (const row of [...list.children]) {
        if (!row.querySelector("input").checked) continue;
        await removeRuleFrom(project, row.dataset.id);
        row.remove();
      }
      if (!list.children.length) list.replaceWith(h("p.jr-empty", {}, t("settings.noRules")));
    });
    for (const rule of data.rules) {
      const check = h("input", { type: "checkbox", "aria-label": t("settings4.removeRule", rule.text) });
      list.append(h("li", { dataset: { id: rule.id } },
        h("div", {}, h("span.set-rule-mode", {}, t(rule.mode === "never" ? "rule.never" : "rule.always")), h("span.set-rule-text", {}, rule.text)),
        h("label.set-remove", {}, check, t("settings.remove"))));
    }
    form.form.append(h("h3.sum-h", {}, t("settings.rules")), hint("settings4.rulesScope"),
      !project ? hint("settings4.noProjectRules") : data.rules.length ? list : h("p.jr-empty", {}, t("settings.noRules")));
    if (project && data.rules.length) form.form.append(form.footer);
    return h("section.set-section", {}, form.form);
  }

  function themeSection() {
    const choices = ["light", "dark", "system"];
    const status = h("span.set-save-state", { role: "status", "aria-live": "polite" });
    const radios = choices.map(value => h("input.sr-only", {
      type: "radio", name: "settings-theme", value, checked: env.themeChoice() === value,
      onchange: () => apply(value),
    }));
    const tiles = choices.map((choice, i) => h("label.set-theme-tile", { dataset: { choice } }, radios[i],
      h("span.set-preview", { "aria-hidden": "true" }, h("i"), h("i"), h("i")),
      h("span.set-theme-caption", {}, t(`settings4.theme.${choice}`), h("i", { "aria-hidden": "true", html: icon("check") }))));
    const retry = button("settings4.retry", () => {
      const current = radios.find(radio => radio.checked);
      current.focus();
      apply(current.value);
    });
    retry.hidden = true;
    const section = h("section.set-section.set-row.set-appearance", { dataset: { setting: "theme", scope: "browser", themeForm: "" } },
      sectionHeading("settings4.appearance", "sun", "settings4.themeScope"),
      h("div", {}, h("fieldset.set-tiles", {}, h("legend.sr-only", {}, t("settings4.theme")), tiles),
        h("div.set-actions", {}, retry, status)));
    const showResult = (saved) => {
      if (saved) drafts.delete(section);
      else drafts.add(section);
      status.textContent = t(saved ? "settings4.saved" : "settings4.themeFailed");
      status.classList.toggle("failed", !saved);
      retry.hidden = saved;
    };
    function apply(value) {
      try { env.setTheme(value); }
      catch (err) {
        showResult(false);
        toast(err.message);
      }
    }
    section.addEventListener("decide-theme", (e) => {
      for (const radio of radios) radio.checked = radio.value === e.detail.choice;
      showResult(e.detail.saved);
    });
    return section;
  }

  async function load() {
    try { data = await getSettings(project); }
    catch { return body.replaceChildren(h("p.jr-empty", {}, t("settings.failed")), button("settings4.retry", load)); }
    const scopeButtons = project && ["global", "project"].map(scope => h("button", {
      type: "button", dataset: { scopeChoice: scope }, onclick: () => showScope(scope),
    }, t(`settings4.${scope}`)));
    function showScope(scope) {
      for (const btn of scopeButtons || []) btn.setAttribute("aria-pressed", String(btn.dataset.scopeChoice === scope));
      for (const form of body.querySelectorAll("form[data-scope]")) {
        form.hidden = form.dataset.scope !== scope;
        if (form.dataset.setting === "rules") form.parentElement.hidden = form.hidden;
      }
    }
    const projectName = project?.split(/[\\/]/).filter(Boolean).at(-1);
    body.replaceChildren(
      h("header.set-page-head", {},
        h("div", {}, h("h2.set-title", {}, t("settings.title")),
          projectName && h("span.set-project-name", { title: project }, t("settings4.projectName", projectName))),
        scopeButtons && h("div.set-scopes", { role: "group", "aria-label": t("settings4.scope") }, scopeButtons)),
      h("div.set-panel", {}, scoped("level", "settings4.askHeading", levelFields),
        scoped("reviewers", "settings4.reviewers", reviewerFields), rulesSection()),
      themeSection());
    showScope("global");
  }
  load();
  return h("section.done-view.settings-view", {}, eyebrow(env),
    h("button.set-back", { type: "button", onclick: env.leaveSettings },
      h("span", { html: icon("left"), "aria-hidden": "true" }), t("settings4.back")),
    body, credit());
}
