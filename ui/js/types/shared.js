// shared.js — pure helpers the type modules and logic.js both use. It imports
// nothing, so it loads under Node as well as in the page.

export const recommendedIds = (q) => q.options.filter((o) => o.recommended).map((o) => o.id);

export const optionLabel = (q, id) => q.options.find((o) => o.id === id)?.label ?? id;

// The option ids of q.default that exist: what a choice question starts with.
export const defaultSelected = (q) => q.default.filter((id) => q.options.some((o) => o.id === id));

// Picked options, with a star when they are the recommendation and a note when they are not.
export function selectedPart(q, r, w) {
  if (!r.selected?.length) return "";
  const rec = recommendedIds(q);
  const picked = r.selected.map((id) => optionLabel(q, id)).join(", ");
  const same = rec.length && r.selected.every((id) => rec.includes(id));
  const against = rec.length && !r.selected.some((id) => rec.includes(id));
  return picked + (same ? " ★" : against ? ` ${w.against(rec.map((id) => optionLabel(q, id)).join(", "))}` : "");
}

// What the user wrote as an option of their own.
export const ownPart = (r, w) => (r.other ? w.own(r.other) : "");

export const joinParts = (...parts) => parts.filter(Boolean).join(" · ");

// The hooks the choice types share: what the answers file keeps, how a stored answer is checked,
// what the recommendation fills in. `many` is true for multi, which may keep several picks.
export const compactChoice = (q, a) => ({ selected: [...a.selected] });
export const checkChoice = (many) => (q, raw, { ids, warn }) => {
  if (!Array.isArray(raw.selected)) return {};
  const bad = raw.selected.filter((id) => !ids.has(id));
  if (bad.length) warn(`unknown option ${bad.map((b) => `"${b}"`).join(", ")} dropped`);
  const selected = raw.selected.filter((id) => ids.has(id));
  return { selected: many ? selected : selected.slice(0, 1) };
};
export const recommendChoice = (many) => (q, a, rec) => (rec.length ? { ...a, selected: many ? rec : rec.slice(0, 1), other: "" } : a);
