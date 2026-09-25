# 0002: Durable workflows: AI SDK code mode plus a journal we own

Status: decided 2026-09-24; revised 2026-09-25 (code mode replaces our QuickJS sandbox, see ADR 0005).

## Question

Learned skills and tools must run as durable workflows: code whose effects are recorded,
so a run that stops resumes instead of starting over. What should run them?

## Requirements

- Runs inside the daemon, with the host's own storage port. No separate server or database.
- Runs code a model wrote, so it must be isolated from the host.
- Replaying the journal gives the same run, or is refused.

## Options considered

- **Temporal, Restate, Inngest, Hatchet, Trigger.dev**: each needs its own server. They
  also do not isolate untrusted code.
- **DBOS and Absurd**: Postgres-backed; the same problem, with a database instead of a server.
- **Vercel Workflow DevKit (`workflow`, `@ai-sdk/workflow`'s `WorkflowAgent`)**: durable
  steps, but a compiler transform turns `"use workflow"` / `"use step"` functions into
  steps at build time. Learned tools are code a model writes at run time, which the
  transform never sees. It suits the harness's own agent loops, not learned code.
- **`@effect/workflow`**: pulls in Effect, which ADR 0001 declined.
- **Our own QuickJS sandbox** (the first version of this decision): deterministic and
  portable, but a sandbox we maintain.
- **AI SDK code mode (`@ai-sdk/code-mode`)**: runs model-written JavaScript or TypeScript
  in QuickJS in a worker, with time, memory and stack limits, calling AI SDK tools. It is
  the AI SDK's own answer to "a model writes code that composes tools". Node only.

## Decision

- Execution: **AI SDK code mode** (`experimental_runCodeMode`). Workflow code is a
  code-mode program: an async function body with `input` and `tools` in scope. Its only
  way out is `tools.<name>(args)` (another library workflow, run as a nested durable run,
  or one of the host's AI SDK tools) and `tools.ask({ prompt, constraint })` (a model).
- Durability: a small journal we own (`packages/workflows/src/run.ts`), using the
  Temporal/DBOS model. Every call's result is saved through a `SnapshotStorage` before
  the code sees it, numbered in the order the code makes the calls (deterministic for the
  same code and results, even when calls run in parallel). A rerun replays recorded
  results; a call that does not match its entry is refused, never performed twice. A
  failed effect aborts the run, so the code cannot catch it and resume retries it. A
  finished run returns its recorded output.
- Code mode keeps `Date` and `Math.random`. Code that uses them to shape its calls cannot
  resume (the journal refuses it); the tool builder asks models not to.
- Checking before keeping: a draft must parse (constructing a function parses it and
  runs nothing), and call only tools that exist.

## Revisit when

- A durable-execution library can journal code written at run time with pluggable
  storage (then drop our journal), or code mode gains a deterministic mode.
- Browser hosts need workflows: code mode is Node only.
