# 0011: Procedural graphs: procedural memory that evolves under a gate

Status: proposed 2026-09-27; revised the same day after an adversarial review.
Research: `docs/research/procedural-graphs.md`. Plan: `docs/plans/procedural-graph.md`.

## Context

The harness learns from sessions in three ways:

- **Memory** recalls related text.
- **Lessons** distil insights, procedures and pitfalls (ExpeL, ReasoningBank, ACE
  deltas).
- **The workflow builder** compiles a learned procedure into linear workflow code (an
  AWM-like approach).

None of these says *what to do next from here*. Lessons are an unordered playbook put in
the instructions once per turn, and workflows are fixed sequences. So at every step the
solver still has to reconstruct the procedure from a flat, growing history.

*Procedural Graphs* (Lu, Chen, Wu, Arık; arXiv:2609.09153) addresses that gap:

- **The graph.** The procedure is a small directed graph of
  `(procedure, relation, procedure)` triplets. Each edge carries `condition`, `guidance`
  and `pitfalls`.
- **Guidance.** At each step, the agent's last action locates it on the graph. A guidance
  model then turns the 2-hop neighborhood into advice for the next step.
- **Evolution.** Offline, a refiner contrasts failed and successful trajectories and
  proposes edits. An edit is kept only if the score on a validation set does not drop, and
  rejected edits are remembered.

The research note (§2) reaches four conclusions:

- The evidence supports three points: localization works; ungated updates can make an
  agent much worse; and gated iteration can repair a bad prior.
- Per-benchmark gains are mostly inside their confidence intervals.
- The paper's gate is a noise filter that accepts ties.
- The paper is ambiguous in places that matter: how `Match` localizes non-tool nodes, the
  cycle policy, and how strides wrap.

The harness already has most of what the paper had to build: an ordered session log, a
hook bus with sagas, judged evals, an ensemble with constrained decoding, and learning's
trajectory schema and builders. It also has problems the paper never faced:

- many domains and owners in one daemon;
- live sessions that cannot be re-run under a candidate graph;
- untrusted tool output feeding a learner whose output reaches every later session;
- model operations that do not know who called them.

## Options considered

- **Extend lessons with conditional guidelines (AutoGuide-style).** This is the cheapest
  option. But it is the closest baseline in the paper, and it loses to connected
  transitions, because retrieval by similarity omits prerequisites.
- **A knowledge graph (GraphRAG, Graphiti, A-Mem).** These model entities and facts, which
  is semantic and episodic memory, not procedure. They answer "what is", not "what to do
  next".
- **The task graph (`core/task-graph.ts`).** It is an execution structure for one plan:
  statuses, joins and resources. It has no attributes and no serialization. A procedural
  graph is the *prior* that plans are drawn from.
- **Hard constraints (KnowAgent- or TOOLDEC-style).** These guarantee order but remove the
  solver's freedom. A wrong graph then blocks correct actions, and the paper's expert
  prior was wrong. We keep this as an ablation only.
- **Adopting the independent reimplementation.** It is written in Python and has its own
  storage and provider layers. We read its list of departures from the paper instead.
- **Chosen:** a new pure package that reproduces the paper by default, integrated through
  ports and validated offline before any daemon integration.

## Decision

- **`@harness/procedural`, a pure package.** It contains:
  - the graph schema and the paper's edit set;
  - `prepareCandidate`;
  - `Match`, the neighborhood and the paper's serializer;
  - the evolution reducer (Algorithm 1, in both one-time and incremental modes);
  - the gates;
  - the revision model.

  Time, randomness, storage, models and rollouts arrive through ports. Revision ids are
  the sha256 of canonical, versioned JSON, computed with `@noble/hashes` (pure JavaScript,
  no host crypto). The refiner answers under a JSON Schema constraint of the edit set.
- **Paper fidelity is a preset, not a fork.** The `paper` preset reproduces the paper's
  decoding, text ReAct solver, per-benchmark strides, ungated one-time modes and `≥` gate.
  Where the paper is ambiguous, the choice is pre-registered and ablated. The `harness`
  preset changes what the research note found weak:
  - a per-trajectory context tail;
  - an **anchored, power-sized non-inferiority gate**: superiority, or non-inferiority
    with a smaller graph, never more than a total loss from `G_0`;
  - claims made only on a split the loop never saw;
  - deduplicated rejections;
  - an enforced tool catalog;
  - a deterministic edit filter;
  - a per-session guidance cache whose key includes the query;
  - guidance delivered as a trailing advisory message, not system text.
- **Reproduce before integrating.** The pure core, a minimal offline rollout in evals, and
  the pre-registered reproduction come first. Daemon integration waits for the results.
- **Evolution is offline, over replayable task suites.** Validation re-runs tasks under a
  candidate, and live sessions cannot be re-run. Live sessions contribute training
  evidence only. Online evolution, which needs an unpaired, capped canary, is a separate
  decision.
- **A round runs as a reducer over an event log, not as a code-mode workflow.** A
  workflow's timeout is a terminal failure, its journal is rewritten on every call, and
  it cannot import the reducer. A round is resumed by replaying its events, and only one
  round runs per owner and domain, under a leased epoch.
- **Advisory, never authority.** A graph names tools; it never grants them. Grants and
  approvals stay in the core, and a node whose tool the session lacks is inert. Edits
  that route into tools with side effects need an approver, through the existing
  permission flow.
- **Where things are recorded.**
  - The revision store is the system of record for graphs, heads, pins and revocations.
    It is keyed by owner.
  - The session log records each guidance step: revision, node, match, digest and
    guidance id.
  - The hook bus carries three notification events: `procedural.session.pinned`,
    `procedural.round.started` and `procedural.revision.decided`. Consumers never trust
    an event over the store.

  Guidance is evidence, not a replayed effect. The log is not write-ahead today, but
  nothing here requires it to be. A write-ahead runtime is its own decision.
- **Core gains three generic things.** None of them knows about procedural graphs:
  - opaque per-session metadata, from ACP `_meta.harness.session` to the worker;
  - the caller's principal and grants on model work, so extension ops can authorize;
  - a host-side publish API whose `source` the host binds.
- **Composition through the same gate.** A new path compiler turns recorded calls into a
  durable workflow and keeps data flow. The workflow goes into a staging library and is
  bound to a node by its code's sha256. Sessions get only the workflows their pinned
  revision binds. Promotion is an edit, so it is validated like any other.

## Consequences

- A new pure package joins the ESLint purity glob, the coverage gate and the mutation
  gate.
- Evals gain several things:
  - metric cases (no judge needed);
  - per-task score vectors and paired or hierarchical bootstrap intervals;
  - concurrency;
  - dataset manifests pinned by sha256;
  - a token budget meter as AI SDK middleware;
  - a text ReAct solver;
  - a synthetic treasury suite for loop and promotion tests.
- Workers localize from `messages`, not from `prepareStep`'s `steps`. `steps` covers only
  one `agent.stream` call, and the worker restarts that call every turn and after every
  approval round.
- Workers report step records through a `report` callback in `TurnOptions`.
- Opaque harness workers get turn-level guidance only, and exact `Match` on their coarse
  tool names localizes little.
- A paper-scale HotpotQA loop costs about 10⁸ tokens per seed. The owner's budget decides
  the validation size, and any reduction is a labeled departure.

## Revisit when

- The reproduction's claims fail. Then stop before integration, and publish the negative
  result.
- An ablation shows that relation labels, case-insensitive matching or a state-tracker
  mode matter. Then change the defaults.
- Online evolution is wanted. It needs its own plan with an unpaired gate.
- The task graph gains payloads and serialization. Then subgraphs can instantiate plans.
- A maintained TypeScript implementation of the paper appears.
