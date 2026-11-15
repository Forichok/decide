# decide 3.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild decide on a core that cannot lose an answer (one server per machine, every round an event log on disk), then build the reactive rounds, the new question anatomy, knobs, the new forms and the new page on top of it.

**Architecture:** One loopback server per `DECIDE_HOME` at a fixed port; binding the port is the election. A round is a directory with the spec, an append-only event log and the answers; the server is a replay of those logs and can be killed at any moment. Question types, media kinds and commands are declared once in registries that produce the MCP schema, the validator, the reference docs and the page's renderer table.

**Tech Stack:** Node 20+ ES modules, `node:test`, no runtime npm dependencies, plain browser ES modules with no build step. Playwright as a dev dependency from milestone 2.

**Spec:** `docs/plans/2026-11-15-decide-3-design.md` (approved 2026-11-15, round `4-7e49e2`). The look: `docs/plans/2026-11-15-decide-3-look.html`. Read both before any task.

**How deep this plan goes.** The design has six milestones. Milestone 1 (Core) is planned here to step level. Milestones 2 to 6 are planned to task level: files, interfaces, the tests that prove each task. Their steps are written at the start of each milestone, after the owner has opened the demo round of the one before, because his reaction changes them (milestone 2 starts with a mockup he has to see). Every milestone ends in software that runs and is tested on its own.

## Global Constraints

- Node 20+. No build step. No runtime npm dependency. Browser code is plain ES modules.
- CI runs `node --test` on ubuntu, macos and windows with Node 20 and 24 (`.github/workflows/test.yml`). Every new suite passes on all six; a test that needs POSIX file modes or signals is skipped on `win32` with the reason in its name.
- Loopback only: the server listens on `127.0.0.1`. Data stays under `~/.decide`; `DECIDE_HOME` moves it.
- Every test and every experiment runs with its own `DECIDE_HOME` (`test/helpers.mjs` does this per test). Nothing writes to the real `~/.decide`. Reading it is allowed.
- 2.x specs, answers files and journals keep opening. 2.1.x sessions keep their per-project servers on ports 43100 to 43899; 3.0 never contacts or stops them.
- A client never shuts a server down. The only ways a server stops: idle, the user's `stop` command, a handover it agreed to.
- The digest is English. The page speaks English and Russian; every new string goes into both `ui/js/lang/en.js` and `ui/js/lang/ru.js`.
- Fixed values from the spec: default port `47474` (`DECIDE_PORT` overrides); idle stop after 30 minutes with no waiting agent and no connected page; export limit 60 MB; body text contrast 4.5:1 in both themes; page widths checked at 375, 768 and 1440; overlap check under 100 ms for 90 questions against 500 entries.
- One branch, `v3`. Commits are local. No push, no merge to `master`, no tag, no version bump in `package.json` or `.claude-plugin/plugin.json` without the owner's word. (Pushing `v3` to the public repository is the owner's call too.)
- Fixtures never come from the owner's real `~/.decide`; they come from the repository's `examples/` at `v2.0.0` and at `f62a924`, and from rounds produced by running that code in a scratch home.
- Prose in docs, skills and the README is written under the `sepia` skill. Commit messages follow the repository's style: an area prefix and a plain sentence (`core: a torn last line no longer breaks the log`).
- Processes are stopped by pid, never by name or path pattern. Browsers started for checks are muted (`agent-browser`, Playwright with `--mute-audio`).

## Review Focus

Five conditions the design implies and its own test list does not name. Each has a test pinned to the task that owns the code.

1. **The log's last line is torn** (the server was killed in the middle of a write). The round opens with every complete event, the torn line is dropped, the next append starts on a fresh line. → Task 2.
2. **Port 47474 is held by something that is not decide, or `daemon.json` points at a dead or reused pid.** The client never treats a foreign HTTP server as decide (it checks `app` and `home` in the ping), never waits forever, and starts a working server. → Tasks 5 and 7.
3. **Two sessions collect the same finished round, or the collecting session dies between the tool result and the acknowledgement.** Both get the answers; the "not collected" line goes away after the first acknowledged delivery and not before. → Tasks 8 and 9.
4. **Two tabs have the same round open.** An answer given in one tab is not wiped by a save from the other; both tabs converge on the same state without a reload. → Milestone 2, task P3.
5. **Rules that contradict or feed each other** (A's answer ghosts B, B's default answer changes A). Evaluation ends, the result does not depend on how many times it ran, and lint names the loop. → Milestone 3, task R1.

---

## Before you start

- [ ] Branch `v3` exists: `origin/master` plus one commit with the design, the look and this plan. `git fetch origin`, then add a worktree on `v3`; the main checkout stays on `master`, because the owner's running decide loads from it. After every git step check `git rev-parse --abbrev-ref HEAD` and `git rev-parse --short HEAD`: another session may share the checkout.
- [ ] `node --test` on the fresh branch. Expected: exit code 0. Judge by the exit code, not the tail of the log.
- [ ] Read `lib/rounds.mjs`, `lib/daemon.mjs`, `lib/client.mjs`, `lib/tools.mjs`, `mcp.mjs` and `test/helpers.mjs` in full. They are what milestone 1 replaces.

## File structure

Milestone 1 creates or replaces these. Later milestones add under the same directories.

| File | Responsibility |
|---|---|
| `lib/project.mjs` (modify) | Project identity: the git common directory, the data dir, old worktree data dirs |
| `lib/store/log.mjs` (new) | Append-only event log of one round: append with fsync, read, torn-line tolerance |
| `lib/store/state.mjs` (new) | Pure replay: meta + events → round state, including the outbox |
| `lib/store/rounds.mjs` (new, replaces `lib/rounds.mjs`) | The round store: create, load from disk, every mutation as an event, waiters |
| `lib/store/scan.mjs` (new) | Disk-only reads that need no server: uncollected rounds, a finished round's answers |
| `lib/home.mjs` (new) | Port for a home, `daemon.json`, the lock file, the token |
| `lib/protocol.mjs` (new) | The protocol integer and which versions a server speaks |
| `lib/server.mjs` (new, replaces `lib/daemon.mjs`) | HTTP server: election, routes, request guard, idle rule, handover |
| `lib/http.mjs` (modify) | `Host`, `Origin` and token checks; page CSP |
| `lib/client.mjs` (rewrite) | Find or start the server for a home, verify it, hand over, call it |
| `lib/registry/index.mjs`, `lib/registry/strict.mjs`, `lib/registry/docs.mjs` (new) | The registry, strict field checks, generated schema and doc tables |
| `lib/registry/types/*.mjs`, `lib/registry/media/*.mjs` (new) | One module per question type and per media kind, server side |
| `ui/js/types/*.js`, `ui/js/media/*.js` (new) | The same, page side; importable under Node (no DOM access at import) |
| `lib/spec.mjs` (shrink) | Round-level and question-common fields; delegates the rest to the registry |
| `lib/commands/index.mjs`, `lib/commands/*.mjs` (new, replace `lib/tools.mjs` and `lib/commands.mjs`) | One command table for MCP tools and CLI commands |
| `mcp.mjs`, `decide.mjs` (rewrite, thin) | Transport only: JSON-RPC over stdio, argv parsing |
| `lib/migrate.mjs` (new) | Format versions and migrate-on-read for specs, answers, journal entries |
| `lib/journal.mjs` (modify) | Per-question records, second source for old worktree dirs |
| `lib/assets.mjs` (modify) | Publish one file, or a mockup's own directory; stable URLs |
| `ui/vendor/mermaid.min.js` (new) | Mermaid, pinned |
| `hooks/hooks.json` (new) | Claude Code session-start hook for the "not collected" line |
| `test/core-*.test.mjs`, `test/project.test.mjs`, `test/registry.test.mjs`, `test/commands.test.mjs`, `test/migrate.test.mjs`, `test/security.test.mjs` (new) | One suite per task below |
| `test/fixtures/2.0/`, `test/fixtures/2.1/` (new) | Real 2.x specs, answers and journals |

Round directory, decided here: `<dataDir>/rounds/<id>/` holding `meta.json` (`{format: 3, id, mode, title, project, source, specFile, outPath, live, createdAt}`), `spec.json` (the prepared spec the page shows), `raw.json` (the spec as the agent sent it), `events.jsonl`, `files/` (uploads) and, once sent, `answers.json`. Round ids keep the 2.x shape `<n>-<hex6>`; `n` counts rounds of the project on disk. Inline specs of 2.1.x sessions (`rounds/<stamp>-<slug>.questions.json`) share the directory and are left alone.

Event types, decided here: `opened`, `draft`, `upload`, `ask`, `reply`, `swipe`, `push`, `deeper`, `batch`, `acked`, `sent`, `cancelled`, `dismissed`, `imported`. Outbox items are derived from them: `ask` → kind `ask`; `batch` → `batch`; `deeper` → `deeper`; `sent` and `imported` → `final`; `cancelled` → `cancel`. An item's sequence number is its event's.

Round statuses: `pending`, `answered`, `cancelled`, `dismissed` (the first three are the 2.1 literals the page reads; `abandoned` is gone).

---

# Milestone 1: Core

Done when: the 2.1 page runs on the new core with nothing lost after `kill -9`, three cold `ask` calls open three rounds, the six existing suites and the new ones exit 0, and the owner has opened the demo.

### Task 1: Project identity

**Files:**
- Modify: `lib/project.mjs`
- Test: `test/project.test.mjs`

**Interfaces:**
- Produces:
  - `gitCommonDir(start: string): string | null`: absolute path of the shared `.git` directory. Reads the `.git` file of a worktree (`gitdir: …`) and that directory's `commondir`; never spawns `git`.
  - `worktreeTop(start: string): string`: what `projectRoot` returns in 2.1.1 (nearest directory with `.git`).
  - `projectRoot(start: string): string`: parent of the common dir when it is named `.git`; the common dir itself for a bare repository; `worktreeTop(start)` outside git.
  - `dataDirPath(root: string): string` (pure) and `dataDirFor(root: string): string` (creates it).
  - `openProject(start: string): Project`, with `Project = { root, top, dataDir, legacyDirs: string[] }`. `legacyDirs` holds `dataDirPath(top)` when `top !== root` and that directory exists; it is never created.

- [ ] **Step 1: Write the failing tests**

```js
test("a worktree and its main checkout are one project", async (t) => {
  const { main, wt } = await repoWithWorktree(t);          // helper: git init, one commit, git worktree add
  assert.equal(openProject(wt).root, openProject(main).root);
  assert.equal(openProject(wt).dataDir, openProject(main).dataDir);
});
test("a worktree's 2.1 data dir is a legacy source and is not created", async (t) => {
  const { wt } = await repoWithWorktree(t);
  assert.deepEqual(openProject(wt).legacyDirs, []);
  mkdirSync(dataDirPath(wt), { recursive: true });
  assert.deepEqual(openProject(wt).legacyDirs, [dataDirPath(wt)]);
});
test("the main checkout keeps its 2.1 data dir", ...);     // dataDirPath(main) equals the 2.1.1 formula: `${name}-${fnv1a(root) hex8}`
test("outside git the directory itself is the project", ...);
test("a submodule is its own project", ...);                // .git file pointing into modules/, no commondir
```

- [ ] **Step 2: Run** `node --test test/project.test.mjs`. Expected: FAIL, `gitCommonDir` is not exported.
- [ ] **Step 3: Implement the five exports in `lib/project.mjs`.** `repoWithWorktree` goes into `test/helpers.mjs` and uses the `git` binary; skip the suite with a clear message when `git` is missing.
- [ ] **Step 4: Run** `node --test test/project.test.mjs test/engine.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `core: worktrees of one repository are one project`.

### Task 2: Event log

**Files:**
- Create: `lib/store/log.mjs`
- Test: `test/core-log.test.mjs`

**Interfaces:**
- Produces: `openLog(file: string): { append(type: string, data?: object): Event, read(after?: number): Event[], last(): number }` with `Event = { seq: number, at: string, type: string, ...data }`. `seq` starts at 1 and has no gaps. `append` returns only after the line is written and `fsync`ed.

- [ ] **Step 1: Write the failing tests**

```js
test("append numbers events and read returns them in order", ...);      // seq 1,2,3; read(1) returns 2 and 3
test("a log reopened continues the numbering", ...);                     // openLog twice on one file: next seq is 4
test("a torn last line is dropped and the next append is intact", () => {
  appendFileSync(file, '{"seq":4,"at":"2026-11-15T10:00:00.000Z","type":"dra');   // no newline: a killed write
  const log = openLog(file);
  assert.equal(log.last(), 3);
  assert.equal(log.append("draft", { draft: {} }).seq, 4);
  assert.deepEqual(openLog(file).read().map((e) => e.seq), [1, 2, 3, 4]);
});
test("a write that fails throws and adds nothing", ...);                 // file's directory removed; append throws, last() unchanged
```

- [ ] **Step 2: Run** `node --test test/core-log.test.mjs`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `openLog`.** One JSON object per line. On open, read the file once; a last line without `\n` or that does not parse is cut off the file before the first append. Keep one file descriptor open in append mode; `fsyncSync` after each write.
- [ ] **Step 4: Run** the suite. Expected: PASS.
- [ ] **Step 5: Commit** `core: append-only event log for a round`.

### Task 3: Round state from the log

**Files:**
- Create: `lib/store/state.mjs`
- Test: `test/core-state.test.mjs`

**Interfaces:**
- Consumes: `Event` from Task 2.
- Produces:
  - `EVENTS: string[]`: the fourteen event types listed under File structure.
  - `replay(meta: object, spec: object, events: Event[]): RoundState` and `apply(state: RoundState, event: Event): RoundState` (`replay` is a fold of `apply`).
  - `RoundState = { id, mode, title, status, draft, uploads: string[], dialog: object[], swipe: object | null, outbox: Item[], acked: number, result: object | null, lastSeq: number }`.
  - `Item = { seq: number, kind: "ask" | "batch" | "deeper" | "final" | "cancel", payload: object }`.
  - `pendingItems(state: RoundState, { events: boolean }): Item[]`: outbox items with `seq > state.acked`; kind `ask` only when `events` is true.

- [ ] **Step 1: Write the failing tests**

```js
test("draft events: the last one is the draft", ...);
test("swipe events rebuild answers, the log and undo", ...);            // same sequence fed to 2.1's swipeAnswer gives the same answers map
test("ask then reply: one dialog entry with both", ...);
test("sent makes the round answered and adds a final item", ...);
test("acked hides items up to its seq and nothing after", ...);
test("an unknown event type is ignored, not fatal", ...);               // a newer server wrote it
test("replay is deterministic", ...);                                   // deepEqual(replay(m, s, ev), replay(m, s, ev))
```

- [ ] **Step 2: Run** `node --test test/core-state.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement `state.mjs`.** Move the swipe bookkeeping out of `lib/rounds.mjs:239-397` (pending entries, batches, deeper) so that it works on plain state; batch boundaries come from `batch` events, never from timers. No I/O in this file.
- [ ] **Step 4: Run** the suite. Expected: PASS.
- [ ] **Step 5: Commit** `core: a round's state is a replay of its log`.

### Task 4: Round store on disk

**Files:**
- Create: `lib/store/rounds.mjs`
- Test: `test/core-store.test.mjs`

**Interfaces:**
- Consumes: `openLog` (Task 2), `replay`, `apply`, `pendingItems` (Task 3), `openProject` (Task 1).
- Produces `createStore({ home: string, roots, on?: { change, dialog, deck, finish } }): Store` with:
  - `load(): number`: scans `projects/*/rounds/*/meta.json` under `home`, replays every round whose status is `pending` or whose final item is not acknowledged; returns how many.
  - `create({ project, spec, raw, outPath, source, specFile, live, mode }): Round`: writes `meta.json`, `spec.json`, `raw.json` and the `opened` event before returning.
  - `get(id): Round | null` (loads a finished round from disk on demand), `pending(): Round[]`, `summary(): object` (the shape `GET /api/state` returns in 2.1.1, plus `project` on each round).
  - `saveDraft(round, draft)`, `saveUpload(round, name, type, buf): string`, `ask(round, { qid, text })`, `explain(round, { qid, askId, text, media })`, `swipeAnswer(round, { card, side, text, undo, rev, ms })`, `push(round, patch)`, `deeper(round, { note })`, `finish(round, payload): Result`, `dismiss(round): Result`. Each appends its event before it changes memory or calls `on.*`; a failed append throws `{ status: 507 }` and changes nothing.
  - `next(round, { waiter: string, events?: boolean, timeoutMs?: number }): Promise<Item | { superseded: true } | null>` and `ack(round, seq: number, waiter: string): void`. Used by Task 8; in this task `next` returns the first pending item or waits.
  - `listening(round): boolean`, `swipeView(round)`, `publicDialog(round)` as in 2.1.1.
  - `roundDir(dataDir: string, id: string): string`.

- [ ] **Step 1: Write the failing tests**

```js
test("a second store on the same home sees the open round as it was", async (t) => {
  const a = createStore({ home, roots });
  const r = a.create(roundArgs);
  a.saveDraft(r, { answers: { layout: { selected: ["today"] } } });
  a.ask(r, { qid: "layout", text: "why?" });
  const b = createStore({ home, roots: createRoots() });
  assert.equal(b.load(), 1);
  assert.deepEqual(b.get(r.id).draft, a.get(r.id).draft);
  assert.equal(b.get(r.id).dialog.length, 1);
});
test("a swipe round restores its position and answers", ...);
test("finish writes answers.json in the round dir and next to the spec file", ...);
test("the spec file's directory is gone: the round is still sent, the result carries a warning", ...);
test("a round with no waiter for a week is still pending", ...);        // no sweep, no 'abandoned'
test("dismiss keeps what was answered and ends the round", ...);
test("an append that fails leaves the round unchanged and throws 507", ...);   // skipped on win32
test("a round sent but killed before answers.json was written gets the file on load", ...);
```

- [ ] **Step 2: Run** `node --test test/core-store.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement `createStore`.** `finish` order: append `sent` (the event carries the whole result), write `answers.json` by temp file and rename, then copy to `outPath` when the round came from a spec file. `<slug>.answers.draft.json` and `<slug>.answers.files/` are no longer written; uploads go to `rounds/<id>/files/` and answers carry their absolute paths as before. There is no `sweep`.
- [ ] **Step 4: Run** `node --test test/core-store.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `core: rounds live on disk and survive the server`.

### Task 5: Home, port and election

**Files:**
- Create: `lib/home.mjs`, `lib/protocol.mjs`, `lib/server.mjs` (start from `lib/daemon.mjs`)
- Delete: `lib/daemon.mjs`, `lib/rounds.mjs`
- Modify: `lib/client.mjs` (the smallest change that keeps it working: imports from `lib/server.mjs` and `lib/home.mjs`, the shutdown call removed; Task 7 rewrites it)
- Modify: `test/helpers.mjs` (`shutdownDaemon` reads `<home>/daemon.json` and sends `POST /api/stop` with the token)
- Test: `test/core-election.test.mjs`

**Interfaces:**
- Consumes: `createStore` (Task 4).
- Produces:
  - `lib/protocol.mjs`: `PROTOCOL = 1`; `speaks(server: number, client: number): boolean`, true for `client === server` and `client === server - 1`.
  - `lib/home.mjs`: `DEFAULT_PORT = 47474`; `portForHome(home: string): number` (`DECIDE_PORT` if set; `47474` for `~/.decide`; otherwise `44000 + fnv1a(home) % 2000`); `infoPath(home)` (`<home>/daemon.json`); `readInfo(home): Info | null`; `writeInfo(home, info)` with mode `0o600`; `lockPath(home)`; `Info = { pid, port, protocol, version, home, token, startedAt }`.
  - `lib/server.mjs`: `VERSION`; `startServer({ home?, port?, idleMs?, embedded?, protocol? }): Promise<{ port, token, store, stop } | null>`. Resolves `null` when a decide server for the same home already holds the port.
  - Routes added: `GET /api/ping` → `{ ok: true, app: "decide", protocol, version, home, pid }`; `POST /api/stop` (the user's `stop`). `POST /api/shutdown` is removed.

- [ ] **Step 1: Write the failing tests**

```js
test("three servers started at once: one serves, two resolve null", async (t) => {
  const pids = await Promise.all([1, 2, 3].map(() => spawnServer(t, home)));   // helper: node decide.mjs serve
  const info = readInfo(home);
  assert.equal(pids.filter((p) => p.exited === 0 && p.pid !== info.pid).length, 2);
  assert.equal((await ping(info.port)).home, home);
});
test("a second home gets its own port and its own server", ...);            // portForHome differs, both ping with their own home
test("the port is taken by a foreign HTTP server: the lock file elects one, daemon.json names its port", ...);
test("daemon.json points at a dead pid: a new server starts", ...);
test("daemon.json points at a live pid that is not decide: it is ignored", ...);   // ping lacks app: "decide"
test("daemon.json is mode 0600 and carries a token", ...);                  // mode check skipped on win32
```

- [ ] **Step 2: Run** `node --test test/core-election.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement `home.mjs`, `protocol.mjs`, `startServer`.** On `EADDRINUSE`: ping the port; a decide server of this home → resolve `null`; anything else → take `lockPath(home)` with the `wx` flag (a lock whose pid is dead is replaced), listen on port 0, write `daemon.json`. `decide.mjs serve` replaces `--daemon`. The route table and the page stay as in `lib/daemon.mjs` except that the store is `createStore` with `load()` called before listening and the journal is appended to the round's own project. `GET …/wait` is served by `store.next` until Task 8 replaces the route.
- [ ] **Step 4: Run** `node --test`. Expected: PASS for the new suite; the six old suites pass with the updated helper.
- [ ] **Step 5: Commit** `core: one server per home, elected by binding the port`.

### Task 6: Server lifetime and recovery over HTTP

**Files:**
- Modify: `lib/server.mjs`, `ui/js/net.js`
- Test: `test/core-recovery.test.mjs`

**Interfaces:**
- Consumes: `startServer`, `readInfo` (Task 5), the store (Task 4).
- Produces: the idle rule; `GET /api/events` sends `event: hello` with `{ version, protocol, startedAt }` first; the page reloads itself when `startedAt` changes between two connections.

- [ ] **Step 1: Write the failing tests**

```js
test("kill -9 mid-round: the restarted server serves the same round", async (t) => {
  const s1 = await spawnServer(t, home);
  const { id } = await post(s1, "/api/rounds", roundBody);
  await put(s1, `/api/rounds/${id}/draft`, { answers: { layout: { selected: ["today"] } } });
  await post(s1, `/api/rounds/${id}/ask`, { qid: "layout", text: "why?" });
  process.kill(s1.pid, "SIGKILL");
  const s2 = await spawnServer(t, home);
  const view = await get(s2, `/api/rounds/${id}`);
  assert.deepEqual(view.draft.answers.layout.selected, ["today"]);
  assert.equal(view.dialog.length, 1);
});
test("kill -9 mid-deck: the swipe round resumes on the same card", ...);
test("a save answers 200 only after the event is in events.jsonl", ...);    // read the file inside the test right after the response
test("the server stops idleMs after the last waiter and page left, with a round still open", ...);   // idleMs: 300
test("the server does not stop while a waiter is connected", ...);
test("the server does not stop while a page holds /api/events", ...);
```

- [ ] **Step 2: Run** `node --test test/core-recovery.test.mjs`. Expected: FAIL (the server stops with a round open, or does not).
- [ ] **Step 3: Implement.** Idle clock: restarts whenever the count of waiters plus SSE clients drops to zero; open rounds do not count. Remove the `sweep` interval.
- [ ] **Step 4: Run** `node --test`. Expected: exit code 0.
- [ ] **Step 5: Commit** `core: the server may die at any moment; rounds come back`.

### Task 7: Client: find, verify, start, hand over

**Files:**
- Rewrite: `lib/client.mjs`
- Modify: `lib/server.mjs` (`POST /api/handover`, protocol check)
- Create: `test/fixtures/server-next.mjs` (starts `startServer({ protocol: PROTOCOL + 1 })`)
- Test: `test/core-protocol.test.mjs`, `test/core-home.test.mjs`

**Interfaces:**
- Consumes: `readInfo`, `portForHome` (Task 5), `PROTOCOL`, `speaks`.
- Produces:
  - `findServer(home: string): Promise<Server | null>`: never starts anything. `Server = { port, token, protocol, embedded?: true }`.
  - `ensureServer({ home, engine, protocol? }): Promise<Server>`: returns a server that serves `home` and that this client can talk to; starts one when needed; falls back to an in-process server (`embedded`) only when a detached one cannot start.
  - `api(server: Server, path: string, opts?: { method, body, timeoutMs, signal }): Promise<any>`: sends `x-decide-token` and `x-decide-protocol`.
  - Server: every `/api/*` request with `x-decide-protocol` the server does not speak gets `426` with `{ error, protocol }`. `POST /api/handover` (token required) answers 200, tells pages `event: handover`, closes and exits.

- [ ] **Step 1: Write the failing tests**

```js
test("a newer client asks an older server to hand over; the round survives", async (t) => {
  const old = await spawnServer(t, home);                                   // protocol 1
  const { id } = await post(old, "/api/rounds", roundBody);
  const s = await ensureServer({ home, engine: nextEngine, protocol: PROTOCOL + 1 });
  assert.notEqual(readInfo(home).pid, old.pid);
  assert.equal((await api(s, `/api/rounds/${id}`)).status, "pending");
});
test("an older client uses a newer server and does not ask for a handover", ...);   // server P+1, client P: same pid before and after
test("a client two versions behind is told to restart its session", ...);           // 426, message names both versions
test("a server for another home on the expected port is ignored", ...);             // ping.home differs → findServer null
test("a client in a test home never reaches the default home's server", ...);       // portForHome(testHome) !== 47474 and info is read from testHome only
test("three clients on a cold home: one server, three rounds, none gets 404 on its first wait", ...);
test("the engine cannot be spawned: the client serves in-process", ...);
```

- [ ] **Step 2: Run** `node --test test/core-protocol.test.mjs test/core-home.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** `ensureServer` loop: `readInfo` → ping → check `app === "decide"` and `home` → compare protocols (server older: `POST /api/handover`, wait for the port to free, up to 5 s) → spawn `engine serve` detached and poll the ping for up to 6 s. The client has no code path that calls `/api/stop`. Keep `postRound`, `postExplain`, `postPush`, `getRoundView`, `postExport`, `postImport`, `getJournal`, `waitOnce` and `waitResult` as thin wrappers over `api` until Task 13 removes their callers.
- [ ] **Step 4: Run** `node --test`. Expected: exit code 0.
- [ ] **Step 5: Commit** `core: clients find or start the server and never stop it`.

### Task 8: Delivery: outbox, acknowledgement, supersede, cancel

**Files:**
- Modify: `lib/store/rounds.mjs` (`next`, `ack`), `lib/server.mjs` (`GET /api/rounds/:id/next`, `POST /api/rounds/:id/ack`; remove `GET …/wait`), `lib/client.mjs` (`waitNext`, `ack`), `mcp.mjs`
- Test: `test/core-delivery.test.mjs`

**Interfaces:**
- Consumes: `Item`, `pendingItems` (Task 3), `api` (Task 7).
- Produces:
  - `waitNext(server, id, { waiter, events, timeoutMs, signal }): Promise<Item | { superseded: true } | null>`. A network error is retried inside (back off 0.5 s, re-run `ensureServer` after three failures); it never throws "not running".
  - `ack(server, id, seq, waiter): Promise<void>`.
  - `mcp.mjs`: a handler may return `{ text, delivered?: () => Promise<void> }`. `delivered` runs after the response line is written to stdout and only if no `notifications/cancelled` named that request. A cancelled request's `signal` is aborted.

- [ ] **Step 1: Write the failing tests**

```js
test("an item not acknowledged is returned again", ...);                  // next → item 5; next again → item 5; ack(5); next → waits
test("a question typed on the page is delivered only on ack", ...);       // dialog entry seen:false until ack, true after
test("a newer wait supersedes the older one", async () => {
  const older = waitNext(s, id, { waiter: "a" });
  const newer = waitNext(s, id, { waiter: "b" });
  assert.deepEqual(await older, { superseded: true });
  // the newer one gets the next item
});
test("a cancelled wait does not acknowledge", ...);                       // MCP child: tools/call wait, notifications/cancelled, user asks → next wait gets the ask
test("the server dies during wait: the call survives and returns the answers", ...);   // SIGKILL, answers sent to the restarted server
test("a finished round returns its answers to any session", ...);          // second MCP child, no shared memory
test("two sessions collect one finished round: both get it, one ack is enough", ...);
```

- [ ] **Step 2: Run** `node --test test/core-delivery.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** `next` holds one waiter per round; a different `waiter` id resolves the held one with `{ superseded: true }`. For a round that is `answered` or `cancelled`, `next` resolves at once with the final item whatever `acked` is. `ack` appends `acked` with the highest sequence number seen. The in-memory `known` map of `lib/tools.mjs:20` goes away: a round is found by id through the server.
- [ ] **Step 4: Run** `node --test`. Expected: exit code 0.
- [ ] **Step 5: Commit** `core: nothing is delivered until the agent has it`.

### Task 9: Answers nobody collected

**Files:**
- Create: `lib/store/scan.mjs`, `hooks/hooks.json`
- Modify: `mcp.mjs` (prefix), `decide.mjs` (`notice` command), `.claude-plugin/plugin.json` if hooks need declaring
- Test: `test/core-notice.test.mjs`

**Interfaces:**
- Consumes: `roundDir`, `replay`.
- Produces:
  - `uncollected(dataDir: string): { id, title, at: string }[]`: rounds whose final item has no `acked` event. Reads the disk; starts no server.
  - `noticeLine(list): string`: `""` for an empty list; otherwise one line per round: `decide: round <id> "<title>" was answered at HH:MM and not collected; call wait {round: "<id>"}.`
  - Every decide tool result for a project starts with `noticeLine` when it is not empty (the `wait` that collects the round excepted).
  - `node decide.mjs notice [--project <dir>]`: prints the line or nothing; exit code 0 either way.

- [ ] **Step 1: Write the failing tests**

```js
test("a round answered with no agent shows up; after ack it does not", ...);
test("the line is the first line of the next tool result in that project", ...);     // MCP child: history → text starts with "decide: round"
test("another project's tool results do not carry it", ...);
test("notice prints nothing and starts no server when there is nothing", ...);       // stdout === "", no daemon.json in home
test("the agent session died after the result was written but before ack: the line stays", ...);
```

- [ ] **Step 2: Run** `node --test test/core-notice.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Check the current Claude Code plugin hooks reference before writing `hooks/hooks.json` (a `SessionStart` command hook that runs `node "${CLAUDE_PLUGIN_ROOT}/decide.mjs" notice`); do not write the format from memory. Check whether Codex has a session-start hook; if it has none, write that down in the commit body and move on: the tool-result line covers Codex.
- [ ] **Step 4: Run** `node --test`. Expected: exit code 0.
- [ ] **Step 5: Commit** `core: uncollected answers announce themselves`.

### Task 10: Request guard

**Files:**
- Modify: `lib/http.mjs`, `lib/server.mjs`
- Test: `test/security.test.mjs`

**Interfaces:**
- Produces: `guard(req, { port, token }): { ok: true } | { ok: false, status: 403, error: string }`, called first for every request; `PAGE_CSP: string`.
  - `Host` must pass `hostAllowed` (unchanged).
  - A request with an `Origin` header that is not `http://127.0.0.1:<port>` or `http://localhost:<port>` is refused, `GET` included.
  - A state-changing request needs a same-origin `Origin` or `x-decide-token` equal to the token.
  - `index.html` is served with `PAGE_CSP`: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'`.

- [ ] **Step 1: Write the failing tests**

```js
test("POST from another origin is refused", ...);                 // Origin: https://evil.example → 403, no event in the log
test("POST with no Origin and no token is refused", ...);
test("POST with the token passes; a wrong token does not", ...);
test("GET /api/state with a foreign Origin is refused", ...);
test("a Host header that is not loopback is refused", ...);       // existing behaviour, pinned
test("the page is served with the CSP above", ...);
test("the 2.1 page saves a draft from its own origin", ...);      // fetch with Origin http://127.0.0.1:<port>
test("an html block is served from its own URL with the sandbox policy", ...);   // not srcdoc
```

- [ ] **Step 2: Run** `node --test test/security.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement `guard` and `PAGE_CSP`.** The `x-decide: 1` header check is replaced by the guard. Inline scripts and styles in `ui/index.html`, if any, move to files so the CSP holds; `style` attributes written through HTML strings move to classes or are set through the DOM. Check first: an `html` block is a `srcdoc` frame today, and a `srcdoc` document inherits the page's policy, which would block the block's own inline scripts and styles. Serve html blocks from a URL of their own with `ASSET_CSP` instead.
- [ ] **Step 4: Run** `node --test`. Expected: exit code 0.
- [ ] **Step 5: Commit** `core: only the page and token holders can change a round`.

### Task 11: Registry of question types

**Files:**
- Create: `lib/registry/index.mjs`, `lib/registry/strict.mjs`, `lib/registry/types/{single,multi,confirm,rank,scale,text}.mjs`, `ui/js/types/{single,multi,confirm,rank,scale,text}.js`, `ui/js/types/index.js`
- Modify: `lib/spec.mjs`, `ui/js/logic.js`, `ui/js/inputs.js`, `ui/js/question.js`
- Test: `test/registry.test.mjs`

**Interfaces:**
- Produces:
  - `FieldDef = { type: "string" | "number" | "boolean" | "enum" | "array" | "object" | "any", doc: string, values?: string[], items?: FieldDef, fields?: Record<string, FieldDef> }`.
  - Server module default export: `{ name: string, summary: string, fields: Record<string, FieldDef>, optionFields?: Record<string, FieldDef>, normalize(q, ctx): void, lint(q, add): void, example: object }`.
  - Page module named exports: `emptyAnswer(q)`, `isAnswered(q, a): boolean`, `describe(q, a, words): string`, `render(q, ctx): HTMLElement`, `keys?: object`. No DOM access at import time.
  - `lib/registry/index.mjs`: `TYPES: Map<string, TypeDef>`; `QUESTION_FIELDS`, `OPTION_FIELDS`, `ROUND_FIELDS: Record<string, FieldDef>` (the fields common to all).
  - `lib/registry/strict.mjs`: `unknownFields(obj, known: string[], where: string, add): void` (adds an error `unknown field "optoins"; did you mean "options"?`) and `nearest(name: string, known: string[]): string | null` (edit distance of at most 2, or a shared prefix of 4 or more).
  - `lib/spec.mjs` keeps `normalizeSpec(raw, { specDir })` and `fitBudget`; `TYPES` there becomes `[...registry.TYPES.keys()]`.

- [ ] **Step 1: Write the failing tests**

```js
test("an unknown field is an error with the nearest name", () => {
  const { issues } = normalizeSpec({ questions: [{ id: "a", title: "t", optoins: ["x", "y"] }] });
  assert.match(errorsOf(issues)[0], /unknown field "optoins".*"options"/);
});
test("a string where an option is expected becomes its label", () => {
  const { spec } = normalizeSpec({ questions: [{ id: "db", title: "Which?", options: ["Postgres", "SQLite"] }] });
  assert.deepEqual(spec.questions[0].options.map((o) => o.label), ["Postgres", "SQLite"]);
});
test("every type has a page module that imports under Node", ...);
test("every type has a summary, an example that validates and strings in en and ru", ...);
test("every example of every type validates with no error", ...);
test("the six 2.1 types normalise exactly as before", ...);        // examples/showcase.questions.json: deepEqual against a snapshot taken on master
```

- [ ] **Step 2: Run** `node --test test/registry.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Move each type's branch out of `lib/spec.mjs` (normalise, lint), `ui/js/logic.js` (`emptyAnswer`, `isAnswered`, `describe`) and `ui/js/inputs.js` (render) into its two modules; `logic.js` and `inputs.js` dispatch through `ui/js/types/index.js`. Take the snapshot for the last test on `master` before touching `spec.mjs` and commit it as `test/fixtures/2.1/showcase.normalized.json`.
- [ ] **Step 4: Run** `node --test`. Expected: exit code 0.
- [ ] **Step 5: Commit** `registry: one module per question type on each side`.

### Task 12: Registry of media kinds, generated schema and docs

**Files:**
- Create: `lib/registry/media/{images,preview,html,mermaid,code,compare,video,diff,table,chart,links}.mjs`, `ui/js/media/*.js` (same names), `lib/registry/docs.mjs`
- Modify: `lib/media.mjs`, `ui/js/media.js`, `skills/decide/spec.md` (markers), `package.json` (`"docs": "node lib/registry/docs.mjs --write"`)
- Test: `test/registry.test.mjs` (extend)

**Interfaces:**
- Consumes: `FieldDef`, `TYPES` (Task 11).
- Produces:
  - `MEDIA: Map<string, MediaDef>` in `lib/registry/index.mjs`; `MediaDef = { name, summary, field: FieldDef, normalize(node, ctx): void, lint(node, add): void, example: object }`. Page side: `render(node, ctx): HTMLElement`.
  - `specSchema(): object`: JSON Schema of a spec with `additionalProperties: false` at every level, options accepting `string | object`.
  - `docTables(): { types: string, media: string }`: markdown tables.
  - `typeLines(): string`: one line per type and per media kind, for tool descriptions.
  - `skills/decide/spec.md` holds the tables between `<!-- registry:types -->` / `<!-- registry:media -->` markers and their closing twins.

- [ ] **Step 1: Write the failing tests**

```js
test("every media kind has a page module, a doc row and a valid example", ...);
test("spec.md is in step with the registry", () => {
  assert.equal(between(readFileSync("skills/decide/spec.md", "utf8"), "registry:media"), docTables().media);
});
test("the schema refuses an unknown field and accepts string options", ...);     // a tiny schema check inside the test, no library
test("typeLines names every type and every media kind once", ...);
```

- [ ] **Step 2: Run** `node --test test/registry.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** `ui/js/media.js` (584 lines) is split by kind; shared pieces (lightbox, frame sizing) stay in it. Correct the `preview` row while generating: mockups do have network access.
- [ ] **Step 4: Run** `npm run docs`, then `node --test`. Expected: exit code 0, `git diff --stat` shows `spec.md` changed only between the markers.
- [ ] **Step 5: Commit** `registry: media kinds, generated schema and reference tables`.

### Task 13: One command table for MCP and CLI

**Files:**
- Create: `lib/commands/index.mjs` and one file per command: `ask`, `swipe`, `wait`, `push`, `explain`, `screenshot`, `history`, `supersede`, `adr`, `export`, `import`, `lint`, `stop`, `open`, `notice`
- Delete: `lib/tools.mjs`, `lib/commands.mjs`
- Rewrite: `mcp.mjs`, `decide.mjs`
- Test: `test/commands.test.mjs`

**Interfaces:**
- Consumes: `ensureServer`, `api`, `waitNext`, `ack`, `specSchema`, `typeLines`, `noticeLine`.
- Produces:
  - `CommandDef = { name: string, summary: string, params: Record<string, FieldDef>, mcp: boolean, cli: boolean, legacyFlag?: string, run(args: object, ctx: Ctx): Promise<{ text: string, exit?: number, delivered?: () => Promise<void> }> }`.
  - `Ctx = { project: Project, server(): Promise<Server>, signal?: AbortSignal }`.
  - `COMMANDS: CommandDef[]`; `runCommand(name: string, args: object, ctx: Ctx)`; `UserError`.
  - CLI: `decide <command> [--param value …] [file]`. Every 2.1 flag keeps working through `legacyFlag` (`--lint`, `--wait`, `--reply`, `--export`, `--import`, `--adr`, `--shot`, `--sim`, `--journal`, `--supersede`, `--stop`, `--demo`, and a bare spec path).
  - MCP: `tools/list` is built from `COMMANDS` with `mcp: true`; `ask` and `swipe` descriptions end with `typeLines()`; `inputSchema` for `spec` is `specSchema()`.

- [ ] **Step 1: Write the failing tests**

```js
test("swipe, push, lint and stop exist as MCP tools and as CLI commands", ...);
test("explain takes the same fields on both sides", ...);                   // params of the tool equal the CLI's flags
test("every 2.1 flag still runs its command", ...);                         // table of [argv, command name]
test("an MCP call with an unknown argument names the nearest one", ...);    // {rond: "1-ab"} → 'did you mean "round"?'
test("tools/list has the eleven 2.1 tools plus lint and stop", ...);
test("wait never answers 'page is not running'", ...);                      // home with no server and one pending round on disk
```

- [ ] **Step 2: Run** `node --test test/commands.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** `mcp.mjs` keeps only stdio JSON-RPC, cancellation and the `delivered` hook; `decide.mjs` keeps only argv parsing and exit codes (`EXIT_ASK = 3` stays). `open` starts the server if needed and opens the page.
- [ ] **Step 4: Run** `node --test`. Expected: exit code 0.
- [ ] **Step 5: Commit** `commands: one table behind the MCP tools and the CLI`.

### Task 14: Formats, migration, journal

**Files:**
- Create: `lib/migrate.mjs`, `test/fixtures/2.0/*`, `test/fixtures/2.1/*`
- Modify: `lib/journal.mjs`, `lib/spec.mjs`, `lib/answers.mjs`
- Test: `test/migrate.test.mjs`

**Interfaces:**
- Consumes: `openProject().legacyDirs` (Task 1).
- Produces:
  - `SPEC_FORMAT = 3`, `ANSWERS_FORMAT = 3`, `JOURNAL_FORMAT = 3`.
  - `migrateSpec(raw: object): { spec: object, from: 1 | 2 | 3 }`, `migrateAnswers(file: object): object`, `migrateEntry(entry: object): object`. Pure; they never write. In this milestone step 1→2 holds the legacy normalisations that sit inline in `lib/spec.mjs` today (`image` on options, `note: true`, `recommended: true`) and step 2→3 only stamps the version; milestones 2 and 3 add to step 2→3.
  - `readJournal(project: Project, opts)`, `overlaps(project, texts, opts)`, `findDecision(project, round)`: read `project.dataDir` and every `project.legacyDirs`, de-duplicated by round id, the main dir winning.
  - `appendJournal(dataDir, round, result)`: the 2.x fields unchanged, plus `format: 3` and `records: [{ id: "<round>/<question>", title, answer: string, flag?: string }]`.

- [ ] **Step 1: Write the failing tests**

```js
test("every 2.0 and 2.1 spec fixture opens with no error", ...);
test("2.x answers files read as format 3 and are not rewritten", ...);       // mtime unchanged
test("a 2.1 journal reads; a 3.0 line is readable by the 2.1 reader", ...);  // run the reader from f62a924 kept as test/fixtures/2.1/journal-reader.mjs
test("a worktree's old journal is merged in and de-duplicated by round id", ...);
test("3.0 never writes into a legacy dir", ...);
test("a journal entry carries one record per question with a stable id", ...);
```

- [ ] **Step 2: Run** `node --test test/migrate.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Fixtures: `git show v2.0.0:examples/…` and `git show f62a924:examples/…`, plus answers and a journal produced by running each of those two versions in a scratch home. Then run `decide lint` over every spec under the real `~/.decide/projects/*/rounds/` (read only, output to the scratchpad, nothing committed) and report how many fail and why; an unknown-field failure on a real 2.x spec is a blocker for this task, not a warning.
- [ ] **Step 4: Run** `node --test`. Expected: exit code 0.
- [ ] **Step 5: Commit** `formats: versions and migrate-on-read for specs, answers and the journal`.

### Task 15: Vendored Mermaid, asset publishing, export limits

**Files:**
- Create: `ui/vendor/mermaid.min.js`, `ui/vendor/mermaid-frame.html`, `ui/vendor/README.md` (version, source, sha256)
- Modify: `ui/js/media/mermaid.js`, `lib/assets.mjs`, `lib/export.mjs`, `lib/commands/export.mjs`, `lib/server.mjs`
- Test: `test/security.test.mjs` (extend), `test/v21.test.mjs` (export cases)

**Interfaces:**
- Produces:
  - `createRoots(): { publishFile(abs: string): string, publishDir(absHtml: string): string, fileFor(pathname: string): string | null, publish(spec), publishNode(node) }`. URLs are `/r/<hex8 of fnv1a(path)>/<name>`, so they survive a restart. `publishFile` serves that file only; `publishDir` serves the directory of an `.html` mockup.
  - `export` refuses a target outside the project root and the data dir unless `outside: true` (`--outside` on the CLI); the error names the flag.
  - `buildExport` sums the sizes of what it would inline before reading any of it and throws a `UserError` above 60 MB; the file is written through a stream.
  - An exported file inlines the vendored Mermaid when the round has a `mermaid` block and loads nothing from a CDN.

- [ ] **Step 1: Write the failing tests**

```js
test("an image publishes itself, not its neighbours", ...);                // GET of a sibling file in the same directory → 404
test("a mockup publishes its own directory", ...);                         // card.html loads ./card.css → 200
test("asset URLs are the same after a restart", ...);
test("no file under ui/ names a CDN host", ...);                           // grep for jsdelivr, unpkg, cdnjs in ui/ → none
test("export outside the project is refused without the flag", ...);
test("an export over 60 MB fails before reading the media", ...);          // sparse 61 MB file; the error arrives in under a second
test("an exported round with mermaid has no external URL in script or link tags", ...);
```

- [ ] **Step 2: Run** `node --test test/security.test.mjs test/v21.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Get Mermaid with `npm pack mermaid@<exact 11.x version>` into the scratchpad and copy `dist/mermaid.min.js`; record the version and the sha256. Mermaid writes `<style>` elements into its SVG, which `style-src 'self'` blocks. Render diagrams in a frame of their own (`ui/vendor/mermaid-frame.html`) whose policy allows inline styles and scripts from `'self'` only, sized by `postMessage`; the page's own policy stays strict.
- [ ] **Step 4: Run** `node --test`. Expected: exit code 0.
- [ ] **Step 5: Commit** `security: vendored Mermaid, narrower asset publishing, export checks`.

### Task 16: Close milestone 1

**Files:**
- Create: `examples/v3/m1-recovery.questions.json`, `docs/plans/2026-11-15-decide-3-m1-demo.md` (five commands the owner runs)

- [ ] **Step 1:** `node --test`. Expected: exit code 0. Then the same in a clean clone of the branch.
- [ ] **Step 2:** In a scratch home, with `agent-browser` (muted, own session name): open the demo, answer two of five questions, ask the agent one question, `kill -9` the server pid from `daemon.json`, run `node decide.mjs open`. Look at the screenshot yourself: both answers and the question are there. Repeat with the swipe demo. Then open `examples/showcase.questions.json`: a Mermaid block, an html block and a mockup all render, and the browser console shows no CSP violation.
- [ ] **Step 3:** In the same home start three `ask` calls at once from three shells. Expected: three rounds in `GET /api/state`, one pid.
- [ ] **Step 4:** One fresh Opus reviewer on the diff `origin/master...v3`, no author context; a second reviewer with a security role on Tasks 5, 7, 10 and 15 only. At most two fix rounds; P0, P1 and serious P2 block. After fixes, check the fix diff against the findings only.
- [ ] **Step 5:** Report to the owner: what is done, where it was verified, the demo commands, what is left. He opens the demo on his machine. Milestone 2's steps are written after his reaction.

---

# Milestone 2: Page

Done when: the page is rebuilt in the chosen look on the new core, the acceptance list of the design ("The look", 14 items) passes in a browser, and the owner has seen it.

The first task is a gate: nothing else in this milestone starts before the owner has answered it.

| Task | Files | Produces | Proved by |
|---|---|---|---|
| **P1. Calmer pass of the look** | `docs/plans/2026-11-15-decide-3-look.html` → `docs/plans/…-look-2.html`; a decide round with screenshots at 375, 768, 1440, light and dark | The approved mockup: one accent, no legend under progress, plain-text labels, one badge per option at rest, solid content cards, measured contrast | The owner's answer in a decide round; contrast numbers in the round |
| **P2. Tokens and materials** | `ui/css/tokens.css`, `ui/css/glass.css` (new), `ui/css/base.css` | CSS custom properties for the material (`--glass-bg`, `--glass-blur`, `--glass-edge`), type steps, spacing; the default theme follows the system; fallbacks under `prefers-reduced-transparency`, `prefers-reduced-motion` and `@supports not (backdrop-filter: blur(1px))` | `e2e/look.spec.mjs`: computed contrast ≥ 4.5 for body text in both themes; solid surfaces under the three fallbacks |
| **P3. Answers as events** | `lib/store/state.mjs` (`answer`, `note`, `flag` events), `lib/server.mjs` (`POST /api/rounds/:id/answer`, SSE `event: round` with `{ seq, patch }`), `ui/js/net.js`, `ui/js/store.js` (new) | `saveAnswer(round, qid, answer): Promise<{ seq }>`; page state resumes from a sequence number; a "saved" / "not saved, retrying" indicator; `draft` events still replay for rounds opened before the upgrade | `test/core-answers.test.mjs`; `e2e/tabs.spec.mjs`: **two tabs on one round converge and neither wipes the other** (Review Focus 4); reload restores answers and scroll |
| **P4. Shell and inbox** | `ui/index.html`, `ui/js/main.js`, `ui/js/inbox.js` (new), `ui/css/chrome.css`, `lib/server.mjs` (`GET /api/inbox`) | Inbox rail across projects: high stakes first, then longest waiting; row = project, title, progress, mode, listening; "older" group after a day with no agent; dismiss; after Done the next round; the tab never closes itself; a new round appears in the rail without a new tab | `e2e/inbox.spec.mjs`; `test/core-inbox.test.mjs` for the order |
| **P5. Question anatomy** | `lib/registry/index.mjs` (`why`, `more`, option `then`), `lib/migrate.mjs` (2→3: `what`, `how`, `goal`, question `then` joined into `more`), `ui/js/question.js`, `ui/css/question.css`, `lib/spec.mjs` (lint) | The `why` line, "what happens next" under each option, one "more" button; lint warns on a choice question with no `why` and an option with no `then` | `test/migrate.test.mjs` (2.1 facets → `more`); `e2e/question.spec.mjs` |
| **P6. Ready answers** | `ui/js/types/*.js`, `ui/js/quick.js` (new), `ui/js/logic.js`, `lib/journal.mjs` | "Yes, but…" → `{ selected, condition }`; "None, suggest others" → `flag: "none"` plus note (the request to the agent arrives in milestone 3); "Later" → `flag: "later"`, `revisit: string`; `history` and the `ask` result list deferred decisions | `test/logic.test.mjs`; `test/core-later.test.mjs`; digest lines for each |
| **P7. Progress, keys, footer** | `ui/js/nav.js`, `ui/js/header.js`, `ui/css/header.css` | Segmented progress coloured by state; key hints with a keyboard, touch hints on touch; `1`, `J`, `2` answers question 2; one count in header, cards and footer; rank and scale count as answered | `e2e/keys.spec.mjs` |
| **P8. Swipe in the new look** | `ui/js/swipe.js` (split into `ui/js/swipe/{deck,card,brief,end}.js`), `ui/css/swipe.css` | The deck as a real stack; thumb buttons on a phone; a card fits the screen; one set of controls on the end screen | `e2e/swipe.spec.mjs` at 375 and 1440 |
| **P9. Listening, stopped server, Done** | `ui/js/header.js`, `ui/js/offline.js`, `ui/js/done.js` (new) | "The agent is waiting" / "no agent is listening; your answers are saved…" with a line to paste; a stopped server said in words with the command; Done as a readable summary | `e2e/states.spec.mjs` |
| **P10. Acceptance list** | `ui/js/overlays.js`, `ui/js/dialog.js`, `ui/js/journal.js`, `ui/css/*` | Every remaining item of the design's list: wrapping at the three widths, review dialog's Send on screen, "ask the agent" with Send and one status, own option shown selected, viewer with previous / next / "pick this one", 12+ questions usable, skip link and tab order, journal dates, a bad round id is an error | `e2e/acceptance.spec.mjs`, one test per item, named after it |
| **P11. Browser test harness** (lands with P2) | `package.json` (`devDependencies: @playwright/test`, `"test:browser"`), `e2e/helpers.mjs`, `.github/workflows/test.yml` (one ubuntu job) | Tests live in `e2e/`, outside what `node --test` picks up; each starts its own server in its own home; browsers muted | The job is green; `node --test` still needs no install |
| **P12. Close** | `examples/v3/m2-*.json`, demo notes | Screenshots at three widths in both themes looked at by the session itself; one fresh review; the owner's demo | Exit codes of both test commands |

# Milestone 3: Reactive rounds

Done when: a rule in a spec changes the round the moment an answer changes, an agent patch does the same a moment later, and no answer is ever dropped silently.

| Task | Files | Produces | Proved by |
|---|---|---|---|
| **R1. Rule engine** | `ui/js/rules.js` (new, shared with the server like `logic.js`), `lib/registry/index.mjs` (`rules`), `lib/migrate.mjs` (`showIf` → a ghost rule) | `evaluate(spec, answers): { ghosts: Map<id, reason>, removed: Map<qid, Set<optionId>>, stale: Set<qid> }`: pure, computed from the current answers, so undoing an answer undoes the effect. Evaluation runs to a fixed point with a cap of `questions.length + 1` passes | `test/rules.test.mjs`: reversibility; **contradicting and looping rules end, give the same result on a second run, and lint names the loop** (Review Focus 5); 2.x `showIf` specs give a ghost |
| **R2. Patch operations** | `lib/store/patch.mjs` (new), `lib/store/state.mjs` (`patch` event), `lib/commands/patch.mjs`, `lib/commands/explain.mjs` (`patch` field) | `applyPatch(view, patch): view` for `ghost`, `restore`, `set`, `addOptions`, `removeOptions`, `setOptions`, `add`, `remove`, `recommend`, `stale`, `brief`; `keepAnswers`, `override`; `remove` of a seen item becomes a ghost. Tool `patch {round, ops, reason}` | `test/patch.test.mjs`, one test per operation and per row of the precedence order |
| **R3. Computed view** | `lib/store/view.mjs` (new) | `viewOf(spec, events): { items: [{ id, state: "normal" \| "changed" \| "new" \| "ghost", reason, was }], answers, stale: string[] }` in the order: spec, patches as they arrived, rules over current answers, overrides, then the user's own restores | `test/view.test.mjs`: a rule still applies after a patch touched the item; a user restore survives both |
| **R4. States on the page** | `ui/js/question.js`, `ui/js/states.js` (new), `ui/css/states.css` (new) | Ghost (grey, reason, one-click restore), changed (badge, reason, "what it was"), new, stale ("check": keep or answer again). The page never moves focus or scroll and never repaints the item being typed in; that item says "this question was updated" | `e2e/reactive.spec.mjs`: focus and scroll position before and after a patch are equal |
| **R5. Stale block** | `ui/js/logic.js`, `ui/js/header.js`, `lib/store/rounds.mjs` (`finish` refuses) | "N answers to check" in the footer opens them as a list; Done is refused while one is unconfirmed, on the page and on the server | `e2e/stale.spec.mjs`; `test/core-store.test.mjs` |
| **R6. Swipe** | `lib/swipe.mjs`, `ui/js/swipe/*` | Ghost cards are skipped and listed; stale answers return as cards at the end with the old answer preselected; `push` becomes the swipe-shaped form of `patch` and the 33 refused removals become ghosts | `test/swipe.test.mjs`; `e2e/swipe.spec.mjs` |
| **R7. Live questions rounds** | `lib/store/state.mjs` (`batch` for questions), `lib/commands/wait.mjs` | `live: true`: `wait` returns a batch after 3 answers or 20 s of pause (the builder may tune both, and records the numbers in `spec.md`); without it the agent hears only the final answers | `test/live.test.mjs` |
| **R8. Replies that patch; "none, suggest others"** | `lib/commands/explain.mjs`, `ui/js/dialog.js`, `ui/js/quick.js` | The page lists under a reply what it changed; "none" becomes an outbox item of kind `request` and the agent's patch replaces the options; with no agent listening it stays a flag | `e2e/reply.spec.mjs`; `test/core-delivery.test.mjs` |
| **R9. Answers file and close** | `lib/store/rounds.mjs`, `lib/registry/docs.mjs`, examples, demo | `ghosts: [{ id, reason }]` in the answers file; ghosts' earlier answers kept on disk and left out of `answers` | `test/core-store.test.mjs`; review; the owner's demo |

# Milestone 4: Knobs

Done when: a `tune` question with a mockup that has no script of its own reacts to every control, and the values come back in the answer.

| Task | Files | Produces | Proved by |
|---|---|---|---|
| **K1. The `tune` type** | `lib/registry/types/tune.mjs`, `ui/js/types/tune.js` | Fields `preview`, `knobs` (`range`, `toggle`, `select`, `color`, `text`, `image`), `presets`, `frames`, `themes`, `derived`; answer `{ values, preset, snapshots: [{ name, values }], picked, candidates, derived }` | `test/registry.test.mjs`, `test/tune.test.mjs` |
| **K2. The bridge** | `lib/bridge.mjs` (new; injected into a served mockup that belongs to a `tune` question), `ui/js/knobs.js` (new) | In the frame: `--knob-<id>` on the root, text or image into `[data-knob="<id>"]`, a `decide:knobs` event with `{ values }`, `data-theme` and `color-scheme` on the root. Values arrive by `postMessage`; the frame keeps its opaque origin | `e2e/knobs.spec.mjs`: a mockup with no script changes; a mockup with a listener receives the event |
| **K3. The panel** | `ui/js/types/tune.js`, `ui/css/tune.css` | The instrument rack: ticks, large values, memory slots, keyboard steps on every control | `e2e/knobs.spec.mjs`; screenshots looked at |
| **K4. Presets and snapshots** | `ui/js/types/tune.js`, `lib/store/state.mjs` (`knobs` event) | Presets as starting points; "remember this"; saved variants side by side as small live frames; pick one or send two candidates; values survive `kill -9` | `test/core-recovery.test.mjs`; `e2e/knobs.spec.mjs` |
| **K5. Frames and themes** | `ui/js/types/tune.js` | One set of knobs drives phone and desktop widths, light and dark, side by side | `e2e/knobs.spec.mjs` at 1440 and 375 |
| **K6. Formulas** | `ui/js/formula.js` (new, shared with the server) | `compile(source: string): (values) => number \| null`; grammar: numbers, knob ids, `+ - * / %`, parentheses, unary minus, `min`, `max`, `round`, `abs`; no `eval`, no `Function`. Division by zero, an unknown name or a source over 500 characters gives `null` and a lint error, never a throw | `test/formula.test.mjs`; derived values recomputed on the page equal the server's |
| **K7. Numbers view** | `ui/js/types/tune.js`, `ui/js/media/{table,chart}.js` | Knobs drive a table and a chart instead of a mockup; `derived` in the answer | `e2e/knobs.spec.mjs` |
| **K8. In words, own content** | `lib/store/patch.mjs` (`knobs` op), `ui/js/types/tune.js` | "Make it calmer" → outbox item → a `knobs` patch that moves controls or replaces the mockup; the state before is kept as a snapshot; with no agent the text is a note. Image knobs store the file with the round | `test/patch.test.mjs`; `e2e/knobs.spec.mjs` |
| **K9. Close** | examples, demo | The demo the owner asked for as the reason people come: an invitation card with density, accent, names and photo | Review; the owner's demo |

# Milestone 5: The rest

Each row is independent of the others and may be built in any order or in parallel; they share only the registry.

| Task | Files | Produces | Proved by |
|---|---|---|---|
| **F1. `buckets`** | `lib/registry/types/buckets.mjs`, `ui/js/types/buckets.js` | Drag or number keys; answer `{ buckets: { <name>: [ids] } }` | `test/registry.test.mjs`, `e2e/forms.spec.mjs` |
| **F2. `tradeoff`** | `…/tradeoff.mjs`, `…/tradeoff.js` | A slider between two poles, the recommended position marked; `{ value: 0–100 }` | same |
| **F3. `spot`** | `…/spot.mjs`, `…/spot.js` (reuses `ui/js/annotate.js`) | Points or areas on a screenshot; `{ points: [{ x, y, w, h, text }] }` in percent | same |
| **F4. `versus`** | `…/versus.mjs`, `…/versus.js` | Pairs of 4 to 8 variants with the arrow keys until one wins, no agent calls; `{ winner, order, pairs }` | same; the number of pairs for 8 variants is at most 12 |
| **F5. Evidence labels** | `lib/registry/index.mjs`, `ui/js/question.js` | A pro, con, metric or recommendation reason as a string or `{ text, evidence: "measured" \| "estimate" \| "guess", source }`; lint warns on `measured` with no `source` | `test/registry.test.mjs`, `e2e/question.spec.mjs` |
| **F6. Task panel** | `ui/js/brief.js` (from `ui/js/swipe/brief.js`), `lib/registry/index.mjs` (`brief`) | One `brief` field in both modes; the agent rewrites it with the `brief` patch op | `e2e/brief.spec.mjs` |
| **F7. Decision map and journal** | `lib/journal.mjs` (`dependsOn`, edges), `ui/js/journal.js`, `ui/js/map.js` (new) | Journal across projects or one, with dates; a Mermaid map with edges from rules, `supersede` and `dependsOn`; above 40 nodes the map shows one project or one round's neighbourhood at a time | `test/journal.test.mjs`, `e2e/journal.spec.mjs` |
| **F8. How much to ask** | `lib/settings.mjs` (new; `<dataDir>/settings.json`, `<dataDir>/rules.json`), `lib/commands/ask.mjs`, `lib/commands/rules.mjs`, `lib/commands/history.mjs`, `ui/js/settings.js` (new) | Levels `everything` (default), `irreversible`, `mine`; `touches: ["money" \| "data" \| "security" \| "public"]`; rules from answers ("don't ask again", "always ask me"); `ask` rejects once with the rules listed; `history` starts with the level and the rules; lint demands `reversible` at the middle level | `test/settings.test.mjs` |
| **F9. Page buttons** | `ui/js/actions.js` (new), `lib/server.mjs` | Export this round, save as ADR, "I have 5 minutes" (`fitBudget` with 5), all without the agent | `e2e/actions.spec.mjs`: an exported file answered offline imports back |
| **F10. Hints and overlap index** | `lib/hints.mjs` (new), `lib/journal.mjs` | Up to three hints in the `ask` result; overlap check under 100 ms for 90 questions against 500 entries, live decisions only | `test/hints.test.mjs`; a timing test with that fixture |
| **F11. Installable app** | `ui/manifest.webmanifest`, `ui/sw.js`, `ui/js/main.js` | Installable; the badge shows waiting rounds; with the server down the app says how to start it; on a fallback port the page says the app will not find it | `e2e/pwa.spec.mjs` |
| **F12. Close** | examples, demo | Review; the owner's demo | Exit codes |

# Milestone 6: Release candidate

| Task | Files | Produces |
|---|---|---|
| **X1. Skills** | `skills/decide/SKILL.md`, `skills/decide/spec.md`, `skills/swipe/SKILL.md` | Rewritten around the new anatomy and the rules, one worked example per type; tables still generated |
| **X2. README, demo, migration notes** | `README.md`, `docs/demo.gif`, `docs/screens/*`, `docs/migrating-to-3.md` | What changes for a 2.x user: `showIf` questions become ghosts, strict fields, one page, where rounds live |
| **X3. Usage check** | scratchpad only | The four numbers from "How we check" recomputed on a week of real use of the branch: uncollected rounds, "page is not running", questions to the agent per round, own-text answers of the "yes, but" and "none" kind |
| **X4. Review and hand-over** | none | One fresh review of what changed since the milestone 5 review; the owner decides on the merge to `master`, the version and the tag |

---

## Execution rules

- One task, one commit, tests first. A task is not done until its suite and every suite it could touch exit 0.
- Workers: Sonnet (or `gpt-6.1-sol` medium through `codex-job`). Reviewers: Opus, never weaker than the author. Every worker brief states the task, these constraints, what is forbidden (push, merge, anything outside the worktree, the real `~/.decide`), when to stop and what proof to return. A worker's green report is rechecked by running the commands in its worktree.
- Milestone 5 is the only wave of more than five parallel tasks; post the one-line cost note before starting it.
- After two failed fixes of the same thing: stop, reproduce again, propose a different approach.
- Page changes: the session looks at the screenshot itself before saying a task is done.
- A milestone is reported as done only with where and how it was verified.

## Spec coverage

| Design section | Tasks |
|---|---|
| One server per machine | 5, 6, 7, 10 |
| Rounds on disk | 2, 3, 4, 6; P3 |
| Delivery to the agent | 8, 9; P9 |
| Project identity | 1, 14 |
| One registry | 11, 12, 13 |
| Versions and migration | 14; P5, R1 |
| Security | 10, 15 |
| Rounds that react | R1 to R9 |
| The question | P5, P6, F5 |
| Knobs | K1 to K9 |
| New forms | F1 to F4, K1 |
| One page | P4, P9, F6, F7, F9, F11 |
| How much to ask | F8 |
| Making the rest reachable | 12, 13, F10, X1 |
| The look | P1, P2, P7, P8, P10 |
| How we check | every task's suite; P11; X3 |

## Calls made in this plan

The design left these to the builder; they are decided here and can be overturned.

- The round directory layout, the fourteen event types and the four statuses listed under File structure.
- Ports for other homes: `44000 + fnv1a(home) % 2000`, clear of 2.1.x's range and of 47474.
- The protocol starts at 1; a server speaks its own number and the one below.
- A page module carries the type's pure answer logic as well as its rendering, so a type stays two modules; the server imports the pure part.
- Unknown spec fields are errors for every spec, 2.x included; Task 14 checks that against the real 2.x specs before the milestone closes.
- An exported file inlines Mermaid when the round uses it (about 3 MB more) instead of loading it from a CDN.
- Mermaid renders in a frame of its own and html blocks are served from their own URLs, so the page's policy can stay at `'self'` for scripts and styles.
- Browser tests live in `e2e/` and run in one CI job; `node --test` stays install-free.
- Live questions rounds batch after 3 answers or 20 s of pause.
- The decision map shows at most 40 nodes at a time.
- `v3` is not pushed without the owner's word.
