// store.js — the page's copy of each round's answers, notes and flags, and the
// writes that put them on the server one question at a time. A write is
// "saved" only once the server has the event on disk (its answer carries the
// seq); until then it is "saving", and after a failure it is sent again with
// backoff ("retrying"). Writes to one question go one at a time, the newest
// value winning; writes to different questions never touch each other, so
// two tabs on one round never wipe each other's answers.
//
// The server tells every page each change as `event: round` {round, seq, prev, patch}.
// A page holding seq N applies a change after N; one whose `prev` is after N
// means a change was missed, and the round is fetched again. A change to a
// question this page is still writing is passed over: its own write comes later
// and wins. No DOM here: the store loads under Node with any `net` that has
// the functions below.
//
// net: { getRound(id), postAnswer(id, qid, answer), postNote(id, qid, text), postFlag(id, qid, flag, extra),
//        putDraft?(id, draft), onEvent?(name, fn), holdReload?(key, fn) }; every call returns a promise
//        and rejects with an Error whose `status` is the HTTP status (none for a network failure).

const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000];
const KINDS = { answers: "a", notes: "n", flags: "f" };

// A 4xx is final (the round is finished, unknown, or the write is refused): sending it again cannot help.
const final = (err) => Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function createStore(net, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const rounds = new Map();
  const statusFns = new Set();
  let current = "saved";

  function roundOf(id) {
    let r = rounds.get(id);
    if (!r) {
      // writes: key → {kind, qid, pending: {value, waiters} | null, inflight, attempt, failing, timer, seen};
      // seen: the newest change of that question the server told while this page was writing it.
      // acked: key → the seq of this page's last saved write there (its own echo and older changes are passed over).
      r = { id, seq: 0, answers: {}, notes: {}, flags: {}, subs: new Set(), writes: new Map(), acked: new Map(), loaded: false, fetching: null, buffer: [] };
      rounds.set(id, r);
    }
    return r;
  }

  const view = (r) => ({ seq: r.seq, answers: r.answers, notes: r.notes, flags: r.flags });

  function notify(r, changed) {
    if (!changed.length) return;
    for (const fn of r.subs) {
      try {
        fn(view(r), changed);
      } catch {}
    }
  }

  // ---- status: saved, saving, retrying

  function setStatus() {
    let next = "saved";
    for (const r of rounds.values()) {
      for (const w of r.writes.values()) {
        if (w.failing) next = "retrying";
        else if (next === "saved") next = "saving";
      }
    }
    if (next === current) return;
    current = next;
    for (const fn of statusFns) {
      try {
        fn(current);
      } catch {}
    }
  }

  // ---- writes

  function call(r, w, value) {
    if (w.kind === "a") return net.postAnswer(r.id, w.qid, value);
    if (w.kind === "n") return net.postNote(r.id, w.qid, value);
    if (w.kind === "f") return net.postFlag(r.id, w.qid, value?.flag ?? null, value ? { revisit: value.revisit, note: value.note } : {});
    return net.putDraft(r.id, value);
  }

  function send(r, key, w) {
    const { value, waiters } = w.pending;
    w.pending = null;
    w.inflight = true;
    setStatus();
    Promise.resolve()
      .then(() => call(r, w, value))
      .then(
        (res) => {
          const seq = Number(res?.seq) || 0;
          w.inflight = false;
          w.attempt = 0;
          w.failing = false;
          r.acked.set(key, Math.max(r.acked.get(key) || 0, seq));
          for (const x of waiters) x.resolve({ seq });
          // Another page wrote this question after this write landed: theirs is the last word, unless this
          // page has a newer value on its way (that one lands later still).
          const seen = w.seen;
          w.seen = null;
          if (seen && seen.seq > seq && !w.pending) {
            r.writes.delete(key);
            if (put(r, seen.field, w.qid, seen.value)) notify(r, [w.qid]);
          }
          after(r, key, w);
        },
        (err) => {
          w.inflight = false;
          if (final(err)) {
            // Refused: this page's value never landed, so it takes the server's again.
            for (const x of waiters) x.reject(err);
            w.seen = null;
            after(r, key, w);
            if (r.loaded && !r.writes.has(key)) refetch(r);
            return;
          }
          // Not on disk: the value goes again, unless a newer one for the same question is waiting.
          w.pending = w.pending ? { value: w.pending.value, waiters: [...waiters, ...w.pending.waiters] } : { value, waiters };
          w.failing = true;
          w.timer = setTimer(() => {
            w.timer = null;
            if (w.pending && !w.inflight) send(r, key, w);
          }, BACKOFF[Math.min(w.attempt++, BACKOFF.length - 1)]);
          setStatus();
        },
      );
  }

  function after(r, key, w) {
    if (w.pending) send(r, key, w);
    else r.writes.delete(key);
    setStatus();
  }

  function enqueue(r, key, kind, qid, value) {
    let w = r.writes.get(key);
    if (!w) {
      w = { kind, qid, pending: null, inflight: false, attempt: 0, failing: false, timer: null };
      r.writes.set(key, w);
    }
    return new Promise((resolve, reject) => {
      w.pending = { value, waiters: [...(w.pending?.waiters || []), { resolve, reject }] };
      if (!w.inflight && !w.timer) send(r, key, w);
      else setStatus();
    });
  }

  // Every write that waits for its backoff goes now (the connection came back).
  function retryNow() {
    for (const r of rounds.values()) {
      for (const [key, w] of r.writes) {
        if (!w.timer) continue;
        clearTimer(w.timer);
        w.timer = null;
        if (w.pending && !w.inflight) send(r, key, w);
      }
    }
  }

  // ---- what the server says

  const writing = (r, kind, qid) => r.writes.has(`${kind}:${qid}`);

  // A value the server holds for a question this page is writing: kept until the write lands.
  function remember(w, seq, field, value) {
    if (!w.seen || seq > w.seen.seq) w.seen = { seq, field, value };
  }

  // Sets one question's value (null or "" removes it); true when it changed.
  function put(r, field, qid, v) {
    const empty = v === null || v === undefined || v === "";
    if (same(r[field][qid], empty ? undefined : v)) return false;
    if (empty) delete r[field][qid];
    else r[field][qid] = v;
    return true;
  }

  // The round as the server has it, with this page's unsaved writes on top. Returns the changed question ids.
  function adopt(data) {
    const r = roundOf(data.id);
    const changed = new Set();
    r.seq = Number(data.seq) || 0;
    for (const [field, kind] of Object.entries(KINDS)) {
      const theirs = data[field] && typeof data[field] === "object" ? data[field] : {};
      const next = { ...theirs };
      for (const qid of new Set([...Object.keys(r[field]), ...Object.keys(next)])) {
        if (writing(r, kind, qid)) {
          remember(r.writes.get(`${kind}:${qid}`), r.seq, field, next[qid] ?? null);
          if (qid in r[field]) next[qid] = r[field][qid];
          else delete next[qid];
        } else if (r.loaded && !same(r[field][qid], next[qid])) changed.add(qid);
      }
      r[field] = next;
    }
    r.loaded = true;
    return [...changed];
  }

  function refetch(r) {
    if (r.fetching) return r.fetching;
    r.fetching = Promise.resolve()
      .then(() => net.getRound(r.id))
      .then((data) => {
        r.fetching = null;
        const changed = new Set(adopt(data));
        for (const d of r.buffer.splice(0)) for (const qid of applyChange(r, d)) changed.add(qid);
        notify(r, [...changed]);
      })
      .catch(() => {
        r.fetching = null;
        r.buffer.length = 0;
      });
    return r.fetching;
  }

  function applyChange(r, d) {
    if (!(d.seq > r.seq)) return [];
    if (Number.isInteger(d.prev) && d.prev > r.seq) {
      r.buffer.push(d);
      refetch(r);
      return [];
    }
    r.seq = d.seq;
    const changed = [];
    for (const [field, kind] of Object.entries(KINDS)) {
      for (const [qid, v] of Object.entries(d.patch?.[field] || {})) {
        const key = `${kind}:${qid}`;
        if (r.writes.has(key)) remember(r.writes.get(key), d.seq, field, v);
        else if ((r.acked.get(key) || 0) < d.seq && put(r, field, qid, v)) changed.push(qid);
      }
    }
    return changed;
  }

  function onRound(d) {
    const r = d && rounds.get(d.round);
    if (!r || !r.loaded) return;
    if (r.fetching) return void r.buffer.push(d);
    notify(r, applyChange(r, d));
  }

  function pending() {
    let n = 0;
    for (const r of rounds.values()) n += r.writes.size;
    return n;
  }

  net.onEvent?.("round", onRound);
  // The stream came back: what was missed meanwhile is fetched, and writes waiting for a retry go now.
  net.onEvent?.("reconnect", () => {
    retryNow();
    for (const r of rounds.values()) if (r.loaded) refetch(r);
  });
  // A restart reloads the page only once every write is on disk.
  net.holdReload?.("store", () => pending() > 0);

  const store = {
    // The round from the server, its answers, notes and flags as this store holds them.
    load: async (roundId) => store.adopt(await net.getRound(roundId)),
    // A round the page fetched itself: the store takes its answers, notes and flags. Returns the round
    // with them as the store holds them (this page's unsaved writes on top).
    adopt(data) {
      if (!data?.id) return data;
      const r = roundOf(data.id);
      notify(r, adopt(data));
      return { ...data, seq: r.seq, answers: { ...r.answers }, notes: { ...r.notes }, flags: { ...r.flags } };
    },
    state: (roundId) => view(roundOf(roundId)),
    saveAnswer(roundId, qid, answer) {
      const r = roundOf(roundId);
      put(r, "answers", qid, answer ?? null);
      return enqueue(r, `a:${qid}`, "a", qid, answer ?? null);
    },
    saveNote(roundId, qid, text) {
      const r = roundOf(roundId);
      const value = String(text ?? "");
      put(r, "notes", qid, value);
      return enqueue(r, `n:${qid}`, "n", qid, value);
    },
    // flag: "none" | "later" | null; extra: {revisit?, note?}.
    saveFlag(roundId, qid, flag, extra = {}) {
      const r = roundOf(roundId);
      const value = flag ? { flag, ...(extra?.revisit ? { revisit: extra.revisit } : {}), ...(extra?.note ? { note: extra.note } : {}) } : null;
      put(r, "flags", qid, value);
      return enqueue(r, `f:${qid}`, "f", qid, value);
    },
    // The round-level part of the page (closing comment, its files, time spent): one value per round.
    saveDraft: (roundId, draft) => enqueue(roundOf(roundId), "draft", "d", "", draft),
    subscribe(roundId, fn) {
      const r = roundOf(roundId);
      r.subs.add(fn);
      return () => r.subs.delete(fn);
    },
    status: () => current,
    onStatus(fn) {
      statusFns.add(fn);
      return () => statusFns.delete(fn);
    },
    pending,
    retryNow,
    // Resolves once every write is on disk, or after `ms` (a write that keeps failing does not block the caller).
    flush(ms = 3000) {
      if (!pending()) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimer(() => {
          off();
          resolve(false);
        }, ms);
        const off = store.onStatus((status) => {
          if (status !== "saved" || pending()) return;
          clearTimer(timer);
          off();
          resolve(true);
        });
      });
    },
  };
  return store;
}
