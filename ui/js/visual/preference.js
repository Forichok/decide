const key = "decide.visual.imageLayout";

export function defaultImageLayout() {
  try { return localStorage.getItem(key) === "wipe" ? "wipe" : "split"; }
  catch { return "split"; }
}

// The reader's own choice, or null when they never made one: then each capture picks what fits its pane.
export function storedImageLayout() {
  try { const value = localStorage.getItem(key); return value === "wipe" || value === "split" ? value : null; }
  catch { return null; }
}

export function saveDefaultImageLayout(layout) {
  localStorage.setItem(key, layout);
}
