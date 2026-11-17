# decide 3.0, milestone 4: knobs

A `tune` question has controls that drive a live mockup. The mockup (`tune.assets/card.html`) has no script of its own. Use the setup line from the milestone 2 note and two shells in `/tmp/demo3`.

## 1. Open the invitation card

```bash
node $D ask tune.questions.json
```

Question 1 shows an invitation card in four frames (phone and desktop, light and dark) and a rack of controls: Density, Accent, Names, Photo.

- Click a Density value and use the arrow keys, `Home` and `End`: all four frames move at once.
- Type other names into Names; the text changes in the card.
- Press a preset ("Airy", "Balanced", "Packed"). It sets the values it names and shows as pressed. A preset also resets the other knobs, names included.
- Press "Choose a picture" under Photo and pick any image from disk. It shows in the card and is stored with the round.
- Press "Remember this": the values become a small saved variant with its own live frame. Pick one variant, or press "Compare" on two to send both.

## 2. A formula

Scroll to question 2, "Where should the price sit?". Move Price, Clients and Churn: the table below computes "Clients kept" and "Monthly revenue" from the formulas in the spec (`clients * (1 - churn)`, `price * kept`). With the defaults you see 90 and 1800.

## 3. The agent moves the knobs

In shell 2, with the round id from shell 1:

```bash
node $D patch <round> --ops '[{"knobs":{"question":"card","values":{"density":2,"accent":"#7a8cff"}}}]' --reason "Calmer for print"
```

The sliders and the colour move to Density 2 and the new accent. The page says "The agent moved the knobs: Calmer for print", and a new saved variant "Before: Calmer for print" holds what you had a second ago. Load it to go back.

## 4. In words, with no agent listening

Type "Make it calmer and more formal" in the "In words" box and press "Ask the agent" next to it. No agent is waiting, so the text is saved as the question's note. The line under the box says so.

## 5. In words, with an agent listening

In shell 2:

```bash
node $D wait <round> --live
```

Send "Bigger names, less text" from the box again (same button). The page says "Sent. The agent moves the knobs; what you have now is kept as a variant." Shell 2 prints a `DECIDE words` line with the question, your text and the current knob values, then the sentence "The user asks in words to change the knobs...". Answer it with the patch from step 3.

Stop both shells with `Ctrl+C`, then `node $D stop`.
