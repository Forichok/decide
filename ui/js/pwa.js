// pwa.js — the installable page: service worker registration, the app badge, the fallback-port note.
// Pure helpers are importable under Node; browser calls guard on their own APIs.

export const DEFAULT_PORT = "47474";

// A page on any other port is a fallback: the installed app opens the default port and will not find it.
export const wrongPort = (port) => !!port && String(port) !== DEFAULT_PORT;

// Waiting rounds: the inbox rows when there are any, else the open rounds of the state.
export function badgeCount(inbox, state) {
  if (Array.isArray(inbox) && inbox.length) return inbox.length;
  return Array.isArray(state?.rounds) ? state.rounds.length : 0;
}

export function setBadge(n, nav = globalThis.navigator) {
  try {
    if (n > 0) nav?.setAppBadge?.(n)?.catch?.(() => {});
    else nav?.clearAppBadge?.()?.catch?.(() => {});
  } catch {}
}

export function registerShell(nav = globalThis.navigator) {
  try {
    nav?.serviceWorker?.register("/sw.js", { scope: "/" }).catch(() => {});
  } catch {}
}
