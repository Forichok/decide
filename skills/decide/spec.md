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
  "sections": [{ "id": "base", "title": "Basics", "intro": "…" }],
  "questions": [
    {
      "id": "layout",
      "section": "base",
      "title": "Which home screen layout do we go with?",
      "tldr": "This decides what people see first.",
      "what": "…",
      "how": "…",
      "why": "…",
      "goal": "…",
      "type": "single",
      "layout": "compare",
      "stakes": "high",
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
| `preview`            | Path to a self-contained HTML file. Runs in a sandboxed frame with no network; `previewHeight` in px.                                                  |
| `mermaid`            | Mermaid source; the page renders it and the user can enlarge it                                                                                        |
| `code`               | `{text, lang?}` or `{text, diff: true}`                                                                                                                |
| `links`              | `[{label, url}]`                                                                                                                                       |

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
    "share": { "selected": ["p10"], "flag": "delegate", "auto": true }
  },
  "dialog": [{ "question": "layout", "ask": "Why a today view and not a board?", "answer": "…" }],
  "comment": "a comment on the whole round",
  "attachments": ["/abs/path.png"],
  "digest": "1. [layout] …"
}
```

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

## Where things live

Each project gets a data dir, `~/.decide/projects/<name>-<hash>/`
(`DECIDE_HOME` moves the root). The project is the nearest directory with
`.git` above the one you pass. The data dir holds the page server state, the
decision journal (`journal.jsonl`), inline specs (`rounds/`) and screenshots
(`shots/`). One browser tab serves every round of a project; the server stops
after 30 idle minutes.
