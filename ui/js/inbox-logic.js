// inbox-logic.js — pure helpers of the inbox rail. No DOM and no page strings, so Node tests load it.
// A row is what GET /api/inbox returns:
//   { id, project, projectName, title, mode, answered, total, listening, stakes, createdAt, waitingSince, older }

export const DAY = 24 * 60 * 60 * 1000;

export const baseName = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";

// The server's order is kept as it comes. This is the same order for the fallback below:
// open rounds first (high stakes first, then the longest waiting), then the older group.
export function orderRows(rows) {
  const rank = (r) => [r.older ? 1 : 0, r.stakes === "high" ? 0 : 1, Number(r.createdAt) || 0];
  return [...rows].sort((a, b) => {
    const x = rank(a);
    const y = rank(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
}

// No /api/inbox on this server (an older one): rows from /api/state. The answered count is unknown there.
export function rowsFromState(state, now = Date.now()) {
  const rows = (state?.rounds || []).map((r) => {
    const createdAt = Number(r.createdAt) || now;
    const listening = r.listening !== false;
    return {
      id: r.id,
      project: r.project || "",
      projectName: baseName(r.project),
      title: r.title,
      mode: ["swipe", "review", "visual"].includes(r.mode) ? r.mode : "questions",
      answered: null,
      total: Number(r.count) || 0,
      listening,
      stakes: r.stakes === "high" ? "high" : null,
      createdAt,
      waitingSince: createdAt,
      older: !listening && now - createdAt > DAY,
    };
  });
  return orderRows(rows);
}

// The two groups of the rail, each in the order given.
export function groups(rows) {
  return { open: rows.filter((r) => !r.older), older: rows.filter((r) => r.older) };
}

// The round to go to once `currentId` is done: the first open one in rail order, else the first older one.
export function nextRound(rows, currentId) {
  const rest = rows.filter((r) => r.id !== currentId);
  return rest.find((r) => !r.older) || rest[0] || null;
}

// "3 of 8", or just the total where the answered count is unknown.
export const progressOf = (row) => (Number.isFinite(row.answered) ? { answered: row.answered, total: row.total } : { answered: null, total: row.total });
