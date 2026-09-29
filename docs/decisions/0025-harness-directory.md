# 0025: `.harness` holds user and project definitions

Status: decided 2026-09-29.

## Question

Where do sessions, worktrees, and agent skills live, at the user level and at
the project level?

## Decision

They live in a `.harness` directory. The user directory is `~/.harness`. The
project directory is the nearest `.harness` at the working directory or a
parent, and the walk stops before the user home so that directory is not also
the project. The same layout is used at both layers:

- `sessions/<name>.json` — `{ name, harness, state }`, the name matching the
  file. This is a managed harness session.
- `worktrees/<id>.json` — `{ id, branch, paths }`, the id matching the file.
  This is a delivery task.
- `skills/<name>/SKILL.md` — `name` and `description` frontmatter and the skill
  body, plus any other files in that directory. This is an agent skill.

A directory that is not there is an empty layer. A file that is there and
invalid fails, and the error names the file. The project layer replaces a user
entry with the same session name, worktree id, or skill name, and leaves every
other entry where it was.

The native daemon loads both layers when it starts. A harness worker receives
those skills. Every worker that takes instructions also receives the skill
names and descriptions. The skill body stays on the skill.

## Non-goals

The daemon does not start the defined sessions, and `harness-deliver` still
takes its run from `--tasks`. `~/.cache/harness` is still runtime state.
`/settings` remains the only configuration entry point (ADR 0024). The
playground's Eve agent directory (ADR 0015) is a different tree. The browser
host has no home directory and does not read these files.
