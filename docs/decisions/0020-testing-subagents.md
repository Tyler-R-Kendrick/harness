# 0020: Testing sub-agents are a closed roster

Status: decided 2026-09-29.

## Question

The harness needs fuzz, mutation, CRAP, contract, and atomic checks, BDD scenarios
that use a contract at each integration boundary, and UX checks where a subject is
user-facing. Should each of those be a model the host asks, or a built-in sub-agent
with a fixed judgment?

## Decision

They are seven sub-agents in `packages/core/data/testing-subagents.json`.
`parseTestingRoster` refuses a file that drops one, renames one, or changes where
it applies. Floors (fuzz trials, the mutation break, the CRAP bound) are data.

`planTesting` keeps BDD for a subject that names an integration boundary, and UX
for a subject that is user-facing. A layout change asks UX for both viewports.
`reviewTesting` judges the evidence those agents require. One failure fails the
review. `spawnTestingSubagents` adds one observe node per planned agent. The
parent must already hold `cap:test:<name>`. The node does not receive spawn.

The native host loads the file with `loadTestingRoster`. An ordinary session turn
does not run the review.

CRAP is complexity² × (1 − coverage)³ + complexity, with coverage as a fraction
from 0 to 1. A mutation threshold under the roster's break fails even when the
score meets that lower threshold.

## Why the judgment stays in code

The file can change a floor or an instruction. It cannot make a called agent skip
its check, and it cannot turn UX on for a library subject. These agents are not
session workers and not ADR 0002 workflows.

## Non-goals

The roster does not run Stryker, fast-check, or a browser. A host supplies the
evidence. Descendant-agent budgets stay a separate feature.
