import { randomUUID } from "node:crypto";
import { words } from "./spec.mjs";

function refuse(message) {
  throw Object.assign(new Error(message), { status: 409 });
}
export function visualChange(rec, body) {
  const { op, task: taskId, evidence, side, ref, value } = body;
  if (op === "resolve") {
    if (!rec.spec.replies?.some((r) => r.ref === ref) || !["open", "fixed"].includes(value))
      refuse("Unknown recheck item or resolution");
    return { op, ref, value };
  }
  const task = rec.spec.tasks.find((t) => t.id === taskId);
  if (!task) refuse("Unknown visual task");
  if (op === "decision") {
    if (value === null) return { op, task: task.id, value: null };
    if (!["accept", "reject", "conditional", "later"].includes(value)) refuse("Unknown task decision");
    const decision = { choice: value };
    if (value === "conditional" || value === "later") decision.note = words(body.note, "a condition or reminder");
    return { op, task: task.id, value: decision };
  }
  if (op === "check" || op === "gap") {
    if (typeof value !== "boolean" || (op === "gap" && !task.gap)) refuse("Unknown gap or invalid check");
    return { op, task: task.id, value };
  }
  if (op !== "mark" || !["before", "after"].includes(side)) refuse("Invalid visual action or side");
  const pair = task.evidence.find((e) => e.id === evidence);
  if (!pair?.[side]) refuse("Missing evidence for that side");
  const mark = {
    id: randomUUID(),
    round: rec.id,
    task: task.id,
    evidence,
    side,
    revision: rec.spec.range[side === "before" ? "base" : "head"],
    label: pair.label,
    viewport: pair.viewport,
    theme: pair.theme,
    fixture: pair.fixture,
    state: pair.state,
    text: words(body.text, "the remark"),
  };
  if (body.time != null) {
    if (
      !pair[side].video ||
      !Number.isFinite(body.time) ||
      body.time < 0 ||
      [body.x, body.y, body.w, body.h].some((v) => v != null)
    )
      refuse("Invalid video timestamp");
    mark.time = body.time;
  } else {
    const fraction = (n) => Number.isFinite(n) && n >= 0 && n <= 1;
    if (!pair[side].image || !fraction(body.x) || !fraction(body.y)) refuse("Invalid image point");
    Object.assign(mark, { x: body.x, y: body.y });
    if (body.w != null || body.h != null) {
      if (!fraction(body.w) || !fraction(body.h) || body.x + body.w > 1.000001 || body.y + body.h > 1.000001)
        refuse("Invalid image region");
      Object.assign(mark, { w: body.w, h: body.h });
    }
  }
  return { op, mark };
}
export function applyVisual(visual, change) {
  if (change.op === "mark") return { ...visual, marks: [...visual.marks, change.mark] };
  if (change.op === "decision") {
    const decisions = { ...visual.taskDecisions };
    if (change.value) decisions[change.task] = change.value;
    else delete decisions[change.task];
    return { ...visual, taskDecisions: decisions };
  }
  const field = { resolve: "resolutions", gap: "gaps", check: "checks" }[change.op];
  return { ...visual, [field]: { ...visual[field], [change.ref ?? change.task]: change.value } };
}
export function visualVerdict(spec, state, payload) {
  if (payload.cancelled) return { cancelled: true, digest: "Visual acceptance cancelled" };
  if (payload.dismissed) return { dismissed: true, digest: "Visual acceptance dismissed" };
  const { verdict } = payload;
  const note = payload.note ? words(payload.note, "the verdict note") : "";
  const decisions = Object.entries(state.taskDecisions || {});
  if (!["return", "approve"].includes(verdict)) refuse("Choose approve or return");
  if (verdict === "approve") {
    if (decisions.some(([, d]) => d.choice === "reject" || d.choice === "later"))
      refuse("Resolve rejected or deferred tasks before approval");
    if (spec.tasks.some((t) => t.manualOnly && !state.checks[t.id]))
      refuse("Complete the manual check before approval");
    if (spec.tasks.some((t) => t.gap && !state.checks[t.id] && !state.gaps[t.id]))
      refuse("Acknowledge each evidence gap before approval");
    if (spec.replies?.some((r) => state.resolutions[r.ref] !== "fixed"))
      refuse("Recheck every returned remark before approval");
  } else if (!note && !state.marks.length && !decisions.some(([, d]) => d.choice !== "accept") && !spec.replies?.some((r) => state.resolutions[r.ref] !== "fixed"))
    refuse("Add a remark or a note for the return");
  return {
    verdict,
    note,
    digest: [
      `${spec.title} — ${verdict}`,
      note,
      ...decisions.map(([id, d]) => `${id}: ${d.choice}${d.note ? " — " + d.note : ""}`),
      ...(spec.replies ?? []).map(
        (r) => `${state.resolutions[r.ref] ?? "open"}: ${r.original.text} [${r.ref}] — ${r.text}`,
      ),
      ...state.marks.map(
        (m) =>
          `${m.task} / ${m.evidence} / ${m.side} ${m.time != null ? m.time + "s" : [m.x, m.y].join(", ")}: ${m.text} [${m.id}]`,
      ),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
