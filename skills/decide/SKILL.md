---
name: decide
description: Let the user make decisions on a local browser page instead of answering long questions in chat. Options come with a recommendation, screenshots of the running app, clickable HTML mockups, diagrams and diffs, and the user can ask you about any question right on the page. Use when the user types /decide, /decide:decide or $decide, hands you a *.questions.json, when a task has two or more open choices that change the result (behaviour, UX, money, data, rollout, naming, scope), or when a vague request needs a short interview first.
---

# decide — decision rounds in the browser

You write a round of questions. The user answers on a local page by clicking,
and you get back a one-line-per-question digest plus a JSON file. While the
round is open the user can ask you about any question; your answer (text, a
picture, a diagram) appears under that question and they keep going.

The person answering is usually not an engineer and has handed the work to
you. Every rule below follows from that: they decide only what they alone can
decide, they see what they are choosing between, and they can always say
"explain", "you decide" or "skip".

## When to use it

- Two or more open choices that change the result.
- One choice that is expensive to reverse (migration, public copy, pricing)
  and needs a picture or a side-by-side comparison.
- A vague request that needs a short interview before work can start.

Don't use it for a single yes/no that fits in one chat line, or for facts you
can check yourself in code, docs, git history or a running app. Asking the
user what the code already says wastes their time.

## The round conversation

“Write to the agent” in the top bar opens a conversation about the whole
round. `wait` returns a `message` with its id and the user's words. Reply
with `explain {project, round, askId: <message id>, text}` and **omit
question**. Text accepts markdown and every media kind a card accepts.
Omit `askId` too when you want to write first.

If the user asks you to redo something, do it at once with `patch` or
`push`, then say what changed in the dialog. For a complaint or doubt,
propose a solution and ask whether to settle it in the dialog or as a
card/question in the round. Then do what they pick. A reply can offer
`choice: {text: "Where?", options: ["Here in the dialog", "As a card"]}`;
the pick comes through `wait` as a new message.

Messages stay queued when no agent listens. The final answers JSON has
`thread`; the digest's “The conversation” section marks requests without
a reply as `NOT answered`. Item-level questions stay under their own item.
With CLI `--live`, a message prints `DECIDE message:` and exits with the
same code as a question. Without `--live`, it comes with the final result.
Exported offline pages have no conversation button.

In a review, the page keeps its commit snapshot. Make explicitly requested
changes in the working tree and say what you did and that it will be in
the next review round. Never say that the open review page changed.

## Arguments

| After `/decide` or `$decide` | Do                                             |
| ---------------------------- | ---------------------------------------------- |
| nothing                      | Collect the open choices from the current task |
| a path to `*.questions.json` | Run that spec                                  |
| `demo`                       | Show the feature tour (`decide.mjs --demo`)    |
| `history`                    | Show what was already decided in this project  |
| anything else                | Interview the user about that topic            |

## Running a round

### With the decide tools (preferred)

Rounds use the plugin's MCP server: `ask`, `wait`, `explain`, `screenshot`,
`history`, plus `patch`, `lint`, `stop`, `supersede`, `adr`, `export` and `import` (below). `swipe` and
`push` belong to the card interview, see the decide:swipe skill. **Always pass `project`**, the absolute path of the
project you work in. Codex starts the server outside your project, and without
it the tools can't tell where to keep the journal and screenshots.

1. `history {project, query}`: check what was already decided, so you don't
   ask the same thing twice. `history {project, topic: "<your question>"}`
   lists only the live decisions on that topic; `status: "live"` hides
   superseded ones.
2. Optional: `screenshot {project, url, viewport}` captures a running page
   (`desktop`, `mobile` or `both`) and returns PNG paths for the spec.
   `screenshot {project, simulator: "ios" | "android", device?}` captures the
   booted iOS simulator or the running Android emulator instead.
3. `ask {project, spec}` creates the round and returns its id and URL. Give the
   user a clickable link to the questions. The URL confirms that the round is ready. If the output
   says a question may contradict a decision that still holds, read that
   decision: reuse it instead of asking, or ask and supersede it afterwards
   (see [Decisions that change](#decisions-that-change)).
4. `wait {project, round}` blocks for up to 10 minutes and returns one of:
   - **"Still waiting"**: call `wait` again right away. Don't nudge the user
     in chat.
   - **A question from the user** about one of the questions: answer it with
     `explain {project, round, question, askId, text}`, optionally with
     any media kind from [Pictures](#pictures), then call `wait` again. The page shows
     that you are writing, so answer right away.
   - **The answers**: the digest and the path of the answers JSON.

   **Don't end your turn while a round is open.** Answers reach you only
   through `wait`, and the page shows the user whether you are still
   listening. If you stop, the answers sit on the page and you never see them.
   If you must stop anyway, tell the user in one line to message you once they have
   answered, and on that message call `wait {project, round, timeoutSec: 5}`
   before anything else: finished answers come back at once.
5. Act on the answers (see below). If anything is still open, run the next
   round. It appears in the same browser tab.

Inline specs are saved under `~/.decide/projects/<project>/rounds/`, and
relative image paths in them resolve against `project`. Pass `specPath`
instead of `spec` to run a file you wrote.

### With the CLI (when the tools are not available)

The engine is `decide.mjs` in the plugin root: `${CLAUDE_PLUGIN_ROOT}/decide.mjs`
in Claude Code, and `../../decide.mjs` from this file anywhere. Node 20+ is
enough; there are no dependencies.

1. Write the spec to `<slug>.questions.json` in a directory the project
   already ignores, or in the system temp dir. Put screenshots and mockups in
   `<slug>.assets/` next to it; paths in the spec are relative to the spec file.
2. Run it as a background or PTY process and wait for it to exit. Don't poll
   the answers file.

   ```bash
   node <plugin>/decide.mjs <slug>.questions.json --live --project <project>
   ```

3. Exit code 0: the digest is printed and the answers are in
   `<slug>.answers.json`. Exit code 3: the user asked something, and the output
   has a `DECIDE ask: {…}` line with the round, question and text. Reply, then
   wait again:

   ```bash
   node <plugin>/decide.mjs --reply <round> --question <id> --text "…" --project <project>
   node <plugin>/decide.mjs --wait <round> --live --project <project>
   ```

   For a reply with visuals, pass a JSON file instead of `--text`:
   `{"question", "askId", "text", "images", "mermaid", "code"}`.

Other commands: `--lint <file>` checks a spec alone; `--shot <url> --viewport
mobile` takes a screenshot; `--sim ios|android` captures a simulator;
`--journal --query <text>` prints past decisions (`--status live`, `--topic
<text>`); `--supersede <round> --by <round> --reason "…"`; `--adr [<round>]`;
`--export <round | spec> [--out file] [--outside]`; `--import <files…>`;
`--no-open` skips opening the browser (give the user the printed URL);
`--stop` stops the page server.

Without `--live` the page takes no live questions: the user's "explain"
becomes a flag in the answers and you explain in the next round.

### Someone else answers: export and import

When the answer belongs to a person who can't open this machine's page,
export the round: `export {project, round}` for an open round, or
`export {project, spec | specPath}` without opening a page. You get one
self-contained `.html` path; give it to the user to send. `out` must be inside
the project or the decide data dir. For any other place, pass `outside: true`
(`--outside` on the command line). The recipient
answers offline, and Done saves an answers JSON with their name. End your
turn; nothing comes back through `wait`.

When the user hands you the files, call `import {project, files: [...]}`.
One file settles the round: you get the digest and it goes into the journal,
like a round answered here. Several files settle nothing: you get each
person's answers and the questions where they disagree. Show the
disagreements to the user, ask how to resolve them, then import the file
that stands or run a new round. If decide no longer knows the round's spec,
pass `specPath`.

Exported files can't attach files and have no live questions. Swipe rounds
can't be exported.

### Decisions that change

When the user decides against an earlier decision, call
`supersede {project, round: <old id>, by: <new id>, reason}` after the new
round is answered. The journal keeps the old decision, marked superseded,
and later rounds stop treating it as settled.

`adr {project, round?, consequences?}` writes a round (default: the latest)
as `docs/decisions/NNNN-title.md`: context, options, decision, consequences.
Pass `consequences` as markdown on what the decision makes easier and harder;
pros and cons of the picked options are added on their own. Offer an ADR
for decisions the team will want to find in the repo: architecture, data,
public APIs. Writing the same round again updates its file, and `supersede`
updates its status.

## The interview loop

Run rounds until nothing important is open. Most tasks need one or two.

1. **Frame** (only if the goal or constraints are unclear): the outcome, who
   it is for, deadlines, hard limits. Use `text`, `scale` and `single`; 3–5
   questions.
2. **Decide**: the real forks, each with 2–4 honest options and one
   recommendation. Group into sections when there are more than six.
3. **Follow up**: build the next round from the previous answers.
   - `flag: "explain"` left in the answers: explain in `recap` or the
     question's `more`, add a picture if it helps, ask again.
   - A custom option (`other`) or a note that changes scope: confirm what you
     understood with a `confirm` question.
   - Answers that contradict each other: show the conflict, ask which wins.
   - A choice that opens new forks: ask those now, not after the work is done.
4. **Stop** when everything is decided, delegated or skipped. More than four
   rounds on one task usually means the questions are too vague.

Open every follow-up round with a short `recap` ("what I understood from your
answers") so the user can catch a misunderstanding early.

## Writing questions

| Rule                                                                                                                                  | Why                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| The title is a plain question a non-engineer understands. Jargon goes to `glossary`.                                                  | Glossary terms get a tooltip on first use.                        |
| `tldr`: one line on what depends on the answer. `why`: one line above the options on what depends on the answer. `then` on each option: what happens next if it is picked. Longer context goes to `more`, behind one button. | The user reads title, why and the options, and opens `more` only if needed. |
| `body`: markdown shown open under the tldr, for the facts the choice rests on: a short table, a quote, a list.                       | Numbers the user must see shouldn't hide behind a fold.           |
| 2–4 real options. No filler options that exist only to lose.                                                                          | A fake choice is worse than no question.                          |
| Exactly one option is `recommended`, and the value is the reason: `"recommended": "cheapest to undo"`.                                | Shown as ★ with the reason; can fill questions left unanswered.   |
| `pros` / `cons`: up to three each, concrete. `metrics` use the same labels on every option of a question; numbers 1–5 render as dots. | Side-by-side comparison only works when the axes match.           |
| `stakes: "high"` for money, personal data, auth, production data; `reversible: false` for anything that can't be undone.              | Both show as badges, so the user slows down where it matters.     |
| `danger: true` on an option that can break something live.                                                                            | Shown as a warning.                                               |
| `rules` (or `showIf`) for questions that only make sense after a certain answer.                                                       | Such questions become ghosts: grey, with a reason, one click to restore. They don't count. |
| At most ~10 questions per round; above six, use `sections`.                                                                           | Long rounds get skimmed.                                          |
| `budget` (minutes) when the user is short of time, with `priority` 1–3 on questions (1 asks first; high stakes default to 1).         | The page keeps what fits and lists the rest as left out. Decide those yourself and say so. |
| `mine: true` on a question only the user can answer: taste, their money, their name.                                                  | No recommendation fill and no "Agent decides"; Done waits for it. |
| Write questions in the user's language, politely and without blame. The page's own buttons follow the browser language (English or Russian). | The page talks to the user, not to you.                           |

Types: `single` (default), `multi` (`min`/`max`), `confirm` (yes / no /
change), `rank`, `scale`, `text`, plus `tune`, `buckets`, `tradeoff`, `spot`, `versus` (see above). The full schema and the answers format are
in [spec.md](spec.md); read it before your first round.

## Anatomy of a question

Each question answers three things without the user unfolding anything.

| Field | Where | What goes in it |
| --- | --- | --- |
| `why` | question | One line above the options: what depends on the answer. |
| `then` | option | What you will do if this one is picked. |
| `more` | question | Everything else, behind one button. Markdown. |

The old `what`, `how` and `goal` are gone: put them in `more`. Specs that still
carry them are read with those joined into `more`. Lint warns on a choice
question with no `why` and on an option with no `then`.

A pro, a con, a metric or a recommendation reason may carry an evidence label:
`{"text": "p95 is 40 ms", "evidence": "measured", "source": "bench/run.sh"}`.
`evidence` is `measured`, `estimate` or `guess`. Lint warns when `measured` has no `source`.

## Ready answers

Every choice question has three buttons next to "own option", "ask the agent"
and "you decide". Read them in the answers:

| Answer | What you get | What to do |
| --- | --- | --- |
| Yes, but... | `selected` plus `condition`, the user's requirement in their words | Do the picked option and meet the condition. |
| None, suggest others | `flag: "none"` and an optional `note` | With an agent listening, send new options with `patch` (`setOptions`). Otherwise it stays a flag: propose options in the next round. |
| Later | `flag: "later"` and `revisit`, when to come back | Don't decide it. `history` and the result of `ask` list deferred decisions. Nothing reminds you. |

## Rules: a round that reacts

Put `rules` in the spec when one answer makes later questions or options
pointless. The page applies them at once; no tokens are spent.

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

When question `confirm` is answered `link`, question `recover` becomes a ghost
(grey, with the reason, one click to restore) and the option `guest-account`
disappears from `store`. Change the answer back and both come back. Effects are
computed from the current answers, so you never undo them by hand.

- Operations: `ghost`, `restore`, `removeOptions`, `stale`.

- `showIf` still works. It is read as a rule that ghosts the question, which is
  a change from 2.x, where such a question was hidden.
- Rules that contradict or feed each other end, and lint names the loop.
- An answer whose option was removed or rewritten becomes stale: it stays with
  a "check" mark, and Done is refused until the user keeps it or answers again.

## Changing a round while it is open: `patch`

`patch {project, round, ops, reason}` changes an open round. A reply to a
user's question can carry the same `patch` field in `explain`. Use it when an
answer or a question from the user changes what is ahead.

```json
{ "round": "3-a1b2c3", "reason": "you picked the paid plan",
  "ops": [
    { "ghost": ["trial-length"] },
    { "addOptions": { "question": "billing", "options": [{ "id": "annual", "label": "Annual", "then": "one invoice a year" }] } },
    { "recommend": { "question": "billing", "option": "annual", "reason": "saves two months" } }
  ] }
```

| Operation | Effect |
| --- | --- |
| `ghost`, `restore` | Grey out an item with a reason, or bring it back. |
| `set` | Change fields of an item. It shows as changed, with "what it was". |
| `addOptions`, `removeOptions`, `setOptions` | Change options. Removing a selected one makes the answer stale. |
| `add`, `remove` | Add an item before or after another. `remove` of an item the user has seen becomes a ghost. |
| `recommend` | Move the recommendation, with a reason. |
| `stale` | Ask the user to check an answer. |
| `brief` | Rewrite the task panel. |
| `knobs` | Move a `tune` question's knobs or swap its mockup (see Knobs below). |

Pass `keepAnswers: true` for a cosmetic edit so no answer turns stale. Pass
`override: true` only when you really mean to undo a rule or a ghost the user
restored. Order of strength: the user, your `override`, rules, your patches, the
spec. The page never moves focus and never repaints what the user is typing in.

`live: true` on the round makes `wait` return answers in batches (after about
three answers or a pause of about twenty seconds) so you can patch what is ahead.
Each batch wakes you, so use it only when the next questions depend on the
answers. Without `live` you get the answers at the end. Patches work either way.

## Knobs: `tune`

Use `tune` when the user should adjust a thing, not pick from three pictures.

```json
{ "id": "card", "type": "tune",
  "title": "How dense should the invitation card be?",
  "why": "This sets the layout of every card we print.",
  "preview": "invite.assets/card.html",
  "knobs": [
    { "id": "density", "type": "range", "label": "Density", "min": 0, "max": 10, "value": 4 },
    { "id": "accent", "type": "color", "label": "Accent", "value": "#3b6cff" },
    { "id": "names", "type": "text", "label": "Names", "value": "Anna and Max" }
  ],
  "presets": [{ "id": "airy", "label": "Airy", "values": { "density": 2 } }],
  "frames": ["mobile", "desktop"], "themes": ["light", "dark"] }
```

The mockup needs no script: each value is set as `--knob-<id>` on its root, and
an element marked `data-knob="names"` gets the text or image. A mockup that wants
to react in script listens for the `decide:knobs` event. Controls: `range`,
`toggle`, `select`, `color`, `text`, `image`. Give two to four `presets`. The
answer is `{values, preset, snapshots, picked, candidates, derived}`: `snapshots`
are variants the user saved, `picked` the one chosen. `derived` holds values the
spec computes from knobs with a formula such as `price * clients * (1 - churn)`.
An image knob's file is stored with the round; the answer holds its path.

Under the panel the user can also write what they want in words ("make it
calmer"). When you are waiting with events (`wait --live` or the MCP tool),
`wait` returns it as a `words` item with the current values. Answer with a
`knobs` patch, through `patch` or the `patch` field of `explain`:
`{"knobs": {"question": "card", "values": {"density": 2}, "preview": "card.assets/calm.html"}}`.
The page moves the controls, swaps the mockup if you gave one, and keeps the
user's values before as a saved variant. With no agent listening the words are
kept as the question's note.

## Four more forms

| Type | The user | Answer | Example |
| --- | --- | --- | --- |
| `buckets` | Sorts items into named buckets | `{buckets: {now: [ids], later: [ids]}}` | `{"id":"scope","type":"buckets","title":"Sort these","buckets":["now","later","no"],"options":[{"id":"sso"},{"id":"export"}]}` |
| `tradeoff` | Sets a slider between two poles | `{value: 0-100}` | `{"id":"care","type":"tradeoff","title":"Speed or care?","poles":["faster","more careful"],"recommendedAt":70}` |
| `spot` | Marks points or areas on a screenshot | `{points: [{x, y, w, h, text}]}` in percent | `{"id":"bug","type":"spot","title":"Where does it feel off?","images":["shots/home.png"]}` |
| `versus` | Compares 4 to 8 variants in pairs until one wins | `{winner, order, pairs}` | `{"id":"logo","type":"versus","title":"Which logo?","options":[{"id":"a","image":"a.png"},{"id":"b","image":"b.png"},{"id":"c","image":"c.png"},{"id":"d","image":"d.png"}]}` |

The generated type table in [spec.md](spec.md#types) is the source for field names.

## How much to ask

`history` starts with the project's ask level and rules. Three levels:
everything (default), only the irreversible and money and data, only what the
user marked as theirs. Below "everything", `ask` rejects questions under the
bar: decide them yourself and say so in your report.

The gear beside the theme button opens settings. The ask level and reviewer
settings have a global choice with a project override; “Same as everywhere”
clears the override. Rules made from answers belong only to the project.
Global settings live in `<DECIDE_HOME>/settings.json`; the project’s
`<dataDir>/settings.json` holds only its overrides. An old project level stays
an override. No file is migrated on read.

Read `rules` before planning a review. It prints the effective level and
reviewers, where they came from, and the project’s rules. For structured JSON,
use `rules` with `json: true` (CLI: `decide rules --json --project /path`).
`settings.level` and `settings.reviewers` each contain `value`, `from`
(`project`, `global` or `default`), `global` and `globalFrom`. Reviewers is a
whole block: `mode` (`always`, `large`, `request`), `lines` (default 200), and
ordered `roles` (`id`, `title`, `brief`, `model`). A project replaces or inherits
the whole block. An empty model uses your default; if you cannot start a
role’s model, skip that role and say so in the review overview.

What puts a question over the bar: `reversible: false`, `stakes: "high"`,
`mine: true`, or `touches`, a list of `money`, `data`, `security`, `public`.
Fill these in honestly; at the middle level lint demands `reversible` on every
question. The user can also set rules from an answer ("don't ask again", "always
ask me"). `ask` rejects a round once when a question looks like one a rule
covers, and lists the rules. Drop the question, or resend and say why you ask.

## Other fields worth using

- `dependsOn`: the ids of earlier questions or rounds this one rests on. The
  journal map draws it as an edge.
- `brief`: the task panel, in both modes: what the task is, what is decided,
  what you checked yourself, what is open. Rewrite it with a `brief` patch.
- `touches`: see above.
- `budget` and `priority`: the page also has an "I have 5 minutes" button.

## Pictures

Show the thing when the choice is about how something looks or flows.

| Situation                       | Attach                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| The current screen or a bug     | `images` with a screenshot. `{"shot": "http://localhost:5173/page", "viewport": "mobile"}` in `images` captures it when the round opens. |
| UI variants side by side        | `layout: "compare"` and an `image` or `preview` on each option                                                                           |
| One new screen or component     | `preview`: a self-contained HTML mockup (inline CSS/JS, no network), clickable, in a sandboxed frame                                     |
| A flow, rollout or architecture | `mermaid`                                                                                                                                |
| Today's screen vs. the new one  | `compare: {before, after, labels?}`: one picture over the other with a divider to drag                                                   |
| Motion: an animation, a gesture | `video`: mp4, webm or gif, under 20 MB. Clips up to 20 s loop muted                                                                      |
| Two versions of code or text    | `diff: {before, after, lang?, labels?}`: side by side on wide screens, unified on phones. Up to 400 lines                                |
| A few facts in rows             | `table: {columns, rows, caption?}`: limits, prices, specs. Up to 8 columns and 50 rows                                                   |
| Numbers across time or groups   | `chart: {type: "bar" \| "line", labels, series: [{name, values}], unit?}`. Up to 12 bars, 4 series; option charts share one y scale |
| A snippet                       | `code: {text, lang}`                                                                                                                     |
| A small piece of real UI        | `html`: an HTML string (or `{source, maxHeight}`), up to 200 KB, rendered in a sandboxed frame that sizes to its content                 |
| A screen of the mobile app      | `{"sim": "ios"}` or `{"sim": "android"}` in `images` captures the simulator when the round opens                                         |
| Docs, tickets, a live stand     | `links: [{label, url}]`                                                                                                                  |

Pick the lightest kind that settles the question. Every kind works on a
question, on an option and in an `explain` reply. Lint warns past the limits
above; the full shapes are in [spec.md](spec.md#media).

The user can draw on any image (marker, frame, arrow) and attach the marked-up
copy to their answer. Open every file in `attachments`: that is where they
point at things.

A `preview` mockup has a width switch (375, 768, 1440 px) and pins: the user
clicks a point and writes a note. `compare` with two `.html` files is a live
before/after under one divider.

## Reading the answers

Start from the digest: one line per question with the choice, ★ when it
matches your recommendation, "against the recommendation" when it doesn't.
Then open the JSON for notes, attachments and the dialog.

| Field                                | What to do                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `selected`, `order`, `value`, `text` | The decision. Follow it.                                                                                              |
| `other`                              | The user's own option; it overrides `selected` for single choice. Restate it in the next `recap` if it changes scope. |
| `note`                               | Extra conditions for this question. Treat them as requirements.                                                       |
| `attachments`                        | Absolute paths to screenshots or marked-up images. Look at every one.                                                 |
| `condition`                          | "Yes, but...": a requirement on the picked option. Treat it like a note.                                              |
| `flag: "none"`                       | None of the options fit. Send new ones with `patch`, or propose them in the next round.                              |
| `flag: "later"` + `revisit`          | Deferred. Leave it open and don't decide it silently.                                                                 |
| `ghosts`                             | Questions that stopped being relevant, with reasons. Their earlier answers are left out of `answers`.                 |
| `values`, `snapshots`, `derived`     | From `tune`: the knob values, the variants the user saved, the computed numbers.                                      |
| `flag: "explain"`                    | The user still needs context. Explain in the next round; don't pick silently.                                         |
| `flag: "delegate"`                   | "You decide." Pick (usually your recommendation) and say what you picked in your summary.                             |
| `auto: true` + `flag: "delegate"`    | Left unanswered, and the user let your recommendation stand. List these in your summary.                              |
| `auto: true` + `flag: "skip"`        | Left unanswered, and the user chose not to take your recommendation. Don't pick silently; ask again if it blocks.     |
| `flag: "skip"`                       | Leave that part out or as it is. Don't bring it back unless it blocks the work.                                       |
| `dialog`                             | What the user asked you on the page and what you answered. Their final choice already accounts for it.                |
| `pins`                               | Notes on points of a mockup: file, x/y in % of the frame, the width it was laid out at, text. Treat them like notes.  |
| `comment`, top-level `attachments`   | Context for the whole round. Read them before acting.                                                                 |
| `leftOut`                            | Questions cut to fit the user's time budget. Decide them yourself and list what you picked.                           |
| `name`, `importedFrom`               | The answers came back in a file from an exported page; `name` is who answered.                                        |
| `cancelled: true`                    | The user closed the round. Ask in chat how to proceed.                                                                |

An answer against your recommendation isn't a mistake to correct. If it has a
consequence the user may not see (data loss, cost), say so once in the next
round, then follow their choice.
