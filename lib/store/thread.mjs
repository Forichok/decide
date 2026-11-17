// Round conversation entries have no qid. They cannot alias an item, even when an item is named "thread".
const refuse = (message) => Object.assign(new Error(message), { status: 400 });

export function checkedChoice(choice) {
  if (choice === undefined) return undefined;
  if (!choice || typeof choice !== 'object' || typeof choice.text !== 'string' || !choice.text.trim() || choice.text.length > 4000 || !Array.isArray(choice.options) || choice.options.length !== 2 || choice.options.some(x => typeof x !== 'string' || !x.trim() || x.length > 1000) || choice.options[0].trim() === choice.options[1].trim()) throw refuse('choice needs text and two distinct, non-empty options');
  return { text: choice.text.trim(), options: choice.options.map(x => x.trim()) };
}

// Validate before a reply's optional patch is applied, so a refused reply cannot change the round.
export function checkedThreadReply(state, { qid, askId, choice } = {}) {
  if (qid) {
    if (choice !== undefined) throw refuse('choice belongs to the round thread; omit question');
    return undefined;
  }
  if (askId && !state.thread.some(m => m.id === askId && m.from === 'user')) throw refuse('unknown thread message');
  return checkedChoice(choice);
}

export function applyMessage(state, e) {
  const entry = { id: e.id, from: 'user', text: e.text, at: e.at, seq: e.seq, ...(e.replyTo ? { replyTo: e.replyTo } : {}) };
  const thread = [...state.thread.map(m => m.id === e.replyTo ? { ...m, picked: e.picked } : m), entry];
  const payload = { event: 'message', round: state.id, mode: state.mode, message: { id: e.id, text: e.text, at: e.at, ...(e.replyTo ? { replyTo: e.replyTo, picked: e.picked } : {}) } };
  return { ...state, thread, outbox: [...state.outbox, { seq: e.seq, kind: 'message', payload }] };
}

export function applyThreadReply(state, e) {
  const entry = { id: e.id, from: 'agent', text: String(e.text ?? ''), at: e.at, ...(e.askId ? { askId: e.askId } : {}), ...(e.media && Object.keys(e.media).length ? { media: e.media } : {}), ...(e.choice ? { choice: e.choice } : {}) };
  return { ...state, thread: [...state.thread, entry], agentAt: Date.parse(e.at) };
}

export const threadResult = (state) => (state.thread ?? []).map(({ seq, replyTo, ...m }) => m);
export const threadView = (state) => (state.thread ?? []).map(({ seq, ...m }) => m.from === 'user' ? { ...m, status: state.thread.some(r => r.from === 'agent' && r.askId === m.id) ? 'answered' : seq <= state.acked ? 'delivered' : 'waiting' } : m);
