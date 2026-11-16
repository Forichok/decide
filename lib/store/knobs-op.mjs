// knobs-op.mjs — the `knobs` patch op (K8) as a stub until lib/store/patch.mjs exists: patch.mjs dispatches
// {op: "knobs"} here. Pure functions over a round's view; nothing is written.
//
// The view: {spec: {questions: [...]}, answers?: {[qid]: answer}, notes?: [...], outbox?: [...]}.
// A tune question's answer: {values, preset?, snapshots: [{name, values}], ...} (design, "Knobs").
//
// Two halves:
// - knobsAsk(view, {qid, text, values?}, {listening}): the user's words from the page ("make it calmer").
//   With an agent listening they become an outbox item {kind: "knobs", qid, text, values}; with none, a note.
// - knobsOp(view, op): the agent's answer, a patch {op: "knobs", qid, values?, knobs?, preview?, presets?}.
//   values moves the controls, knobs replaces them, preview replaces the mockup. The values before the change
//   are kept as a snapshot named "before" so the user can go back.

const ID = /^[A-Za-z0-9_-]{1,64}$/;

const tuneQuestion = (view, qid) => {
  const q = view?.spec?.questions?.find((x) => x.id === qid);
  if (!q) throw new Error(`knobs: no question "${qid}"`);
  if (q.type !== "tune") throw new Error(`knobs: question "${qid}" is ${q.type}, not tune`);
  return q;
};

// The values the user sees now: the answer's, over each knob's own value.
export function currentValues(view, qid) {
  const q = tuneQuestion(view, qid);
  const values = {};
  for (const k of q.knobs ?? []) if (k.value !== undefined) values[k.id] = k.value;
  return { ...values, ...(view.answers?.[qid]?.values ?? {}) };
}

export function knobsAsk(view, { qid, text, values } = {}, { listening = false } = {}) {
  tuneQuestion(view, qid);
  const words = String(text ?? "").trim();
  if (!words) throw new Error("knobs: the request has no text");
  const now = values ?? currentValues(view, qid);
  if (listening) return { ...view, outbox: [...(view.outbox ?? []), { kind: "knobs", qid, text: words, values: now }] };
  return { ...view, notes: [...(view.notes ?? []), { qid, text: words }] };
}

export function knobsOp(view, op) {
  if (op?.op !== "knobs") throw new Error(`knobs: not a knobs op (${op?.op})`);
  const qid = op.qid ?? op.question;
  const q = tuneQuestion(view, qid);
  const before = currentValues(view, qid);
  const knobs = Array.isArray(op.knobs) ? op.knobs.filter((k) => ID.test(k?.id ?? "")) : q.knobs ?? [];
  const known = new Set(knobs.map((k) => k.id));
  const moved = Object.fromEntries(Object.entries(op.values ?? {}).filter(([id]) => known.has(id)));
  // A replaced panel keeps the values of knobs that still exist.
  const kept = Object.fromEntries(Object.entries(before).filter(([id]) => known.has(id)));
  const question = { ...q, knobs, ...(op.preview ? { preview: op.preview } : {}), ...(op.presets ? { presets: op.presets } : {}) };
  const old = view.answers?.[qid] ?? {};
  const answer = { ...old, values: { ...kept, ...moved }, snapshots: [...(old.snapshots ?? []), { name: "before", values: before }] };
  return {
    ...view,
    spec: { ...view.spec, questions: view.spec.questions.map((x) => (x.id === qid ? question : x)) },
    answers: { ...(view.answers ?? {}), [qid]: answer },
  };
}
