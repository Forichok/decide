# decide launch film — plan (gate 1)

2026-10-20. Owner's request: a film as cool, dynamic and provocative as Agent Notch v7, on music we already have.

## Gate 0 answers (round 1-ef77ab)

- Keep from Agent Notch: the accusing hook in 3 s, silence before the drop with the product on the drop, real UI large with highlights, the end card. Not kept: 3D laptop, the 70–75 s length.
- Reference: Raycast Glaze (black liquid material, the app window comes out of it, prompt shown large, own sound).
- Music: `music-suno-v2-4.wav`, the Agent Notch track (owner chose it over the recommended heist-2). 123.05 BPM, drop at 3.968 s, sections measured in the Agent Notch timeline: groove 0–24, breakdown 24–32, groove 32–56, breakdown 56–64, groove 64–103, final hit 104.8. Played straight through from the drop: no loops, no joins after the cut-in.
- Provocation: the owner clicked the point labelled «дерзко». My spec passed labels as an array, so the label sat under 1, not 5. I read it as «дерзко»; the recap asks to confirm.
- English captions, no voice-over.

## Gate 1 answers (round 2-3f7262)

- Provocation: «дерзко», confirmed.
- Hook: "Your agent isn't dumb." → "Your answers are." (owner chose it over the "idk" hook). The terminal with `1b 2 yes 3 idk` sits under the first line; the second line holds the silence; the drop caption is "Answer like you mean it."
- Story and shot list: approved.
- Stage: liquid in decide's colours.

## What we get

`promo/out/decide-launch.mp4`: 1920×1080, 30 fps, 122 beats = 59.6 s, −14 LUFS / −1.5 dBTP. 2D in Remotion. Real decide pages from the real daemon with fixture rounds, captured at 3× in a muted headless Chrome.

## Story

One task, one person, one agent: "build the home screen of my task app". The agent has 31 questions. In chat the person answers "1b, 2 yes, 3 idk". On the page they answer all 31, the hard 8 by clicking with pictures, the small 23 by swiping, and the agent builds with zero guesses.

Through-line: the number 31. It grows in the hook (6 → 14 → 31 questions), it counts down in the swipe deck (23 left → 0), and it pays off as "31 answers. 0 guesses." The pink accent of decide is the second thread: the dot of "idk." becomes the decide mark on the drop.

Stage: black with a slow liquid material in decide's pink and violet (Glaze), UI panels rise out of it. Camera is 2D: push-ins to the detail that matters, pans that follow the cursor, scale changes between macro (a ★ and its reason) and wide (the whole page). Captions sit beside the UI, never on it.

## Shot list (beats; 1 beat = 0.488 s; beat 10 = 5.0 s)

| Beats | s | Shot | On screen | Caption | Sound |
|---|---|---|---|---|---|
| 0–8 | 0.1–4.0 | **wall** | A chat terminal. The agent's numbered questions pour in; the counter jumps 6 → 14 → 31 on beats 0/2/4 while the camera pulls back over the wall. Beat 5: the reply is typed: `1b 2 yes 3 idk` | `Your agent isn't dumb.` | intro, key ticks |
| 8–10 | 4.0–5.0 | **are** | Black. `Your answers are.` | — | dead silence |
| 10–14 | 5.0–6.9 | **drop** | The period of `are.` turns pink and blooms into the decide mark; the page rises out of the liquid | `Answer like you mean it.` | drop, sub, whoosh |
| 14–20 | 6.9–9.8 | **pick** | Macro on the first question: the agent's ★ pick and its reason, pros/cons. Key `2` lands on the beat, the card turns pink | `Every option comes with the agent's pick. And why.` | click |
| 20–27 | 9.8–13.3 | **see** | Three home-screen mockups side by side; the cursor clicks Today view; push into it | `See what you're choosing.` | click, whoosh |
| 27–34 | 13.3–16.7 | **live** | The task card mockup is live: the cursor ticks the box inside it | `The mockups are live.` | click |
| 34–42 | 16.7–20.6 | **ask** | Breakdown, dark. A question with "Behind a feature flag". The person types under it: `what's a feature flag?` | `Don't know? Ask.` | breakdown, typing |
| 42–50 | 20.6–24.5 | **reply** | On the downbeat the agent's reply lands under the question; the person is already answering the next one | `It answers right here.` | reply chime |
| 50–66 | 24.5–32.3 | **done** | Two more clicks, the diagram question, Done → review → Send → "The agent has your answers". The terminal behind gets the exact answers | `8 answered. 23 to go.` | click, send |
| 66–74 | 32.3–36.2 | **turn** | Breakdown 2. Terminal: `/decide:swipe` typed. The deck deals | `23 small ones? Swipe them.` | typing, deal |
| 74–100 | 36.2–48.9 | **swipe** | Set piece. Cards fly ← → on the beats, the counter 23 → 0, the brief grows line by line: Decisions, Risks, Open questions. One card fits neither side: the person types their own answer. "Dramatisation: sped up" in the corner | `← no. → yes.` `Neither? Type your own.` | arrow key per card, ticks rising |
| 100–113 | 48.9–55.2 | **build** | "Enough, build the brief" → the terminal gets the brief and builds: files tick off | `31 answers. 0 guesses.` | chime, ticks |
| 113–122 | 55.2–59.6 | **end** | The decide mark, the line, both install commands, the repo URL. The track's final hit lands 0.9 s in | `Your agent asks on a page. You answer in clicks.` | final hit |

Features shown: the agent's pick with reason, keys 1–9, pictures side by side, live mockups, ask under a question with a live reply, diagram, Done → review → exact answers, `/decide` and `/decide:swipe`, the swipe deck with arrow keys, own answer, the growing brief, install for Claude Code and Codex. Not shown: history/journal, screenshots of a running app, light theme, Russian.

## Production

- **Fixtures.** Two specs under `promo/fixtures/`: the 8-question page round (based on `examples/showcase.questions.json`) and a 23-card swipe deck, both about the task app. Served by the real daemon (`node decide.mjs --no-open`) with `DECIDE_HOME` in a scratch dir, so no real project data is touched.
- **Capture.** A Playwright script drives the real page in muted headless Chrome at deviceScaleFactor 3: each state (picked, asked, replied, swiped, own answer, done) is a PNG; the agent's replies go through the real `--reply` command. Remotion moves, crops and lights these stills; it doesn't redraw any UI.
- **Terminal.** The chat terminal and the build log are drawn in Remotion as text (a terminal is text; no app UI is faked).
- **Sound.** The track from beat −8, the 2-beat dead stop, then straight from the drop to its own end. SFX synthesized from the timeline (clicks, keys, arrow ticks, chime, sub, whoosh), Agent Notch's synth reused. Master −14 LUFS / −1.5 dBTP.
- **Pipeline.** Copied from Agent Notch `promo/` (Remotion 4.0.290, `timeline.ts` in beats, `audio/synth.mts`). Agent Notch's worktree is not touched.

## How we check it

Gate 2: three finished stills (the drop bloom, the swipe set piece with the brief, the reply landing). Gate 3: the full animatic with music and SFX, `qc.sh` exit 0, my look at the contact sheet and every transition, one fresh Opus review. Gate 4: final MP4 at full and phone size, muted and with sound.

## What we don't do

- No 3D, no voice-over, no vertical cut yet.
- No Claude or OpenAI logos as characters; the terminal says "agent".
- No capability decide lacks: the swipe speed is sped up and labelled.
- No README change, release, tag, merge to master or upload.
- Music, frames and renders are never committed.
