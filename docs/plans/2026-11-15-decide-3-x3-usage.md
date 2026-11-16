# decide 3.0 usage check (X3): one evening, not a week

Date: 2026-11-16. Task X3 of the build plan asked for the four numbers from "How we check", recomputed on a week of real use of the 3.0 branch. There is no such week yet. This check ran in one evening on the data that exists.

## What the data is

- Source: `~/.decide/projects/*/`, 59 project directories (called P1 to P59 below; no names are kept here). The directory was read only.
- Period: first journal line 2026-09-28, last 2026-11-16 (about seven weeks).
- 3.0 rounds (`rounds/<id>/` with `meta.json` format 3 and `events.jsonl`): **0**. No round in the real home was created by the 3.0 core.
- 2.x rounds (one journal line per answered round): **334**. The answers file named by the line exists for 303 of them. The other 31 files are gone, so those rounds count only in the first row of the table.

So the numbers below describe 2.x use. They are the baseline the 3.0 numbers should be compared against, not a measurement of 3.0.

## The four numbers

| Number | Result | Sample | Method |
|---|---|---|---|
| Uncollected rounds | not measurable | 334 rounds | 2.x writes the journal line when the user submits, not when the agent collects. Nothing records collection. The design's figure (21 in seven weeks) came from outside the journal. For 3.0 the count is rounds with a `sent` event and no `acked` event; it is 0 of 0 here. |
| "Page is not running" | not measurable | 334 rounds | 2.x writes no record of a failed `wait`. The string does not appear in any journal line or answers file. The design's figure (4) came from agent transcripts, which this check did not read. |
| Questions to the agent per round | 0.68 | 303 answers files | `dialog` entries in the answers file, 205 in total. 62 rounds (20%) had at least one. Only questions the agent replied to are recorded, so this is a lower bound. |
| Own-text answers, "yes, but" kind | 80 answers, 0.26 per round, 2.9% of answers | 303 files, 2798 answers | Answer objects with a non-empty `note` next to a chosen option. |
| Own-text answers, "none" kind | 77 answers, 0.25 per round, 2.8% of answers | 303 files, 2798 answers | Answer objects with a non-empty `other` (the user typed their own option). |

Free-text questions (`text` answers) are not counted in either own-text row.

## Caveats

- No 3.0 data. Every number is from 2.x and may change once the 3.0 page, "none, suggest others" and the ready answers are in use.
- "Yes, but" and "none" are mapped to the 2.x fields `note` and `other`. A user could also type a "yes, but" into `other`; that is not separable here.
- The 31 missing answers files are probably moved or deleted. Their dialogs and own-text answers are not in the totals.
- The 3.0 branch of the script (event types `sent`, `acked`, `ask`, `note`) ran only on empty input. Check it against a real 3.0 round before trusting it.
- Rounds from test and scratch projects are included; they are not separated.

## What to do next

Use 3.0 on real work for a week, then rerun `node scripts/x3-usage.mjs`. For the two rows that are not measurable in 2.x, the 3.0 event log gives uncollected rounds directly; "page is not running" should be 0 by design (`wait` starts the server), so a nonzero count in agent transcripts is a bug report.

## Script

`scripts/x3-usage.mjs` reads `DECIDE_HOME` (default `~/.decide`), uses only `readFileSync`, `readdirSync`, `statSync` and `existsSync`, and prints aggregate numbers only. Run it with `node scripts/x3-usage.mjs`.
