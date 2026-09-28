# Plan: procedural graphs in the harness

Decision: ADR 0011. Evidence and critique: `docs/research/procedural-graphs.md`.
Status: done 2026-09-27 (P1–P13 and the cross-phase wiring; the API as built is in
`docs/plans/procedural-graph-api.md`). Every phase lands test-first, with atomic assertion ids, and passes
the full gates in `CLAUDE.md` (typecheck, lint, coverage, mutation) before it is pushed.

Revision 3 (2026-09-27). We are building the framework, not running ingestion or
benchmarks. The graph has two parts:

- a **static core**, which changes only through a separate **dream** process;
- a **dynamic layer**, which evolves from live traffic.

How graphs are scoped (per user, team, repository, project, or shared) is configuration,
not architecture. §12 lists what changed from revisions 1 and 2.

## 0. Goal and scope

**Goal.** Build a framework in which agents are guided by a procedural graph that
improves over time, without retraining:

- **Guidance.** At each step, the agent is located on the graph. A guidance model turns
  the surrounding transitions into advice for the next step. This is the paper's online
  inference.
- **The dynamic layer.** It learns continuously from live sessions, through the session
  log and the hook bus. It gathers evidence, notices transitions the graph lacks, and
  holds provisional amendments. It never removes or rewrites the core.
- **Dream.** A separate, out-of-band process consolidates the dynamic layer and the
  recorded trajectories into a new core revision. It adds, prunes and rewrites
  structure, and compiles well-trodden paths into durable workflows. Every change goes
  through a gate. This is the paper's self-evolution loop, generalized.

**In scope:**

- the pure mechanisms, their ports, and their stores;
- integration with the session log, the hook bus, the workers and the workflow library;
- faithful, test-verified reproduction of the paper's mechanism as a settings preset.

**Out of scope:**

- running benchmarks or ingestion;
- choosing a scoping policy for users;
- hard action constraints (an ablation hook at most: `delivery.activeTools: "successors"`, §5.2);
- replacing lessons, memory or the task graph;
- a write-ahead runtime, which is a separate decision (§6.5).

## 1. Vocabulary

| Term | Meaning |
|---|---|
| Graph | One procedural graph: a core plus its dynamic layer. It is addressed by an opaque `GraphId`. |
| Resolver | Configuration that maps a session's context to a `GraphId`, or to none. |
| Core | The static part: a revisioned graph that changes only by a dream commit, or by seeding or reverting. |
| Revision | An immutable core, identified by the sha256 of its canonical versioned JSON. |
| Head | The core revision that new sessions of a graph use. |
| Dynamic layer | The overlay: an append-only log of evidence and amendment events, folded into overlay state. |
| Overlay version | The event-log offset the overlay state was folded to. |
| Effective graph | `core ⊕ overlay`: what guidance reads. It always contains the whole core. |
| Probation | The status of a new overlay amendment: shown to a random share of sessions while evidence accrues. |
| Dream | The consolidation process. It takes the core, the overlay and trajectories, and produces a gated core revision, then rebases the overlay. |
| Evaluator | An optional port that scores a graph on a replayable task set, which a user may provide. With one, dream can run the paper's validation gate. |
| Step | One solver decision: a tool call and its observation, or a final answer. |
| Active node | The node `Match` returns for the last action. Undefined when nothing matches. |

## 2. Architecture

```
 live path (per step)                                  dynamic layer (continuous)
 ────────────────────                                  ──────────────────────────
 session ──resolve──► GraphId ──pin──► (core rev, overlay ver)
    │                                        │
    ▼                                        ▼
 prepareStep: Match → neighborhood of the EFFECTIVE graph → guide → advisory message
    │
    ▼
 session log ◄── step records, tool calls, outcomes
    │  (hook bus: turn.ended, …)
    ▼
 live learner (bus actor, per-plugin cursor) ──► overlay event log ──fold──► overlay state
                                                         │
 dream (separate process, scheduled or on demand)        │
 ─────────────────────────────────────────────────       │
 core head + overlay snapshot + trajectories + rejections ◄
    │
    ▼
 propose (refiner) → prepare (structure, filter) → gate (evaluator / evidence / approval)
    │ accept                                  │ reject
    ▼                                         ▼
 new core revision (+ compiled workflows)   rejection memory
    │
    ▼
 rebase the overlay onto the new core (absorbed entries retire, orphans drop, the rest carry over)
```

## 3. Invariants (the static/dynamic contract)

Each invariant is a property test.

- **I1 Core changes only through dream.** A core revision's origin is `seed`, `dream`,
  `merge` or `revert`. Live traffic never writes the core.
- **I2 The overlay is monotone over the core.** The effective graph contains every core
  node and edge with its core attributes. The overlay can add nodes and edges, append
  notes to edges, and flag edges with a caution. It cannot delete or rewrite core
  structure. Pruning happens only in dream.
- **I3 A step reads one version pair.** Guidance for a step comes from exactly one
  `(core revision, overlay version)`, and the step record names both.
- **I4 The fold is deterministic and idempotent.** Folding the overlay's events gives the
  same state for the same events, and a redelivered event, as the hook bus is
  at-least-once, changes nothing.
- **I5 Only dream changes the tools a graph can bind.** Overlay entries never carry a
  `binding`. Workflow compilation and tool bindings are dream outputs, so they are gated.
- **I6 Overlay entries are anchored.** Every overlay entry references core or overlay
  nodes that exist. After a dream commit, entries whose anchors disappeared are dropped,
  and each drop is recorded.
- **I7 No scope assumptions.** Nothing in the package knows what a user, team,
  repository or project is. `GraphId` is opaque, and resolution is configuration.

## 4. Data model (`@harness/procedural`, pure)

### 4.1 Graph (the core)

```ts
// A zod schema, parsed into the branded ProceduralGraph. Casting to it is a lint error.
{
  $schema?: string,                            // never part of the revision id
  format: "harness.procedural-graph/v1",       // hashed, so a format migration changes ids
  nodeTypes: readonly NodeTypeName[],          // vocabulary; default ["ACTION","REASONING","STATUS"]
  relations: readonly RelationName[],          // default LEADS_TO, TRIGGERS, PROVIDES_INPUT_FOR, CONVERGES_TO
  nodes: readonly { id: NodeName, type: NodeTypeName, description: string, binding?: Binding }[],
  edges: readonly { from, relation, to, condition: string | null, guidance: string, pitfalls: string }[],
}
Binding = { kind: "tool", name } | { kind: "workflow", name, code: Sha256 } | { kind: "skill", name, content: Sha256 }
```

**Refinements** (the pattern of `behavior/graph.ts`), all following the paper's App. B.6:

- Ids are unique.
- Types and relations are in their vocabularies.
- Endpoints exist.
- `Start` exists.
- Every node reaches *some* terminal (out-degree 0).
- The cycle policy holds.

`CandidateDocument` is the same shape without the refinements, so that a candidate that
fails its checks can be stored with its diagnostics.

**Refined types:**

- `GraphId`: opaque, `^[a-z0-9][a-z0-9._/-]*$`, so it can hold `team/web` or
  `repo/harness` if a user chooses;
- `NodeName`, `NodeTypeName`, `RelationName`;
- `RevisionId`, `OverlayVersion`, `TrajectoryId`;
- `Score` (= `Probability`).

### 4.2 Edit set (the paper's refiner output, exactly)

```ts
{ add_nodes: {id, type, description}[], delete_nodes: NodeName[],
  add_edges: {source, target, relation, condition, guidance, pitfalls}[],
  delete_edges: {source, target}[] }            // removes every relation between the endpoints
```

The refiner's JSON Schema constraint is generated from this zod schema. Neither the
refiner nor the overlay can set `binding`; dream's composition step (§7.6) is the only
writer.

### 4.3 Core revision record

```ts
{ id: RevisionId, graph: GraphId, parents: RevisionId[],   // two parents = a merge (§8.2)
  document, edits: EditSet | null,
  origin: "seed" | "dream" | "merge" | "revert",
  dream?: DreamId, evidence, decision, at }                 // `at` from the Clock port
```

Rejected candidates are kept as records with a `rejected-structure` or `rejected-gate`
decision. They form the rejection memory.

### 4.4 Overlay (the dynamic layer)

The overlay is event-sourced: its state is a pure fold over an append-only event log.

```ts
OverlayEvent =
  | { kind: "observed", session, turn, path: NodeName[], unmatched: string[], score: Score | null, exposure: EntryId[] }
  | { kind: "proposed", entry: OverlayEntry, source: { sessions: string[], by: "stats" | "reflection" } }
  | { kind: "status", entry: EntryId, to: "active" | "retired", reason }
  | { kind: "rebased", core: RevisionId, absorbed: EntryId[], dropped: EntryId[] }

OverlayEntry =
  | { kind: "edge", from, relation, to, condition, guidance, pitfalls }  // a transition the core lacks
  | { kind: "node", id, type, description }                              // needed by an edge entry
  | { kind: "note", on: {from, to}, text }                               // appended advice on a core or overlay edge
  | { kind: "caution", on: {from, to}, text }                            // "this edge preceded failures"; shown, never deleted

OverlayState = {
  base: RevisionId, version: OverlayVersion,
  entries: Map<EntryId, { entry, status: "probation" | "active" | "retired", evidence }>,
  stats: per-edge { traversals, scored, meanScore, lastSeen },           // core and overlay edges
  transitions: per (u, v) not in the graph { support: distinct sessions, meanScore }
}
```

Every entry has an `EntryId`: a hash of its canonical content alone. So the same
proposal from two sessions is one entry with more support, and I4 holds. The id does not
include the base revision, so an entry keeps its id and its evidence across rebases. A
rebase re-checks only its anchors.

### 4.5 Scored trajectory

```ts
{ id: TrajectoryId, graph: GraphId, core: RevisionId, overlay: OverlayVersion,
  session, turn, query, steps: learning.Step[], score: Score | null,
  scoreSource: "metric" | "judge-probability" | "judge-verdict" | "outcome" | "feedback" | null,
  localization: { matched, fallback, inert }, usage }
```

Learning's `Trajectory` has no score and no revision, so this type wraps its steps.

**Scores:**

- A judge's probability is used as the score, not its verdict. This keeps the uncertain
  band from being dropped non-randomly.
- A missing score is `null`. It still counts as traversal evidence.

### 4.6 Settings (data, with a generated schema and a drift test)

```jsonc
{
  "$schema": "./settings.schema.json",
  "presets": {
    "paper": {                     // the paper's mechanism exactly; dream needs an evaluator
      "overlay": false, "match": "exact", "turnBoundary": "start", "delivery": "system",
      "guidancePrompt": "paper", "guidanceCache": false,
      "dream": { "context": "tail-concatenated", "gate": ["evaluator-at-least-retained"],
                 "rejections": { "dedupe": false, "show": "all" }, "enforceToolCatalog": false, "editFilter": false }
    },
    "harness": {
      "overlay": true, "match": "exact", "turnBoundary": "carry", "delivery": "trailing-message",
      "guidancePrompt": "harness", "guidanceCache": true,
      "live": { "reflection": "off", "probationShare": 0.2, "minSupport": 3, "promote": { "confidence": 0.9 },
                "halfLifeDays": 30, "maxEntries": 64 },
      "dream": { "context": "tail-per-trajectory", "gate": ["structure", "evidence", "evaluator-anchored-noninferiority?", "approval-for-side-effects"],
                 "rejections": { "dedupe": true, "show": "recent-and-similar", "limit": 8 },
                 "enforceToolCatalog": true, "editFilter": true }
    }
  },
  "decoding": { "temperature": 0, "topK": 1, "solverMaxTokens": 2048, "refinerMaxTokens": 8192 },
  "prompts": { "guidance": "...", "guidanceHarness": "...", "refiner": "...", "dream": "...", "reflection": "..." }
}
```

The paper's prompts (App. B.5) are stored verbatim. Hops (`h = 2`), window (`w = 3`) and
the full-graph fallback are constants, taken from the paper, until an ablation is
scheduled. What a hop counts is a setting: `hopUnit: "edge"` (the paper, both presets) or
`"action"`, where a hop runs through reasoning and status nodes to the next action node,
so that nodes which are never active cannot hide the next tool. A `?` on a gate means it
applies only when the graph has an evaluator.

## 5. The live path

### 5.1 Resolving and pinning

- The session's context is what the resolver sees:
  - `cwd`;
  - the owner principal, which the daemon already records;
  - an opaque `_meta.harness.session` record from `session/new`, which the daemon stores
    and passes on each prompt as `sessionMeta`. Core never interprets it.
- The **resolver** is configuration (§8). It maps this context to a `GraphId`, or to no
  graph.
- When a session first resolves, it **pins** the graph's head core revision, and the pin
  survives restarts. A pinned revision that is later reverted is re-pinned at the next
  turn boundary.
- It also pins an **overlay version**:
  - `overlayRefresh: "turn"` (the default) re-reads the overlay at each turn boundary.
  - `"session"` freezes it for the session.

  In both cases a step reads one version pair (I3).
- **When a dream moves the head mid-session.** The overlay is rebased onto the new core,
  so its new versions may anchor on nodes the session's pinned core lacks.
  - `repinOnDream: "turn"` (the default) re-pins to the new head, and its rebased
    overlay, at the next turn boundary.
  - `"never"` keeps the old core, with the overlay frozen at its last version on that
    base. That frozen version is recorded by the `rebased` event.
  - A session never pairs a core with an overlay built on a different core.
- Tool check: the pinned core's action nodes are checked against the session's tools.
  Absent tools make their nodes inert, and the inert rate is recorded.

### 5.2 Localization and guidance

`prepareStep` in `sessionAgent` does the following on each step:

1. **Localize from `messages`.** `prepareStep`'s `steps` covers only one `agent.stream`
   call, which `AgentWorker` restarts on every turn and after every approval round.
   - The last action is the last `tool-call` part of the last assistant message. With
     parallel calls, it is the last in emission order, and the others are recorded.
   - `turnBoundary: "start"` (paper) resets to `Start` at each turn.
   - `"carry"` keeps the previous turn's last action.
2. **Match.** It resolves `u_t` against the **effective graph**. `exact` is the paper's
   written definition. `case-insensitive` is an option, because the paper's own excerpt
   pairs `First_Hop_Retrieve` with `first_hop_retrieve`. `state-tracker` also reads the
   node the last call's result declared and bindings' argument predicates (below).
3. **Build `G_t`:** the `h`-hop neighborhood, or the full effective graph when nothing
   matches.
4. **Serialize.** The paper's text format (App. B.5), with overlay content labeled. An
   overlay edge or note is prefixed "Learned (provisional)" while on probation, or
   "Learned" once active. A caution is prefixed "Caution". The paper preset has no
   overlay, so its text is exactly the paper's.
5. **Guidance.**
   - `guide(G_t, q, window)` calls `generateText`. The guidance model is the session's
     own by default; the cascade may choose one instead.
   - Harness preset: a per-session cache keyed by
     `(core, overlay version, u_t, digest(q), digest(window), model)`, with the hit rate
     recorded.
6. **Delivery.**
   - `system` (paper): the instructions are rebuilt from `initialInstructions` plus the
     guidance slot. An override carries forward, so guidance would otherwise stack.
   - `trailing-message` (harness): one advisory user-role message, tagged under
     `providerOptions.harness`, replacing the previous tagged message. This keeps the
     system prompt stable for prefix caching, and keeps text derived from tool output out
     of system authority.
   - `activeTools: "successors"` is the hard-constraint ablation (off in both presets):
     a step offers only the tools of the active node's successor actions, through AI SDK
     `activeTools`, and every tool when nothing matches or no successor's tool is offered.
7. **Record.** `TurnOptions.report(update)` is `AgentWorker`'s own `update`, passed
   through `runtimeContext`.
   - The step record is a notice with
     `_meta.harness.procedural.step = {graph, core, overlay, node, matched, others, cached, guidanceId, digest, exposure, usage}`.
   - `exposure` lists the probationary entries this step showed (§6.3).
   - The guidance text is stored beside the overlay, keyed by `guidanceId`. The log holds
     only a digest, so it does not grow much.

**Opaque harness workers** (`harnessSessions`) have no `prepareStep`. They get
turn-level guidance, prepended to the prompt in `harnessSessions.stream` and localized
from the previous turn's last `tool_call`. Their coarse tool names (Bash, Read, Edit)
localize poorly with exact `Match`. The `state-tracker` match mode addresses this (built,
off in both presets): a tool's result, or an environment wrapping tools, may declare the
active node under `_meta.harness.procedural.node`, and a tool binding may carry an argument
predicate (a JSON Schema over the call's arguments), so `Bash` running `npm test` can be
`Run_Tests`. Match takes the declared node first, then the binding, then the id.

## 6. The dynamic layer: learning from live traffic

### 6.1 Where evidence comes from

The **live learner** is a hook-bus actor with its own cursor, the harness's plugin model.

1. On `turn.ended`, it reads that turn's entries from the session log. It starts
   in-process, on the host, which can read logs directly. An out-of-process learner would
   need an observe grant.
2. It projects those entries into a scored trajectory (§4.5), keyed by the version pair
   in the step records.
3. It appends one `observed` event.

Scores arrive from whichever sources a deployment has:

- a judge run on the turn;
- a learning `outcome`;
- explicit user feedback (`procedural.feedback`);
- none, in which case the score is `null`.

Redelivered bus events fold to the same state (I4).

### 6.2 What the overlay learns (cheapest first)

1. **Statistics.** Per edge: traversals, scored traversals, mean score, last seen. The
   fold computes them with no model.
2. **Missing transitions.** The trajectory went from matched `u` to matched `v`, and the
   effective graph has no `u → v`. The learner records it with its distinct-session
   support.
   - At `minSupport` distinct sessions, it `proposed` an overlay `edge`, on probation.
     The edge's text is templated from the evidence ("observed after `u` in N sessions,
     mean score s"), not generated.
3. **Cautions.** An edge whose scored traversals fall well below the graph's mean, with
   enough support, gets a `caution` on probation. The core edge stays (I2).
4. **Reflection (optional; off in the harness preset).** After a scored turn, or a batch
   of turns, a small refiner call proposes overlay entries, `note`s and `edge`s, under a
   JSON Schema constraint. Every entry passes the edit filter (§9) before it is
   `proposed`. This is the only live path that writes model-generated text.

### 6.3 Probation, exposure and promotion

Online, nothing can be re-run, so the overlay gates itself by randomized exposure:

- **Exposure.** Each probationary entry is shown to a random `probationShare` of
  sessions. The draw uses the `Entropy` port, per session and entry, and is recorded in
  `exposure`. That is a randomized comparison, not an observational one.
- **Promotion.** An entry becomes `active` when the scored outcomes of exposed sessions
  are non-inferior to those of unexposed sessions. The test is a Beta-binomial or
  bootstrap comparison at `promote.confidence`.
- **Retirement.** An entry is `retired` when those outcomes are inferior, when it goes
  stale (`halfLifeDays` decay of support), or when it is displaced under `maxEntries`.
- **Unscored entries.** An entry without enough scored exposure stays on probation until
  dream reviews it.

Active entries are shown to every session, labeled as learned. A deployment with no
scores still gains statistics and missing transitions. Its entries stay on probation,
and dream decides.

### 6.4 What the overlay can never do

It cannot do any of these:

- delete or rewrite core structure (I2);
- bind tools or workflows (I5);
- change which tools a session has;
- raise an entry's status without evidence.

A poisoned overlay can therefore add provisional advice, bounded and labeled, but it
cannot remove a core step or reach a tool the session lacks.

### 6.5 The log, honestly

The session log is where evidence comes from. It is not write-ahead today:
`DaemonRuntime.#apply` dispatches before `#persist()`, and it saves whole snapshots. The
live learner needs only what the log records, so nothing here depends on write-ahead.
Step records carry digests, not text, so the log stays small. A write-ahead runtime is
a separate ADR.

## 7. Dream: consolidating the core

### 7.1 What dream is

Dream is a separate process that runs out of band, away from the request path:

- it is started by a schedule, a trigger, the CLI (`harness-procedural dream <graph>`),
  or the `procedural.dream` operation;
- it holds a lease per `GraphId`, so only one dream runs per graph, under an epoch;
- it is implemented as the pure reducer (§7.3) over an append-only dream event log, so
  it resumes by replay after a crash;
- it is not a code-mode workflow, because a workflow's timeout is terminal and its
  journal is rewritten whole.

### 7.2 Inputs

- The core head.
- An overlay snapshot at version `V`, with its entries and statistics.
- Trajectories under the head, selected from the log's projections: high- and
  low-scoring, balanced, each with its own tail. In the paper preset, the tail of the
  concatenation.
- The rejection memory.
- The graph's evaluator, if one is configured.

### 7.3 The dream round (Algorithm 1, generalized)

1. **Select** a batch of trajectories. In the paper preset, the batch is a stride of the
   evaluator's training tasks, *rolled out* under the head (App. B.6 line 6).
2. **Propose.** The refiner answers under the edit-set JSON Schema constraint, using the
   paper's refiner prompt plus a consolidation section. The consolidation section lists:
   - overlay entries, with their status and evidence (candidates to absorb);
   - core edges with cautions or poor statistics (candidates to prune);
   - rejections.
3. **Prepare.** Apply the edits to a copy, deletions first. Then run the structural checks
   of App. B.6, the tool catalog check and the edit filter. On failure, the candidate goes
   to the rejection memory, with no evaluation.
4. **Gate.** The candidate must pass every gate configured for the graph (§7.4).
5. **Commit or reject.**
   - A commit appends the new core revision and moves the head, as one store append.
   - A rejection appends a record to the rejection memory.
6. **Rebase the overlay onto the new head.**
   - Entries the edits absorbed are `retired` with reason `absorbed`.
   - Entries whose anchors disappeared are dropped (I6).
   - The rest carry over, with their evidence.
   - Overlay events after `V` are folded onto the new base (optimistic concurrency).

   A dream never blocks live learning.
7. **Repeat** up to `rounds` times. Each round starts from the retained head, never from a
   rejected candidate (the paper).

**Modes (App. D.2).** Both are dream settings:

- `onetime`: a single ungated round over everything.
- `incremental`: strides with the gate.

### 7.4 Gates (composable; each is a pure function of evidence)

| Gate | Needs | Accepts when |
|---|---|---|
| `structure` | nothing | the candidate parses and passes the filter and catalog checks (always on) |
| `evaluator-at-least-retained` (paper) | an evaluator | the mean validation score is at least the retained head's cached score; ties are accepted |
| `evaluator-anchored-noninferiority` | an evaluator | paired per-task scores show the candidate is superior, or non-inferior *and* smaller in (nodes + edges, attribute characters); non-inferior to `G_0` within `totalLoss`; δ is sized by power, so equal candidates pass with probability at least 0.8, and when δ exceeds `totalLoss` only superiority is accepted |
| `evidence` | overlay statistics | every *removed* core edge has a caution or poor statistics with at least `minSupport` distinct sessions; every *added* structure corresponds to an active overlay entry or to a transition with at least `minSupport` support |
| `approval` | an approver | an approver accepts through the daemon's permission flow (MX3), bound to the candidate id; by default only edits that route into tools with side effects need it |

- **With an evaluator,** dream is the paper's Algorithm 1, and can also gate on it.
- **Without one** (the common case in production), dream is conservative:
  - It can absorb what live evidence supports.
  - It can prune what live evidence condemns.
  - It can rewrite attributes, which the `evidence` gate allows when the text is shorter,
    or when the edge has an active `note` that the new text absorbs.
  - Everything else needs `approval`.

### 7.5 Rejection memory

- The paper preset keeps every rejected candidate and shows all of them to the refiner.
- The harness preset keys candidates by revision id, never re-evaluates a known
  rejection, and shows the refiner the recent and similar ones.

### 7.6 Dynamic workflow composition (a dream output)

- **Candidates.** A path `n1 → … → nk` of action nodes is a candidate when all of these
  hold:
  - every interior node has out-degree 1 and an unconditional edge;
  - the path has at least `support` distinct-session traversals;
  - its mean score is at least `minScore`.
- **`compilePath(path, recordedCalls, toolSpecs)`.** This is a new compiler.
  `compileProcedure` routes step text through a model and emits constant arguments, which
  loses data flow.
  - Arguments that are constant across the recorded calls stay constant.
  - The first call's other arguments become the workflow's `inputs` schema.
  - Each later argument is filled by `tools.ask`, constrained to that tool's input schema.
- **Staging.** The workflow goes into a **staging library**. It never goes into the
  shared library that `workflowTools` exposes to every session.
- **The revision.** The candidate core adds a node with
  `binding: {kind: "workflow", name, code: sha256}` and edges `pred → W → succ`, and keeps
  the old path. The revision's gates decide as for any edit.
- **Tools per session.** A session gets its base tools plus exactly the workflows its
  pinned core binds.
- **Journals.** A workflow run's journal links to its session's `tool_call` by run id
  (`tool/<toolCallId>`), so a compiled node's inner steps remain evidence.
- **Task graph.** `planFromSubgraph(graph, from, to)` instantiates a `TaskGraph` from the
  subgraph between two nodes: its action nodes become tasks whose payload holds the node
  and its binding, `PROVIDES_INPUT_FOR` becomes data edges and `LEADS_TO`/`TRIGGERS` control
  edges, and a cycle through a task is refused with a diagnostic. Task graphs have
  payloads and JSON serialization.

## 8. Scoping, merging and access are configuration

### 8.1 Resolver (data)

```jsonc
// procedural/data/resolver.json (per deployment)
{ "$schema": "./resolver.schema.json",
  "rules": [                                          // first match wins
    { "when": { "meta": { "procedural.graph": "*" } }, "graph": "${meta.procedural.graph}" },
    { "when": { "cwdUnder": "/work/harness" },          "graph": "repo/harness" },
    { "when": {},                                       "graph": "default" }
  ] }
```

A rule may match on anything in the session context:

- `sessionMeta` keys;
- `cwd` prefixes;
- the principal's identity kind or name.

A rule names a graph by a template. Per user, per team, per repository, per project, one
shared graph, or no graph at all are all resolver files. None is architecture.

A rule may instead route: `{ "route": { "candidates": ["repo/harness", {"graph": "team/web",
"description": "…"}], "minConfidence": 0.8 } }` asks the cognitive router (its `route`, with
calibrated confidence) to choose among the candidates by the session's first prompt. A
choice below `minConfidence`, no choice, or no router is no graph, and a session pinned to
a candidate keeps it.

### 8.2 Merging

A revision record has `parents[]`, so a merge is a first-class revision. Merging two
graphs is a dream whose inputs are two heads (and their overlays). Its output is a merge
revision under a new or existing `GraphId`, and the resolver then points sessions at it.
Nothing more is needed now. The design only avoids anything that would make merges
impossible later: ids are content hashes, the refiner cannot rename nodes (paper rule 6),
and overlays are event logs that can be re-based.

### 8.3 Access

- Operations on graphs (`procedural.*`) are an extension capability, gated like any
  cognitive extension today.
- Finer rules, such as who may run dream on which graph or who may read which graph, are
  an `authorize(action, graphId, context)` policy. It is configuration, and its default
  is allow-when-granted.
- If a deployment writes a policy that needs the caller's principal, core must pass the
  caller on model work. That is a small, generic change, made when such a policy exists.

## 9. Security

| Threat | Control |
|---|---|
| Persistent prompt injection: tool output → reflection or refiner → guidance for later sessions | The deterministic **edit filter** applies to overlay proposals and dream edits. It rejects any text sharing an 8-token or longer n-gram with its source observations, URLs, absolute paths and high-entropy strings, and runs secret scanning. The harness guidance prompt drops App. B.5's "include any specific command patterns, file paths". Delivery is a trailing advisory message. Overlay text is labeled provisional. Reflection is off by default. |
| Live poisoning (crafted sessions push an edge) | Support counts *distinct* sessions. Entries start on probation with randomized exposure. The overlay cannot delete core structure or bind tools (I2, I5). Dream's `evidence` gate requires support. |
| A bad core revision found later | Revert moves the head to an earlier revision; pinned sessions re-pin at their next turn. |
| An injected edge that does not lower the score | `approval` for edges into tools with side effects; tools without metadata are treated as side-effecting. |
| Forged bus events | Events are notifications. Consumers read the stores. The host binds each event's `source`. |
| Graph binds a dangerous tool | A binding names a tool; it never grants one. Grants stay in the core, and a missing tool makes its node inert. |
| PII in stored text | Redaction tombstones a record's text in place. Its id stays, and the record is marked unverifiable. |

## 10. Paper fidelity without running benchmarks

The `paper` preset is verified by deterministic tests with `ai/test` models and a
scripted testkit environment. No benchmark or dataset is used.

- **Serializer.** A golden test reproduces App. B.5's HotpotQA excerpt from the graph it
  describes.
- **Algorithm 1 trace tests.** With a scripted refiner and a scripted evaluator, the
  dream reducer produces exactly the paper's sequence:
  - `S_0` is evaluated once;
  - structural failures skip evaluation;
  - ties are accepted;
  - a rejected candidate never seeds the next round;
  - rejection memory holds the diagnostics or scores;
  - the context is the tail of the concatenation.
- **`PrepareCandidate`.**
  - Deletions come before additions.
  - `delete_edges` removes every relation between the endpoints.
  - Cycles are repaired when disallowed.
  - The reachability check is to *any* terminal.
  - Tool-catalog membership is not enforced in the paper preset.
- **Online inference.** `a_0 = Start`; exact match; the `h = 2` neighborhood; the
  full-graph fallback; the window `w = 3`; guidance appended to the solver prompt.

The **Evaluator port** (`evaluate(graph, tasks) → per-task scores`) is how a user who
has a replayable task set runs the paper's gate. The framework ships its contract and
the testkit's scripted environment, not datasets. The research note records what the
paper leaves ambiguous, and each ambiguity is a setting, not a guess baked into code.

## 11. Phases

Each phase updates its row in `docs/features.md` in the same change. The assertion-id
prefixes are:

| Prefix | Area |
|---|---|
| `PG` | graph |
| `PO` | overlay |
| `PD` | dream |
| `PS` | stores |
| `PW` | worker |
| `PL` | live learner |
| `PC` | composition |
| `PX` | extension and CLI |

| Phase | Deliverable | Key tests | Status |
|---|---|---|---|
| P1 | Package (pure ESLint glob, tsconfig without DOM or Node types, Stryker `mutate`); graph, candidate and settings schemas; canonical JSON; `RevisionId` (`@noble/hashes`); drift tests | PG1.x; PG1.P (id invariant under array permutation; `$schema` excluded; `format` included) | done |
| P2 | Edit set; `prepareCandidate`; cycle repair; edit filter | PG2.x; PG2.P (a copy is never mutated; accepted implies parses; rejected implies diagnostics; `delete_edges` removes every relation) | done; a node bound to a workflow passes the catalog check (finalization) |
| P3 | `match`, `neighborhood`, `serialize` (golden file of App. B.5) | PG3.x | done |
| P4 | Overlay: events, entries, `EntryId`, the fold, the effective graph, labeled serialization | PO1.x; PO1.P (I2: the effective graph contains the core; I4: the fold is idempotent under duplicated and reordered-by-redelivery events; I6: anchors) | done; `observed` later gained `rescore` for feedback (P11) |
| P5 | `guide`, `refine`, `reflect` on `ai/test` mocks; the constraint is sent; the cache key | PG4.x (two queries at `Start` never share a cache entry) | done |
| P6 | Dream reducer; gates; rejection memory; overlay rebase; the Evaluator port and contract; testkit scripted environment | PD1.x; PD1.M model-based (paper preset trace equals Algorithm 1; a rejected candidate never becomes head; I1; rebase keeps I2 and I6) | done; the reducer prepares candidates itself (no `prepare` command); the stride became settings data, and the evaluator contract and scripted environment (PD3.x) landed with the finalization |
| P7 | Stores (a port and its contract): core revisions and heads, overlay event log, dream event log with lease, pins, guidance texts; memory and file implementations | PS1.x; PD2.x (a dream resumes after a crash re-issuing only unfinished commands; a stale epoch cannot commit) | done; the file implementation is the snapshot store over any `SnapshotStorage` |
| P8 | Core, generic: opaque `sessionMeta` from `session/new` to prompt commands; host publish API with host-bound `source` | DM additions | done (DM10.x) |
| P9 | Resolver and `authorize` policy (data + schema); pinning and revert re-pin | PX1.x | done |
| P10 | Worker: `prepareStep` (localization from messages, effective graph, delivery, `report`, step records with exposure); turn-level mode for harness workers | PW1.x (scripted AI SDK harness: no reset after an approval round; guidance never stacks; one version pair per step; pins survive a restart) | done; the hook resolves with the host's principal, and harness workers are guided once per turn through `harnessSessions({ step })` |
| P11 | Live learner: bus actor with a cursor; log projection; statistics; missing transitions; cautions; probation with randomized exposure; promotion, retirement and decay; optional reflection | PL1.x; PL1.P (support counts distinct sessions; exposure draws come only from `Entropy`) | done; feedback is a re-observation (`rescore`), and reflection was wired in the finalization (a `Reflector` port, `reflectionBatch` for `batch`) |
| P12 | Extension operations and CLI: `graph`, `history`, `feedback`, `dream`, `revert`, `import` (seed), `export` (JSON and Mermaid) | PX2.x | done; `procedural.dream` runs `nativeDream` on the ensemble's generator, the CLI's `dream` refines with `--model` or else the ensemble's reasoning model, and the daemon has no approver |
| P13 | Composition in dream: `compilePath`, staging library, per-revision tools | PC1.x on the scripted environment | done as a library: dream composes in one round after its refine rounds when a host gives it a composer (none does yet), and no worker takes `revisionTools` yet; PC1.x use their own fixtures, not the testkit environment |

## 12. Changes from earlier revisions

- **Revision 2** fixed what an adversarial red-team and a code walkthrough found in
  revision 1:
  - a cache key without the query;
  - the domain having no path to the worker;
  - localization from `steps`;
  - a code-mode round runner;
  - `compileProcedure` losing data flow;
  - gate statistics that creep and lack power;
  - `paper` preset departures;
  - security controls that were only prose.

  Those fixes stand.
- **Revision 3** follows the owner's direction:
  - **Framework, not ingestion.** The benchmark reproduction protocol, datasets, token
    budget and evals additions are removed. Paper fidelity is verified by deterministic
    trace tests (§10), and users bring task sets through the Evaluator port.
  - **Static core and dynamic layer.** The core changes only through dream. An
    event-sourced overlay learns from live traffic under randomized probation, and can
    only add and annotate. Dream consolidates it and rebases it. §3 is the contract.
  - **No owner in the architecture.** `GraphId` is opaque. Scoping is a resolver file,
    merging is supported by multi-parent revisions, and access is a configurable policy.
    Revision 2's "caller identity" blocker becomes an optional generic change, needed
    only by a policy that uses it.
