// i18n.js — the page language. `?lang=en|ru` wins, then the browser's first
// language: Russian gets Russian, everything else English. The questions
// themselves stay in whatever language the agent wrote them.

import en from "./lang/en.js";
import ru from "./lang/ru.js";

function pick() {
  const forced = new URLSearchParams(location.search).get("lang");
  if (forced === "en" || forced === "ru") return forced;
  return /^ru\b/i.test(navigator.languages?.[0] || navigator.language || "") ? "ru" : "en";
}

export const lang = pick();
const dict = lang === "ru" ? ru : en;
const mac = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);

// Shortcuts are written with ⌘ and become Ctrl+ off the Mac.
export const shortcut = (s) => (mac ? s : s.replace(/⌘/g, "Ctrl+"));

// t("key", ...args): a string, or a function of args for counts and names.
export function t(key, ...args) {
  const v = dict[key] ?? en[key] ?? key;
  return shortcut(typeof v === "function" ? v(...args) : v);
}
