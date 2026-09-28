# 0013: The harness in its own filesystem, as an Eve agent directory

## Context

The playground's filesystem held example files, while the harness's own state (its
workers, tools and how their calls are approved, its settings, its decision model and
generators, its templates, its commands) lived only in memory and in slash commands'
output. A person or an agent working in that filesystem could not see what the harness
is, and what the harness learned (templates, the scripts they run) had to be asked for.
Vercel's Eve describes an agent as a directory of files: `agent.ts` (runtime settings),
`instructions.md`, `tools/`, `skills/`, `subagents/<name>/`, and more.

## Decision

- **The harness writes itself into the filesystem as an Eve agent** (`syncAgentDir`):
  `~/AGENTS.md` (what the harness is now and where things are), and under `~/agent/`:
  `agent.ts` (the current worker's model and the harness's settings: approvals,
  generation, tier, decision model, generators), `tools/<name>.ts` (each tool the agents
  have: description, input schema, how its calls are approved), `skills/` (using the
  terminal; writing templates, with the facts a hole can use), `subagents/<worker>/`
  (each worker as a subagent: description, model, instructions), `templates/` (ADR 0012)
  and `workflows/<id>.sh` (each script template as a script that fills its holes from
  variables of their names and runs, as `/ask` would).
- **It is kept in sync:** at boot, after every turn (before the turn's effect on the
  files is taken, so what the harness wrote is in that turn's diff), when a setting
  changes, and when Claude becomes reachable. Only files whose content changed are
  written; what it generated before and no longer has (a retired script template's
  workflow, a tool that is gone) is removed, by a manifest (`agent/.generated`); nothing
  else is touched.
- **What the person owns stays theirs:** `instructions.md` is written once and then read
  by the agents each turn (so editing it changes them); templates are the person's and
  the engine's to edit. The generated files say so at their top.

## Consequences

- The Files tab and the terminal show the harness's state, and a turn's report shows how
  it changed (a new template, its workflow, AGENTS.md's counts).
- The generated `agent.ts` and `tools/*.ts` import `eve` but are descriptions of the
  harness in Eve's layout, not a project Eve builds; the harness runs them itself.
- `workflows/` is ours, not an Eve directory: Eve keeps durable work in Vercel
  Workflows; here a script template is a workflow a person can run by hand.

## Revisit when

- The harness runs durable workflows in the page (`@harness/workflows`): write each
  workflow's code under `workflows/` beside the script templates.
- Eve's file conventions change, or the harness loads an Eve agent directory to
  configure itself: read `agent/` as well as write it.
