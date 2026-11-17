// rules.js — the rules of a round: conditions on answers that ghost questions,
// bring them back, take options away or mark an answer for checking. Shared by
// the page and the server like logic.js: no DOM, no imports, nothing runs at
// import.
//
// A rule: { when, reason, do: [op, ...] }
//   when  { question, in?: [ids], notIn?: [ids], equals?, answered?: bool }
//         { all: [when, ...] }  { any: [when, ...] }  { not: when }
//         A leaf's tests all hold together; a leaf with no test means "answered".
//         `q` is accepted for `question`, as in 2.x showIf.
//   do    { ghost: id | [ids] }  { restore: id | [ids] }
//         { removeOptions: { question, options: [ids] } }  { stale: id | [ids] }
//         An op may carry its own reason. Rules never set or add: an agent's patch does.
//
// Effects come from the current answers alone, so changing an answer back
// undoes them. A ghosted question's answer does not count for any condition.
// Evaluation repeats until the ghosts stop changing, at most items + 1 passes.
// Rules that feed each other can flip forever; then only what every state of
// the cycle ghosts is a ghost, the rest stays shown, the result says
// settled: false, and lintRules names the loop.

export const RULE_OPS = ["ghost", "restore", "removeOptions", "stale"];
const LEAF_TESTS = ["in", "notIn", "equals", "answered"];

const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const ids = (v) => list(v).map(String);
const str = (v) => (typeof v === "string" ? v.trim() : "");

// The items of a round: the questions, or a swipe deck's cards.
export const itemsOf = (spec) => (Array.isArray(spec?.questions) ? spec.questions : Array.isArray(spec?.cards) ? spec.cards : []);

// Ids as the spec normaliser gives them: q1, q2… for a question, a, b… for an option.
const itemId = (q, i) => str(q?.id) || `q${i + 1}`;
const optionIds = (q) => list(q?.options).map((o, i) => (o && typeof o === "object" && str(o.id)) || String.fromCharCode(97 + i));

// What an answer picked: a choice's options, or a swipe card's side.
export function selectedOf(a) {
  if (!a || typeof a !== "object") return [];
  if (Array.isArray(a.selected)) return a.selected.map(String);
  if (typeof a.side === "string" && a.side !== "skip") return [a.side];
  return [];
}

// An answer counts when it says something: picked options, an own option, a value, text, a ranking
// the user touched, a swipe side. A flag alone ("up to the agent", "skip") does not.
export function hasAnswer(a) {
  if (!a || typeof a !== "object") return false;
  if (selectedOf(a).length) return true;
  if (typeof a.other === "string" && a.other.trim()) return true;
  if (Number.isFinite(a.value)) return true;
  if (typeof a.text === "string" && a.text.trim()) return true;
  if (a.touched === true) return true;
  if (!("touched" in a) && Array.isArray(a.order) && a.order.length) return true;
  return false;
}

function equalsAnswer(a, want) {
  if (!a || typeof a !== "object") return false;
  if (Array.isArray(want)) {
    const sel = selectedOf(a);
    return sel.length === want.length && want.every((w) => sel.includes(String(w)));
  }
  if (Number.isFinite(a.value) && a.value === want) return true;
  if (typeof a.text === "string" && a.text.trim() && a.text.trim() === String(want)) return true;
  const sel = selectedOf(a);
  return sel.length === 1 && sel[0] === String(want);
}

// One condition against the answers, with the ghosted items' answers left out.
function holds(cond, answers, ghosted) {
  if (!cond || typeof cond !== "object") return false;
  if (Array.isArray(cond)) return cond.every((c) => holds(c, answers, ghosted));
  const parts = [];
  if (Array.isArray(cond.all)) parts.push(cond.all.every((c) => holds(c, answers, ghosted)));
  if (Array.isArray(cond.any)) parts.push(cond.any.some((c) => holds(c, answers, ghosted)));
  if (cond.not !== undefined) parts.push(!holds(cond.not, answers, ghosted));
  const qid = str(cond.question) || str(cond.q);
  if (qid) {
    const a = ghosted.has(qid) ? undefined : answers?.[qid];
    const sel = selectedOf(a);
    if (!LEAF_TESTS.some((k) => cond[k] !== undefined)) parts.push(hasAnswer(a));
    if (cond.in !== undefined) {
      const want = ids(cond.in);
      parts.push(want.length === 0 || want.some((id) => sel.includes(id)));
    }
    if (cond.notIn !== undefined) parts.push(!ids(cond.notIn).some((id) => sel.includes(id)));
    if (cond.equals !== undefined) parts.push(equalsAnswer(a, cond.equals));
    if (cond.answered !== undefined) parts.push(hasAnswer(a) === Boolean(cond.answered));
  }
  return parts.length > 0 && parts.every(Boolean);
}

// The one op an entry of `do` names, as [name, value]; null when it names none or several.
export function opOf(op) {
  if (!op || typeof op !== "object" || Array.isArray(op)) return null;
  const keys = Object.keys(op).filter((k) => k !== "reason");
  return keys.length === 1 ? [keys[0], op[keys[0]]] : null;
}

// A 2.x showIf as a rule that ghosts the question while the condition fails. showIf is
// [{q, in, notIn}] once normalised, or one object, with `question` and `selected` as older spellings.
// null when the question has no showIf that limits anything.
export function showIfToRule(question) {
  if (!question || typeof question !== "object") return null;
  const id = str(question.id);
  if (!id) return null;
  const fails = [];
  const said = [];
  for (const c of list(question.showIf)) {
    if (!c || typeof c !== "object") continue;
    const q = str(c.q) || str(c.question);
    if (!q) continue;
    const inIds = ids(c.in ?? c.selected);
    const notIds = ids(c.notIn);
    // Shown when one of `in` is picked and none of `notIn`: a ghost when none of `in` is, or one of `notIn` is.
    if (inIds.length) {
      fails.push({ question: q, notIn: inIds });
      said.push(`${q} is ${inIds.join(" or ")}`);
    }
    if (notIds.length) {
      fails.push({ question: q, in: notIds });
      said.push(`${q} is not ${notIds.join(" or ")}`);
    }
  }
  if (!fails.length) return null;
  return { when: fails.length === 1 ? fails[0] : { any: fails }, reason: `asked only when ${said.join(" and ")}`, do: [{ ghost: [id] }], from: "showIf" };
}

// The rules a spec runs: its own, then each 2.x showIf as a ghost rule.
export function rulesOf(spec) {
  const own = Array.isArray(spec?.rules) ? spec.rules : [];
  return [...own, ...itemsOf(spec).map(showIfToRule).filter(Boolean)];
}

const asMap = (m) => (m instanceof Map ? m : new Map(Object.entries(m && typeof m === "object" ? m : {})));

// evaluate(spec, answers, { ghosted?, forced? }) →
//   { ghosts: Map<id, reason>, removed: Map<qid, Set<optionId>>, stale: Set<qid>,
//     restored: Map<id, reason>, reasons: Map<qid, reason>, removedReasons: Map<qid, reason>,
//     settled: boolean }
// answers: { qid: answer }, as the page keeps them or as the answers file has them.
// ghosted: items that are ghosts before the rules run (an agent's ordinary patch); a rule may restore them.
// forced: Map or object id → "ghost" | "shown": what beats the rules (an override patch, the user's restore).
// ghosts and restored hold only what the rules did. stale holds every answer a rule wants checked,
// answered or not, and reasons says why for each; removedReasons says why options went. settled is false when rules feed each other and
// the answers make them flip (lintRules names such loops).
export function evaluate(spec, answers = {}, { ghosted = [], forced = new Map() } = {}) {
  const rules = rulesOf(spec);
  const outside = new Set(ids([...ghosted]));
  const force = asMap(forced);
  const cap = itemsOf(spec).length + 1;

  const effective = (ruleGhost) => {
    const g = new Set(outside);
    for (const [id, s] of ruleGhost) {
      if (s.ghost) g.add(id);
      else g.delete(id);
    }
    for (const [id, f] of force) {
      if (f === "ghost") g.add(id);
      else if (f === "shown") g.delete(id);
    }
    return g;
  };

  // One pass: every rule whose condition holds under these ghosts, in spec order; a later rule wins.
  const pass = (ghostSet) => {
    const ruleGhost = new Map();
    const removed = new Map();
    const stale = new Set();
    const reasons = new Map();
    const removedReasons = new Map();
    for (const rule of rules) {
      if (!rule || typeof rule !== "object" || !holds(rule.when, answers, ghostSet)) continue;
      const reason = str(rule.reason);
      for (const op of list(rule.do)) {
        const [name, value] = opOf(op) ?? [];
        const why = str(op?.reason) || reason;
        if (name === "ghost") for (const id of ids(value)) ruleGhost.set(id, { ghost: true, reason: why });
        else if (name === "restore") for (const id of ids(value)) ruleGhost.set(id, { ghost: false, reason: why });
        else if (name === "stale") {
          for (const id of ids(value)) {
            stale.add(id);
            reasons.set(id, why);
          }
        } else if (name === "removeOptions" && value && typeof value === "object") {
          const qid = str(value.question) || str(value.q);
          if (!qid) continue;
          const set = removed.get(qid) ?? new Set();
          for (const o of ids(value.options)) set.add(o);
          removed.set(qid, set);
          removedReasons.set(qid, why);
          // A removed option that was picked makes the answer one to check.
          if (!ghostSet.has(qid) && selectedOf(answers?.[qid]).some((o) => set.has(o))) {
            stale.add(qid);
            reasons.set(qid, why);
          }
        }
      }
    }
    return { ruleGhost, removed, stale, reasons, removedReasons, next: effective(ruleGhost) };
  };

  const key = (set) => [...set].sort().join("\u0000");
  let ghostSet = effective(new Map());
  const states = [ghostSet];
  let settled = false;
  let cycle = null;
  for (let i = 0; i < cap; i++) {
    const { next } = pass(ghostSet);
    if (key(next) === key(ghostSet)) {
      settled = true;
      break;
    }
    const at = states.findIndex((s) => key(s) === key(next));
    ghostSet = next;
    if (at >= 0) {
      cycle = states.slice(at);
      break;
    }
    states.push(next);
  }
  if (!settled) {
    // Flipping: what every state of the cycle ghosts stays a ghost, the rest stays shown.
    const ring = cycle ?? states.slice(-2);
    ghostSet = new Set([...ring[0]].filter((id) => ring.every((s) => s.has(id))));
  }

  const last = pass(ghostSet);
  const ghosts = new Map();
  const restored = new Map();
  for (const [id, s] of last.ruleGhost) {
    if (s.ghost && ghostSet.has(id) && force.get(id) !== "ghost") ghosts.set(id, s.reason);
    if (!s.ghost && !ghostSet.has(id) && force.get(id) !== "shown") restored.set(id, s.reason);
  }
  if (!settled) {
    // An item ghosted in every state of the cycle got there by a rule in some pass: take that reason.
    for (const id of ghostSet) {
      if (ghosts.has(id) || outside.has(id) || force.get(id) === "ghost") continue;
      for (const s of cycle ?? states) {
        const found = pass(s).ruleGhost.get(id);
        if (found?.ghost) {
          ghosts.set(id, found.reason);
          break;
        }
      }
    }
  }
  const stale = new Set([...last.stale].filter((id) => !ghostSet.has(id)));
  const reasons = new Map([...last.reasons].filter(([id]) => stale.has(id)));
  return { ghosts, removed: last.removed, stale, restored, reasons, removedReasons: last.removedReasons, settled };
}

// lintRules(spec) → [{ level: "error" | "warn", message, path }]: unknown questions and options,
// unknown or forbidden operations, and loops (a ghost or restore here changes a condition there).
export function lintRules(spec) {
  const issues = [];
  const add = (level, path, message) => issues.push({ level, message, path });
  const items = itemsOf(spec);
  const byId = new Map(items.map((q, i) => [itemId(q, i), q]));
  const raw = spec?.rules;
  if (raw !== undefined && !Array.isArray(raw)) {
    add("error", "rules", "rules must be a list");
    return issues;
  }
  const rules = Array.isArray(raw) ? raw : [];

  const knownQuestion = (qid, path, what) => {
    if (!qid) {
      add("error", path, `${what} names no question`);
      return null;
    }
    if (!byId.has(qid)) {
      add("error", path, `${what} names unknown question "${qid}"`);
      return null;
    }
    return byId.get(qid);
  };
  const knownOptions = (q, qid, named, path) => {
    const own = optionIds(q);
    if (!own.length) {
      add("warn", path, `"${qid}" has no options to name; test its answer with equals or answered`);
      return;
    }
    for (const o of named) if (!own.includes(o)) add("error", path, `unknown option "${o}" of "${qid}"`);
  };

  const checkWhen = (cond, path) => {
    if (!cond || typeof cond !== "object") {
      add("error", path, "a condition must be an object");
      return;
    }
    if (Array.isArray(cond)) {
      cond.forEach((c, i) => checkWhen(c, `${path}[${i}]`));
      return;
    }
    const known = new Set(["question", "q", "all", "any", "not", ...LEAF_TESTS]);
    for (const k of Object.keys(cond)) if (!known.has(k)) add("error", path, `unknown condition field "${k}" (use question, in, notIn, equals, answered, all, any, not)`);
    for (const k of ["all", "any"]) {
      if (cond[k] === undefined) continue;
      if (!Array.isArray(cond[k]) || !cond[k].length) add("error", `${path}.${k}`, `${k} must be a non-empty list of conditions`);
      else cond[k].forEach((c, i) => checkWhen(c, `${path}.${k}[${i}]`));
    }
    if (cond.not !== undefined) checkWhen(cond.not, `${path}.not`);
    const qid = str(cond.question) || str(cond.q);
    const tested = LEAF_TESTS.filter((k) => cond[k] !== undefined);
    if (!qid) {
      if (tested.length) add("error", path, `${tested.join(", ")} without a question`);
      else if (cond.all === undefined && cond.any === undefined && cond.not === undefined) add("error", path, "an empty condition");
      return;
    }
    const q = knownQuestion(qid, path, "the condition");
    if (!q) return;
    const named = [...ids(cond.in), ...ids(cond.notIn)];
    if (named.length) knownOptions(q, qid, named, path);
    if (cond.answered !== undefined && typeof cond.answered !== "boolean") add("warn", path, "answered is true or false");
  };

  rules.forEach((rule, i) => {
    const path = `rules[${i}]`;
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      add("error", path, "a rule is { when, reason, do }");
      return;
    }
    for (const k of Object.keys(rule)) if (!["when", "reason", "do", "from"].includes(k)) add("error", path, `unknown rule field "${k}" (use when, reason, do)`);
    if (rule.when === undefined) add("error", path, "a rule needs when: the condition on answers");
    else checkWhen(rule.when, `${path}.when`);
    if (!str(rule.reason)) add("warn", path, "no reason: the page shows it on every ghost and changed question");
    const ops = list(rule.do);
    if (!ops.length) add("warn", path, "do is empty: the rule changes nothing");
    ops.forEach((op, j) => {
      const at = `${path}.do[${j}]`;
      const found = opOf(op);
      if (!found) {
        add("error", at, `an operation names exactly one of ${RULE_OPS.join(", ")}`);
        return;
      }
      const [name, value] = found;
      if (!RULE_OPS.includes(name)) {
        const patchOnly = ["set", "add", "remove", "addOptions", "setOptions", "recommend", "brief", "knobs"].includes(name);
        add("error", at, patchOnly ? `rules don't ${name}: an agent's patch does; a rule can ${RULE_OPS.join(", ")}` : `unknown operation "${name}" (use ${RULE_OPS.join(", ")})`);
        return;
      }
      if (name === "removeOptions") {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          add("error", at, "removeOptions is { question, options: [ids] }");
          return;
        }
        const qid = str(value.question) || str(value.q);
        const q = knownQuestion(qid, at, "removeOptions");
        const opts = ids(value.options);
        if (!opts.length) add("error", at, "removeOptions names no option");
        else if (q) knownOptions(q, qid, opts, at);
        return;
      }
      const targets = ids(value);
      if (!targets.length) add("error", at, `${name} names no question`);
      for (const id of targets) knownQuestion(id, at, name);
    });
  });

  for (const loop of rulesLoops(spec)) {
    add("warn", "rules", `rules loop: ${loop.map((id) => `"${id}"`).join(" → ")}. A ghost or restore on one changes a condition on the next, so answers can make them flip; while they flip, these questions stay shown`);
  }
  return issues;
}

// The questions a condition reads.
function readsOf(cond, out = new Set()) {
  if (!cond || typeof cond !== "object") return out;
  if (Array.isArray(cond)) {
    for (const c of cond) readsOf(c, out);
    return out;
  }
  const qid = str(cond.question) || str(cond.q);
  if (qid) out.add(qid);
  for (const c of list(cond.all)) readsOf(c, out);
  for (const c of list(cond.any)) readsOf(c, out);
  if (cond.not !== undefined) readsOf(cond.not, out);
  return out;
}

// Loops between rules, each as the question ids around it, first id repeated last ("a", "b", "a"),
// starting from the smallest id. An edge runs from a question a condition reads to the item the
// rule ghosts or restores, since a ghost takes that item's answer out of every condition. 2.x
// showIf counts too. At most 20 loops.
export function rulesLoops(spec) {
  const edges = new Map();
  for (const rule of rulesOf(spec)) {
    if (!rule || typeof rule !== "object") continue;
    const targets = [];
    for (const op of list(rule.do)) {
      const [name, value] = opOf(op) ?? [];
      if (name === "ghost" || name === "restore") targets.push(...ids(value));
    }
    for (const from of readsOf(rule.when)) {
      const set = edges.get(from) ?? new Set();
      for (const t of targets) set.add(t);
      edges.set(from, set);
    }
  }
  const loops = [];
  const LIMIT = 20;
  // Each loop is found once, from its smallest id: the walk only visits ids above the start.
  const walk = (start, node, path, onPath) => {
    for (const next of [...(edges.get(node) ?? [])].sort()) {
      if (loops.length >= LIMIT) return;
      if (next === start) loops.push([...path, start]);
      else if (next > start && !onPath.has(next)) {
        onPath.add(next);
        walk(start, next, [...path, next], onPath);
        onPath.delete(next);
      }
    }
  };
  for (const start of [...edges.keys()].sort()) walk(start, start, [start], new Set([start]));
  return loops;
}
