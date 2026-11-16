# decide 3.0, milestone 5: the rest

Six independent pieces: new forms, evidence and the task panel, the journal and its map, settings, buttons that need no agent, and the installable app. Use the setup line from the milestone 2 note, in `/tmp/demo3`. Run each `ask` in its own shell, or one at a time.

## 1. The four new forms

The forms example links a picture on the web. Point it at a local file first:

```bash
cp showcase.assets/current-list.svg spot.svg && sed 's#https://example.com/screen.png#spot.svg#' forms.questions.json > forms-local.questions.json
node $D ask forms-local.questions.json
```

- Buckets: click an item in the pool, then a bucket header (or press `1`, `2`, `3`), or drag it. When the pool is empty, "done" appears.
- Tradeoff: a slider between "ship fast" and "check everything" with the recommended position marked. Arrow keys move it, `End` goes to 100.
- Spot: click a point on the picture and type a note beside the mark. A mark can be removed from the list.
- Versus: four directions, compared in pairs ("Pair 1 of 3"). `←` and `→` pick a side. A winner and the order come out.

## 2. Evidence and the task panel

```bash
node $D ask evidence.questions.json
```

The panel "The task" at the top groups the brief into decisions, risks and open questions, and folds. Under the options, each pro, con and reason carries a label: "measured" (with its source), "estimate" or "guess". Answering the question takes it off the open list.

## 3. The journal, projects and the map

The journal needs many answered rounds. This script fills it: 45 rounds in one project, 3 in another, each resting on the one before (it starts the server if none runs; it works only with your scratch `DECIDE_HOME`).

```bash
node scripts/demo-journal.mjs
```

Open `http://127.0.0.1:<port>/#journal` (the script prints it). The list is grouped by day. Above it, "All projects", "wedding-site" and "task-app" switch between projects; a project shows only its own decisions. Press "Map". With 48 decisions it says "Too many to draw: the newest 40 of 48 decisions." Open "Show around this round", search for a title and pick a round: the map shows that round and its neighbours ("4 of 48 decisions around round ...") and a "Back" chip returns to the newest. With a project selected (3 rounds) the map draws everything.

## 4. Settings

Open `http://127.0.0.1:<port>/#settings`. Pick "Only the irreversible, money and data". Then:

```bash
node $D history | head -1
```

It prints `How much to ask (level "irreversible")...`. Lint now warns that every question needs `reversible`. To make a rule, finish a round and press "Don't ask about this again" under an answer on the Done screen, then "Save". `node $D rules` lists it, and so does the settings page, where you can remove it. Put the level back to "Everything" afterwards.

## 5. Buttons that need no agent

```bash
node $D ask long.questions.json
```

The round has 16 questions. On the page:

- "I have 5 minutes": the round shrinks to 8 questions and says "Left out to fit your 5 min · 8". The agent later sees the left-out ones listed in `history`.
- "Export this round": a toast says `Saved .../long.decide.html`. The file is one page that works offline. From the shell, `node $D export long.questions.json --out offline.decide.html` does the same from the spec.
- Press `1`, Done, then Send. On the Done screen "Save as ADR" writes `docs/decisions/0001-a-long-round.md`. `node $D adr <round>` does the same from the shell.

## 6. Install the page as an app

With a server running, open its page in Chrome or Edge and use "Install decide" in the address bar (or the browser menu). The manifest (`/manifest.webmanifest`, standalone, with an icon) and the service worker (`/sw.js`) are served and registered. The app badge shows how many rounds wait. With the server stopped, the installed app says how to start it. I did not click the install button itself in a headless run.

Stop everything with `Ctrl+C`, then `node $D stop`.
