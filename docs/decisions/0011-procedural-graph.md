# 0011: Procedural graphs: a static core, a live dynamic layer, and dream

Status: accepted 2026-09-27; implemented. Proposed and revised the same day, after an
adversarial review and the owner's direction. Research: `docs/research/procedural-graphs.md`.
Plan: `docs/plans/procedural-graph.md`; the API as built: `docs/plans/procedural-graph-api.md`.

## Context

The harness learns from sessions in three ways:

- **Memory** recalls related text.
- **Lessons** distil insights and pitfalls.
- **The workflow builder** compiles linear procedures.

None of these answers *what to do next from here*. At every step, the solver still
reconstructs the procedure from a flat, growing history.

*Procedural Graphs* (Lu, Chen, Wu, Arık; arXiv:2609.09153) answers that question with a
small directed graph of `(procedure, relation, procedure)` triplets. Each edge carries
`condition`, `guidance` and `pitfalls`. The paper has two parts:

- **Online.** The agent's last action locates it on the graph, and a guidance model turns
  the 2-hop neighborhood into advice.
- **Offline.** A refiner proposes edits from contrasting trajectories. An edit is kept
  only when validation does not get worse, and rejections are remembered.

The research note concludes that localization and gated iteration carry the result. It
also finds the paper's gate weak and the paper ambiguous in places that matter.

The harness needs two things the paper does not have:

- **Learning from live traffic.** The paper's graph is frozen online and changes only
  in offline rounds against a validation set. A deployed harness has live sessions, not
  validation sets.
- **Stability.** Live learning must not erode procedures that are known to work. It
  must not be a path for poisoning either.

Scope is also not ours to decide. Graphs may be per user, team, repository or project, or
shared, and teams may merge them later.

## Options considered

- **Extend lessons with conditional guidelines.** This is AutoGuide-like. It is the
  closest baseline in the paper, and it loses to connected transitions.
- **A knowledge graph.** It models facts, which is semantic and episodic memory, not
  procedure.
- **The task graph.** It is an execution structure for one plan, while a procedural graph
  is the prior that plans come from.
- **One graph evolving online from live traffic.** Nothing can be re-run online, so every
  change is ungated. The paper shows that an ungated update can cost 30 points.
- **One graph evolving offline only (the paper).** It is safe, but it learns nothing
  between rounds. It also needs a validation set, which most deployments lack.
- **Chosen: a static core that changes only through dream, and a dynamic layer that
  learns from live traffic but can only add and annotate.**

## Decision

- **`@harness/procedural`, a pure package.** Time, randomness, storage, models, the
  evaluator and the stores arrive through ports. Model calls use AI SDK `generateText`,
  and the refiner answers under a JSON Schema constraint of the paper's edit set.
- **The static core.**
  - It is a revisioned graph. Each revision's id is the sha256 of its canonical,
    versioned JSON, computed with `@noble/hashes`.
  - It changes only by a dream commit, a seed, a merge or a revert. Live traffic never
    writes it.
- **The dynamic layer (overlay).** It is an event-sourced log folded into state, fed by a
  live learner that is a hook-bus actor reading the session log. It learns, cheapest
  first:
  - edge statistics;
  - transitions the graph lacks (with distinct-session support);
  - cautions on edges that precede failures;
  - optionally, model-written notes from reflection, which pass the edit filter.

  Four rules bound it:
  - It can only add nodes and edges, append notes and flag cautions. The effective graph
    always contains the whole core.
  - It never binds tools.
  - New entries start on probation. They are shown to a random share of sessions, drawn
    from the `Entropy` port. They are promoted when exposed sessions do no worse, and
    retired when they do worse or go stale.
  - Its content is labeled as learned or provisional in the guidance context.
- **Dream.** A separate, out-of-band process: scheduled, triggered, run from the CLI or
  called as an operation. It runs one at a time per graph, under a leased epoch, as a pure
  reducer over a dream event log. Each round:
  1. It takes the core, an overlay snapshot, trajectories and the rejection memory.
  2. It proposes edits that absorb what the overlay proved, prune what the evidence
     condemns, and compile paths into workflows.
  3. It prepares the candidate and runs the gates.
  4. It commits, or records a rejection.
  5. It rebases the overlay, optimistically, so live learning never blocks.

  The gates compose:
  - `structure`: always on.
  - `evaluator`: the paper's gate, or an anchored, power-sized non-inferiority gate.
    Either needs a user-provided evaluator.
  - `evidence`: backed by overlay statistics.
  - `approval`: through the permission flow; by default, only for edges into tools with
    side effects.
- **Paper fidelity is a preset.** The `paper` preset disables the overlay. Dream is then
  Algorithm 1 exactly, over an evaluator. Deterministic trace tests with scripted models
  verify this; no benchmark or dataset is run. The harness preset changes what the
  research note found weak:
  - a per-trajectory context;
  - deduplicated rejections;
  - an enforced tool catalog;
  - an edit filter;
  - a query-keyed cache;
  - guidance delivered as a trailing advisory message.
- **Scope is configuration.** A `GraphId` is opaque. A resolver file maps a session's
  context (`sessionMeta`, `cwd`, principal) to a graph. A revision can have several
  parents, so graphs can be merged later. Access beyond the extension capability is an
  `authorize` policy, which is configuration too. Nothing in the package knows what a
  user, team, repository or project is.
- **Guidance at run time.** It happens through AI SDK `prepareStep`:
  - Localization comes from `messages`.
  - Each step reads one `(core revision, overlay version)` pair and records both.
  - Delivery is a trailing advisory message; the paper preset uses the system prompt.
  - The graph names tools but never grants them; a node whose tool the session lacks is
    inert.
- **Where things are recorded.**
  - The session log records steps (with digests).
  - The stores hold the core, the overlay, dreams and pins.
  - The hook bus carries notifications. Consumers never trust an event over the store.

  The session log is not write-ahead today, and nothing here requires it.
- **Core gains two generic things:**
  - opaque per-session metadata, from ACP `_meta.harness.session` to prompt commands;
  - a host publish API with a host-bound `source`.

## Consequences

- A new pure package joins the purity lint, coverage and mutation gates.
- Workers gain a per-step hook and a `report` callback. Opaque harness workers get
  turn-level guidance only.
- Deployments without scores still learn statistics and missing transitions. Their
  overlay entries stay on probation until dream decides.
- Deployments without an evaluator get a conservative dream. It absorbs what live
  evidence supports and prunes what it condemns, and everything else needs approval.
- A guidance call per step costs tokens. A cache keyed by the query and version pair,
  and cascade selection of the guidance model, mitigate this.

## What changed during implementation

The decision held; these details moved.

- **Dream is a reducer that prepares candidates itself.** There is no `prepare` command:
  preparation is pure, so only model calls, evaluation, approval and store writes are
  commands. A refiner answer that is not an edit set is a structural rejection kept in
  memory without a record.
- **Composition is a round of its own.** After its refine rounds, a dream with a composer
  (and `compose` in its settings) compiles the best-supported path into a workflow, stages
  it and binds it to a new node. The path's distinct-session support is that node's
  evidence, and it goes through the same gates as any candidate. By default approval is
  needed, because a workflow counts as a tool with side effects. No host gives dream a
  composer yet, and no worker takes `revisionTools` yet, so composition is a library.
- **Approval has no daemon path yet.** The permission flow belongs to a session's turn,
  and dream runs outside any session. The CLI asks on a terminal; `procedural.dream` in
  the daemon rejects candidates that need approval, and the rejection is recorded for a
  later dream or an operator.
- **One owner per store directory.** The snapshot store loads its file once and saves it
  whole, so two processes over one directory would lose each other's writes. A lock file
  in the directory names its holder; the daemon refuses to start on a held store, and
  `harness-procedural` either holds the lock for its run or, when a daemon holds it and
  listens on a socket, sends its operation to that daemon's `procedural.*`. We chose a
  lock over routing alone because a daemon on stdio has no socket to reach.
- **Dream runs on demand.** `procedural.dream` and `harness-procedural dream` start it;
  there is no schedule or trigger in the daemon.
- **Feedback re-observes a turn.** A score that arrives after a turn is an `observed`
  event with `rescore`, which moves the turn's score without a new traversal.
- **Reflection is a port.** The live learner takes a `Reflector`, which the native host
  builds on the ensemble's generator, so the harness preset can keep reflection off
  while a deployment turns it on with data.
- **Records are keyed by graph and content.** A revision's id is its document's hash, and
  the store keys its record by the graph too, so two graphs that hold the same document
  each keep their own record. Within a graph a rejection never replaces an older head's
  or an import's record with the same id, and a commit that loses the head race puts
  back the record it replaced. Redaction follows the content into every graph. A revert
  writes no record: its target is already recorded, and the heads show the move back.
- **Harness workers are guided per turn.** An opaque harness exposes no steps, so its
  guidance is prepended to each turn's prompt; AI SDK agents are guided per step.

## Revisit when

- Live evidence shows the overlay's probation rules are too slow or too loose. Then tune
  the data, not the code.
- A deployment needs per-caller access rules. Then pass the caller on model work.
- The task graph gains payloads. Then dream can emit plans from subgraphs.
- A write-ahead runtime lands. Then step records can become replayed effects.
- A maintained TypeScript implementation of the paper appears.
- The daemon gains approvals outside a session's turn. Then `procedural.dream` can ask
  for approval instead of rejecting.
