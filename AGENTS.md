# decide

A public plugin for Claude Code and Codex. Agents ask questions on a local
browser page; users pick options, inspect visuals and ask follow-up questions.
Use README.md as the product guide:

- The problem / When to use it / How: decision rounds for multiple choices
  that affect the result. Keep a single yes/no in chat.
- Screens / What the agent gets: recommendations, screenshots, HTML mockups,
  diagrams, inline questions and answers. Results distinguish user choices
  from agent recommendations and include a JSON file.
- Install / Commands: Node.js >=20; `/decide` in Claude Code, `$decide` in
  Codex. `node decide.mjs --demo` runs a tour without installation.
- How it works: `mcp.mjs` exposes ask, wait, explain, screenshot and history;
  `decide.mjs` is the CLI. `lib/` contains the engine and `ui/` the page.
  The local server starts on demand and stops after 30 idle minutes. State
  lives in `~/.decide/projects/`; `DECIDE_HOME` changes that location.
- Security / FAQ: loopback only, Host validation, an x-decide header for
  writes, sandboxed mockups. Mermaid loads from jsDelivr for diagrams.
- Development / License: no dependencies or build step; MIT. Agent usage
  lives in skills/decide/SKILL.md; the format is in skills/decide/spec.md.

## Checks

Run `node --test` for the whole suite. Tests start real servers in temporary
directories and do not touch the user's ~/.decide. CI covers Linux, macOS
and Windows. Never skip or loosen tests. Judge checks by exit codes.

Run `echo '{}' | node scripts/stop-check.mjs` to exercise the Stop gate.
It checks changed JS syntax and runs the whole suite when JS or JSON changes.
Exit 2 blocks on real failures; environment failures report NOT verified and
exit 0. Identical failures do not block repeated active Stop events.
`AGENT_STOP_CHECK=0` is the owner's explicit opt-out, not a workaround for
failing tests.

## Shipping

Push to a branch and open a PR freely when the task permits it. This is a
public plugin: merging to master and releases require the owner's explicit
yes. Respect narrower task restrictions on commits, pushes and remotes.
Verify the result where the user uses it; do not claim completion from a
test log alone. Report the commands, exit codes and anything NOT verified.
