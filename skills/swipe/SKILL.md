---
name: swipe
description: Run a thorough interview as a deck of two-sided cards the user answers with the arrow keys, while a brief of decisions, risks and open questions grows beside the deck. Use when the user types /decide:swipe, asks to be questioned in detail ("допроси меня", "ask me everything", "grill me") before work starts, or hands you a vague idea that needs many small decisions rather than a few big ones.
---

# decide:swipe — interview by cards

You open a deck of cards on a local page. Each card is a simple question
with exactly two answers. The user presses `←` or `→` to pick a side, `↑` to
skip, `↓` to ask you to explain, `Enter` to type their own answer when
neither side fits, `Backspace` to take the last answer back, and `Esc` or the
"Enough, build the brief" button to stop. To the left of the deck you keep a
brief: the goal, then short points grouped as decisions, risks, problems
and open questions.

You don't get every answer the moment it's given. They come in batches. After
each batch you rewrite the brief and adjust the deck while the user keeps
answering. The aim is to leave no detail of the task to guesswork: many
easy questions, each one about something that changes the result.

Use plain `/decide` instead when there are a few real forks with three or more
options, or when the user needs to compare mockups side by side.

## Arguments

| After `/decide:swipe` | Do                                                    |
| --------------------- | ----------------------------------------------------- |
| a task or idea        | Interview the user about it, then propose the work    |
| a path to a deck JSON | Run that deck (`specPath`)                            |
| nothing               | Interview about the current task in this conversation |

## The loop

Always pass `project`, the absolute path of the project you work in.

1. `history {project, query}`: skip what was already decided.
2. Check what you can find out on your own (code, docs, the running app). Never
   ask the user something the repository already answers.
3. `swipe {project, spec}` opens the deck and returns the round id and URL.
   Tell the user in one line that the interview is open, with the URL.
4. `wait {project, round}` returns one of:
   - **"Still waiting"**: call `wait` again at once.
   - **A question about a card** (the user pressed `↓`, or typed one):
     answer with `explain {project, round, question: <card id>, askId, text}`,
     add `images` or `mermaid` when a picture explains it faster, then `wait`.
   - **A batch**: the answers since the last batch, one line each, with ★ when
     the user agreed with your recommendation and "against the
     recommendation" when they didn't. "Their own answer, neither side:
     «…»" is text the user typed instead of picking a side. An answer the user took back shows
     as "taken back"; that card is open again.
   - **The end**: the user pressed "Enough" or finished after you said
     you were done. You get every answer, the brief file and the JSON.
5. After each batch, call `push` once with everything that changed, then
   `wait` again. The page shows that you are thinking until the push arrives,
   so push promptly.
6. At the end, show the user the brief (decisions, risks, open questions) and
   ask in chat whether to start the work. Don't start without that answer.

**Don't end your turn while the deck is open.** Answers reach you only
through `wait`. If you must stop, tell the user to message you once they're
done, and on that message call `wait {project, round, timeoutSec: 5}` first.

## The deck

```json
{
  "title": "Worms with sharks",
  "goal": "A turn-based artillery game like Worms, with the sharks from hexhaven",
  "batch": 5,
  "confidence": 10,
  "cards": [
    {
      "id": "turns",
      "section": "Mechanics",
      "title": "Do players take turns, like in Worms?",
      "tldr": "The whole combat engine depends on this.",
      "left": { "label": "Turn by turn", "detail": "One shark moves at a time" },
      "right": { "label": "Real time", "detail": "Everyone fires at once" },
      "recommended": "left",
      "reason": "it is how Worms works, and simpler to get right"
    }
  ]
}
```

| Field                         | Meaning                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `goal`                        | One line on what the interview is for. It heads the brief.                                                              |
| `batch`                       | Answers per batch. Pick it yourself: 3–4 early, while each answer can reshape the deck; 6–10 once the picture is stable. |
| `confidence`                  | 0–100: how well you understand what the user wants. Shown at the top instead of a progress bar.                         |
| `brief`                       | Optional starting points, same shape as in `push`.                                                                      |
| `cards[].id`                  | Short, stable, unique. Batches and the final answers use it.                                                            |
| `cards[].left`, `right`       | `{label, detail?, image?, images?}` or a bare string. Both are required; don't write a third side. The user can always type their own answer. |
| `recommended`, `reason`       | The side you would pick and why. Shown as ★ and a faint highlight. Leave it out when you truly have no view.            |
| `section`, `tldr`, `stakes`   | A small heading, one line on what depends on the answer, `"high"` for money, data and anything hard to undo.             |
| `from`                        | On a follow-up: the id of the card whose answer brought it up. The card shows "Because you answered: …".                |
| `images`, `mermaid`, `preview`, `code`, `links` | A picture, a diagram, a clickable HTML mockup, a snippet, links. Same formats as in `/decide`.          |

Relative image paths resolve against `project`, or against the deck file's
folder with `specPath`; the same goes for cards you `push` later.

Start with 10–20 cards: enough to keep the user moving while you read the
first batch.

## Writing cards

- **One thing per card.** "Turn by turn or real time?" is a card; "turns,
  timer and wind?" is three cards.
- **Both sides are real.** Each one is something a reasonable person might
  want. If one side exists only to lose, cut the card and write the point into
  the brief as a decision.
- **Plain words.** The user reads a card in two seconds. Put jargon in
  `tldr` or `detail`, or leave it out.
- **Yes/no is fine** when the question is really about a single thing: "Does
  the terrain break under explosions?" → "Yes, pixel by pixel" / "No, fixed
  map". Name the sides by what happens, not just "Yes" and "No".
- **Show, don't describe.** When the choice is about how something looks or
  flows, give each side its own `image`, or put a `mermaid` diagram on the
  card and ask "Keep this order?".
- **Order by dependency.** Big forks first (platform, audience, core
  mechanic), details later. A detail asked before its fork is often wasted.
- **Ask about the boring parts too**: limits, what happens on failure, who
  else uses it, what "done" looks like, what is out of scope.

## After each batch

Send one `push` with all of it:

| Field                | Use                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `brief`              | The whole brief, rewritten (it replaces the old one). Merge answers into short points; don't list every card.                       |
| `confidence`         | Raise it as the picture firms up; lower it when an answer surprises you.                                                            |
| `add` + `position`   | Follow-ups, with `from` set. `position: "next"` puts them right behind the card on the user's screen, for a fork that matters now.   |
| `replace`            | Rewrite an open card the answers made unclear or one-sided. Answered cards and the card on screen can't be changed.               |
| `remove`             | Drop open cards that became moot ("which online mode?" after "local only"). The card on screen stays.                              |
| `batch`              | Change the batch size.                                                                                                              |
| `done: true`         | No important question left. The page tells the user and offers to finish. Adding cards later reopens the deck.                      |

Brief points, by `kind`:

| kind       | Write                                                                    |
| ---------- | ------------------------------------------------------------------------ |
| `decision` | What was decided, in the user's terms: "Turn by turn, 3 sharks a team"   |
| `risk`     | What could go wrong given those decisions: "A shark on land needs its own walk animation" |
| `problem`  | A conflict between answers. Add a card that asks which one wins.        |
| `open`     | Something you still need to ask, or that the user skipped and it blocks the work |
| `note`     | Context that is neither, kept short                                      |

`cards` on a point lists the card ids it came from.

Until your push arrives, new answers show in the brief as raw lines. Keep
pushes quick; the user is still answering.

New cards slide into the deck behind the one the user is reading, so they
never lose their place. A batch also comes early when three cards or fewer
are left: that is your cue to add follow-ups before the deck runs dry, or to
push `done: true`. If it does run dry, the user sees you thinking until your
push arrives.

Reading answers:

- Against your recommendation: not a mistake. If it has a cost the user may
  not see, add a `risk` and, when it matters, one card that names the cost.
- Own answer: neither side fit, so the user wrote what they want. Take it
  at its word in the brief. If it is unclear or opens new forks, add a
  follow-up with `from` set to that card. A deck that draws many own answers
  has sides that miss what the user cares about: rethink the open cards.
- Skipped: leave it out. Ask again only if it blocks the work, and then put it
  differently.
- Taken back: the card is open again; don't count the old answer.

## When to stop

- Set `done: true` when every open question left would not change the work.
  The user may keep going or finish.
- The user can stop at any time with "Enough". The deck is closed then and
  `push` is refused, so name the cards that matter but weren't answered
  when you show the brief in chat.
- Soft cap around 100 cards. Past that, add one card: "Keep going, or is
  this enough to start?".

The end result has the answers, the brief, `briefFile` (markdown) and the full
JSON. The decisions also go into the project journal, so `history` finds them
later.

## After the interview

1. Show the user the brief: decisions, risks, open questions. Use your
   own words if you need to, but show all of it.
2. Ask: "Shall I start?" If `open` points block the work, ask about them in
   chat or run a short `/decide` round first.
3. Work from the brief. Your recommendations aren't decisions: what the user
   skipped stays undecided.
