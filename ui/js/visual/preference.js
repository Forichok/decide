const key = "decide.visual.imageLayout";

export function defaultImageLayout() {
  try { return localStorage.getItem(key) === "wipe" ? "wipe" : "split"; }
  catch { return "split"; }
}

export function saveDefaultImageLayout(layout) {
  localStorage.setItem(key, layout);
}
