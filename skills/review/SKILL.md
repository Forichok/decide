---
name: review
description: Show the user a code review of a branch on a local page: your overview of the change, then the diff cut into chapters by meaning, with line comments, questions to you and a verdict. Use when the user types /decide:review, asks to review a branch or a change before merging ("покажи ревью", "дай посмотреть дифф", "review this branch"), or when you finished a change and the user reviews before merge.
---

# decide:review — a code review by chapters

You open a page with the change you made (or any branch against its base).
The user reads your overview first: decisions for them, risks and what checks
cover them, how to check the change, what changed, and the checks you ran. Then they walk the diff, which you
have cut into chapters by meaning, not by file. On any line they can leave a
comment of two kinds (fix, nit) or ask you a question. At the end they give
one of three verdicts: approve, approve with nits, return.

The server reads the diff from git itself. You never paste a diff: you write
the words and say which hunks belong to which chapter. The snapshot is taken
once, when the review opens, and holds commits only. Uncommitted work is not
in it, so commit before you call `review`.

Use plain `/decide` to explore alternatives before implementation. In a review,
ask yes/no questions about behaviour already present in the change.

## Arguments

| After `/decide:review`   | Do                                                      |
| ------------------------ | ------------------------------------------------------- |
| nothing                  | Review the current branch against its base              |
| a branch or a commit     | Review that head against the default base (`head`)      |
| `<base>..<head>`         | Review that range: pass them as `base` and `head`       |
| a path to a review JSON  | Run that spec (`specPath`)                              |

The default base is the remote's default branch, else `main` or `master`.
The diff runs from the point where the branch left the base to the head, so
what landed on the base since is not in the review.

## The loop

Always pass `project`, the absolute path of the project you work in.

1. Commit the change. Run the checks and note for each the command, the exit
   code and the seconds. The page runs nothing, and the user approves on what
   you report.
2. Read the diff yourself (`git diff <base>...HEAD`) and cut it into chapters
   (below).
3. `lint {project, spec}` lays the spec on the diff without opening anything.
   Fix what it names: a reference that matches no hunk, hunks in no chapter.
4. `review {project, spec}` opens the page and returns the round id, the URL
   and the lint warnings. Tell the user in one line that the review is open,
   with the URL.
5. `wait {project, round}` returns one of:
   - **"Still waiting"**: call `wait` again at once.
   - **A question on a hunk**: the file, the line, the code on it and the
     user's words. Answer with
     `explain {project, round, question: <the id in brackets>, askId, text}`,
     then `wait`. The answer appears under that line. Answer the question
     asked; don't defend the code and don't change it yet.
   - **The verdict**, with every comment: what to fix, the nits, the
     questions and whether you answered them.
6. Act on the verdict (below).

**Don't end your turn while the review is open**, and don't change code
before the verdict: the user is reading a snapshot, and a commit under their
hands makes the comments point at lines that moved. If you must stop, tell
the user to message you when they are done, and on that message call
`wait {project, round, timeoutSec: 5}` first.

## The spec

```json
{
  "title": "Sign-in by magic link",
  "summary": "Guests can sign in from a link in the mail instead of a password. The link holds a one-time token that lives 15 minutes. Passwords still work.",
  "acceptance": {
    "changed": "Guests can sign in without a password.",
    "where": "The sign-in screen",
    "steps": ["Request a magic link", "Open it from the mail", "Open the same link again"],
    "expect": "The first visit signs you in. The second refuses the used link."
  },
  "risks": [
    { "level": "high", "what": "A leaked link signs anyone in", "why": "The token is single-use and expires, but it is the only factor.", "chapter": "token", "checkedBy": "Nothing checks whether a leaked link reaches the wrong person." }
  ],
  "checks": [
    { "command": "npm test", "exit": 0, "seconds": 41 },
    { "command": "npx playwright test e2e/signin.spec.mjs", "exit": 1, "seconds": 73, "note": "the resend case fails, see the chapter on mail" },
    { "command": "npm run lint", "note": "not run: no linter in this repo yet" }
  ],
  "chapters": [
    {
      "id": "token",
      "title": "A one-time token",
      "summary": "A token is 32 random bytes, stored hashed with its expiry. Using it deletes it.",
      "watch": "`consume()` reads and deletes in two statements. I think the unique index makes a double use fail, but look at it.",
      "risk": "high",
      "focus": [
        { "at": "lib/auth/token.mjs:41-58", "note": "`consume()`: the read and the delete are two statements.", "kind": "check" },
        { "at": "db/migrations/0042_tokens.sql:3-9", "note": "The unique index that makes a second use fail." },
        { "at": "lib/auth/token.mjs:12-20", "note": "The expiry is fixed at 15 minutes.", "kind": "decision", "question": "Is a 15-minute sign-in window acceptable?", "options": ["Keep 15 minutes", "Change the window"] }
      ],
      "hunks": ["lib/auth/token.mjs", "db/migrations/0042_tokens.sql", "test/token.test.mjs"]
    },
    {
      "id": "mail",
      "title": "The mail with the link",
      "summary": "A new template and a rate limit of three mails an hour per address.",
      "hunks": ["lib/mail/", "lib/server.mjs:210-260", "e2e/signin.spec.mjs"]
    }
  ],
  "mechanical": [
    { "title": "`session` renamed to `signin` in imports", "hunks": ["lib/routes/*.mjs", "lib/server.mjs"] },
    { "title": "Lock file", "hunks": ["package-lock.json"] }
  ]
}
```

| Field                  | Meaning                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `title`                | What the change is, as you would name the pull request.                                                    |
| `summary`              | What changed and why, under "What changed". Markdown.                                            |
| `risks[]`              | `{level, what, why, chapter, checkedBy}`. `checkedBy` names the check that covers the risk, or says nothing does. `level` is `high`, `medium` or `low`. `chapter` is a chapter id: the risk on the page jumps there. |
| `acceptance` | `{changed, where, steps, expect}`. All optional; `steps` is a list of strings. Say what changed for the user and how to check it. |
| `checks[]`             | `{command, exit, seconds, note}`. Leave `exit` out for a check you did not run; the page shows it as not run. |
| `chapters[].id`        | Short, unique, a word (`token`, not `h3`: those are the hunks' own ids).                                   |
| `chapters[].summary`   | What this part does and why. Two or three sentences.                                                       |
| `chapters[].watch`     | The line or the decision you are least sure of. The user reads it before the diff.                         |
| `chapters[].risk`      | `high`, `medium` or `low` (default). A high chapter wants a risk in the overview that points to it.        |
| `chapters[].hunks`     | References to the hunks of this chapter.                                                                   |
| `chapters[].focus`     | `[{at, note, kind, checkedBy, question, options}]`: the places to read, up to five. `at` is `"path:from-to"` in lines of the new file, inside this chapter's hunks. `kind` is optional: `risk`, `decision` or `check`. |
| `chapters[].focus[].checkedBy` | For `risk`: what check covers it, or say nothing does. |
| `chapters[].focus[].question` | For `decision`: one yes/no question about behaviour the owner can judge. Without it the place stays a blue mark. |
| `chapters[].focus[].options` | For `decision`: two short labels, yes then no. Leave out for localised Yes / No. |
| `chapters[].skim`      | One sentence on why the chapter needs no reading line by line. Not for a high-risk chapter.                |
| `mechanicalWhy`        | Why mechanical groups hold more than one third of all added and removed lines. One or two sentences; required above that share. |
| `mechanical[]`         | `{title, hunks}`: one folded line on the page with a count.                                                |

### Naming hunks

| Reference                 | Takes                                                                    |
| ------------------------- | ------------------------------------------------------------------------ |
| `"lib/x.mjs"`             | Every hunk of the file                                                   |
| `"lib/x.mjs:120-180"`     | The hunks that touch lines 120–180 of the new file; context lines count  |
| `"lib/x.mjs:120"`         | The hunk that holds line 120                                             |
| `"docs/shots/"`           | Every file under the directory                                           |
| `"ui/css/*.css"`, `"e2e/**"` | A glob: `*` within a name, `**` across directories                    |

A hunk goes to the first chapter that names it, then to the first mechanical
group. So a file split between two chapters is written
`"lib/x.mjs:1-90"` in the first and plain `"lib/x.mjs"` in the second, which
takes what is left. A renamed file answers to its old name too. A binary
file, a pure rename and a mode change count as one hunk each.

Hunks nobody names are not lost. The page shows them under "The rest" and
"sorted N of M" in the rail, and `review` and `lint` list them. Aim for
nothing in the rest: an unsorted hunk tells the user you did not look at it.

## Cutting chapters

A chapter is one idea of the change, and its hunks may sit in five files.
"The token", "the mail", "the rate limit" are chapters. "Changes in
lib/server.mjs" is not: that is how git sorts a diff.

- Order the chapters the way you would explain the change aloud: the data
  model before the code that reads it, the core before the callers, the
  risky part early while the user is fresh.
- Put a test in the chapter of the code it covers, after that code. The page
  marks it as a test. A chapter of code with no test is something the user
  should see, so don't hide the tests in a chapter of their own.
- Three to eight chapters is a change a person can review. Twelve chapters
  means the branch holds several changes: say so in the summary and offer to
  split the branch.
- One hunk that carries two ideas goes where the riskier idea lives; name the
  other in that chapter's summary.
- Write `watch` only when there is something to watch. "Looks fine" on every
  chapter teaches the user to skip the field.

## What the user reads

A review that opens on a new file of 200 lines gets closed. The user will not
read every line, and you know which twenty carry the decision. Name them.

- `focus` lists the key places of a chapter: where the decision is made,
  where input is checked, where data is written, the condition that changed.
  Up to five per chapter, 10–30 lines each. The `note` says what to check
  there: "the token is compared in constant time", not "important code".
- `kind` says what the place is, and the page colours it: `risk` (red) can
  break or leak; `decision` (blue) is a choice that could have gone another
  way, for the user to agree with; `check` (amber) is a spot you are not sure
  of. Leave it out for a place that is simply where the change happens. Most
  places have no kind: a page where everything is a risk says nothing.
- The row over a place has "Ask the agent" and "Comment"; both land on the
  place's first line.
- The page opens such a chapter on those places, with three lines around
  each. Hunks of the chapter with no key place go under one fold, "The rest
  of the chapter", and a test file longer than 30 lines shows as the list of
  its test names.
- `skim` marks a chapter that needs no reading by line: documentation,
  fixtures, wiring that repeats a pattern the repo already has. Say why in
  one sentence. A high-risk chapter is never skim.
- A chapter with neither opens in full; a hunk longer than 60 lines opens on
  its first 20. Lint warns when a spec of three or more chapters names no key
  place and no skim.

Nothing is hidden for good. A folded gap opens 20 lines at a time or whole,
a hunk has "Whole hunk", "Lines around" and "Whole file" on its bar, and
"Show the whole diff" in the rail unfolds every chapter. Every line of a
hunk takes a comment; the file's lines outside the change do not.

So don't choose places to make the change look smaller. If the risky line is
line 3 of a 200-line file, that line is the place. A place must lie inside
the chapter's own hunks: lint refuses a place that touches none of them. A place that extends beyond them stays, with a warning naming the lines shown.

## What counts as mechanical

Mechanical is an edit the user can check by its description, without reading
each line: a rename applied everywhere, moved files, formatting, a lock file,
generated code, regenerated screenshots and snapshots, a version bump.

Say in the title what was done, so that one look at a few hunks confirms it:
"`getUser` renamed to `loadUser` (14 call sites)". The user can unfold the
group and read all of it.

Not mechanical, however small: a changed default, a changed condition, a
dependency added or upgraded across a major version, a config value, a
migration, anything in auth or money, a deleted test. If a rename hunk also
changes behaviour, it belongs to a chapter.

If mechanical groups hold more than one third of the snapshot's added and
removed lines, give the reason in `mechanicalWhy`. Lint refuses the review
without it. With a reason, lint still warns about the share. The page labels
the share and reason as the agent's account. Move edits that change behaviour
into chapters rather than using this field to excuse them.

Chapter marks mean "Viewed". Piece coverage records which changes reached the
viewport with their changed lines unfolded. Neither mark claims the user read
or understood the code. Approvals warn about pieces opened only in part or
not opened, and the verdict includes those counts and files.

## Writing the overview

The owner wants to know whether a bad decision slipped in and whether the
change will break. Write for that reader, even when they are an engineer.
The page marks your claims as "in the agent’s words".

Start with decisions for the owner. Give each `decision` place one yes/no
`question` about behaviour they can judge: "Is a silent 50% cap on a discount
acceptable?" Ask about the effect on a person, not whether a function or an
index is correct. Keep its `note` as the explanation beside the code. Use
`options` for two short answer labels, yes first; leave them out for Yes / No.
The same answer appears in the overview and over the place. A second click
clears it. Without `question`, the place keeps its blue mark but no buttons.

List risks next, worst first, pointing to their chapters. Red key places also
appear here. Give every risk a `checkedBy`: name the check and the behaviour
it covers, such as "Three refusals are covered by test/git.test.mjs". Name
only coverage you checked. A green command alone does not prove the risk is
closed. Say when nothing covers it; do not imply a test ran when it did not.
Without this field the page says the risk was not checked, by your account.

Write `acceptance` so the owner can check the change without reading code.
`changed` says what changed for the user in one or two sentences; `where`
names a URL, screen or command; `steps` lists what to do; `expect` says what
should happen. Every part is optional, but write `changed`. For a refactoring,
write `{ "changed": "Nothing changes from outside." }`. The page displays
these instructions; it does not run or verify them.

Your `summary` appears under "What changed": say what the change does and
why it was needed. Leave the list of files to the chapters. In `checks`, keep
every command as you ran it, with its real exit code. A failed check stays
with a note. A skipped check stays without `exit`. Never report a check you
did not run or round a failure up.

A comment about the whole change belongs in the verdict's note. The overview
links to that dialog with the note focused.

## After the verdict

| Verdict             | Do                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| Returned            | Fix what is under "To fix". Decide on each nit. Answer the open questions in chat. Tell the user for every comment what you did: fixed, answered, or declined and why. Then commit and call `review` again on the new head. |
| Approved with nits  | Fix the nits or say why not. No new review is needed.                                                  |
| Approved            | Follow the decision answers below.                                                                                        |

Read the result's `decisions` before acting on any verdict. Each entry gives
`chapter`, `at` (file:lines), `question`, `answer` (`yes`, `no` or `null`), and
`label` (the chosen label, or `null`). The digest puts these before "To fix".
Treat every "no" as something to fix, even with an approval. A "no" does not
create a comment. Do not count an unanswered decision as consent: the digest
says "NOT answered". Both approvals warn about unanswered decisions but allow
them; Approve also warns about a "no" as it does an open Fix.

An approval is the user's opinion of the code. It merges nothing and pushes
nothing: that stays under the repository's own rules, and you ask as you
would have without the review.

The full result is in the JSON that `wait` names: the verdict, the note, the
snapshot head SHA and ref, the range of commits, and every comment with its file, line, side and the code on
that line. An approval covers only that snapshot commit. If the branch has
moved, the verdict names both commits.

`Full JSON:` points to the round's own `answers.json`, which later rounds do
not replace. The file next to the spec is a convenience copy; the next round
of that spec overwrites it. An explicit `--out` still selects that copy's path.

## With the CLI

When the tools are not available, the same runs through `decide.mjs` in the
plugin root:

```bash
node <plugin>/decide.mjs lint <spec.json> --project <project>
node <plugin>/decide.mjs review <spec.json> --project <project> [--base <ref>] [--head <ref>]
node <plugin>/decide.mjs wait <round> --live --project <project>
node <plugin>/decide.mjs explain <round> --question <id> --text "…" --project <project>
```

`wait` exits with code 3 when the user asked a question (the output has a
`DECIDE ask:` line) and with 0 on the verdict.

For a bounded CLI wait, pass `--timeout-sec n`. After n seconds without an
item, it prints how to wait again and exits 4. Without the flag it keeps
waiting. Exit codes are 0 for a result, 1 for lint errors or a refused stop,
2 for an error, 3 for a live item, and 4 for a wait timeout. MCP waits still
use a timeout between 5 and 840 seconds.
