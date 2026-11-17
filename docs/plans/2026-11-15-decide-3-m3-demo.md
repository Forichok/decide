# decide 3.0, milestone 3: rounds that react

In milestone 3 a round changes while you answer: by its own rules, and by the agent's `patch`. Use the setup line from the milestone 2 note. You need two shells in `/tmp/demo3` (export `DECIDE_HOME` and `D` in both).

## 1. A rule

```bash
node $D ask reactive.questions.json
```

Shell 1 prints `DECIDE ready: ...#r=<round>`. Keep the round id. The spec has one rule: if you pick "Email link, no password" in question 1, question 2 (password recovery) is not needed.

Pick "Email link, no password". Question 2 greys out with the reason ("you chose sign-in by email link...") and a "Bring it back" button, and question 3 loses its "A guest account" option. Pick "Email and password" and both come back by themselves: the rule works from the current answers, so changing your answer undoes it.
## 2. The agent ghosts and restores a question

In shell 2:

```bash
node $D patch <round> --ops '[{"ghost":"name"}]' --reason "The title does not matter yet"
node $D patch <round> --ops '[{"restore":"name"}]'
```

Each prints `Round <round> changed.` The last question greys out with the reason, then comes back. Neither move scrolls the page or takes focus from where you are.

## 3. A stale answer

Answer question 1 with "Email and password", then:

```bash
node $D patch <round> --ops '[{"stale":"login"}]' --reason "Check again after the reword"
```

Question 1 gets a "Check" mark with the reason and two buttons, "Keep my answer" and "Answer again". The bar says "1 answer to check". Press Done: a list "Answers to check" opens and the round cannot be sent until you keep or change that answer.

## 4. Reword and add options

```bash
node $D patch <round> --ops '[{"set":{"id":"store","title":"Where do signed-in sessions live?"}},{"addOptions":{"question":"store","options":[{"id":"redis","label":"In Redis","then":"Fast, one more service to run."}]}}]' --reason "Sessions need a real home"
```

The question takes the new title and the "In Redis" option without a reload. It is marked "Changed" with the reason, and "What it was" shows the old title.

## 5. A swipe deck: removed and reworded cards

Stop shell 1 with `Ctrl+C`, then:

```bash
node $D swipe swipe.deck.json
```

Open the page. Press `→` on the first card (pricing) and `←` on the second (home). Then, in shell 2, with `push-change.json` saved from this note:

```json
{
  "replace": [{ "id": "home", "title": "Which home screen, now that the budget is one week?",
    "left": { "label": "List" }, "right": { "label": "Board" }, "recommended": "left" }],
  "remove": ["pricing"],
  "reason": "The budget dropped to one week; pricing moved to the next release"
}
```

```bash
node $D push <round> --file push-change.json
```

The command warns that `pricing` is already answered, so it stays as a ghost. The pricing card shows "Not relevant: The budget dropped..." with "Bring it back". The answered `home` card is changed, so your old answer is stale: skip the other cards with `↑` and it returns as the last card, "1 left", with the reason and "Keep my answer".

Stop shell 1 with `Ctrl+C`, then `node $D stop`.
