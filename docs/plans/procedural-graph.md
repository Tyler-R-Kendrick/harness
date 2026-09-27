# Plan: procedural graphs in the harness

Decision: ADR 0011. Evidence and critique: `docs/research/procedural-graphs.md`.
Status: not started. Every phase lands test-first, with atomic assertion ids, and passes
the full gates in `CLAUDE.md` (typecheck, lint, coverage, mutation) before it is pushed.

## 0. Goal and non-goals

**Goal.** Build procedural memory that the harness improves over time. It has three
parts:

1. A per-domain graph of procedures, with conditional advice on each transition.
2. Step-level guidance, read from the graph around the agent's current position.
3. A gated loop that rewrites the graph from scored trajectories, and that compiles
   well-trodden paths into durable workflows.

The system of record for all of it is the session log and the hook bus.

**Reproduction target.** A `paper` settings preset that reproduces the paper's
mechanism exactly, and a pre-registered replication of its construction-mode and
localization results on two public benchmarks (§6).

**Non-goals (for now).**

- Hard action constraints, except as an ablation.
- Cross-owner graph sharing.
- Automatic domain routing before explicit domains work.
- Replacing lessons, memory or the task graph.

## 1. Vocabulary

| Term | Meaning here |
|---|---|
| Domain | A named family of tasks that share one graph, e.g. `code-review`. A session names one or none. |
| Revision | An immutable graph, identified by the sha256 of its canonical JSON. |
| Head | The revision a domain's new sessions pin. It moves only through the gate. |
| Step | One solver decision: a tool call and its observation, or a final answer. |
| Active node | `Match(last action)`. Undefined when nothing matches. |
| Guidance | The text `g_t` a guidance model writes from the neighborhood, query and window. |
| Round | One pass of Algorithm 1: rollout, propose, prepare, validate, commit or reject. |

## 2. Data model (`@harness/procedural`)

### 2.1 Graph

```ts
// Zod schema -> branded ProceduralGraph (parse only; casting is a lint error)
{
  $schema?: string,
  format: "harness.procedural-graph/v1",
  domain: DomainName,                          // kebab-case, refined
  relations: readonly RelationName[],          // default: LEADS_TO, TRIGGERS, PROVIDES_INPUT_FOR, CONVERGES_TO
  nodes: readonly {
    id: NodeName,                              // ^[A-Za-z][A-Za-z0-9_.-]*$, unique; "Start" and "End" required
    type: "start" | "end" | "action" | "reasoning" | "status",
    description: string,
    binding?: { kind: "tool" | "workflow" | "skill", name: string },  // action nodes: what Match compares
  }[],
  edges: readonly {
    from: NodeName, relation: RelationName, to: NodeName,
    condition: string | null, guidance: string, pitfalls: string,
  }[],
}
```

Refinements, checked when the graph is parsed (as in `behavior/graph.ts`):

- Every node id is unique.
- Every edge's endpoints exist, and every relation is in the vocabulary.
- `Start` and `End` exist.
- Every node reaches a terminal (out-degree 0).
- The cycle policy holds.

The tool catalog is *not* part of the graph. It is checked against the graph by
`prepareCandidate`, and again at pin time (§4.3).

Refined types: `DomainName`, `NodeName`, `RelationName`, `RevisionId` (a `Sha256`),
`Hops` (a positive integer), `Score` (= `Probability`).

### 2.2 Edit set (the refiner's output, the paper's shape exactly)

```ts
{ add_nodes: {id, type, description, binding?}[], delete_nodes: NodeName[],
  add_edges: {source, target, relation, condition, guidance, pitfalls}[],
  delete_edges: {source, target}[] }            // removes every relation between the endpoints
```

The JSON Schema is generated from the zod schema and sent as the refiner's constraint.

### 2.3 Revision record

```ts
{ id: RevisionId, parent: RevisionId | null, domain, graph, edits: EditSet | null,
  origin: "seed" | "refiner" | "promotion" | "human",
  evidence: { round?, trainTrajectories: TrajectoryId[], validation?: GateEvidence },
  decision: { kind: "head" | "rejected-structure" | "rejected-gate" | "pending-approval", diagnostics?, by?, at } }
```

The revision store holds records in append-only order and one head per domain. It uses a
`SnapshotStorage` port first. When the file grows, an append-log port replaces it, as in
phase P0.

### 2.4 Settings (data, `packages/procedural/data/settings.json`)

```jsonc
{
  "$schema": "./settings.schema.json",
  "presets": {
    "paper": {
      "match": "exact", "fallback": "full-graph", "hops": 2, "hopUnit": "edge", "window": 3,
      "context": { "tail": "concatenated", "maxChars": 120000 },
      "gate": { "kind": "at-least-retained" },            // ties accepted
      "rejections": { "dedupe": false, "show": "all" },
      "cycles": "allowed", "enforceToolCatalog": false,
      "guidanceCache": false, "skipTrivialGuidance": false, "serializeRelations": false
    },
    "harness": {
      "match": "exact", "fallback": "full-graph", "hops": 2, "hopUnit": "edge", "window": 3,
      "context": { "tail": "per-trajectory", "maxChars": 120000, "balance": true },
      "gate": { "kind": "paired-noninferiority", "margin": 0.02, "confidence": 0.9, "minPairs": 30, "tieBreak": "smaller" },
      "rejections": { "dedupe": true, "show": "recent-and-similar", "limit": 8 },
      "cycles": "allowed", "enforceToolCatalog": true,
      "guidanceCache": true, "skipTrivialGuidance": true, "serializeRelations": false
    }
  },
  "rounds": 10, "batch": 20,
  "prompts": { "solverGuidanceSlot": "...", "guidance": "...", "refiner": "..." }   // App. B.5 verbatim
}
```

`maxChars` stands in for the paper's `L_max` tokens. Pure code has no tokenizer, and this
is the departure the reimplementation made too.

## 3. Components, and where each lives

| Component | Package | Pure? | Notes |
|---|---|---|---|
| Graph schema, parse, canonical form, JSON Schema | `procedural` | yes | pattern of `behavior/graph.ts`, `graphJsonSchema()` + drift test |
| Edit schema, `prepareCandidate` | `procedural` | yes | paper order: delete then add; diagnostics, not exceptions |
| `match`, `neighborhood`, `serialize` | `procedural` | yes | serializer reproduces App. B.5's text |
| `guide(...)` | `procedural` | yes (AI SDK) | `generateText` on a `LanguageModel` port; cache by `(revision, node, windowDigest)` |
| `refine(...)` | `procedural` | yes (AI SDK) | `generateText` + `constrain(editSetJsonSchema)` |
| Evolution reducer | `procedural` | yes | `(state, event) -> {state, commands}`, as in the daemon core |
| Gates | `procedural` | yes | `atLeastRetained`, `pairedNonInferiority` |
| Log → trajectory projection | `procedural` | yes | ACP updates → learning's `Trajectory` |
| Revision store + contract | `procedural` + `testkit` | port | `revisionStoreContract` like `storageContract` |
| Extension `procedural.*` | `procedural` | yes | ops: `graph`, `pin`, `guide`, `observe`, `evolve`, `history`, `approve` |
| Per-step hook | `workers` | portable | `sessionAgent({ procedural })` → `prepareStep` |
| Evolution runner | `procedural` + `workflows` | portable | the reducer driven by a durable workflow, so a round resumes |
| Rollout port (offline) | `evals` | host | runs a task set under a revision; datasets for §6 |
| Hosts | `platform-native`, `platform-browser` | host | load settings and graphs, and wire the extension (`--procedural <dir>`) |

Dependencies: `procedural → cognitive, learning` (for `Trajectory`), plus `@noble/hashes`.
Nothing in `core` depends on it.

## 4. Integration with the log, the bus, trajectories and workflows

### 4.1 Agent bus and log (what is written, and when)

| Moment | Log entry (session) | Bus event (`source: "procedural"`) |
|---|---|---|
| First turn of a session with a domain | `update` notice, `_meta.harness.procedural.pinned = {domain, revision}` | `procedural.session.pinned` |
| Each solver step (per-step workers) | notice, `_meta.harness.procedural.step = {revision, node, matched, hops, windowDigest, cached, guidance}` | none; too hot |
| Each tool call | `tool_call` with `_meta.harness.tool = <real name>`, so Match never reads a prose title | none |
| Session scored | none | `procedural.trajectory.scored {sessionId, revision, score or excluded}` |
| Round events | none | `procedural.round.started / proposed / prepared / validated`, `procedural.revision.committed / rejected / awaiting-approval`, all under one correlation id per round, so `HookBus.saga()` shows the round |

Today, plugins cannot publish to the bus (features §J). The extension publishes through
the daemon until plugin publishing exists. That is phase P6's dependency.

**Write-ahead, honestly.** `DaemonRuntime.#apply` dispatches worker commands and model
work *before* `#persist()` saves the snapshot. It also saves the whole snapshot on every
change. Per-step guidance entries make both problems worse: more entries, and larger
snapshots. Phase P0 fixes this before per-step records are turned on:

- An append-only log port (`appendLog`), with group commit.
- Persistence before dispatch, for outputs with external effects.
- Snapshots taken as periodic checkpoints.

Until P0 lands, per-step records are sampled or summarized per turn, as a setting.

### 4.2 Trajectory evolution

- `project(entries) -> Trajectory` maps a session's log to learning's `Trajectory`. It
  maps `user_message`/prompt, `tool_call(name, rawInput)`,
  `tool_call_update(rawOutput)` and agent text into steps. It also carries the pinned
  revision.
- Scores:

  | Source | Score |
  |---|---|
  | Eval metric (EM, F1, rubric) | the metric's value in [0,1] |
  | Judge verdict `passed` | 1 |
  | Judge verdict `failed` | 0 |
  | Judge verdict `inconclusive` or `blocked` | excluded |
  | Learning `outcome` `success` or `failure` | 1 or 0 |
  | Learning `outcome` `unknown` | excluded |

- Per-revision evidence is aggregated from the log. It is shown to the refiner beside
  the traces, and in `procedural.history`. It includes:
  - match rate;
  - fallback rate;
  - per-edge traversals and the mean score after each edge;
  - steps and tokens.
- Splits are made by a deterministic hash of the session or task id, into train,
  validation and held-out test. The loop never sees test. We report the *returned*
  graph, never the best round, which follows the paper's §5.4 caution.

### 4.3 Guidance at run time

`sessionAgent({ procedural: { domain, guide } })` sets a `prepareStep` that does the
following:

1. Pin the head at the session's first step, if it is not pinned yet. Check the pinned
   revision's action bindings against this session's tools. A node whose tool is absent
   is inert, and its rate is reported.
2. Set `u_t = match(steps.at(-1)?.toolCalls.at(-1)?.toolName ?? "Start")`.
3. Set `G_t = neighborhood(u_t, hops)`, or the full graph if `u_t` is undefined.
4. Produce the guidance:
   - With `skipTrivialGuidance`, when `G_t` has one outgoing unconditional edge, render
     it without a model.
   - Otherwise, when a cached result exists, use the cache.
   - Otherwise, call `guide(G_t, q, window w)`.
5. Return `{ instructions: initialInstructions + slot(g_t) }`. Always build from
   `initialInstructions`: an override carries forward to later steps, so building from
   the current instructions stacks guidance.
6. Emit the step record (§4.1).

Opaque harness workers have no `prepareStep`. They get turn-level guidance, localized
from the last `tool_call` of the previous turn, and put into the prompt.

### 4.4 Dynamic workflow composition

1. **Nodes bind to workflows.** A library workflow is an action node with
   `binding.kind = "workflow"`. Match compares the tool name that `workflowTools`
   exposes.
2. **Promotion (path → workflow).** A path `n1 → … → nk` of action nodes is a candidate
   when all of these hold:
   - every interior node has out-degree 1 and an unconditional edge;
   - the path was traversed in at least `support` scored trajectories under the head;
   - its mean score is at least `minScore`;
   - it is not already bound.

   For a candidate, the pipeline is:
   1. The traversals become a `procedure` lesson, whose steps are the recorded calls.
   2. The workflow builder (`compileProcedure`) writes a durable workflow and puts it in
      the library.
   3. A candidate revision adds a node bound to it, with edges `pred → W → succ`, and
      keeps the old path. The refiner or the gate can prune the old path later.
   4. The candidate goes through the same gate. Promotion never bypasses validation.
3. **Plans from subgraphs (later).** Once the task graph has payloads and serialization,
   a subgraph can be instantiated as a `TaskGraph`: action nodes become tasks, and
   `PROVIDES_INPUT_FOR` becomes a data edge. This fills features §D, "compiler (known
   workflows) and planner (novel parts)". It is out of scope until then.

### 4.5 Relation to lessons and memory

- The refiner prompt gets the domain's `pitfall` and `procedure` lessons, as prior
  evidence. It is free to encode them as edge attributes.
- Lessons stay the ExpeL-style baseline in §6.
- The graph never writes lessons. That keeps the comparison clean.

## 5. Phases

Each phase is shippable, with its row in `docs/features.md` updated in the same change.
The assertion-id prefixes are `PG`, plus `PX` for the extension and `PW` for the worker.

| Phase | Deliverable | Tests (ids) | Depends on |
|---|---|---|---|
| P1 | Package skeleton; graph schema, refinements, canonical JSON, `RevisionId`; settings schema + data + drift test | PG1.x units; PG1.P properties (canonical form invariant under array permutation; parse ∘ serialize = id) | none |
| P2 | Edit schema; `prepareCandidate` (delete before add, diagnostics, cycle policy, reachability, tool catalog) | PG2.x; PG2.P (applying to a copy never mutates the parent; accepted ⇒ parses; rejected ⇒ diagnostics non-empty; delete_edges removes every relation) | P1 |
| P3 | `match`, `neighborhood` (edge and ACTION hop units), `serialize` (the paper's text, golden file) | PG3.x; golden test of App. B.5's HotpotQA excerpt | P1 |
| P4 | `guide` and `refine` on AI SDK with `ai/test` mocks; the refiner under a JSON Schema constraint; cache; trivial skip | PG4.x (scripted models; constraint sent; cache hit on the same key; never regenerates a cached step) | P2, P3 |
| P5 | Evolution reducer; `atLeastRetained` and `pairedNonInferiority` gates; rejection memory (dedupe by candidate id) | PG5.x; PG5.M model-based test: the retained score never drops (paper gate), a rejected candidate never becomes head, an invalid candidate is never validated, a duplicate is never re-validated | P2 |
| P6 | Revision store + `revisionStoreContract`; extension `procedural.*`; bus events and sagas | PX1.x; contract on the memory and file stores | P5 |
| P0 | Runtime write-ahead: append-log port, persist-before-dispatch for external effects, checkpoints | RT/SL additions; fault-injection property (crash between append and dispatch) | none; can run in parallel with P1 to P6; required before P7 enables per-step records by default |
| P7 | Worker `prepareStep` integration; pinning; step records; `_meta.harness.tool` on tool calls; turn-level mode for harness workers | PW1.x (AI SDK harness test: guidance at each step, from `initialInstructions`, pinned revision never changes mid-session) | P4, P6 |
| P8 | Log → trajectory projection; scoring; splits; per-revision evidence | PG6.x; property: projection is total on any log the daemon writes | P6 |
| P9 | Evolution runner as a durable workflow (a round resumes after a crash); offline rollout port in evals | PG7.x; WF-style resume test | P5, P8 |
| P10 | Promotion (path → workflow) through the gate | PG8.x (a candidate path is detected; the workflow is built; the revision is gated) | P9 |
| P11 | Reproduction suites and runs (§6) | evals `procedural` suite | P9 |
| P12 | Online canary (off by default): the head vs a candidate, a capped share, optional approver | PG9.x | P9, product decision (§8) |
| P13 | Domain routing by router confidence, with a "no graph" arm | PG10.x | P12 |

Mutation testing: add `packages/procedural/src/**` to `stryker.config.mjs`'s `mutate`.

## 6. Reproduction protocol (pre-registered)

We pre-register the claims, metrics and budgets here, before any run, so the results
cannot choose the question.

**Benchmarks.** Both appear in the paper's construction-mode study (Table 2) and its
evolution curves (App. E.4). Both run inside our TypeScript evals without a Python
environment.

- **HotpotQA (distractor setting).** Retrieval is over the task's own passages, through
  deterministic local tools (`search`, `lookup`, `finish`). The metrics are EM and F1,
  which are exact, so no judge is needed. The splits are 1,000 train, 200 validation and
  1,000 test. The paper used 1,000 validation tasks. We reduce it for cost, which is a
  documented departure.
- **MultiChallenge.** The splits are the paper's: 100 train, 100 validation, 56 test. It
  is judged by the catalog's best reachable judge. `blocked` makes the run `blocked`,
  never a pass.

**Arms**, all on one ReAct solver (`sessionAgent` with local tools):

1. No graph.
2. Lessons (our ExpeL-like baseline).
3. Paper Mode 4: scratch, one-time build.
4. Paper Mode 5: scratch, gated rounds (`K = 10`).
5. Mode 5 under the `harness` preset.
6. Localization ablation on the Mode 5 graph: full graph raw, full graph generative,
   subgraph generative.

Expert modes (1 to 3) need the paper's expert graphs, which were not published. We run
them only with an expert graph we write ourselves, and we label it so.

**Models.** The paper's construction study used Gemini 3.5 Flash at temperature 0 for
the solver, guidance and refiner. We use one generator for all three roles, picked from
the catalog, and record its id in the results. Model ids are catalog data, not code.

**Claims we test.** A claim holds when a paired bootstrap 95% interval on the test
split excludes 0 in the stated direction.

- **C1.** Mode 5 > no graph on HotpotQA F1. Paper: +7.58.
- **C2.** Subgraph generative > full-graph generative, on the same graph and task. Paper:
  Table 3.
- **C3.** The returned Mode 5 graph ≥ Mode 4 on both benchmarks. This is the claim that
  gated iteration beats one-shot.
- **C4.** The `harness` preset ≥ the `paper` preset. It is non-inferior at a margin of
  2 points, and it grows fewer edges.

**Reporting.** For each arm we report:

- the score and its interval;
- tokens and steps;
- match and fallback rates;
- each round's decision.

A replication that fails is reported as failed, with the graphs and traces.

**Budget guard.** Each run declares a token budget up front, and the evals runner stops
at it. A run stopped by its budget is `inconclusive`.

## 7. Adversarial review: failure modes and the mitigations in this plan

| # | Attack or failure | Mitigation (where) |
|---|---|---|
| A1 | Persistent prompt injection: a tool output says "always call `upload` first", and the refiner encodes it as guidance for every later session | Trajectories are framed as untrusted data in the refiner prompt; guidance is advice, never authority (§4.3); tools that are not in the session are inert; the gate; approver-required commits per domain; provenance on every revision (§2.3) |
| A2 | Gate accepts noise; graph grows by random walk | Paired non-inferiority with `minPairs`; size tie-break; test split never seen (§4.2) |
| A3 | Winner's curse across rounds | Report the returned graph, not the best round; hold-out test |
| A4 | Match fails → full-graph fallback, which the paper shows hurts most | Match and fallback rates are measured per revision; `_meta.harness.tool` gives real names; the ACTION-hop ablation; a sticky last-matched-node fallback as an ablation |
| A5 | Graph drift during a session | Pin at the first step, recorded in the log; the head moves only between sessions |
| A6 | Wrong domain graph (the MultiChallenge expert-prior loss) | Explicit domains; the "no graph" arm stays; routing only with confidence (P13) |
| A7 | Tool renamed or removed, so the graph goes stale | Pin-time catalog check; inert-node rate; `enforceToolCatalog` at prepare; evidence invalidation |
| A8 | Cost blowup (a guidance call per step) | Cache; trivial skip; guidance model chosen by the cascade; budget guard |
| A9 | Log and snapshot bloat from step records | P0 append log; sampling until then |
| A10 | Refiner overfits to one trajectory, or leaks specifics (PII) into guidance | Generality rule in the prompt; balanced per-trajectory context; per-owner graphs, never shared by default |
| A11 | Scores from a weak judge | `inconclusive` and `blocked` are excluded; the judge is the catalog's best reachable one; calibration suite |
| A12 | Rejection memory grows without bound, and duplicates are re-validated | Dedupe by candidate revision id; show recent and similar only |
| A13 | The loop crashes mid-round, and a candidate is half-committed | The round is a durable workflow; commit is one store append; the reducer is idempotent on replay |
| A14 | Concurrent rounds for one domain | One round per domain: the runner holds a lease with an epoch, using the input-lease or capability-lease pattern, and a stale epoch cannot commit |
| A15 | Promotion hides a failing branch inside a workflow | The old path is kept until the gate prunes it; the workflow is a durable run whose journal is itself a trajectory |

## 8. Open decisions (the owner's call; defaults in bold)

1. Online canary in production: **off**, with a 10% cap when turned on.
2. Approver-required commits: **required for domains with online evolution**, optional
   for offline-only domains.
3. Graph scope: **per owner**. Team sharing waits for features §B team sharing.
4. The reproduction model and budget: which generator the evals may reach (a gateway
   key), and the token budget per run.
