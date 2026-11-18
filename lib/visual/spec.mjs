// Visual rounds keep an immutable capture recipe for each pair of observations.
export function invalid(message) {
  throw Object.assign(new Error(message), { status: 422 });
}
export function words(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 8000)
    invalid(`Provide ${label} (1–8000 characters)`);
  return value.trim();
}
function list(value, label, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > 100) invalid(`Invalid ${label} list`);
  return value;
}
function unique(value, label, seen) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value) ||
    Object.hasOwn(Object.prototype, value) ||
    seen.has(value)
  )
    invalid(`Invalid or duplicate ${label} ID`);
  seen.add(value);
  return value;
}
function capture(raw, recipe) {
  if (raw == null) return undefined;
  if (!raw.image && !raw.video) invalid("A capture needs an image or a video");
  const side = {};
  for (const key of ["image", "video", "unmatched"]) if (raw[key] != null) side[key] = words(raw[key], key);
  if (raw.cue != null) {
    if (!Number.isFinite(raw.cue) || raw.cue < 0 || !side.video) invalid("Invalid video action cue");
    side.cue = raw.cue;
  }
  for (const key of ["fixture", "theme", "viewport", "state"]) {
    if (raw[key] != null && raw[key] !== recipe[key])
      invalid(`Capture ${key} differs from the pair; describe it in a separate pair with a gap`);
  }
  return side;
}
function taskOf(task, ids) {
  const id = unique(task?.id, "task", ids);
  const evidenceIds = new Set();
  const evidence = list(task.evidence ?? [], "evidence").map((pair) => {
    const e = { id: unique(pair?.id, "evidence", evidenceIds) };
    for (const key of ["label", "viewport", "theme", "fixture", "state"]) e[key] = words(pair[key], key);
    for (const side of ["before", "after"]) if (pair[side]) e[side] = capture(pair[side], e);
    return e;
  });
  const needsGap =
    !evidence.length ||
    evidence.some(
      (e) =>
        !e.before ||
        !e.after ||
        Boolean(e.before.image) !== Boolean(e.after.image) ||
        Boolean(e.before.video) !== Boolean(e.after.video) ||
        e.before.unmatched ||
        e.after.unmatched,
    );
  const out = {
    id,
    evidence,
    title: words(task.title, "a task title"),
    beforeText: words(task.beforeText, "what happened before"),
    afterText: words(task.afterText, "what happens now"),
    steps: list(task.steps, "manual steps", 1).map((s) => words(s, "a step")),
    expected: words(task.expected, "the expected result"),
  };
  if (task.manualOnly != null && typeof task.manualOnly !== "boolean")
    invalid("manualOnly must be a boolean");
  if (task.manualOnly) {
    if (task.gap || evidence.length) invalid("A manual-only task uses steps and an expected outcome");
    out.manualOnly = true;
  } else if (needsGap || task.gap) out.gap = words(task.gap, "a reason for the evidence gap");
  if (task.scene) {
    let url;
    try {
      url = new URL(task.scene);
    } catch {
      invalid("Provide an absolute HTTP scene URL");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      invalid("Invalid scene URL");
    out.scene = url.href;
  }
  return out;
}
export function normalizeVisual(raw, range) {
  const ids = new Set();
  const tasks = list(raw?.tasks, "tasks", 1).map((t) => taskOf(t, ids));
  const spec = {
    title: words(raw.title, "a title"),
    lang: raw.lang === "ru" ? "ru" : "en",
    summary: list(raw.summary, "summary", 1).map((s) => words(s, "a summary bullet")),
    tasks,
    range,
  };
  if (raw.previous) spec.previous = words(raw.previous, "the previous round ID");
  if (raw.replies)
    spec.replies = list(raw.replies, "replies").map((r) => {
      const task = tasks.find((t) => t.id === r?.task);
      if (!task || (r.evidence && !task.evidence.some((e) => e.id === r.evidence)))
        invalid("A reply must name its replacement task and a known capture");
      const reply = {
        ref: words(r.ref, "the original mark ID"),
        task: task.id,
        text: words(r.text, "the author's reply"),
      };
      if (r.evidence) reply.evidence = r.evidence;
      if (r.side != null && !["before", "after"].includes(r.side)) invalid("Invalid replacement side");
      if (r.side) reply.side = r.side;
      for (const k of ["x", "y", "time"])
        if (r[k] != null) {
          if (!Number.isFinite(r[k]) || r[k] < 0 || (k !== "time" && r[k] > 1))
            invalid("Invalid replacement anchor");
          reply[k] = r[k];
        }
      if ("x" in reply !== "y" in reply || ("x" in reply && "time" in reply))
        invalid("Choose a replacement point or a time");
      return reply;
    });
  return spec;
}
