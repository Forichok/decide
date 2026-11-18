// A select-only combobox. Focus stays on the button while the user explores options.
import { h, icon } from "./dom.js";

let nextList = 0;

export function settingsChoice(values, initial) {
  const id = `settings-options-${++nextList}`;
  const label = h("span");
  const trigger = h("button.set-choice-trigger", {
    type: "button", role: "combobox", "aria-haspopup": "listbox", "aria-controls": id, "aria-expanded": "false",
  }, label, h("span.set-chevron", { "aria-hidden": "true", html: icon("chevron") }));
  const options = values.map(([value, text], index) =>
    h("li.set-option", { role: "option", id: `${id}-${index}`, dataset: { value },
      onpointerdown: e => e.preventDefault(), onclick: () => choose(index) },
    h("span", {}, text), h("span.set-check", { "aria-hidden": "true", html: icon("check") })));
  const list = h("ul.set-options", { id, role: "listbox", hidden: true }, options);
  const el = h("div.set-choice", {}, trigger, list);
  let active = 0;
  let prefix = "", typedAt = 0;

  function select(value) {
    const index = values.findIndex(([key]) => key === value);
    if (index < 0) return;
    trigger.value = value;
    label.textContent = values[index][1];
    options.forEach((option, i) => option.setAttribute("aria-selected", String(i === index)));
  }
  function highlight(index) {
    active = Math.max(0, Math.min(index, values.length - 1));
    trigger.setAttribute("aria-activedescendant", options[active].id);
    options.forEach((option, i) => option.classList.toggle("active", i === active));
    options[active].scrollIntoView({ block: "nearest" });
  }
  function open() {
    if (!list.hidden) return;
    list.hidden = false;
    list.classList.toggle("above", trigger.getBoundingClientRect().bottom + list.offsetHeight + 8 > innerHeight &&
      trigger.getBoundingClientRect().top > list.offsetHeight);
    list.setAttribute("aria-labelledby", trigger.id);
    trigger.setAttribute("aria-expanded", "true");
    highlight(values.findIndex(([key]) => key === trigger.value));
  }
  function close() {
    list.hidden = true;
    prefix = "";
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
  }
  function choose(index) {
    if (trigger.matches(":disabled")) return;
    const [value] = values[index];
    const changed = value !== trigger.value;
    select(value);
    close();
    trigger.focus({ preventScroll: true });
    if (changed) trigger.dispatchEvent(new Event("change", { bubbles: true }));
  }
  trigger.onclick = () => list.hidden ? open() : close();
  trigger.onblur = close;
  trigger.onkeydown = e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const wasOpen = !list.hidden;
    switch (e.key) {
      case "ArrowUp": case "ArrowDown":
        open();
        if (wasOpen) highlight(active + (e.key === "ArrowDown" ? 1 : -1));
        break;
      case "Home": case "End":
        open(); highlight(e.key === "Home" ? 0 : values.length - 1); break;
      case "Enter": case " ":
        if (wasOpen) choose(active); else open();
        break;
      case "Escape":
        if (!wasOpen) return;
        close(); break;
      case "Tab":
        if (wasOpen) choose(active);
        return;
      default: {
        if (e.key.length !== 1) return;
        open();
        prefix = (performance.now() - typedAt < 700 ? prefix : "") + e.key.toLocaleLowerCase();
        typedAt = performance.now();
        const match = values.findIndex(([, text]) => text.toLocaleLowerCase().startsWith(prefix));
        if (match >= 0) highlight(match);
      }
    }
    e.preventDefault();
    e.stopPropagation();
  };
  select(initial);
  return { el, trigger, select };
}
