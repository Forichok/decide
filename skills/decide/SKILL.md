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

The plugin ships an MCP server with five tools: `ask`, `wait`, `explain`,
`screenshot`, `history`. **Always pass `project`**, the absolute path of the
project you work in. Codex starts the server outside your project, and without
it the tools can't tell where to keep the journal and screenshots.

1. `history {project, query}`: check what was already decided, so you don't
   ask the same thing twice.
2. Optional: `screenshot {project, url, viewport}` captures a running page
   (`desktop`, `mobile` or `both`) and returns PNG paths for the spec.
3. `ask {project, spec}` opens the round and returns its id and URL. Tell the
   user in one line that the questions are open, with the URL.
4. `wait {project, round}` blocks for up to 10 minutes and returns one of:
   - **"Still waiting"**: call `wait` again right away. Don't nudge the user
     in chat.
   - **A question from the user** about one of the questions: answer it with
     `explain {project, round, question, askId, text}`, optionally with
     `images`, `mermaid` or `code`, then call `wait` again. The page shows
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
mobile` takes a screenshot; `--journal --query <text>` prints past decisions;
`--no-open` skips opening the browser (give the user the printed URL);
`--stop` stops the page server.

Without `--live` the page takes no live questions: the user's "explain"
becomes a flag in the answers and you explain in the next round.

## The interview loop

Run rounds until nothing important is open. Most tasks need one or two.

1. **Frame** (only if the goal or constraints are unclear): the outcome, who
   it is for, deadlines, hard limits. Use `text`, `scale` and `single`; 3–5
   questions.
2. **Decide**: the real forks, each with 2–4 honest options and one
   recommendation. Group into sections when there are more than six.
3. **Follow up**: build the next round from the previous answers.
   - `flag: "explain"` left in the answers: explain in `recap` or the
     question's `what`/`how`/`why`, add a picture if it helps, ask again.
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
| `tldr`: one line on what depends on the answer. Longer context goes to `what` / `how` / `why` / `goal`, which stay folded.            | The user reads title and tldr, and opens the rest only if needed. |
| 2–4 real options. No filler options that exist only to lose.                                                                          | A fake choice is worse than no question.                          |
| Exactly one option is `recommended`, and the value is the reason: `"recommended": "cheapest to undo"`.                                | Shown as ★ with the reason; unanswered questions fall back to it. |
| `pros` / `cons`: up to three each, concrete. `metrics` use the same labels on every option of a question; numbers 1–5 render as dots. | Side-by-side comparison only works when the axes match.           |
| `stakes: "high"` for money, personal data, auth, production data; `reversible: false` for anything that can't be undone.              | Both show as badges, so the user slows down where it matters.     |
| `danger: true` on an option that can break something live.                                                                            | Shown as a warning.                                               |
| `showIf` for questions that only make sense after a certain answer.                                                                   | Hidden questions don't count and aren't sent.                     |
| At most ~10 questions per round; above six, use `sections`.                                                                           | Long rounds get skimmed.                                          |
| Write questions in the user's language, politely and without blame. The page's own buttons follow the browser language (English or Russian). | The page talks to the user, not to you.                           |

Types: `single` (default), `multi` (`min`/`max`), `confirm` (yes / no /
change), `rank`, `scale`, `text`. The full schema and the answers format are
in [spec.md](spec.md); read it before your first round.

## Pictures

Show the thing when the choice is about how something looks or flows.

| Situation                       | Attach                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| The current screen or a bug     | `images` with a screenshot. `{"shot": "http://localhost:5173/page", "viewport": "mobile"}` in `images` captures it when the round opens. |
| UI variants side by side        | `layout: "compare"` and an `image` or `preview` on each option                                                                           |
| One new screen or component     | `preview`: a self-contained HTML mockup (inline CSS/JS, no network), clickable, in a sandboxed frame                                     |
| A flow, rollout or architecture | `mermaid`                                                                                                                                |
| A code, schema or config change | `code: {text, lang}` or `code: {text, diff: true}`                                                                                       |
| Docs, tickets, a live stand     | `links: [{label, url}]`                                                                                                                  |

The user can draw on any image (marker, frame, arrow) and attach the marked-up
copy to their answer. Open every file in `attachments`: that is where they
point at things.

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
| `flag: "explain"`                    | The user still needs context. Explain in the next round; don't pick silently.                                         |
| `flag: "delegate"`                   | "You decide." Pick (usually your recommendation) and say what you picked in your summary.                             |
| `auto: true`                         | Left unanswered, so the recommendation was applied. List these in your summary.                                       |
| `flag: "skip"`                       | Leave that part out or as it is. Don't bring it back unless it blocks the work.                                       |
| `dialog`                             | What the user asked you on the page and what you answered. Their final choice already accounts for it.                |
| `comment`, top-level `attachments`   | Context for the whole round. Read them before acting.                                                                 |
| `cancelled: true`                    | The user closed the round. Ask in chat how to proceed.                                                                |

An answer against your recommendation isn't a mistake to correct. If it has a
consequence the user may not see (data loss, cost), say so once in the next
round, then follow their choice.
