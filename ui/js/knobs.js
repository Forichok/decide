// knobs.js — the page side of the knobs bridge (lib/bridge.mjs). The tune panel sends the values it holds
// to a mockup frame with postKnobs; the frame has an opaque origin (sandbox without allow-same-origin), so the
// target origin is "*" and the frame checks that the message comes from its parent. No DOM access at import.

export const KNOBS_MESSAGE = "decide:knobs";
export const READY_MESSAGE = "decide:knobs-ready";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

// The values as the frame takes them: valid ids only; a number, a string, or {value, unit} for a number with a unit.
export function knobPayload(values) {
  const out = {};
  for (const [id, v] of Object.entries(values ?? {})) {
    if (!ID.test(id) || v == null) continue;
    if (typeof v === "number" || typeof v === "string") out[id] = v;
    else if (typeof v === "boolean") out[id] = v ? 1 : 0;
    else if (typeof v === "object" && "value" in v) out[id] = v.unit ? { value: v.value, unit: String(v.unit) } : v.value;
  }
  return out;
}

// Sends values (and "light" | "dark" when given) to the mockup in iframe. Returns false when the frame has no window yet.
export function postKnobs(iframe, values, theme) {
  const win = iframe?.contentWindow;
  if (!win) return false;
  const message = { type: KNOBS_MESSAGE, values: knobPayload(values) };
  if (theme === "light" || theme === "dark") message.theme = theme;
  win.postMessage(message, "*");
  return true;
}

// Calls send() whenever the bridge in iframe says it is ready (on every load of the frame). Returns a stop function.
export function onKnobsReady(iframe, send, target = globalThis) {
  const listen = (e) => {
    if (e.source && e.source === iframe?.contentWindow && e.data?.type === READY_MESSAGE) send();
  };
  target.addEventListener?.("message", listen);
  return () => target.removeEventListener?.("message", listen);
}
