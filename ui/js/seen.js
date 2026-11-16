// seen.js — tells the server what the user has seen, so an agent's patch greys such an item out
// (a ghost with the reason) instead of dropping it. A question counts once it has been in view; a
// swipe card once it is shown. Ids go out in batches: the first new one starts a short timer and
// everything seen until it fires goes in one request. No DOM access at import.

export const SEEN_DELAY_MS = 1000;

// send(ids) → Promise. known: ids the server has as seen already. A failed send gives its ids back to
// the next batch.
export function seenReporter(send, { delay = SEEN_DELAY_MS, known = [] } = {}) {
  const sent = new Set(known);
  let queue = new Set();
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (!queue.size) return;
    const ids = [...queue];
    queue = new Set();
    for (const id of ids) sent.add(id);
    Promise.resolve()
      .then(() => send(ids))
      .catch(() => {
        for (const id of ids) sent.delete(id);
      });
  };
  return {
    add(id) {
      const key = String(id ?? "");
      if (!key || sent.has(key) || queue.has(key)) return;
      queue.add(key);
      timer ??= setTimeout(flush, delay);
    },
    flush,
    stop: flush,
  };
}

// Watches question cards (elements with data-qid): one that is half in view, or fills half the screen,
// counts as seen. Returns { observe(elements), stop() }; without IntersectionObserver it does nothing.
export function watchSeen(reporter) {
  if (typeof IntersectionObserver !== "function") return { observe() {}, stop: () => reporter.stop() };
  const watched = new WeakSet();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const tall = e.intersectionRect.height >= (e.rootBounds?.height ?? innerHeight) * 0.5;
        if (e.intersectionRatio < 0.5 && !tall) continue;
        reporter.add(e.target.dataset.qid);
        io.unobserve(e.target);
      }
    },
    { threshold: [0, 0.25, 0.5, 0.75, 1] },
  );
  return {
    observe(elements) {
      for (const el of elements) {
        if (!el || watched.has(el) || !el.dataset?.qid) continue;
        watched.add(el);
        io.observe(el);
      }
    },
    stop() {
      io.disconnect();
      reporter.stop();
    },
  };
}
