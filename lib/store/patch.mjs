// patch.mjs — an agent's patch applied to a round's view: pure, returns a new
// view, never touches the one it was given. view.mjs builds the view and
// decides the order (who wins); this file only knows what each operation does.
//
// A patch: { ops: [op, ...], reason?, keepAnswers?, override?, seq? }
//   reason       why, shown on every item the patch touches unless an op says its own
//   keepAnswers  a cosmetic edit: nothing it does marks an answer stale (the stale op still does)
//   override     beats the rules; view.mjs applies such patches after the rules, applyPatch does not care
//   seq          the event's place in the log: an answer or "keep" after it outranks its stale marks
// An op names one operation and may carry its own reason:
//   { ghost: id | [ids] }                      greys an item out; its answer moves to ghostAnswers
//   { restore: id | [ids] }                    brings a ghost back with its answer
//   { set: { id, ...fields } }                 changes fields of an item ("options" goes through setOptions)
//   { addOptions: { question, options, before?, after? } }  an existing id is rewritten in place
//   { removeOptions: { question, options: [ids] } }
//   { setOptions: { question, options } }      the whole list
//   { add: { item, before?, after? } }         a new item before or after another, else at the end
//   { remove: id | [ids] }                     drops an item the user has not seen; a seen one becomes a ghost
//   { recommend: { question, option | options, reason } }
//   { stale: id | [ids] }                      marks an answer for checking, keepAnswers or not
//   { brief: value }                           rewrites the task panel
// Options in addOptions and setOptions are expected normalised (the patch tool normalises them like
// a spec's); a bare string becomes { id, label } with the next free letter as the id.
//
// The view (view.mjs makes it, see viewOf):
//   items        [{ id, state, reason, was, item, ghosted, ghostReason, changeReason, isNew, addReason, first }]
//                state "normal" | "changed" | "new" | "ghost"; reason is the one the page shows;
//                was is the item as first shown when it changed since, else null; item is the item now
//   answers      { id: answer } of items that are not ghosts
//   ghostAnswers { id: answer } of ghosts, kept to come back on restore
//   stale        [id] answers to check; staleReasons { id: reason }
//   brief, seen [ids the user has seen], confirmedAt? { id: seq of the last answer or keep }

import { hasAnswer, opOf, selectedOf } from "../../ui/js/rules.js";

export const PATCH_OPS = ["ghost", "restore", "set", "addOptions", "removeOptions", "setOptions", "add", "remove", "recommend", "stale", "brief"];
// Fields whose change makes an answer doubtful: the question itself, or how it is answered.
// A swipe card's two sides are how it is answered.
export const STALE_FIELDS = ["title", "type", "scale", "min", "max", "left", "right"];

const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const ids = (v) => list(v).map(String);
const str = (v) => (typeof v === "string" ? v.trim() : "");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What the page shows for an entry, from its flags.
export function settle(e) {
  const state = e.ghosted ? "ghost" : e.isNew ? "new" : e.changeReason !== null ? "changed" : "normal";
  const reason = e.ghosted ? e.ghostReason : e.isNew ? e.addReason : e.changeReason;
  return { ...e, state, reason: reason ?? null, was: e.changeReason !== null && !e.isNew ? e.first : null };
}

// An entry for an item of the spec as opened, or one a patch adds.
export function entryOf(item, { isNew = false, reason = "" } = {}) {
  return settle({ id: String(item.id), item, first: item, ghosted: false, ghostReason: null, changeReason: null, isNew, addReason: isNew ? reason : null });
}

function cloneView(view) {
  return {
    ...view,
    items: [...(view.items ?? [])],
    answers: { ...(view.answers ?? {}) },
    ghostAnswers: { ...(view.ghostAnswers ?? {}) },
    stale: [...(view.stale ?? [])],
    staleReasons: { ...(view.staleReasons ?? {}) },
    seen: [...(view.seen ?? [])],
  };
}

// Mutators on a cloned view; each replaces the entry it changes.
function editor(view, patch) {
  const seq = Number.isFinite(patch?.seq) ? patch.seq : Infinity;
  const keep = patch?.keepAnswers === true;
  const at = (id) => view.items.findIndex((e) => e.id === id);
  const get = (id) => view.items[at(id)] ?? null;
  const put = (e) => {
    const i = at(e.id);
    if (i >= 0) view.items[i] = settle(e);
  };
  const answerOf = (id) => view.answers[id] ?? view.ghostAnswers[id];
  const markStale = (id, reason, { always = false } = {}) => {
    if (keep && !always) return;
    const e = get(id);
    if (!e || e.ghosted || !hasAnswer(view.answers[id])) return;
    // An answer given or kept after this patch already answers it.
    if ((view.confirmedAt?.[id] ?? -Infinity) >= seq) return;
    if (!view.stale.includes(id)) view.stale.push(id);
    view.staleReasons[id] = reason;
  };
  const unstale = (id) => {
    view.stale = view.stale.filter((s) => s !== id);
    delete view.staleReasons[id];
  };
  const changed = (e, reason) => ({ ...e, changeReason: reason });
  const ghost = (id, reason) => {
    const e = get(id);
    if (!e) return;
    // A ghost ghosted again takes the newer reason: the later layer is the stronger one.
    if (e.ghosted) {
      if (reason) put({ ...e, ghostReason: reason });
      return;
    }
    put({ ...e, ghosted: true, ghostReason: reason });
    if (id in view.answers) {
      view.ghostAnswers[id] = view.answers[id];
      delete view.answers[id];
    }
    unstale(id);
  };
  const restore = (id) => {
    const e = get(id);
    if (!e || !e.ghosted) return;
    put({ ...e, ghosted: false, ghostReason: null });
    if (id in view.ghostAnswers) {
      view.answers[id] = view.ghostAnswers[id];
      delete view.ghostAnswers[id];
    }
  };
  // The options of an item changed: a picked one that is gone or reworded makes the answer stale.
  const setOptionsOf = (e, options, reason) => {
    if (same(options, e.item.options ?? [])) return;
    const before = new Map((e.item.options ?? []).map((o) => [o.id, o]));
    const after = new Map(options.map((o) => [o.id, o]));
    put(changed({ ...e, item: { ...e.item, options } }, reason));
    const picked = selectedOf(answerOf(e.id));
    const hit = picked.some((id) => before.has(id) && (!after.has(id) || !same(wording(before.get(id)), wording(after.get(id)))));
    if (hit) markStale(e.id, reason);
  };
  return { view, get, put, ghost, restore, markStale, unstale, changed, setOptionsOf, answerOf };
}

const wording = (o) => ({ label: o?.label ?? "", detail: o?.detail ?? "" });

// Options as given, with an id for each: a bare string becomes { id, label }.
function optionsFrom(raw, taken) {
  const used = new Set(taken);
  const free = () => {
    for (let i = 0; ; i++) {
      const id = i < 26 ? String.fromCharCode(97 + i) : `o${i + 1}`;
      if (!used.has(id)) return id;
    }
  };
  return list(raw).map((o) => {
    const opt = typeof o === "string" ? { label: o } : { ...(o || {}) };
    opt.id = str(opt.id) || free();
    used.add(opt.id);
    return opt;
  });
}

const placeAt = (items, { before, after }) => {
  if (before !== undefined) {
    const i = items.findIndex((e) => e.id === String(before));
    if (i >= 0) return i;
  }
  if (after !== undefined) {
    const i = items.findIndex((e) => e.id === String(after));
    if (i >= 0) return i + 1;
  }
  return items.length;
};

// applyPatch(view, patch) → view: every op in order; an op on an unknown id changes nothing
// (validatePatch reports it).
export function applyPatch(view, patch) {
  const ed = editor(cloneView(view), patch);
  const v = ed.view;
  const patchReason = str(patch?.reason);
  for (const op of list(patch?.ops)) {
    const [name, value] = opOf(op) ?? [];
    const reason = str(op?.reason) || patchReason;
    switch (name) {
      case "ghost":
        for (const id of ids(value)) ed.ghost(id, reason);
        break;
      case "restore":
        for (const id of ids(value)) ed.restore(id);
        break;
      case "set": {
        if (!value || typeof value !== "object") break;
        const e = ed.get(String(value.id ?? ""));
        if (!e) break;
        const { id, options, ...fields } = value;
        const doubtful = STALE_FIELDS.some((k) => k in fields && !same(fields[k], e.item[k]));
        ed.put(ed.changed({ ...e, item: { ...e.item, ...fields } }, reason));
        if (doubtful) ed.markStale(e.id, reason);
        if (options !== undefined) ed.setOptionsOf(ed.get(e.id), optionsFrom(options, []), reason);
        break;
      }
      case "addOptions": {
        const e = value && ed.get(String(value.question ?? ""));
        if (!e) break;
        const current = [...(e.item.options ?? [])];
        const fresh = optionsFrom(value.options, current.map((o) => o.id));
        const known = new Map(current.map((o, i) => [o.id, i]));
        const added = [];
        for (const o of fresh) {
          // An existing id is the agent rewording that option.
          if (known.has(o.id)) current[known.get(o.id)] = { ...current[known.get(o.id)], ...o };
          else added.push(o);
        }
        let at = current.length;
        if (value.before !== undefined && known.has(String(value.before))) at = known.get(String(value.before));
        else if (value.after !== undefined && known.has(String(value.after))) at = known.get(String(value.after)) + 1;
        current.splice(at, 0, ...added);
        ed.setOptionsOf(e, current, reason);
        break;
      }
      case "removeOptions": {
        const e = value && ed.get(String(value.question ?? ""));
        if (!e) break;
        const gone = new Set(ids(value.options));
        ed.setOptionsOf(e, (e.item.options ?? []).filter((o) => !gone.has(o.id)), reason);
        break;
      }
      case "setOptions": {
        const e = value && ed.get(String(value.question ?? ""));
        if (!e) break;
        ed.setOptionsOf(e, optionsFrom(value.options, []), reason);
        break;
      }
      case "add": {
        const item = value && (value.item ?? value.question ?? value.card);
        if (!item || typeof item !== "object" || !str(item.id) || ed.get(str(item.id))) break;
        const entry = entryOf({ ...item, id: str(item.id) }, { isNew: true, reason });
        v.items.splice(placeAt(v.items, value), 0, entry);
        break;
      }
      case "remove":
        for (const id of ids(value)) {
          if (!ed.get(id)) continue;
          // Something the user has seen or answered never disappears: it greys out with the reason.
          const seen = v.seen.includes(id) || hasAnswer(ed.answerOf(id));
          if (seen) ed.ghost(id, reason);
          else {
            v.items = v.items.filter((e) => e.id !== id);
            delete v.answers[id];
            delete v.ghostAnswers[id];
            ed.unstale(id);
          }
        }
        break;
      case "recommend": {
        const e = value && ed.get(String(value.question ?? ""));
        if (!e) break;
        const picks = ids(value.options ?? value.option);
        const why = str(value.reason) || reason;
        let item;
        if (Array.isArray(e.item.options) && e.item.options.length) {
          item = { ...e.item, options: e.item.options.map((o) => (picks.includes(o.id) ? { ...o, recommended: true, reason: why } : { ...o, recommended: false })) };
        } else item = { ...e.item, recommended: picks[0] ?? null, reason: why };
        ed.put(ed.changed({ ...e, item }, why));
        break;
      }
      case "stale":
        for (const id of ids(value)) ed.markStale(id, reason, { always: true });
        break;
      case "brief":
        v.brief = value;
        break;
      default:
        break;
    }
  }
  return v;
}

// validatePatch(spec, patch) → [{ level, message, path }]: what the patch tool refuses (errors) or
// passes on with a word (warnings). spec is the round's spec, or a view (its items are read).
export function validatePatch(spec, patch) {
  const issues = [];
  const add = (level, path, message) => issues.push({ level, message, path });
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    add("error", "patch", "a patch is { ops: [...], reason, keepAnswers?, override? }");
    return issues;
  }
  const ops = patch.ops;
  if (!Array.isArray(ops) || !ops.length) add("error", "ops", "ops must be a non-empty list of operations");
  for (const k of ["keepAnswers", "override"]) if (patch[k] !== undefined && typeof patch[k] !== "boolean") add("warn", k, `${k} is true or false`);
  const patchReason = str(patch.reason);

  // Items as the ops go: an op may act on an item an earlier op of the same patch added.
  const source = Array.isArray(spec?.items) ? spec.items.map((e) => e.item ?? e) : Array.isArray(spec?.questions) ? spec.questions : Array.isArray(spec?.cards) ? spec.cards : [];
  const items = new Map(source.map((q) => [String(q.id), { options: (q.options ?? []).map((o) => String(o.id)) }]));
  const item = (id, path, name) => {
    const key = String(id ?? "");
    if (!key) add("error", path, `${name} names no item`);
    else if (!items.has(key)) add("error", path, `${name}: no item "${key}"`);
    return items.get(key) ?? null;
  };
  const optionList = (raw, path, name) => {
    const out = [];
    list(raw).forEach((o, i) => {
      if (typeof o === "string") return;
      if (!o || typeof o !== "object") add("error", `${path}.options[${i}]`, `${name}: an option is an object or its label`);
      else {
        if (!str(o.label)) add("error", `${path}.options[${i}]`, `${name}: an option needs a label`);
        if (str(o.id)) {
          if (out.includes(str(o.id))) add("error", `${path}.options[${i}]`, `${name}: duplicate option id "${o.id}"`);
          out.push(str(o.id));
        }
      }
    });
    return out;
  };

  list(ops).forEach((op, i) => {
    const path = `ops[${i}]`;
    const found = opOf(op);
    if (!found) {
      add("error", path, `an operation names exactly one of ${PATCH_OPS.join(", ")} (and may carry a reason)`);
      return;
    }
    const [name, value] = found;
    const reason = str(op.reason) || patchReason;
    if (!PATCH_OPS.includes(name)) {
      add("error", path, `unknown operation "${name}" (use ${PATCH_OPS.join(", ")})`);
      return;
    }
    if (["ghost", "restore", "remove", "stale"].includes(name)) {
      const targets = ids(value);
      if (!targets.length) add("error", path, `${name} names no item`);
      for (const id of targets) item(id, path, name);
      if (name === "ghost" && !reason) add("warn", path, "a ghost without a reason: the page shows it next to the greyed-out item");
      if (name === "remove") for (const id of targets) items.delete(id);
      return;
    }
    if (name === "brief") return;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      add("error", path, `${name} takes an object`);
      return;
    }
    if (name === "set") {
      const target = item(value.id, path, "set");
      const fields = Object.keys(value).filter((k) => k !== "id");
      if (!fields.length) add("warn", path, "set changes no field");
      if ("options" in value) add("warn", path, "set with options: setOptions says the same more plainly");
      if (target && "options" in value) target.options = optionList(value.options, path, "set");
      return;
    }
    if (name === "add") {
      const it = value.item ?? value.question ?? value.card;
      if (!it || typeof it !== "object") {
        add("error", path, "add is { item, before?, after? }");
        return;
      }
      const id = str(it.id);
      if (!id) add("error", path, "an added item needs an id");
      else if (items.has(id)) add("error", path, `add: item "${id}" exists; pick a new id or use set`);
      if (value.before !== undefined && value.after !== undefined) add("error", path, "add takes before or after, not both");
      for (const k of ["before", "after"]) if (value[k] !== undefined && !items.has(String(value[k]))) add("error", path, `add: no item "${value[k]}" to go ${k}`);
      if (!reason) add("warn", path, "an added item without a reason: the page shows why it is new");
      if (id && !items.has(id)) items.set(id, { options: optionList(it.options, path, "add") });
      return;
    }
    // The option operations and recommend name a question.
    const target = item(value.question, path, name);
    if (!target) return;
    if (name === "addOptions") {
      const given = optionList(value.options, path, name);
      if (!list(value.options).length) add("error", path, "addOptions names no option");
      for (const id of given) if (target.options.includes(id)) add("warn", path, `addOptions: option "${id}" exists and will be reworded`);
      for (const k of ["before", "after"]) if (value[k] !== undefined && !target.options.includes(String(value[k]))) add("error", path, `addOptions: no option "${value[k]}" to go ${k}`);
      target.options.push(...given.filter((id) => !target.options.includes(id)));
    } else if (name === "removeOptions") {
      const gone = ids(value.options);
      if (!gone.length) add("error", path, "removeOptions names no option");
      for (const id of gone) if (!target.options.includes(id)) add("error", path, `removeOptions: no option "${id}" in "${value.question}"`);
      target.options = target.options.filter((id) => !gone.includes(id));
      if (gone.length && !target.options.length) add("warn", path, `removeOptions leaves "${value.question}" with no options`);
    } else if (name === "setOptions") {
      if (!list(value.options).length) add("error", path, "setOptions needs at least one option");
      target.options = optionList(value.options, path, name);
    } else if (name === "recommend") {
      const picks = ids(value.options ?? value.option);
      if (!picks.length) add("error", path, "recommend names no option");
      if (target.options.length) for (const id of picks) if (!target.options.includes(id)) add("error", path, `recommend: no option "${id}" in "${value.question}"`);
      if (!str(value.reason) && !reason) add("warn", path, "recommend without a reason: the page shows why the recommendation moved");
    }
  });
  return issues;
}
