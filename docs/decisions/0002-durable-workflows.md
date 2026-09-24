# 0002: Durable workflows: QuickJS sandbox plus a journal we own

Status: decided, 2026-09-24.

## Question

Learned skills and tools must run as durable workflows: deterministic code whose effects
are recorded, so a run that stops resumes instead of starting over. What should run them?

## Requirements

- Runs inside the daemon on every host (native, browser extension, tab, remote), with
  the host's own storage port. No separate server or database.
- Runs code a model wrote, so it must be isolated from the host.
- Deterministic: replaying the journal gives the same run.

## Options considered

- **Temporal, Restate, Inngest, Hatchet, Trigger.dev**: each needs its own server, which
  a browser extension or tab cannot run. They also do not isolate untrusted code.
- **DBOS and Absurd**: Postgres-backed; the same problem, with a database instead of a
  server.
- **Vercel Workflow DevKit (`workflow`)**: needs a compiler transform for its
  `"use workflow"` / `"use step"` directives and a "world" adapter. It targets deployed
  apps and does not isolate code.
- **`@effect/workflow`**: pulls in Effect, which ADR 0001 declined.
- **Node `vm`**: not a security boundary, and Node only.

## Decision

- Sandbox: **QuickJS compiled to WebAssembly** (`quickjs-emscripten`, sync variant).
  It is isolated and portable, with memory and stack limits and a counted (not timed)
  interrupt budget. The prelude removes the clock and randomness. Host effects are
  promises the host settles one at a time, in call order.
- Durability: a small journal we own (`packages/workflows/src/run.ts`, about 100 lines),
  using the Temporal/DBOS model. Every effect result is saved through a
  `SnapshotStorage` before the code sees it. A rerun replays recorded results, refuses a
  journal that diverges from the code, and returns a finished run's recorded output.
- Effects are the only way out: `ctx.tool(name, args)` and `ctx.ask(prompt)`. Other
  library workflows are tools, run as nested durable runs.

## Revisit when

- A durable-execution library appears that is embeddable, portable to browsers, has
  pluggable storage, and isolates code. We would then adopt it and drop the journal.
