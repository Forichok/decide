# decide 3.0: design

Status: approved by the owner on 2026-11-15 (round `4-7e49e2`). Nothing is
built yet.

Sources: four audits of 2.1.1 run on 2026-11-15 (code, the page in a browser,
seven weeks of real usage, the market), then three owner rounds the same
day: `1-b5d10e` (11 answers), `2-7b7d2a` (7 answers), `3-dd09ee` and
`4-7e49e2` (the look, and the approval). A fresh reader then checked this document against the code; his seven
questions are answered in the text. Line references are to
2.1.1 at `f62a924`. Findings I reproduced myself are marked ✔; the rest come
from the audit agents.

## Why

2.1.1 does the job and still reads as an alpha. The owner's words, shortened:

- he keeps having to interrogate the agent, because the questions and the
  five folded hint points under them are unclear;
- one answer often makes later questions, or their options, pointless, and
  the round does not notice;
- he wants cards to change with the answers, dead ones marked as ghosts, and
  the same when he asks the agent something: the reply should be able to
  change the current card and the ones after it, in both modes;
- the look needs a refresh, and some ways of showing a question are missing.

The audits add what he could not see from the page:

| Finding | Evidence |
|---|---|
| A session on another plugin version shuts down the running page server ✔ | `lib/client.mjs:55-58` |
| Three `ask` calls on a cold start: two rounds get 404 on `wait` | `lib/client.mjs:61-77`, `lib/daemon.mjs:257-262` |
| A question typed on the page goes to the oldest waiter and is marked delivered with no acknowledgement ✔ | `lib/rounds.mjs:196-220` |
| Open rounds, dialogs and swipe answers live only in memory; drafts are written and never read back | `lib/rounds.mjs:25,42,67-70` |
| The server stops after 30 idle minutes; `wait` then says the page is not running although the answers file exists | `lib/tools.mjs:40-44,120,129` |
| Loose validation: `options: ["Postgres","SQLite"]` renders "Option 1 / Option 2" | `lib/spec.mjs:144-152` |
| Each worktree is a separate project with its own journal | `lib/project.mjs:15-24` |
| A new question type touches about 11 places | `lib/spec.mjs`, `mcp.mjs`, `ui/js/*`, `skills/decide/*` |

Usage over seven weeks (324 rounds, 37 projects): 21 rounds had answers the
agent never received, 13 never finished, 4 died with "page is not running"
after 4 to 5.5 hours. The owner asked the agent 191 questions on 50 rounds.
He typed his own text 231 times instead of picking an option; 46 of those
were "yes, but on a condition" and 35 were "none of these". `push` tried to
remove an already answered card 33 times and was refused
(`lib/swipe.mjs:183`). `export`, `import` and `adr` were never
called.

## What 3.0 is

One release, no 2.1.2 patch first (owner's call, against my recommendation).

Goals:

1. An answer cannot be lost. Whatever dies (the page server, the agent
   session, the browser tab), the round is still there and the next `wait`
   gets it.
2. A round reacts to answers: questions become ghosts, change their options
   or appear, at once from rules written in the spec and a moment later from
   the agent.
3. A question explains itself: why it is asked and what each option leads to,
   without unfolding anything.
4. One page for every project and session on the machine.
5. Live mockups with knobs: the user tunes the thing instead of choosing
   from three pictures, and the agent gets the values.
6. Answers people actually give have a button: "yes, but…", "none, suggest
   others", "later".
7. Three new question forms, a pairwise tournament, evidence labels, a task
   panel, a decision map, an "ask me less" setting.
8. A new look, and every defect from the page audit fixed.
9. Everything the tool can do is in front of the agent when it writes a
   round, and the user-side actions (export, ADR, "I have 5 minutes") are
   buttons on the page.

Not in 3.0 (the owner declined these or did not pick them): access from a
phone or the home network, a short fallback question in chat, an assumptions
list at the end of a round, a digest injected at session start, a check of
outcomes after the work, the round drawn inside the chat window, the ready
answers "all of them" and "a number or value", knob values returned as code
tokens, and four question forms (matrix, 100 points, decision tree,
timeline).

What would make 3.0 a failure even if it works:

- a round that changes under the user's hands without saying what changed
  and why, or that drops an answer he already gave;
- a reply that reaches no agent and no file;
- a 2.x spec that stops opening;
- the page server listening anywhere but loopback, or a web page from the
  internet being able to read or answer a round;
- a build step, a runtime dependency, an account.

## Constraints

- Node 20+, no build step, no runtime npm dependencies. Browser code is plain
  ES modules.
- Loopback only. Data stays under `~/.decide` (`DECIDE_HOME` moves it).
- One codebase serves the Claude Code plugin, the Codex plugin, the MCP
  server and the CLI.
- 2.x specs, answers files and journals keep working. Sessions still running
  2.1.x during the upgrade must not break and must not be broken.
- The digest stays in English; the page speaks English and Russian.

## Approaches

**A. Repair in place.** Keep a server per project, fix the eight defects
above one by one, add features on top. Cheapest, and it keeps the two causes
of most defects: state held in memory, and a server per project that
sessions fight over. The owner's choice of one page for all projects rules
it out anyway.

**B. New core, same shape (chosen).** One server per machine at a fixed
address. Every round is an append-only log on disk; the server is a view of
those logs and can die at any moment. Question types and media kinds come
from one registry that produces the tool schema, the validator, the docs and
the page's renderers. The page is rebuilt on that core in the new look.
The plugin shape, the MCP flow (`ask` → `wait` → `explain`) and the spec
format stay recognisable.

**C. A desktop app or a hosted service.** A tray app would solve "always
running" and notifications; a hosted page would solve the phone. Both break
the constraints (install weight, accounts, data leaving the machine) and the
owner chose "this computer only".

B is the only one that meets goals 1, 2 and 4 together. Its cost is that
almost every file in `lib/` and `ui/js/` is rewritten or moved; the test
suite and the 2.x fixtures are what keep that honest.

## Core

### One server per machine

- Fixed address `http://127.0.0.1:47474` (`DECIDE_PORT` overrides). Binding
  the port is the election: of several servers started at once, one binds
  and the others exit. That removes the cold-start race by construction.
  If a foreign process holds the port, the election falls back to an
  exclusive lock file in `~/.decide`; the winner takes a free port, writes
  it to `~/.decide/daemon.json`, and the page says the installed app and
  bookmarks will not find it.
- The fixed port belongs to the default home. A server for another
  `DECIDE_HOME` (every test uses one) gets a port derived from that path, as
  2.1.x does per project (`lib/client.mjs:14`), and keeps its info file
  inside that home. A client checks that the server it reached serves its
  home and ignores it otherwise, so a test can never reach, or hand over,
  the user's real server.
- A client never shuts a server down. The protocol has its own integer
  version, apart from the release version. A newer client meeting an older
  server asks it to hand over: the server flushes, closes and exits, the
  client starts its own, which loads every round from disk; open pages
  reconnect and reload themselves. An older client meeting a newer server
  uses it; the server speaks the current protocol and the previous one.
- 2.1.x sessions keep their per-project servers on their own ports
  (43100 to 43899). 3.0 leaves them alone.
- The server stays up while an agent is waiting on a round or a page is
  connected, and stops 30 minutes after the last of them goes. Open rounds
  do not keep it up; they are on disk. It does not start at login: after a
  reboot the next decide call, or `decide open`, starts it and the open
  rounds are back.
- Requests must carry an allowed `Host` (as today, `lib/http.mjs:13`).
  New, because one server now holds every project: state-changing requests
  need a same-origin `Origin` or the token from `daemon.json` (mode 0600),
  so a web page from elsewhere cannot answer a round.

### Rounds on disk

Each round has a directory in the project's data dir with the spec as
opened, an append-only event log, uploaded files, and the answers file once
it is sent. The log is the truth; everything else is derived.

Invariants the builder must keep:

1. A user action is on disk before the page shows it as saved. The page
   shows "saved" or "not saved, retrying", never a silent failure.
2. After `kill -9` of the server at any point, a restart restores every open
   round: answers, notes, the dialog with the agent, the deck position,
   knob values, ghosts.
3. Answers are written both to the round directory and, for a spec given as
   a file, next to that file as `<slug>.answers.json`, as in 2.x.
4. Events carry a sequence number per round. The page and the agent both
   resume from a number.

Swipe sends one event per answer, not the whole deck per keypress
(`lib/rounds.mjs:372`).

A round never expires. 2.1.1 marks a round abandoned two hours after its
last waiter left (`lib/rounds.mjs:426-430`); that is where the "page is not
running" deaths came from, and it goes. A round ends when it is sent,
cancelled, or dismissed by the user from the inbox; a dismissed round keeps
whatever was answered. Rounds with no agent listening for a day fold into an
"older" group in the inbox. A round whose agent is gone is reported with its
real title and state, never as "Round «undefined» answered (0 answers)"
(`lib/rounds.mjs:427-428`).

### Delivery to the agent

- Everything meant for the agent (a user's question, a batch of answers, a
  request for new options, the final answers, a cancel) is an outbox item
  with a sequence number. An item counts as delivered when the MCP server
  has written the tool result and the request was not cancelled;
  `notifications/cancelled` is honoured. Undelivered items are sent again.
- A new `wait` on a round replaces the older one; the older call returns
  "superseded by a newer wait".
- `wait` never says the page is not running. It starts the server if needed.
  For a finished round it returns the stored answers, whichever session
  asks.
- A network error inside `wait` is retried, not thrown (`lib/tools.mjs:127`).
- Answers nobody collected: every decide tool result in that project starts
  with one line, "round X was answered at 14:02 and not collected; call
  wait". In Claude Code a session-start hook prints the same line, and
  prints nothing when there is nothing to collect. This is how "the next
  session picks the answers up" works without the session-start digest the
  owner declined. Whether Codex can do the same is for the builder to check;
  the tool-result line covers it either way.
- The page says who is listening: "the agent is waiting", or "no agent is
  listening; your answers are saved and the next session will get them",
  with a line to paste into chat.

### Project identity

The project is the git common directory, so worktrees of one repository
share a journal and an inbox entry (2.1.1 treats each worktree as its own
project, `lib/project.mjs:15`). The main checkout keeps its data dir. A
worktree's old data dir is read as a second source every time the journal is
read, and entries are de-duplicated by round id, so a 2.1.x session that
keeps writing there during the upgrade loses nothing. 3.0 never writes to
the old directory.

Journal lines keep their 2.x shape, because 2.1.x sessions read them
(`lib/journal.mjs:77,134`). Per-question records are extra fields inside the
round's line. Anything that is not a round (settings, rules) lives in files
of its own.

### One registry

Each question type and each media kind is one module on the server side
(schema, normalisation, lint, how its answer reads in the digest, a one-line
description) and one on the page side (render, read the answer, keys).
From the registry come:

- the MCP `inputSchema`, strict: an unknown field is an error with the
  nearest known name, and a string where an option object is expected is
  accepted as its label;
- the reference tables in `skills/decide/spec.md` and the list of types and
  media in the tool descriptions (a test fails when they drift);
- the page's renderer table.

A test asserts that every entry has a page module, strings in both
languages, a doc row and an example that validates. Adding a type should
touch its two modules and the language files.

MCP tools and CLI commands come from one command table, so `swipe`, `push`,
`lint` and `stop` exist on both sides and `explain` carries the same fields
on both.

### Versions and migration

Specs, answers files and journal entries carry a format version. Readers
migrate on read through pure functions (1 → 2 → 3); old files are not
rewritten. Fixtures of real 2.0 and 2.1 specs, answers and journals are part
of the test suite.

### Security

- Mermaid is vendored at a pinned version and loaded on demand; the page
  loads no script or style from anywhere but itself (`ui/js/media.js:13`).
  The page's CSP allows scripts and styles from `'self'` only, and images
  and video from `https:` as well, because 2.x specs may point at URLs.
- Mockups and HTML blocks stay in sandboxed frames with an opaque origin, as
  today (`lib/daemon.mjs:23`). They can still load from the network, as
  they can in 2.1.1; `spec.md` says otherwise and is corrected.
- For an image or a video the server publishes that file only. For an
  `.html` mockup it publishes the mockup's own directory, because mockups
  load their CSS and pictures by relative path. Today any referenced file
  publishes its whole directory (`lib/assets.mjs:33-52`).
- `export` writes inside the project or the data dir; another path needs an
  explicit flag (`lib/daemon.mjs:139-146`).
- The 60 MB export limit is checked before inlining, and the export streams.

## Rounds that react

### States

An item (a question or a card) is `normal`, `changed`, `new` or `ghost`.
Its answer is fresh or `stale`.

- **Ghost.** No longer relevant. It stays where it was, grey, with the
  reason ("not relevant: you chose sign-in without an account") and one
  click to bring it back. Swipe skips ghosts and shows them in the deck
  list. A ghost's earlier answer is kept on disk and left out of the answers
  the agent acts on; the answers file lists ghosts with their reasons.
- **Changed.** Text or options differ from what the user first saw. A badge
  with the reason, and "what it was" on demand.
- **New.** Added after the round opened.
- **Stale answer.** The user answered, then something made the answer
  doubtful: its option was removed or rewritten, a rule or the agent said
  so, or the question text changed. The answer stays with a "check" mark and
  two actions, keep or answer again. The round cannot be sent while a stale
  answer is unconfirmed. The footer shows "N answers to check" and opens
  them as a list (owner's note). In swipe they come back as cards at the end
  with the old answer preselected.

The page never moves focus or scroll because of a change, and never repaints
the item the user is typing in; that item shows "this question was updated"
and repaints when he asks or leaves it.

### Two sources of change

The owner chose the hybrid: rules written in advance, and the agent refining
as the user goes.

**Rules** live in the spec and are applied by the page at once, and by the
server for the record. A rule is a condition on answers plus operations:

```json
"rules": [
  { "when": { "question": "confirm", "in": ["link"] },
    "reason": "you chose sign-in without an account",
    "do": [
      { "ghost": ["recover"] },
      { "removeOptions": { "question": "store", "options": ["guest-account"] } }
    ] }
]
```

Rule effects are computed from the current answers, so changing the answer
back undoes them; nothing has to be reverted by hand. `showIf` from 2.x
becomes a rule that ghosts the question. That is a visible change from 2.x,
where such a question was hidden.

**Patches** come from the agent: the same operations, sent with a new tool
`patch` or attached to `explain`. `push` stays as the swipe-shaped form of
it.

| Operation | Effect |
|---|---|
| `ghost` / `restore` | With a reason |
| `set` | Change fields of an item; marks it changed |
| `addOptions`, `removeOptions`, `setOptions` | Marks it changed; a removed option that was selected makes the answer stale |
| `add` | A new item before or after another |
| `remove` | Only for an item the user has not seen; otherwise it becomes a ghost |
| `recommend` | Move or set the recommendation, with a reason |
| `stale` | Mark an answer for checking |
| `brief` | Rewrite the task panel |
| `knobs` | Set knob values or replace the mockup (see Knobs) |

A cosmetic edit passes `keepAnswers: true` so it does not mark answers
stale.

Who wins, strongest first: the user (a ghost he restored stays restored),
an agent patch sent with `override: true`, the rules, ordinary agent
patches, the spec as opened. The state of a round is always computed in that
order from the log: the spec, then patches in the order they arrived, then
the rules over the current answers, then overrides. So a rule keeps applying
after a patch touched the same item, and an agent that really means to undo
a rule has to say so.

**When the agent hears about answers.** Swipe is live as today: `wait`
returns answers in batches. A questions round is live when the spec says
`live: true`; then `wait` also returns batches (when the user pauses or
after a few answers) and the agent may patch what is ahead. Without `live`,
only the rules react and the agent gets the answers at the end, which costs
no extra tokens. Patches work in every round regardless, so a reply to a
question the user asks can always change the current card and the ones
after it. The page lists under the reply what it changed.

## The question

- One line, **why I'm asking**, above the options: what depends on the
  answer. Field `why`.
- Under each option, **what happens next**: what the agent will do if this
  one is picked. Field `then` on the option.
- One "more" button with connected text. Field `more`.
- The five folded points go away. A 2.x spec maps onto this: `why` stays,
  and `what`, `how`, `goal` and the question-level `then` are joined into
  `more`.
- Lint warns when a choice question has no `why` or an option has no `then`.

**Evidence labels.** A pro, a con, a metric or the reason for a
recommendation can be a string or `{text, evidence, source}` with `evidence`
one of `measured`, `estimate`, `guess`. The page shows the label; lint warns
when `measured` has no `source` (a command, a file, a link). An unlabelled
item shows no label.

**Ready answers** on every choice question, next to "own option", "ask the
agent" and "you decide":

| Button | What the agent gets |
|---|---|
| Yes, but… | The picked option plus `condition`, a requirement in the user's words |
| None, suggest others | A request for new options, with an optional note. The user moves on; the agent replaces the options with a patch. With no agent listening it stays in the answers as a flag. |
| Later | `flag: "later"` with a revisit condition. The journal keeps it as a deferred decision; `history` and the result of `ask` list deferred decisions that touch the new round. Nothing reminds the agent in the background. |

## Knobs

A question of type `tune`: a live mockup, a panel of controls the agent
declared, and the values in the answer. The owner asked for this to be the
feature people come for, so it gets its own milestone.

```json
{ "id": "card", "type": "tune",
  "title": "How dense should the invitation card be?",
  "preview": "invite.assets/card.html",
  "knobs": [
    { "id": "density", "type": "range", "label": "Density", "min": 0, "max": 10, "value": 4 },
    { "id": "accent",  "type": "color", "label": "Accent", "value": "#3b6cff" },
    { "id": "names",   "type": "text",  "label": "Names", "value": "Аня и Миша" },
    { "id": "photo",   "type": "image", "label": "Photo" }
  ],
  "presets": [ { "id": "airy", "label": "Airy", "values": { "density": 2 } } ],
  "frames": ["mobile", "desktop"], "themes": ["light", "dark"] }
```

- **Controls:** range, toggle, select, color, text, image.
- **How values reach the mockup.** The server adds a small bridge script to
  the served mockup. It sets each value as a CSS custom property
  (`--knob-density`), fills elements marked `data-knob="names"` with text or
  an image, and fires a `decide:knobs` event for anything a mockup wants to
  do in script. A mockup with no script of its own works with knobs.
- **Presets** from the agent: two to four named sets; the user starts from
  any and keeps tuning.
- **Snapshots:** "remember this" stores the current values. Saved variants
  stand side by side as small live frames; the user picks one or sends two
  candidates.
- **In words:** a text field, "make it calmer". The agent answers with a
  `knobs` patch that moves the controls or replaces the mockup; the state
  before the change is kept as a snapshot so the user can go back. With no
  agent listening the text is saved as a note.
- **Own content:** text and image knobs let the user put his own headline,
  picture or logo into the mockup. Images are stored with the round.
- **Numbers:** knobs can drive a table and a chart instead of a mockup.
  The spec declares derived values with formulas over the knobs
  (`price * clients * (1 - churn)`); the page recomputes them as a knob
  moves, and the derived values come back in the answer. The formulas are a
  small arithmetic language with its own evaluator, shared by server and
  page; no `eval`.
- **Frames:** one set of knobs drives the mockup at phone and desktop width,
  light and dark, side by side. The bridge sets `data-theme` and
  `color-scheme` on the mockup's root.
- **Answer:** `{values, preset, snapshots: [{name, values}], picked,
  candidates, derived}`.

## New forms

| Type | The user does | Answer |
|---|---|---|
| `buckets` | Sorts items into named buckets ("now / later / no") by dragging or with number keys | `{buckets: {now: [...], later: [...]}}` |
| `tradeoff` | Sets a slider between two poles ("faster ↔ more careful"); the recommended position is marked | `{value: 0–100}` |
| `spot` | Marks a point or an area on a screenshot, with an optional note | `{points: [{x, y, w, h, text}]}` in percent |
| `versus` | Compares 4 to 8 variants in pairs with the arrow keys until one wins; no calls to the agent | `{winner, order, pairs}` |
| `tune` | See Knobs | |

`single`, `multi`, `confirm`, `rank`, `scale` and `text` stay.

## One page

- **Inbox.** A rail of open rounds from every project: high stakes first,
  then the longest waiting. Each row shows the project, the title, progress,
  the mode, and whether an agent is listening. After Done the page goes to
  the next round. The tab does not close itself.
- **Opening.** If a page is connected, a new round appears in the rail with
  a notification and no new tab. If the user is sitting on the inbox, the
  page opens the round. If no page is connected, the browser opens as today.
- **Installable.** A web manifest and a small service worker let the page be
  installed as an app; the icon shows the number of waiting rounds. With
  the server down the app shows how to start it.
- **Task panel** on a questions round, the same thing as the brief in swipe:
  what the task is, what is already decided, what the agent checked itself,
  what is open. Field `brief` in both modes; the agent rewrites it with a
  patch.
- **Done** shows the answers as a readable summary, not the raw digest.
- **Journal** across projects or for one, with dates. A **decision map**
  shows which decision depends on which and what replaced what. The journal
  records one entry per question with a stable id (`round/question`), its
  evidence labels and its links; edges come from rules, from `supersede`
  and from an explicit `dependsOn` in a spec. The map is drawn with the
  vendored Mermaid.
- **Buttons the user has now:** export this round to a file, save as ADR,
  "I have 5 minutes" (the page keeps the questions that matter most and
  lists the rest as left out). They run on the server without the agent.

This reverses one decision of 2026-10-22: round `1-983ce7`, card `[inbox]`,
"no, a tab per round". `supersede` works on whole rounds and that round
holds 40 decisions, so the reversal is recorded here. The same goes for
three items the 2.1 scope left out or undecided and 3.0 takes in: revisit
conditions, "don't ask about X" rules, and "measured" evidence.

## How much to ask

- A project setting with three levels: **everything** (the default, by the
  owner's note), **only the irreversible, money and data**, **only what I
  marked as mine**. Below "everything", `ask` rejects the questions under
  the bar and tells the agent to decide them itself and say so in its
  report.
- What puts a question over the bar at the middle level: `reversible:
  false`, `stakes: "high"`, `mine: true`, or a new field `touches` listing
  any of `money`, `data`, `security`, `public`. The agent fills these in, so
  the level is as good as the agent's labelling; at that level lint demands
  that `reversible` is stated on every question. At the lowest level only
  `mine` questions pass.
- **Rules from answers.** Under an answered question: "don't ask about this
  again, always do it this way", or the opposite, "always ask me about
  this". The rule's text is prefilled from the question and the answer and
  can be edited. A "always ask me" rule is how the user, not the agent,
  decides what is `mine`. Rules and the level are listed and edited on a
  settings page.
- The agent learns them where it would otherwise break them: `history`
  starts with the level and the rules, and `ask` rejects a round once when a
  question looks like one a rule covers, listing the rules; the agent drops
  the question or resends saying why it asks anyway. No digest at session
  start.

## Making the rest reachable

`export`, `import`, `adr`, `budget` and most media kinds went unused because
the agent did not reach for them (the owner's reading, and the numbers
agree). So:

- tool descriptions list every question type and media kind in a line each,
  generated from the registry;
- the result of `ask` carries up to three hints for the round just opened
  ("two screens compared in text: `compare` shows them with a slider");
- the skills are rewritten around the new anatomy and the reactive rules,
  with one worked example per type.

The overlap check that fired on 28% of rounds gets an index and compares
against live decisions only by question id and text, in under 100 ms for 90
questions and 500 entries (3.5 s today, `lib/journal.mjs:102-127`).

## The look

Round 3 showed four finished directions on the same two screens (quiet
tool, paper, console, tactile cards). The owner took none as the base: he
likes the current look best and wants it tightened and brought up to date,
"liquid glass or something else modern". So the 2.1 look stays (its
colours, type, logo and crimson primary button) and four details come over
from the mockups:

- key hints next to every option and action;
- progress in segments, one per question or card, coloured by state;
- the knobs panel as an instrument rack: ticks, large values, memory slots;
- the deck as a real stack, and thumb-sized buttons on a phone.

The default theme follows the system.

Round 4 showed that lifted look at two levels of glass. The owner picked
the stronger one, liquid glass on cards as well as on the floating chrome,
with a correction: "do it in Apple's style; I like this one more, but it is
too overloaded". For the builder that means:

- the material stays: translucent blurred surfaces, a thin highlight on the
  top edge, soft layered shadows, a quiet colour field behind the page;
- less on screen at once. One accent colour doing one job, the crimson of
  the primary action and the selection. State colours only where a state is
  shown. No legend under the progress bar, no uppercase micro-labels where
  plain text reads the same, fewer borders, one badge per option at rest;
- content first: glass belongs to what floats (header, footer bar, inbox,
  popovers) and to cards at rest; a card holding a mockup, a screenshot or
  code is solid inside so the backdrop does not tint the content;
- more air and larger type steps instead of more decoration;
- motion that is short and interruptible, off under
  `prefers-reduced-motion`; solid surfaces under
  `prefers-reduced-transparency` and where `backdrop-filter` is missing;
- body text holds 4.5:1 in both themes, measured, not judged by eye.

The mockup the owner reacted to is kept with the plan as
`docs/plans/2026-11-15-decide-3-look.html`; the page milestone opens with a
calmer pass of it that the owner sees before the rest of the page is built.

Whatever the direction, the page audit's defects are an acceptance list:

- 1, J, 2 answers question 2, not question 1;
- header, cards and footer agree on how many questions there are; rank and
  scale count as answered;
- long unbreakable text wraps; no horizontal scroll at 375, 768 and 1440;
- the review dialog's Send is on screen without scrolling;
- "ask the agent" has a Send button and one status;
- an own option shows as selected;
- the image viewer has previous, next and "pick this one";
- a list of 12 or more questions stays usable;
- a skip link, a sane tab order, arrow keys inside option groups;
- touch hints on touch screens, key hints with a keyboard;
- a swipe card fits the screen; its end screen has one set of controls;
- a stopped server is said in words, with what to do;
- the journal shows dates; a bad round id is an error, not another round;
- scroll position survives a reload.

## How we check

- `node --test` for the core, with new suites for: recovery after `kill -9`,
  parallel cold start, a client on an older and a newer protocol, a
  superseded waiter, a cancelled `wait`, a round whose agent never
  returns, a second `DECIDE_HOME`, migration of
  2.x fixtures, registry completeness, docs in step with the registry.
- Browser tests of the page for the first time: the keyboard path, rules,
  ghost and restore, the stale block, knobs reaching the mockup, reload
  restoring everything, the offline banner, the three widths with hostile
  content, tab order, an exported file answered offline. Playwright as a dev
  dependency only; users of the plugin never install it.
- After each milestone the owner opens a demo round on his own machine.
- After release, the journal answers the usage questions again: rounds
  answered and never collected (21 in seven weeks), "page is not running"
  (4), questions to the agent per round, own-text answers of the "yes, but"
  and "none" kind.

## Milestones

One branch, `v3`. Nothing merges to `master` and nothing is tagged without
the owner.

1. **Core.** One server, rounds on disk, delivery, project identity,
   registry, strict validation, migrations, security. The 2.1 page keeps
   working on the new core.
2. **Page.** The chosen look, inbox, new question anatomy, ready answers,
   the acceptance list, browser tests.
3. **Reactive rounds.** Rules, patches, ghost and stale in both modes,
   replies that patch, "none, suggest others".
4. **Knobs.**
5. **The rest.** `buckets`, `tradeoff`, `spot`, `versus`, evidence labels,
   task panel, decision map, ask level and rules, page buttons, hints,
   installable app.
6. **Release candidate.** Skills, README, demo and migration notes rewritten;
   one fresh review; the owner decides on the merge and the tag.

## My calls

The owner did not decide these; I did. Each can be overturned.

- Port 47474; the bound port as the election; the handover between
  versions; a separate server per `DECIDE_HOME`.
- A round never expires; the server stops when no agent waits and no page
  is open, even with rounds open.
- Precedence: user, agent override, rules, agent patches, spec.
- `touches` and the "always ask me" rule as what the ask level works from.
- Mockups keep network access; a mockup's own directory is published.
- The one-line "answers not collected" notice in tool results and in a
  Claude Code session-start hook that is silent when there is nothing to
  say.
- Rules reach the agent through `history` and a one-time rejection in
  `ask`.
- `showIf` questions become ghosts instead of being hidden.
- Knobs are a question type (`tune`) with a bridge script and CSS custom
  properties; formulas for numbers have their own small evaluator.
- `versus` is a question type; the task panel and the swipe brief are one
  field.
- Mermaid is vendored, which adds about 3 MB to the repository.
- Playwright as a dev dependency.
- All eleven tools stay; `patch`, `lint`, `rules` and `stop` are added.

## Left to the builder

File layout inside a round directory and event names; the snapshot format;
the exact rule and patch schema beyond the operations listed; the formula
grammar; batching thresholds for live rounds; CSS architecture; how the
decision map lays out more than a few dozen nodes; whether Codex has a
session-start hook.

## Risks

- **Size.** One release holds a new core, a new page and five milestones of
  features. The order above puts the part that stops answers being lost
  first, so stopping after any milestone still leaves something shippable.
- **Live rounds cost tokens.** Each batch wakes the agent. Rules are free,
  which is why `live` is off by default in questions rounds.
- **Mixed versions during the upgrade.** 3.0 reads what 2.1.x sessions
  write to the journal. It does not show their rounds: a 2.1.x round is not
  in the inbox, and a 2.1.x session in a worktree does not see decisions
  3.0 recorded for the repository.
- **The installed app depends on the fixed port.** If something else holds
  47474, the app cannot find the server until the port is freed or
  `DECIDE_PORT` is set.
