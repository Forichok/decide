# decide 3.0, milestone 2: the new page

Milestone 2 replaced the page: a new look, a new question card, a deck in the same look, and one shell with an inbox rail. Four commands show it on your machine. They use a scratch home, so your real `~/.decide` is not touched.

Run the setup line from a checkout of the `v3` branch. It makes a scratch home and a project folder, copies the demos there, and keeps the path to this checkout's `decide.mjs` in `$D`. The other three milestone notes use the same line.

```bash
export DECIDE_HOME=$(mktemp -d)/dh D=$PWD/decide.mjs; mkdir -p /tmp/demo3 && cp -R examples/showcase.questions.json examples/showcase.assets examples/swipe.deck.json examples/swipe.assets examples/v3/* /tmp/demo3/ && cd /tmp/demo3 && git init -q
```

## 1. Open a round

```bash
node $D ask showcase.questions.json --live
```

The page opens with ten questions. The command stays open and waits for you; leave it running and use a second shell for the later steps (run the setup line's `export` part there too, or `cd /tmp/demo3` and re-export `DECIDE_HOME` and `D`).

What to look at:

- The question card: a title, one `why` line under it, and under each option what happens next. The recommended option has one badge. Everything else (more text, pros and cons) sits behind "More".
- The bar at the bottom: segmented progress, `1`-`9` picks, `J` / `K` moves. Press `2` on question 2 and the answer is saved ("Saved" in the bar).
- Light and dark: the page follows your system. The moon button in the header switches it.
- Make the window narrow (375 px wide). The cards stack and nothing scrolls sideways.

## 2. A second round and the inbox rail

In the second shell:

```bash
node $D swipe swipe.deck.json
```

A deck of 14 cards opens. At 1440 px and wider, the rail "Waiting for you" appears at the left and lists both rounds: project, title, progress, mode, and a green dot while an agent is listening. High stakes come first. A new round shows up there without a new tab. On a narrow window the rail turns into a "Rounds" button in the header.

## 3. Answer the deck

Click the deck round in the rail, then use the keys: `→` and `←` answer, `↑` skips, `Backspace` takes the last answer back, `Enter` opens your own answer. The brief on the left grows. On a phone-sized window the arrow buttons sit under the card.

## 4. Done

Go back to the first round and press Done. The review dialog lists every answer and asks what to do with the questions you left open. Send it. The page shows "Handing your answers to the agent" and a summary of what you answered. The tab does not close itself.

Stop everything with `Ctrl+C` in both shells, then `node $D stop`.

## Screenshots

`node scripts/screens.mjs` redraws every file in `docs/screens` (the README's and the `<view>-<width>-<theme>.webp` set at 375, 768 and 1440).
