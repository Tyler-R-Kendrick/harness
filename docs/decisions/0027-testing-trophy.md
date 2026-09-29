# 0027: A decision pass picks the testing trophy

Status: decided 2026-09-29.

## Question

Which of the applicable testing agents should verify a piece of work, and where
does that choice run?

## Decision

The testing trophy picks the band. Static analysis is the base, unit tests are
few, integration tests are the bulk, and end-to-end tests are the tip. Fuzzing
and mutation sit outside that default: they run only when the pass asks to
amplify.

`selectTrophy` asks one decision pass. The request has the same fields as the
ADR 0016 decision request (`text`, `context`, and two to twenty options). The
options are `static`, `unit`, `integration`, `e2e`, and `amplify`. The choice
is the band. A higher probability on another band does not promote the work.
The pass is a port: tests script it, and this package does not call a model.

The band is then intersected with `planTesting`, in roster order. Static keeps
CRAP. Unit adds the atomic agent. Integration adds contract tests and, when a
boundary applies, BDD. End to end adds evals and, when the subject is
user-facing, UX. Amplify adds fuzz and mutation to the integration agents and
does not add evals or UX. An agent the plan excluded is never added back.

A thrown answer, a complicated answer, an unknown choice, a choice that is not
a string, or a probability that is not a finite number falls back to
integration. The fallback is the bulk of the trophy, not the whole roster.

The task-verification workflow bakes that in. `select-tests` runs the pass and
stores the names. `review-tests` judges those names. `reviewTesting` without a
selection still judges every applicable agent, so a called agent still cannot
skip its own check.

## Why this is not a roster edit

ADR 0020 keeps the eight agents and where each applies. The file cannot make a
called agent skip its check. Skipping fuzz, mutation, evals, or UX for a small
change is a separate decision about this piece of work. Running every
applicable agent on every change is the cost the trophy avoids.

## Non-goals

No ninth agent. Floors and applicability stay data. The pass does not run
Stryker, fast-check, a browser, or a model. Delivery verify stays correctness,
gates, and budget. `spawnTestingSubagents` still spawns the plan it is given.
