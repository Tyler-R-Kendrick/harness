# 0011: Procedural graphs: procedural memory that evolves under a gate

Status: proposed 2026-09-27. Research: `docs/research/procedural-graphs.md`. Plan:
`docs/plans/procedural-graph.md`.

## Context

The harness learns from sessions in three ways. Memory recalls related text. Lessons
distil insights, procedures and pitfalls (ExpeL, ReasoningBank, ACE deltas). The workflow
builder compiles a learned procedure into linear workflow code (AWM-like). None of these
says *what to do next from here*. Lessons are an unordered playbook put in the
instructions once per turn. Workflows are fixed sequences with no branches. The solver
still has to reconstruct the procedure from a flat, growing history at every step.

*Procedural Graphs* (Lu, Chen, Wu, Arık; arXiv:2609.09153) addresses exactly this gap.
The procedure is a small directed graph of `(procedure, relation, procedure)` triplets,
and each edge carries `condition`, `guidance` and `pitfalls`. At each step, the agent's
last tool call locates it on the graph, and a guidance model turns the 2-hop
neighborhood into advice for the next step. Offline, a refiner contrasts failed and
successful trajectories and proposes graph edits. An edit is kept only when validation
does not get worse. Rejected edits are remembered.

The paper's evidence (research note §2) supports three findings:

1. Localized guidance beats both no graph and full-graph guidance.
2. Ungated updates can make an agent much worse.
3. Gated iteration repairs a bad prior.

The per-cell gains are mostly inside the confidence intervals, and the gate is a noise
filter that accepts ties on 20 to 100 validation tasks.

The harness has most of the machinery the paper had to build:

- An ordered session log.
- A hook bus with sagas.
- Judged evals.
- An ensemble with constrained decoding.
- Durable workflows.
- Learning's trajectory schema and builders.

It also has gaps the paper did not face:

- Many domains in one daemon.
- Concurrent sessions.
- Untrusted tool output feeding a learner whose output reaches every later session.
- A session log that is persisted *after* outputs are dispatched. It is not write-ahead.

## Options considered

- **Extend lessons (conditional guidelines, AutoGuide-style).** Cheapest. The paper shows
  it is the closest baseline and loses to connected transitions. Retrieval by similarity
  omits prerequisites, for example `submit` without `check_answer`.
- **A knowledge graph (GraphRAG, Graphiti, A-Mem).** It models entities and facts, which
  is semantic and episodic memory, not procedure. It answers "what is", not "what to do
  next".
- **The task graph (`core/task-graph.ts`) as the procedure.** It is an execution
  structure for one plan: statuses, joins, resources. It has no attributes, no
  serialization, and no notion of advice. A procedural graph is the *prior* that plans
  are drawn from, so the two are different layers.
- **Hard constraints (KnowAgent, TOOLDEC-style: allow only successor tools).** This
  guarantees ordering, but it removes the solver's freedom. A wrong graph then blocks
  correct actions, and the paper's expert prior was wrong on MultiChallenge. We offer it
  only as an ablation.
- **Adopt the independent reimplementation.** It is Python, and it has its own storage
  and provider layers. We would still have to write the ports, the log integration and
  the gate, so we take its departures list as input, not its code.
- **A new pure package that reproduces the paper by default, integrated through ports.**
  **Chosen.**

## Decision

- **`@harness/procedural`, a pure package.** It holds:
  - the graph schema, parsed into a branded `ProceduralGraph`;
  - the paper's edit set, and `prepareCandidate` with its structural checks;
  - `Match`, the `h`-hop neighborhood, and the paper's serializer;
  - the evolution loop as a pure reducer (Algorithm 1);
  - the gates;
  - the revision model;
  - the projection from session-log entries to learning's `Trajectory`.

  Time, randomness, storage, models and rollouts arrive through ports. Model calls go
  through AI SDK `generateText`. The refiner answers under a JSON Schema constraint of
  the edit set, and never as prose that we then parse.
- **Paper fidelity is a mode, not a fork.** Settings are data
  (`packages/procedural/data/settings.json` with a generated schema). The `paper` preset
  reproduces the paper exactly:
  - exact match, with full-graph fallback;
  - `h = 2`, `w = 3`;
  - tail of the concatenated batch;
  - a `≥` gate that accepts ties;
  - unbounded rejection memory.

  The `harness` preset changes the parts the research note found weak:
  - a per-trajectory tail;
  - a paired, non-inferiority gate with a size tie-break;
  - deduplicated, capped rejection memory;
  - the tool catalog enforced structurally;
  - a guidance cache.

  Each departure is listed in the plan and has an ablation.
- **Advisory, never authority.** Guidance reaches the solver as advice in its
  instructions. The graph never grants tools, capabilities or approvals, which stay with
  the core. A strict "successor tools only" mode exists for ablation only.
- **The log is the system of record.**
  - A session pins one graph revision and records it.
  - Each guidance step is appended to the session log with its revision, active node,
    match result, window digest and text.
  - Trajectories are projections of the log.
  - Evolution publishes its saga on the hook bus (`procedural.round.*`,
    `procedural.revision.*`).

  Guidance is evidence, not a replayed effect, because turns do not resume
  mid-step today. Inside a durable workflow it is a journaled call like any `ask`. The
  log becomes write-ahead only when the runtime persists before it dispatches. The plan
  makes that a prerequisite phase, not an assumption.
- **Revisions are content-addressed and append-only.**
  - The id is the sha256 of the canonical graph, computed with `@noble/hashes`, which is
    pure JavaScript and needs no host crypto.
  - Each revision records its parent, edit set, evidence, gate decision and committer.
  - The head per domain moves only through the gate, or through an approver when one is
    required.
  - Rejections are revisions that never became head.
- **Composition through the same gate.**
  - Nodes can bind to a tool, a library workflow or a skill.
  - A frequent, successful, unbranched path can be compiled by the workflow builder into
    a durable workflow. A candidate revision then adds it as one node.
  - Promotion is an edit like any other, so it is validated like any other.
- **Domains are explicit first.** A session names its procedure domain, or has none.
  Automatic routing comes later, through the router with a confidence and a "no graph"
  arm.

## Consequences

- A new pure package joins the mutation and coverage gates.
- Workers gain a per-step hook through AI SDK `prepareStep`. It always rebuilds
  instructions from `initialInstructions`, because an `instructions` override carries
  forward and guidance would otherwise pile up.
- Opaque harness workers (Claude Code, Codex, ACP agents) have no per-step hook. They get
  turn-level guidance only, localized from their `tool_call` updates. Worker updates must
  carry the tool's real name in `_meta.harness.tool`, because a harness's `title` is
  prose.
- Guidance costs a model call per step. The paper measured 33–55% more tokens. We cache
  it, and we skip the call when only one unconditional transition is available.
- Evolution needs scores. Judge verdicts `inconclusive` and `blocked` are excluded,
  never scored as 0.
- Online evolution (a canary between the head and a candidate) exposes users to
  candidates. It is off by default, capped, and can require an approver.

## Revisit when

- Ablations show relation labels matter (then serialize them), or that ACTION-hop
  horizons beat plain hops (then change the default).
- The runtime gains a true write-ahead log (then guidance becomes a replayed effect).
- The task graph gains payloads and serialization (then subgraphs instantiate plans).
- A maintained TypeScript implementation of the paper appears.
