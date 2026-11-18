---
name: visual
description: Use when the owner asks for /decide:visual or wants to accept a product change by looking at before and after captures and trying the changed task.
---

# decide:visual

Build a round around what the owner does and sees. Put the main changes in the overview and give each task a short reproduction.

## Pick the revisions

Call `visual {project, compare: true}` with the absolute project path. The CLI equivalent is `node decide.mjs visual --compare --project <directory>`. Add `head` or `--head` to look at a different branch.

On the first project round, show the owner the proposed source branch and both commit IDs. Ask whether to remember automatic branch-start comparisons. Pass `baselinePolicy: "branch-start"` or `--baseline-policy branch-start` when they confirm. Each later work branch gets its own recorded starting commit. If the proposal is uncertain or the owner prefers another baseline, pass `base` or `--base` with their exact Before revision. A detached HEAD or missing branch creation history can require this choice.

Capture from the two commits in the proposal. Use their commit IDs as `base` and `head` if a ref could move between capture and opening. Re-preview a named ref if it moved. Save any local fixture or build state needed to reproduce the result.

## Capture a task

- Use the same viewport, theme, fixture and starting state on both revisions. Add a separate evidence pair for a phone or a different scenario.
- Match the action in both recordings. Set each clip's `cue` in seconds at that action. Use `unmatched` to name an action that exists on one side only and explain it in the task's `gap`.
- For a new or removed screen, look for the route the user had before or the one they can use now. If a capture is unavailable, include the side you can show and explain the gap. For an invisible change, set `manualOnly: true`, omit the captures and gap, and provide steps and an expected outcome. Approval requires an owner check. When a capture is missing, the owner may verify the task manually or explicitly accept the gap. The result records which they chose.
- Use disposable data for `scene`. Give the owner an HTTP or HTTPS URL they can open and steps they can follow if the URL is unavailable.

Place PNG, JPEG or WebP screenshots and WebM or MP4 recordings beside the spec or in a subdirectory. Use relative paths. For an inline MCP spec, capture paths start at the project root. Decide copies the captures into the round when it opens.

## Open a round

Use the `visual` MCP tool with `project` and `specPath`, or run `node decide.mjs visual settings.visual.json --project <directory>`. A task can have multiple evidence pairs. Each side can carry an image, a video or both.

```json
{
  "lang": "en",
  "title": "Settings sidebar",
  "summary": ["Settings now stays beside the list while you edit."],
  "tasks": [{
    "id": "open-settings",
    "title": "Open settings from the list",
    "beforeText": "Settings replaced the list.",
    "afterText": "Settings opens beside the list and keeps the same item selected.",
    "steps": ["Select the sample item.", "Open Settings."],
    "expected": "The sample item stays selected while the settings panel opens.",
    "scene": "http://127.0.0.1:4173/settings-fixture",
    "evidence": [{
      "id": "desktop",
      "label": "Open settings with an item selected",
      "viewport": "1440 × 900",
      "theme": "Light",
      "fixture": "Sample item",
      "state": "Item selected, settings closed",
      "before": { "image": "before.png", "video": "before.webm", "cue": 1.0 },
      "after": { "image": "after.png", "video": "after.webm", "cue": 0.8 }
    }]
  }]
}
```

Share the returned URL. Call `wait {project, round}` or run `node decide.mjs wait <round> --live --project <directory>`. Answer questions with `explain` using the returned `askId`, then wait again for the verdict. The owner records their manual check and can accept an evidence gap in the round.

## Reopen after a return

Pass the returned round ID as `previous` or `--previous`. Add a `replies` entry for each open remark. Use its original ID as `ref` and name the current `task`. Include `evidence`, `side` and either `x` and `y` as fractions of the image or `time` in seconds if you have a replacement location. Use `text` to say what changed and how to check it, including where to look if the original control moved or disappeared. The round keeps the original capture and mark. Wait for the owner's recheck and verdict.
