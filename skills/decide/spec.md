# decide — spec and answers reference

## The questions spec

```json
{
  "title": "Round title",
  "lang": "en",
  "intro": "One or two sentences: why these questions now.",
  "recap": "What I understood from earlier answers (follow-up rounds).",
  "context": "Longer background, folded by default. Markdown.",
  "glossary": { "MR": "a request to merge code into the main branch" },
  "budget": 5,
  "sections": [{ "id": "base", "title": "Basics", "intro": "…" }],
  "questions": [
    {
      "id": "rollout",
      "title": "How do we roll it out?",
      "options": [
        { "id": "gradual", "label": "Gradually" },
        { "id": "all", "label": "To everyone at once" }
      ]
    },
    {
      "id": "layout",
      "section": "base",
      "title": "Which home screen layout do we go with?",
      "tldr": "This decides what people see first.",
      "body": "| Screen | Visits a day |\n|---|--:|\n| Today | 4 100 |\n| Inbox | 900 |",
      "why": "What depends on the answer, one line.",
      "more": "Everything else, behind one button. Markdown.",
      "type": "single",
      "layout": "compare",
      "stakes": "high",
      "priority": 1,
      "mine": false,
      "reversible": true,
      "optional": false,
      "allowOther": true,
      "note": "Tell me what bothers you",
      "showIf": [{ "question": "rollout", "in": ["gradual"] }],
      "images": [
        { "src": "slug.assets/now.png", "caption": "Today" },
        { "shot": "http://localhost:5173/", "viewport": "mobile" }
      ],
      "preview": "slug.assets/card.html",
      "previewHeight": 400,
      "mermaid": "flowchart LR\n A --> B",
      "code": { "text": "- old\n+ new", "diff": true },
      "chart": { "type": "bar", "labels": ["Mon", "Tue"], "series": [{ "name": "Visits", "values": [4100, 3900] }] },
      "links": [{ "label": "Ticket", "url": "https://…" }],
      "options": [
        {
          "id": "today",
          "label": "Today view",
          "detail": "Markdown allowed.",
          "then": "…",
          "recommended": "puts what is due first",
          "pros": ["…"],
          "cons": ["…"],
          "metrics": { "Speed": 4, "Time": "5 days" },
          "tags": ["quick"],
          "danger": false,
          "image": "slug.assets/today.svg"
        }
      ]
    }
  ]
}
```

- Only `questions[].id`, `title` and, for choice types, `options` are
  required. Option ids default to `a`, `b`, `c`….
- `lang`: `en` or `ru`, the language of the labels the page fills in on its
  own (confirm buttons, missing titles, screenshot captions). Without it,
  questions with Cyrillic text get Russian and everything else English. The
  page's buttons follow the user's browser language.
- `type`: `single` (default), `multi`, `confirm`, `rank`, `scale`, `text`.
  `multi` takes `min` / `max`; `scale` takes `scale: {min, max, labels}`;
  `text` takes `placeholder`. `confirm` generates its own options: `yes`,
  `no` and `change` (which opens a note).
- `default`: preselected option ids, or the starting order for `rank`.
- `layout`: `list` (default), `grid` (short options, two columns) or
  `compare` (options side by side, media on top).
- `note`: `true` opens the note field from the start; a string does the same
  and becomes its placeholder. Without it the note stays behind a button.
- `allowOther: false` hides the "own option" field (single and multi only).
- `showIf` entries take `question` plus `in` and/or `notIn`. Point them at
  earlier questions; the linter warns otherwise. In 3.0 a question whose
  `showIf` fails is a ghost, not hidden. `showIf` is read as a rule; new specs
  should use `rules` (below).
- Markdown in text fields: `**bold**`, `_italic_`, `` `code` ``,
  `[link](https://…)`, lists, paragraphs. Terms from `glossary` get a tooltip.
- `body` takes more markdown, and stays open: tables (`| a | b |` with a
  `|---|--:|` separator row; `:` sets the alignment), `> quotes` and `###`
  headings. Raw HTML is shown as text.
- `budget`: the minutes the user has. The page keeps the questions that fit,
  by `priority` (1–3, 1 first; default 1 for `stakes: "high"`, else 2) and
  then by order. The first question always stays, and a question whose
  `showIf` points at a dropped one is dropped too. The rest is shown as
  "left out" and comes back in the answers as `leftOut: [{id, title}]`.
- `mine: true`: a question only the user may answer. It never gets the
  recommendation filled in, has no "Agent decides" action, and the review
  won't send until it is answered. Lint warns when it is also `optional`.
- Specs from older versions (`image` on options, `note: true`,
  `recommended: true`) still work.

### Types

<!-- registry:types -->
| Type | What it is | Fields of its own |
| --- | --- | --- |
| `single` | Pick exactly one option, or write an own one. The default type. | `layout`, `allowOther`, `default` |
| `multi` | Pick several options, between min (default 1) and max, or write own ones. | `layout`, `allowOther`, `default`, `min`, `max` |
| `rank` | Put all options in order, most wanted first; default is the starting order. | `default` |
| `scale` | A number from scale.min to scale.max (default 1 to 5, at most 11 steps), with labels for steps. | `scale` |
| `text` | A free-text answer; placeholder is the hint shown in the empty field. | `placeholder` |
| `confirm` | A yes / no / yes-with-changes question; the engine writes the three options, "changes" opens the note. | `default` |
| `buckets` | Sort every option into one of the named buckets (buckets: ["now", "later", "no"]) by dragging or with the number keys. | `buckets` |
| `tradeoff` | A slider from 0 to 100 between two poles (poles: ["faster", "more careful"]); recommendedAt marks the agent's pick. | `poles`, `recommendedAt` |
| `spot` | Mark points or areas on the question's first picture (images), each with an optional note; answers are in percent. | `maxSpots` |
| `versus` | Four to eight options compared in pairs (arrow keys) until one wins: a knockout, at most 7 pairs. Answer: winner, order, pairs. | none |
| `tune` | A panel of knobs (range, toggle, select, color, text, image) that drives a live mockup in `preview` or a table of derived numbers; the answer is the values. | `knobs`, `presets`, `frames`, `themes`, `derived` |
<!-- /registry:types -->

### New in 3.0

These fields are optional. A 2.x spec uses none of them. The generated tables
list every field of each type; this section says how the new ones behave.

**Anatomy.** `why` (question): one line on what depends on the answer. `then`
(option): what happens next if it is picked. `more` (question): the rest, behind
one button. `what`, `how`, `goal` and a question-level `then` are gone; a 2.x
spec's copies are joined into `more` on read. Lint warns on a choice question
without `why` and on an option without `then`.

**Evidence.** A pro, a con, a metric or a `recommended` reason is a string or
`{text, evidence, source}`. `evidence` is `measured`, `estimate` or `guess`.
Lint warns when `measured` has no `source` (a command, a file or a link).

**`rules`.** A list on the round:

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

`when` takes `question` plus `in` and/or `notIn`. `do` is a list of operations:
`ghost`, `restore`, `removeOptions`, `stale`. Effects are computed from the current answers, so
changing an answer back undoes them. Evaluation runs to a fixed point with a cap
of one pass more than there are questions. Rules that contradict or feed each
other end and give the same result on a second run; lint names the loop.

**`patch` operations** (tool `patch {round, ops, reason, keepAnswers?, override?}`, or the `patch` field of `explain`):

| Operation | Takes | Effect |
| --- | --- | --- |
| `ghost` / `restore` | item ids | Grey an item with the reason, or bring it back |
| `set` | `{question, fields}` | Change fields; marks the item changed |
| `addOptions` / `removeOptions` / `setOptions` | `{question, options}` | Change options; a removed selected option makes the answer stale |
| `add` | item, `before` or `after` | A new item |
| `remove` | item id | Only for an item the user has not seen; otherwise it becomes a ghost |
| `recommend` | `{question, option, reason}` | Move the recommendation |
| `stale` | question ids | Mark an answer for checking |
| `brief` | the new brief | Rewrite the task panel |
| `knobs` | `{question, values?, preview?}` | Move the knobs of a `tune` question and/or swap its mockup for another `.html` file; the page keeps the user's values before as a snapshot |

Order of strength, strongest first: the user (a ghost they restored stays
restored), a patch with `override: true`, the rules, ordinary patches, the spec
as opened. `keepAnswers: true` keeps a cosmetic edit from marking answers stale.
In swipe, `push` is the swipe-shaped form of `patch`, and `patch` works on a
deck directly. The page reports what the user has seen; `remove` of a seen item
makes it a ghost.

**`live: true`** (round). `wait` returns batches: after 3 answers or about 20 s
of pause. Without it the agent hears the answers at the end; rules still react.

**`brief`** (round, both modes). The task panel: what the task is, what is
decided, what the agent checked itself, what is open. A string or the same
points as in swipe. Rewrite it with the `brief` operation.

**`touches`** (question). A list of `money`, `data`, `security`, `public`. With
`reversible: false`, `stakes: "high"` and `mine: true` it decides whether a
question passes the project's ask level. At the middle level lint demands
`reversible` on every question.

**`dependsOn`** (question). Ids of earlier questions or rounds this one rests
on. The journal map draws them as edges, with the edges from rules and `supersede`.

**`tune`** (type). Fields: `preview` (the mockup), `knobs`, `presets`, `frames`
(`mobile`, `desktop`), `themes` (`light`, `dark`), `derived`. A knob is
`{id, type, label, value, ...}` with `type` one of `range` (`min`, `max`, `step`),
`toggle`, `select` (`options`), `color`, `text`, `image`. The server adds a
bridge to the served mockup: `--knob-<id>` on the root, text or an image into
`[data-knob="<id>"]`, a `decide:knobs` event with `{values}`, and `data-theme`
plus `color-scheme` on the root. A mockup needs no script of its own. `derived`
is a list of `{id, label, formula}` over knob ids and earlier derived ids: numbers, `+ - * / %`, parentheses, unary
minus, `min`, `max`, `round`, `abs`. A bad formula is a lint error and shows no
value.

```json
{ "id": "price", "type": "tune", "title": "What does the plan cost?",
  "why": "This sets the revenue forecast.",
  "knobs": [
    { "id": "price", "type": "range", "label": "Price", "min": 5, "max": 30, "value": 12 },
    { "id": "clients", "type": "range", "label": "Clients", "min": 10, "max": 500, "value": 120 },
    { "id": "churn", "type": "range", "label": "Churn", "min": 0, "max": 1, "step": 0.05, "value": 0.1 }
  ],
  "derived": [{ "id": "revenue", "label": "Revenue", "formula": "price * clients * (1 - churn)" }] }
```

**Other new types.**

| Type | Fields | Answer |
| --- | --- | --- |
| `buckets` | `buckets` (names), `options` (the items) | `{buckets: {now: [ids], later: [ids]}}` |
| `tradeoff` | `poles` (two labels), `recommendedAt` (0 to 100) | `{value: 0-100}` |
| `spot` | `images` (the screenshot) | `{points: [{x, y, w, h, text}]}` in percent |
| `versus` | `options` (4 to 8 variants) | `{winner, order, pairs}` |

```json
{ "id": "scope", "type": "buckets", "title": "Sort these by when we need them",
  "why": "This decides what the first release holds.",
  "buckets": ["now", "later", "no"],
  "options": [{ "id": "sso", "label": "Single sign-on" }, { "id": "export", "label": "CSV export" }] }
```

**Answers of the ready buttons.** "Yes, but..." gives `selected` plus
`condition`. "None, suggest others" gives `flag: "none"` and an optional `note`.
"Later" gives `flag: "later"` and `revisit`, the condition to come back on.
`history` and the result of `ask` list deferred decisions.

### Media

Any question or option can carry media; images open in a lightbox and can be
marked up by the user.

<!-- registry:media -->
| Field | What it shows | What it takes |
| --- | --- | --- |
| `images` (also `image`) | Pictures that open large and can be marked up; or a capture of a running page or a simulator. | Paths (relative to the spec file; to project for an inline spec), URLs, {src, caption}, {shot: url, viewport?, …} to capture a page, or {sim: ios\|android, …} to capture a simulator. `src`: A path or a URL. `caption`: Shown under the picture. `shot`: An http(s) page to capture with the local Chrome when the round opens. `sim` (ios, android): Capture the booted iOS simulator (xcrun simctl io booted screenshot) or the Android emulator (adb exec-out screencap -p) when the round opens. DECIDE_SIMCTL and DECIDE_ADB point at other binaries. `viewport` (desktop, mobile, both): With shot: the screen size. Default desktop. `waitMs`: With shot: how long to let the page settle. Default 1500. `name`: With shot or sim: a name for the file. `device`: With sim: the device id. |
| `preview` (also `previewHeight`) | A live mockup: an HTML file the user can click around in, at phone, tablet or laptop width, with notes pinned on it. | Path to a self-contained HTML file, shown in a sandboxed frame with no access to the page. The mockup itself has network access. The page frames only files it serves, so an http(s) URL is shown as a link, not framed. `previewHeight`: Height of the frame in px, default 360. The page offers 375, 768 and 1440 px widths and pins notes on the mockup. |
| `html` | An HTML snippet drawn in a sandboxed frame that grows to its content. | An HTML string, or {source, maxHeight?}: up to 200 KB; maxHeight 80 to 1200 px, default 640. `source`: The HTML. `maxHeight`: Tallest the frame grows, 80 to 1200 px. Default 640. |
| `mermaid` | A diagram from Mermaid source, which the user can enlarge. Drawn in a sandboxed frame; an exported file draws it too. A failed drawing shows the source text. | Mermaid source. |
| `code` | A code block with a copy button; a unified diff is coloured. | A string, or {text, lang?, diff?}. `text`: The code. `lang`: The language; shown in the bar. `diff`: Colour added and removed lines. Found by itself when lang is diff or the lines look like one. |
| `compare` | A before/after slider over two pictures, or over two live mockups. | {before, after, labels?}: two pictures of the same size, or two .html mockups. Two .html files make a live compare: both run, one divider. Mixing a picture and an .html is skipped with a warning. A remote .html is shown as a link, not framed. `before`: A path or URL, or {src, label}. `after`: A path or URL, or {src, label}. `labels`: Tags for before and after. |
| `video` (also `videos`) | A short clip: mp4, webm or gif. Up to 20 s it loops muted. | A path or URL, {src, caption?, loop?}, or a list of them. mp4, webm or gif. Clips up to 20 s loop muted unless loop is false. `src`: A path or a URL: mp4, webm or gif. `caption`: Shown under the clip. `loop`: Loop it muted (default for clips up to 20 s) or give it controls. |
| `diff` | Two texts side by side, changed lines paired by likeness with the changed part marked. | {before, after, lang?, labels?}: two texts. Changed lines are paired by likeness; the changed part of each is marked. `before`: The old text. `after`: The new text. `lang`: The language; shown in the bar. `labels`: Headings for before and after. |
| `table` | A data table; numeric cells align right. | {columns, rows, caption?}: columns are strings or {id, label}; rows are arrays or objects keyed by column. Up to 50 rows and 8 columns. `columns`: The columns. Taken from the first row when it is an object. `rows`: The rows. `caption`: Shown above the table. |
| `chart` | A bar or line chart; charts on the options of one question share a scale. | {type, labels, series: [{name, values}], unit?, title?}, or {series: [1, 2, 3]} for one unnamed series. null is a gap. Up to 12 bars, 60 points, 4 series. `type`: bar or line. Default bar. `labels`: The x labels. Default 1, 2, 3… `series`: The series, or the numbers of one. `unit`: Shown after the values. `title`: Shown above the chart. |
| `links` (also `link`) | Links to a ticket, a page or a doc, shown as chips. | Links shown with the question: URLs or {label, url}. http(s) only. `url`: An http(s) URL. `label`: The words on the chip. Default the URL. |
<!-- /registry:media -->

Limits; lint warns past them: 12 bars, 60 line points, 4 series, unnamed
series when there are two or more, a 400-line diff, a 20 MB video, 50 table
rows, 8 table columns. Charts on the options of one question share one y
scale, so equal bars mean equal values.

Missing local files and failed shots are reported as lint warnings and
skipped. Viewports: desktop 1440×900, mobile 390×844 at 2×. Set
`DECIDE_CHROME` if Chrome isn't found. `DECIDE_SIMCTL` and `DECIDE_ADB` point at other simulator binaries.

## The answers file

```json
{
  "version": 2,
  "round": "3-a1b2c3",
  "title": "…",
  "submittedAt": "2026-09-28T11:08:27.862Z",
  "answers": {
    "layout": { "selected": ["today"] },
    "features": {
      "selected": ["me"],
      "other": "download as one archive",
      "note": "…",
      "attachments": ["/abs/path/Diagram marked up.png"]
    },
    "migration": { "selected": [], "flag": "explain", "note": "what does \"can't be undone\" mean?" },
    "share": { "selected": ["p10"], "flag": "delegate", "auto": true },
    "card": {
      "selected": ["yes"],
      "pins": [{ "file": "card.html", "x": 42.5, "y": 18, "width": 375, "text": "Too tight here" }]
    }
  },
  "leftOut": [{ "id": "naming", "title": "What do we call it?" }],
  "dialog": [{ "question": "layout", "ask": "Why a today view and not a board?", "answer": "…" }],
  "comment": "a comment on the whole round",
  "attachments": ["/abs/path.png"],
  "digest": "1. [layout] …"
}
```

3.0 adds to an answer: `condition`, `flag: "none"`, `flag: "later"` with
`revisit`, and for `tune` `values`, `preset`, `snapshots`, `picked`,
`candidates` and `derived`. The file lists `ghosts: [{id, reason}]`: questions
that stopped being relevant. Their earlier answers stay on disk and are left
out of `answers`. A round with an unconfirmed stale answer cannot be sent.

`auto: true` marks a question the user left unanswered. Before sending they
choose what happens to those: `flag: "delegate"` means the recommendation stands
(as in `share` above), `flag: "skip"` means it stays open.

`pins` are notes on points of a `preview` mockup: `x` and `y` in percent of
the frame, `width` the layout width the user had picked. A round answered in
an exported file also carries `name` (who answered) and `importedFrom` (the
file it came from).

`digest` is always in English, whatever the language of the page and the
questions. A cancelled round has `cancelled: true` and no answers. Answers go to
`<slug>.answers.json` next to the spec; unfinished answers are kept in
`<slug>.answers.draft.json` while the user works, so a page reload loses
nothing. Uploaded files go to `<slug>.answers.files/`.

## Replying to a live question

`explain` (tool) or `--reply <round> <reply.json>` (CLI) takes:

```json
{
  "question": "layout",
  "askId": "6cc223",
  "text": "Markdown, short and plain.",
  "images": ["shots/home-mobile.png"],
  "mermaid": "flowchart LR\n A --> B",
  "code": { "text": "…", "lang": "ts" },
  "links": [{ "label": "…", "url": "https://…" }]
}
```

Only `question` and `text` are required. Without `askId` the reply answers
the oldest unanswered ask on that question. If the user asked nothing there,
it appears as a note from you, so you can also add an explanation unasked.

## Live rounds and "None, suggest others"

Put `live: true` in a questions spec and `wait` hands you a batch of answers
while the round is still open: after 3 new answers, or after 20 seconds
without a change when something new is waiting. The batch lists only what is
new since the last one. Use it to patch the questions ahead with `explain`,
then call `wait` again. Without `live` you hear only the final answers.
(For tests: `DECIDE_LIVE_COUNT` and `DECIDE_LIVE_PAUSE_MS` shorten both.)

When the user presses "None, suggest others" on a question and you are
waiting, `wait` returns a request with the question and the user's note.
Answer with `explain`; if you pass a `patch` ({add, replace, remove}) or a
list `changes` ([{op, title}]), the page lists under the reply what it
changed. With no agent waiting, the press stays a flag in the answers.

## Export and import

`export` writes one `.html` file: the page, its CSS, its scripts (as an
import map of `data:` modules), the round, and every local picture, video
and mockup as `data:` URIs. Relative CSS, scripts, images and fonts inside a
mockup are inlined too; absolute URLs are not. Mermaid loads from jsDelivr
when online and otherwise shows its source. An export holds up to 60 MB.

The file answers offline. The draft stays in the recipient's browser
(`localStorage`). Done asks for a name and downloads
`<title>.<name>.answers.json`:

```json
{
  "version": 2,
  "exported": true,
  "round": "xmvislb4z-09a138",
  "title": "…",
  "name": "Anna",
  "submittedAt": "…",
  "answers": { "layout": { "selected": ["today"] } },
  "digest": "1. [layout] …"
}
```

`import` checks each file against the round's spec. It drops unknown
questions and options with a warning, and turns a `delegate` on a `mine`
question into `skip`. If the round is still open on the page, the page
server settles it. Otherwise the spec comes from the export record in
`exports/` in the data dir, or from `specPath`. A round already in the
journal is not imported twice.

## Superseded decisions and ADRs

`supersede {round, by?, reason?}` appends `{"type": "supersede", …}` to
`journal.jsonl`; reading the journal folds it into the old entry as
`superseded: {by, reason, at}`. `history` then marks it, `status: "live"`
hides it, and overlap warnings skip it. An overlap is a new question that
shares at least two words, and at least half of its words, with a question
of a live decision. Words are 4+ letters, stopwords dropped, cut to six
letters.

`adr {round?, consequences?, dir?}` writes `docs/decisions/NNNN-slug.md`
(next free number) with Status, Date, Round, Context (intro, recap,
context), Options (with pros and cons), Decision (the answers and notes) and
Consequences (your text plus the picked options' pros and cons). The round
id in the file lets a second call, and `supersede`, find and update it.

## Where things live

One server per machine serves every project, at `127.0.0.1:47474`
(`DECIDE_PORT` moves it; another `DECIDE_HOME` gets a port of its own). Data
lives under `~/.decide` (`DECIDE_HOME` moves it). Each project has
`~/.decide/projects/<name>-<hash>/`. The project is the git common directory,
so worktrees of one repository share it. It holds the decision journal
(`journal.jsonl`), screenshots (`shots/`), export records (`exports/`) and
`rounds/<id>/`: the spec as opened, an append-only event log, uploaded files and
the answers. The log is the truth; the server is a replay of it and can be
killed at any time. A round never expires. The server stops 30 minutes after the
last waiting agent or open page. 2.1 servers on ports 43100 to 43899 are left
alone.
