import { h } from "../dom.js";
import { settingsChoice } from "../settings-choice.js";

export function visualChoice(label, options, changed, className) {
  const choice = settingsChoice(options, options[0][0]);
  choice.trigger.id = choice.trigger.getAttribute("aria-controls") + "-button";
  choice.trigger.onchange = () => changed(choice.trigger.value);
  return h("div." + className, {}, h("label", { for: choice.trigger.id }, label), choice.el);
}
