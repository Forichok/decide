# Migrating to decide 3.0

This is for people who used decide 2.x. Your old specs, answers files and
journals still open. Nothing is rewritten on disk. 3.0 reads the old shape and
converts it in memory.

## What stays the same

- The flow: `ask`, `wait`, `explain`. Answers come back as a digest and a JSON file.
- Spec files named `*.questions.json`, and answers files next to them.
- The journal at `~/.decide/projects/<project>/journal.jsonl`, with the same line shape.
- The six question types: `single`, `multi`, `confirm`, `rank`, `scale`, `text`.
- Node 20+, no dependencies, no build step.

## What changes

### One server per machine

All projects and sessions share one server on `127.0.0.1:47474`. Set
`DECIDE_PORT` to move it. A server for another `DECIDE_HOME` gets its own port.
If something else holds 47474, the server takes a free port and the installed
app and bookmarks will not find it. Free the port or set `DECIDE_PORT`.

The server starts on demand. It stops 30 minutes after the last waiting agent
or open page is gone. Open rounds do not keep it up, because they are on disk.

### 2.1 servers are left alone

A session that started on 2.1 keeps its own per-project server (ports 43100 to
43899) until it ends. 3.0 never talks to it and never stops it. Both can run
at once. A 2.1 round does not show in the 3.0 inbox, and a 2.1 session does
not see decisions that 3.0 recorded.

### Rounds are event logs on disk

Where: `~/.decide/projects/<project>/rounds/<id>/`. The directory holds the
spec as opened, an append-only event log, uploaded files and, once sent, the
answers. If the server is killed, the next command starts a new one and every
answer, note and question comes back.

A round no longer expires. In 2.1 a round was marked abandoned two hours after
the agent left. Now it stays until it is sent, cancelled, or dismissed from the
inbox. Answers nobody collected are announced at the top of the next decide
tool result in that project.

Worktrees of one repository now share one project, so they share rounds and
the journal. The old per-worktree folders are still read. 3.0 does not write to them.

### Strict fields

An unknown field in a spec the agent sends is now an error. The message names
the nearest known field. Old spellings that 2.1 accepted (`image` on an option,
`note: true`, `recommended: true`) stay valid. A string where an option object
is expected is read as its label.

A spec read back from an export, an ADR or an old round only gets warnings.
That way an old spec still opens.

Run `lint` (tool) or `node decide.mjs --lint <file>` to check a spec before you
open it.

### `showIf` questions become ghosts

In 2.x a question whose `showIf` did not hold was hidden. In 3.0 it is a ghost:
it stays where it was, grey, with the reason ("not relevant: you chose ...") and
one click to bring it back. Ghosts do not count as open, and their earlier
answers stay on disk but stay out of the answers the agent acts on. The answers
file lists them under `ghosts`.

Your `showIf` field keeps working. 3.0 turns it into a rule that ghosts the
question. New specs should use `rules` (see the spec reference).

### `what`, `how`, `goal` and `then` are joined into `more`

The five folded points under a question are gone. A question now has:

- `why`: one line above the options, what depends on the answer. It stays its own field.
- `then` on each option: what happens next if it is picked.
- `more`: one button with the rest of the context.

An old spec's `what`, `how`, `goal` and question-level `then` are joined into
`more` when it is read, as short labelled paragraphs. The same applies to swipe
cards. Lint warns when a choice question has no `why`, or an option has no `then`.

### New fields and answers

- **Ready answers.** Every choice question has "Yes, but...", "None, suggest
  others" and "Later" next to "own option", "ask the agent" and "you decide".
  In the answers they appear as `condition` (with the picked option), `flag:
  "none"` and `flag: "later"` with a `revisit` text. See the reading table in `skills/decide/SKILL.md`.
- **Evidence labels.** A pro, con, metric or recommendation reason can be a
  string or `{text, evidence, source}`.
- **`rules`, `live`, `brief`, `touches`, `dependsOn`** and the new types
  `tune`, `buckets`, `tradeoff`, `spot`, `versus`. All are optional. A 2.x spec
  uses none of them.

### Tools

New tools: `patch`, `lint`,
`stop`, and `rules`.

### One page, with an inbox

There is no tab per round. One page lists open rounds from every project: high
stakes first, then the longest waiting. A new round appears in the list. If no
page is open, the browser opens as before. The tab does not close itself after
Done; it goes to the next round. The page can be installed as an app.

### Safer by default

- State-changing requests need a same-origin `Origin` or the token from `daemon.json`.
- Mermaid ships with the plugin. Nothing loads from a CDN.
- An exported file inlines Mermaid when the round uses it, so it is about 3 MB larger.
- `export` writes only inside the project or the data dir. Anything else needs `--outside`.

## Checklist

1. Update the plugin. Start a new session. Old sessions keep their 2.1 server.
2. Run `node decide.mjs --lint` on specs you keep. Fix the errors it names.
3. Replace `showIf` with `rules` when you want a reason shown on the ghost.
4. Add `why` and `then` where lint asks for them.
5. If the page does not load on `localhost:47474`, check what holds the port.
