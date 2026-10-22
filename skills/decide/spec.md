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
      "id": "layout",
      "section": "base",
      "title": "Which home screen layout do we go with?",
      "tldr": "This decides what people see first.",
      "body": "| Screen | Visits a day |\n|---|--:|\n| Today | 4 100 |\n| Inbox | 900 |",
      "what": "…",
      "how": "…",
      "why": "…",
      "goal": "…",
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
          "recommended": "puts what is due first",
          "pros": ["…"],
          "cons": ["…"],
          "metrics": [
            { "label": "Speed", "value": 4 },
            { "label": "Time", "value": "5 days" }
          ],
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
  earlier questions; the linter warns otherwise.
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

### Media

Any question or option can carry media; images open in a lightbox and can be
marked up by the user.

| Field                | Value                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `images`             | Paths (relative to the spec file, or to `project` for inline specs), URLs, or `{src, caption}`                                                         |
| `images[]` as a shot | `{shot: url, viewport: "desktop" \| "mobile" \| "both", caption?, name?, waitMs?}`: captured with the local Chrome when the round opens. http(s) only. |
| `image` (option)     | One image for the option card                                                                                                                          |
| `images[]` from a simulator | `{sim: "ios" \| "android", device?, caption?, name?}`: the booted iOS simulator (`xcrun simctl io booted screenshot`) or the Android emulator (`adb exec-out screencap -p`), captured when the round opens. `DECIDE_SIMCTL` / `DECIDE_ADB` point at other binaries. |
| `preview`            | Path to a self-contained HTML file. Runs in a sandboxed frame with no network; `previewHeight` in px. The page offers 375 / 768 / 1440 px widths and pins with notes. |
| `html`               | An HTML string, or `{source, maxHeight?}` (80–1200 px, default 640). Up to 200 KB. Rendered in a sandboxed frame that grows to its content.            |
| `mermaid`            | Mermaid source; the page renders it and the user can enlarge it                                                                                        |
| `code`               | `{text, lang?}` or `{text, diff: true}`                                                                                                                |
| `compare`            | `{before, after, labels?: [a, b]}`; `before` / `after` take a path, a URL or `{src, label}`. Two pictures of the same size work best. Two `.html` files make a live compare: both mockups run, one divider. Mixing an image and an `.html` is skipped with a warning. |
| `video`              | A path or URL, `{src, caption?, loop?}`, or a list. mp4, webm or gif. Clips up to 20 s loop muted unless `loop: false`.                        |
| `diff`               | `{before, after, lang?, labels?: [a, b]}`. Changed lines are paired by likeness, with the changed part of each line marked.                             |
| `table`              | `{columns, rows, caption?}`. Columns are strings or `{id, label}`; rows are arrays or objects keyed by column. Numeric cells align right.              |
| `chart`              | `{type: "bar" \| "line", labels, series: [{name, values}], unit?, title?}`, or `{series: [1, 2, 3]}` for one unnamed series. `null` is a gap.       |
| `links`              | `[{label, url}]`                                                                                                                                       |

Limits; lint warns past them: 12 bars, 60 line points, 4 series, unnamed
series when there are two or more, a 400-line diff, a 20 MB video, 50 table
rows, 8 table columns. Charts on the options of one question share one y
scale, so equal bars mean equal values.

Missing local files and failed shots are reported as lint warnings and
skipped. Viewports: desktop 1440×900, mobile 390×844 at 2×. Set
`DECIDE_CHROME` if Chrome isn't found.

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

Each project gets a data dir, `~/.decide/projects/<name>-<hash>/`
(`DECIDE_HOME` moves the root). The project is the nearest directory with
`.git` above the one you pass. The data dir holds the page server state, the
decision journal (`journal.jsonl`), inline specs (`rounds/`), screenshots
(`shots/`) and export records (`exports/`). One browser tab serves every round of a project; the server stops
after 30 idle minutes.
