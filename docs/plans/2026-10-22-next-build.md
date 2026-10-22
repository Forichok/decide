# decide 2.1: build plan

Scope: `2026-10-22-next.md`, items 1–14. Out and Undecided stay out.

## What we get

| # | Item | Shape |
|---|------|-------|
| 14 | md `\|` in links; focus stuck in a mockup iframe | links and code are lifted out before the table split; leaving the iframe (pointer out, or blur to it) returns focus to the card |
| 1 | Round export | `export` tool / `--export`: one `.html` with the page, CSS, JS (import map of data: modules), the round and its media as data: URIs. An offline shim replaces the daemon API |
| 2 | Answer in the file | the exported page answers locally (draft in localStorage) and Done downloads `*.answers.json` with a name field; `import` tool / `--import` validates it against the round and settles the round or returns the digest |
| 3 | Several answer files | `import` with several files: one digest per person and a "they disagree" list |
| 4 | ADR export | `adr` tool / `--adr`: `docs/decisions/NNNN-slug.md` with context, options, decision, consequences; the journal stays in `~/.decide` |
| 5 | Journal page | `#journal` view: search, filters (questions / swipe, live / superseded), opened from the header and the idle screen |
| 6 | Superseded | `supersede` tool appends a supersede line to the journal; `history` marks it, `history {topic}`, `ask` and `swipe` warn when a new question overlaps a live decision |
| 7 | Attention budget | spec `budget` (minutes) + question `priority`: the server keeps what fits, lists the rest as left out on the page and in the result |
| 8 | Only my answer | question `mine: true`: no auto-fill, no "Agent decides", Done waits for it |
| 9 | Notifications | bell in the header: browser notifications for a new round and an agent reply while the tab is hidden |
| 10 | Hesitation | the page sends how long the card was read; a long pause or a re-answer after undo becomes `hesitated` and reads "not sure or hesitated" in the digest |
| 11 | HTML block | `html` on a question, option, card or side: sandboxed srcdoc iframe, height posted from inside |
| 12 | Mockups | width switch 375 / 768 / 1440; `compare` of two `.html` files is a live slider; pins with notes on a mockup go into the answer |
| 13 | Simulator capture | `screenshot {simulator: "ios" | "android"}` via `xcrun simctl` / `adb`; images `{sim: "ios"}` |

Version 2.1.0.

## How we check

- `node --test` green, with new tests: export builds a self-contained file (no `/ui/`, no `/r/` left) and its answers import back; ADR file content and numbering; supersede folding and overlap warnings; md `|` in a link and in code; budget trim; `mine` fill; hesitation marks; simulator commands via a fake binary.
- Exported file opened from `file://` in agent-browser, answered, answers downloaded and imported.
- Light/dark screenshots, desktop 1180×820@2 and mobile 390×844@2, looked at.
- One fresh Opus reviewer on the diff; P0/P1/serious P2 fixed.

## What we don't do

Hosting, LAN, journal in the repo, editing after Done, anything in Out or Undecided. Mermaid in an exported file needs the network once; offline it shows its source. Mockup assets referenced by absolute URL are not inlined.

## Order

14 → 8 → 7 → 10 → 11 → 12 → 9 → 6 → 4 → 5 → 1 → 2 → 3 → 13 → docs → screenshots → review.
