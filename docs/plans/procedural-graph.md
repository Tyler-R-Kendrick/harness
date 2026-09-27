# Plan: procedural graphs in the harness

Decision: ADR 0011. Evidence and critique: `docs/research/procedural-graphs.md`.
Status: not started. Every phase lands test-first, with atomic assertion ids, and passes
the full gates in `CLAUDE.md` (typecheck, lint, coverage, mutation) before it is pushed.

Revision 2 (2026-09-27) follows an adversarial red-team and a rubber-duck walkthrough of
revision 1 against the real code. §9 lists what they found and what changed.

## 0. Goal, order and non-goals

**Goal.** Build procedural memory that the harness improves over time. It has four
parts:

1. A per-domain graph of procedures, with conditional advice on each transition.
2. Step-level guidance, read from the graph around the agent's current position.
3. A gated loop that rewrites the graph from scored trajectories.
4. Compilation of well-trodden paths into durable workflows.

The session log and the hook bus are where sessions record what happened. The revision
store is the system of record for graphs.

**Order: reproduce before integrating.** The gate and the presets decide whether the
rest is worth building, so they are validated first, offline, against the paper. That
means P1 to P5 (the pure core), then P6 (a minimal offline rollout), then P7 (the
reproduction). Daemon integration (P8 onward) comes only after that.

**Non-goals.**

- Hard action constraints, except as an ablation.
- Cross-owner graph sharing.
- Online evolution and automatic domain routing. They wait until the reproduction's
  claims are in, and each needs its own plan.
- Replacing lessons, memory or the task graph.
- A write-ahead runtime. That is a separate finding and needs a separate ADR (§4.1).

## 1. Vocabulary

| Term | Meaning here |
|---|---|
| Domain | A named family of tasks that share one graph, e.g. `hotpot-qa`. It is owned by one principal. A session names one domain or none. |
| Task suite | A domain's replayable tasks: an input, sandboxed tools and a scorer, split into train, validation, confirm and test. Evolution needs one; live sessions are not one. |
| Candidate | A graph document produced by applying edits. It may fail structural checks. |
| Revision | A candidate that passed structural checks: an immutable graph, identified by the sha256 of its canonical versioned JSON. |
| Head | The revision a domain's new sessions pin. It moves only through the gate, or through an approved rollback. |
| Episode | One scored unit: a task from a suite, offline; one turn, online. |
| Step | One solver decision: a tool call and its observation, or a final answer. |
| Active node | The node `Match` returns for the last action. Undefined when nothing matches. |
| Round | One pass of Algorithm 1: rollout, propose, prepare, validate, then decide. |

## 2. Data model (`@harness/procedural`, pure)

### 2.1 Graph

```ts
// A zod schema, parsed into the branded ProceduralGraph. Casting to it is a lint error.
{
  $schema?: string,                            // never part of the revision id
  format: "harness.procedural-graph/v1",       // hashed, so a format migration changes ids
  domain: DomainName,
  nodeTypes: readonly NodeTypeName[],          // vocabulary; default ["ACTION","REASONING","STATUS"]; "ACTION" is required
  relations: readonly RelationName[],          // vocabulary; default LEADS_TO, TRIGGERS, PROVIDES_INPUT_FOR, CONVERGES_TO
  nodes: readonly {
    id: NodeName,                              // unique; "Start" is required (a_0 = Start)
    type: NodeTypeName,                        // upper case, matching the refiner prompt's "ACTION"
    description: string,
    binding?: Binding,                         // harness extension; the paper preset ignores it
  }[],
  edges: readonly { from, relation, to, condition: string | null, guidance: string, pitfalls: string }[],
}
Binding = { kind: "tool", name } | { kind: "workflow", name, code: Sha256 } | { kind: "skill", name, content: Sha256 }
```

**Refinements** follow the pattern of `behavior/graph.ts`:

- Node ids are unique.
- Every type and relation is in its vocabulary.
- Every endpoint exists.
- `Start` exists.
- Every node reaches *some* terminal (out-degree 0). An `End` node is not required,
  because the paper's check does not require one (App. B.6).
- The cycle policy holds. The policy is a per-suite setting, and its value for each
  paper task is unknown, so it is pre-registered in §7.

`CandidateDocument` is the same shape without the refinements, so that a candidate that
fails its checks can still be stored with its diagnostics.

**Refined types:**

- `DomainName`, `NodeName`, `NodeTypeName`, `RelationName`;
- `RevisionId` (a `Sha256`), `TrajectoryId`;
- `Hops` (a positive integer);
- `Score` (= `Probability`).

### 2.2 Edit set (the paper's shape exactly)

```ts
{ add_nodes: {id, type, description}[], delete_nodes: NodeName[],
  add_edges: {source, target, relation, condition, guidance, pitfalls}[],
  delete_edges: {source, target}[] }            // removes every relation between the endpoints
```

The refiner's JSON Schema constraint is generated from this zod schema. `binding` is not
in the refiner's schema, so only promotion (§5.4) can set it.

### 2.3 Scored trajectory

```ts
ScoredTrajectory = {
  id: TrajectoryId, owner, domain, revision: RevisionId, taskId, split,
  query: string, steps: learning.Step[],        // learning's StepSchema, reused
  score: Score | null,
  scoreSource: "metric" | "judge-probability" | "judge-verdict" | "outcome",
  usage: { steps, inputTokens, outputTokens, guidanceTokens },
  localization: { matched, fallback, inert },   // counts
}
```

Learning's `Trajectory` has no score and no revision, so this type wraps its steps.

**Scores:**

| Source | Score |
|---|---|
| A metric (EM, F1, rubric) | its value |
| A judge | its *probability* that the answer passed (the verdict band's input), not the verdict. This keeps "inconclusive" from being dropped non-randomly. |
| A verdict with no probability | `passed` = 1, `failed` = 0 |
| `inconclusive` or `blocked` with no probability | `null`, counted and reported |

### 2.4 Revision store (a port, with a contract suite in testkit)

- **Records.** Revision and candidate records carry: id, parent, edit set, origin
  (`seed | import | refiner | promotion | human`), evidence, decision, committer and
  time. Decision time comes from the `Clock` port.
- **Heads.** One head per `(owner, domain)`, with history for rollback. Keys always
  include the owner, and nothing is deduplicated across owners.
- **Pins.** Pins map `sessionId → RevisionId`. They survive restarts, so a session never
  silently re-pins.
- **Revocation.**
  - A revision can be revoked: rolled back, or found to carry an injected edit.
  - Sessions pinned to a revoked revision re-pin to the head at their next turn
    boundary.
  - Otherwise pins are kept for the session's life. `repin: "never" | "on-revoke"`,
    default `on-revoke`.
- **Redaction.** A record's text can be redacted in place, which is a tombstone. The id
  stays, and redacted records are marked as unverifiable. This is how PII is removed from
  an append-only store.
- **Implementations.** A `SnapshotStorage`-backed store first, as learning does. A file
  store follows on the native host.

### 2.5 Settings (data, with a generated schema and a drift test)

Presets hold only the values that differ, or that a scheduled ablation varies. Keys that
no ablation varies yet are constants in code, taken from the paper, until one is
scheduled.

```jsonc
{
  "$schema": "./settings.schema.json",
  "presets": {
    "paper": {
      "match": "exact", "turnBoundary": "start",
      "context": { "tail": "concatenated", "maxChars": 120000 },   // L_max is unspecified in the paper; value pre-registered
      "gate": { "kind": "at-least-retained" },                    // ties accepted
      "rejections": { "dedupe": false, "show": "all" },
      "enforceToolCatalog": false, "guidanceCache": false, "editFilter": false,
      "guidancePrompt": "paper",                                  // App. B.5 verbatim
      "delivery": "system"                                        // paper: appended to the solver prompt
    },
    "harness": {
      "match": "exact", "turnBoundary": "carry",
      "context": { "tail": "per-trajectory", "maxChars": 120000, "balance": true },
      "gate": { "kind": "anchored-noninferiority", "confidence": 0.9, "marginFrom": "power", "totalLoss": 0.02 },
      "rejections": { "dedupe": true, "show": "recent-and-similar", "limit": 8 },
      "enforceToolCatalog": true, "guidanceCache": true, "editFilter": true,
      "guidancePrompt": "harness",                                // drops "include any specific command patterns, file paths"
      "delivery": "trailing-message"
    }
  },
  "decoding": { "temperature": 0, "topK": 1, "solverMaxTokens": 2048, "refinerMaxTokens": 8192 },
  "prompts": { "solver": "...", "guidance": "...", "guidanceHarness": "...", "refiner": "..." }  // App. B.5 verbatim
}
```

Hops (`h = 2`), window (`w = 3`) and fallback (full graph) are code constants until
their ablations are scheduled. Suite settings (§7) hold `batch`, `rounds`, `cyclePolicy`
and the split sizes per benchmark, because the paper's strides differ by benchmark.

## 3. Components

| Component | Where | Notes |
|---|---|---|
| Graph and candidate schemas, canonical JSON, `RevisionId` | `procedural` | `@noble/hashes` sha256 over the canonical versioned JSON; `graphJsonSchema()` and a drift test |
| Edit schema, `prepareCandidate` | `procedural` | deletions, then additions; diagnostics, not exceptions; cycle repair when cycles are disallowed |
| Edit filter (`harness` preset) | `procedural` | deterministic rejection (§6) |
| `match`, `neighborhood`, `serialize` | `procedural` | the serializer reproduces App. B.5's text, checked by a golden test |
| `guide` | `procedural` | `generateText` on a `LanguageModel`; cache key in §5.3 |
| `refine` | `procedural` | `generateText` with `constrain(editSetJsonSchema)` |
| Evolution reducer | `procedural` | `(state, event) → {state, commands}`; the state keeps the retained head's per-task score vector, not a mean |
| Gates | `procedural` | `atLeastRetained` (paper); `anchoredNonInferiority` (§4.3) |
| Round runner | `procedural` + host | the reducer and an append-only round event log (§4.4); not a code-mode workflow |
| Revision store port + `revisionStoreContract` | `procedural` + `testkit` | as in §2.4 |
| Offline rollout, metric cases, datasets, budget meter | `evals` | §4.5 |
| Session metadata through core | `core`, `protocol` | §5.1 |
| Caller identity on model work | `core`, `runtime`, `cognitive` | §5.2 |
| Host publish API | `core` | §5.2 |
| Per-step guidance | `workers` | `prepareStep`, localized from `messages` (§5.3) |
| Path compiler and staging library | `procedural` + `workflows` | §5.4 |

**Build wiring for the new package:**

- Add `packages/procedural/src/**` to the pure ESLint glob (`eslint.config.js`, the
  `files` list with `pureRestrictions`).
- Add it to Stryker's `mutate` list.
- Give it a tsconfig without DOM or Node types.

## 4. Reproduction first (P1 to P7)

### 4.1 Why not write-ahead now

`DaemonRuntime.#apply` dispatches before `#persist()`, and it saves the whole snapshot on
every change. So the session log is not write-ahead. But tools run inside workers, so
persisting before dispatch would not make tool calls write-ahead either.

Guidance is evidence, not a replayed effect. Step records in the log carry a digest and
an id, and the guidance text lives in the revision store's guidance log, so the log does
not grow much.

A write-ahead runtime (append log, group commit, checkpoints) is a separate ADR, and this
plan does not depend on it.

### 4.2 The round (Algorithm 1)

The reducer implements App. B.6 line by line:

1. It caches `S_0` on validation.
2. Each round starts from the retained graph, never from a rejected candidate.
3. The rollout runs a training batch.
4. The context is built:
   - `paper`: the tail of the concatenation.
   - `harness`: the tail of each trajectory, balanced between high and low scores.
5. It serializes the rejections.
6. It calls `refine`.
7. It calls `prepareCandidate`.
8. A structural failure appends the failure to the rejections, with no validation.
9. Otherwise it validates the candidate.
10. It decides.

**Modes (App. D.2):**

- `onetime` gives the whole training split to one refiner call and commits without a
  gate. This is Mode 2 or Mode 4.
- `incremental` runs strides of `batch` for `rounds` rounds, with the gate. This is
  Mode 3 or Mode 5.

When the training split has fewer than `rounds × batch` tasks, strides wrap in order.
The paper is silent on this, so it is pre-registered in §7.

App. D.2 says the incremental refiner uses "the latest failure logs", while §3.3
contrasts high- and low-scoring traces. We follow §3.3, and we flag the discrepancy in
the research note.

### 4.3 Gates

**`atLeastRetained` (paper).** Accept a structurally valid candidate if
`mean(S_cand) ≥ S_retained`. Ties are accepted.

**`anchoredNonInferiority` (harness).** Offline only, because it compares the same
validation tasks under two graphs. It uses per-task score vectors.

- **Statistic.**
  - Binary scores: a paired difference with a Newcombe hybrid-score interval
    (McNemar-consistent).
  - Continuous scores (F1, probabilities): a paired bootstrap.
  - The interval is one-sided at `confidence`.
- **Decision.**
  - Accept if the candidate is **superior** to the retained head: the lower bound is
    above 0.
  - Accept if the candidate is **non-inferior** (the lower bound is at least −δ) *and*
    strictly smaller.
    - Smaller is compared as the pair (nodes + edges, attribute characters), in that
      order.
    - An attribute-only edit is therefore accepted when it is superior, or when it is
      shorter and non-inferior.
  - Reject everything else.
- **Anchor.** A candidate must also be non-inferior to `G_0` with a *total* margin of
  `totalLoss`. Non-inferiority against a moving head cannot creep by δ every round.
- **Margin from power (`marginFrom: "power"`).** δ is the smallest margin at which a
  candidate *equal* to the head is accepted with probability at least 0.8, given the
  validation size and the observed discordance rate.
  - Example: with binary scores, n = 200 and a discordance rate of 0.2, SE ≈ 0.032 and
    δ ≈ 0.07.
  - If δ exceeds `totalLoss`, the suite is too small to gate non-inferiority. The gate
    then accepts only superiority and says so in the round's evidence.
  - A table of δ against n and discordance ships with the settings, so the choice is
    visible before any run.
- **Adaptivity.** Rejected candidates' validation scores reach the refiner (App. B.6
  `SerializeRejections`), so the validation split is reused adaptively. Claims are
  therefore made only on the **confirm** split: the returned graph against `G_0`, tested
  once, after the loop ends. The test split is used only for the §7 report.

### 4.4 The round runner (not a code-mode workflow)

A code-mode workflow does not fit a round, for three reasons:

- It cannot import the reducer.
- Its `timeoutMs` covers the whole run, and a timeout is a terminal failure, not a
  resumable one.
- It rewrites its whole journal on every entry.

Instead the reducer's events are appended to a round log, which is the daemon's own
pattern: a pure core and an event log. On resume, the runner replays the events and
re-issues the commands that have not finished. Rollout commands run per task and return
`{taskId, trajectoryId, score}`. Traces go to a trajectory store, and `refine` loads them
by id. Only one round runs per `(owner, domain)`: the runner holds a lease with an
epoch, and a stale epoch cannot commit.

### 4.5 Evals additions (P6)

- **A metric case kind:** `score(): Promise<number>`. It needs no judge, and returns
  per-task score vectors. The runner still reports `blocked` when a *judged* case has no
  judge.
- **Concurrency:** the runner runs cases with a bounded concurrency.
- **`runSession`:**
  - It returns every update, so the projection works.
  - It accepts session metadata (§5.1). Until P8 lands, offline runs pass the domain to
    the worker directly.
- **Solvers**, all selectable per run:
  - `text-react`: the paper's Thought/Action format and prompt (App. B.5), with its own
    parser, recording parse failures. Reproduction arms use it.
  - `tool-calling`: native AI SDK tools, for the harness preset arms.
- **Datasets:** manifests under `packages/evals/data/`, each schema'd JSON pinned by
  sha256 and cached like model files.
- **Budget meter:** AI SDK middleware (`wrapLanguageModel`) around the solver, guidance,
  refiner and judge models. When it trips it aborts the run, and the run is
  `inconclusive`. Usage goes into every trajectory.
- **Synthetic treasury suite:** a deterministic, long-horizon simulation modeled on
  EnterpriseArena's published mechanics (App. C.1):
  - capital arrives 1 to 6 months after a request;
  - scheduled crises;
  - information tools with fixed arguments.

  It is labeled as synthetic, not a reproduction of EnterpriseArena. It is the
  integration test for the loop with scripted models, and the promotion benchmark in
  §5.4, because its backbone path has fixed arguments.

## 5. Integration (P8 onward)

### 5.1 How a session names its domain

- `session/new` accepts `_meta.harness.session`, an opaque record. Core never interprets
  it.
- The daemon stores it on the session and in the snapshot, and passes it in every prompt
  command as `sessionMeta`.
- `AgentWorker` passes it into `TurnOptions`.
- `sessionAgent`'s `prepareCall` copies it into `runtimeContext`.
- The procedural hook reads `sessionMeta.procedural = { domain }`.

A client can name only a domain that its own principal owns. The procedural extension
enforces this against the caller identity in §5.2.

### 5.2 Identity, publishing and bus events

- **Caller identity (a blocker for any `procedural.*` op).** `CognitiveWork` gains the
  caller's principal and session grants, and `invokeCognitive` passes them to extension
  ops.
  - Each op states its rule: reading needs the owner, observing needs the owner's
    session, and committing needs the owner.
  - Approvals are not an op. They go through the daemon's existing permission flow (MX3),
    bound to the candidate id.
- **Host publish API.**
  - `Daemon.publish({source, type, sessionId?, correlationId?, payload})` is the host's
    counterpart of `offerPlatformCapability`.
  - `source` is bound by the host, never taken from a peer.
  - Until plugins can publish (features §J), only the host can publish.
- **Three event types**, all notifications:
  - `procedural.session.pinned`
  - `procedural.round.started`
  - `procedural.revision.decided {decision}`

  Consumers read the head from the revision store, never from an event. A forged event
  changes nothing.

### 5.3 Guidance at run time

`prepareStep` in `sessionAgent` does the following on each step:

1. **Pin.** Look up the session's pin in the revision store, or pin the head and emit
   `procedural.session.pinned`. Check the pinned revision's action nodes against this
   session's tools. Absent tools make their nodes inert, and the inert rate is recorded.
2. **Localize from `messages`, not `steps`.** `steps` covers only the current
   `agent.stream` call, which `AgentWorker` restarts on every turn and after every
   approval round.
   - The last action is the last `tool-call` part of the last assistant message. With
     parallel calls, it is the last in emission order, and the others are recorded.
   - `turnBoundary: "start"` resets to `Start` when a turn begins. The paper runs one
     task per episode.
   - `carry` keeps the previous turn's last action.
3. **Build `G_t`:** `neighborhood(u_t, h)`, or the full graph when `u_t` is undefined.
4. **Guidance.**
   - With the cache on, the cache is scoped per session. Its key is
     `(revision, u_t, digest(q), digest(window), guidance model)`, and the hit rate is
     measured.
   - The paper preset always calls `guide`.
5. **Deliver.**
   - `delivery: "system"` (paper) rebuilds the instructions from `initialInstructions`
     plus the guidance slot. An override carries forward, so guidance would otherwise
     stack.
   - `delivery: "trailing-message"` (harness) appends one advisory user-role message,
     tagged under `providerOptions.harness`. It replaces the previous tagged message,
     because message overrides carry forward too.

   The trailing message keeps the system prompt stable, so provider prefix caching works.
   It also keeps text derived from tool output out of system-prompt authority.
6. **Record.** `TurnOptions` gains `report(update)`, which is `AgentWorker`'s own
   `update`, passed through `runtimeContext`. The step record is
   `{revision, node, matched, others, cached, guidanceId, digest, usage of the previous step}`.
   It is a notice with `_meta.harness.procedural.step`, and it lands before that step's
   `tool_call`. Notices go to attached clients, and only the owner can attach (MX1.3).

**Opaque harness workers.** Workers built with `harnessSessions` get turn-level guidance
only. It is prepended to the prompt in `harnessSessions.stream`, because only the new
prompt reaches the harness.
- Their tool names (Bash, Read, Edit) are too coarse for exact `Match` to localize much.
- A `state-tracker` match mode (an argument predicate on a binding, or an
  environment-declared node) is future work, gated on an ablation.

**Match modes.** `exact` is the paper's written definition. The paper's excerpt pairs
node `First_Hop_Retrieve` with tool `first_hop_retrieve`, and its refiner prompt refers
to an "environment's state tracker". So its implementation may have normalized case or
tracked state. That is unknown. We run `exact` and `case-insensitive` as a pre-registered
ablation (§7).

### 5.4 Dynamic workflow composition (after P7)

- **Candidates.** A path `n1 → … → nk` of action nodes is a candidate when all of these
  hold:
  - every interior node has out-degree 1 with an unconditional edge;
  - the path is in at least `support` scored trajectories under the head;
  - its mean score is at least `minScore`.
- **`compilePath(path, recordedCalls, toolSpecs)`.** This is a new compiler.
  `compileProcedure` routes step *text* through a model and emits constant arguments,
  which loses data flow.
  - Arguments that are constant across the recorded calls stay constant.
  - The first call's other arguments become the workflow's `inputs` JSON Schema.
  - Each later argument is filled by `tools.ask` under a JSON Schema constraint of that
    tool's input, with the results so far.
- **Staging.** The workflow goes into a staging library. It never goes into the shared
  library that `workflowTools` exposes to every session, and learning's
  `workflowBuilder` cannot overwrite it.
- **Tools per session.** A session's tools are its base tools plus exactly the workflows
  its pinned revision binds. The binding carries the workflow code's sha256, so the
  revision id covers what the workflow does.
- **The revision.** The candidate revision adds the bound node with `pred → W → succ`,
  and keeps the old path. The same gate decides.
- **Benchmark.** The synthetic treasury suite's monthly backbone. HotpotQA's arguments
  depend on data, and MultiChallenge has no tools.
- **Journals.** A workflow run's journal lives in its own `SnapshotStorage`. The
  projection links it to the session's `tool_call` by run id (`tool/<toolCallId>`), so a
  promoted node's inner steps are still visible to the refiner.
- **Task graph.** Instantiating a `TaskGraph` from a subgraph is out of scope until the
  task graph has payloads and serialization.

### 5.5 Lessons and memory

- The refiner gets the domain's `pitfall` and `procedure` lessons as prior evidence.
- The graph never writes lessons, so lessons stay a clean baseline in §7.

## 6. Security

| Threat | Control |
|---|---|
| Persistent prompt injection: tool output → refiner → guidance for every later session | The **edit filter** (`harness` preset) deterministically rejects an edit whose text contains any of these: an 8-token or longer n-gram shared with an observation in its batch; a URL; an absolute path; a high-entropy string. Secret scanning runs over all edit text. The harness guidance prompt drops App. B.5's "include any specific command patterns, file paths". Delivery is a trailing advisory message, not system text. |
| An injected edge that does not lower the score | Edits that add or re-route edges into action nodes whose tools have side effects (tool metadata; unknown means side-effecting) need an approver, through the permission flow. |
| A bad head found later | Revocation: sessions pinned to it re-pin at their next turn, and the revision is marked in the store. |
| Poisoned training data | Trajectories are accepted only from the owner's sessions or the owner's suites. Scores come only from metrics, the catalog's judge, or the owner. |
| Forged bus events | Events are notifications only, and the host binds their `source`. |
| Cross-owner leakage | The store, the heads, the cache and the pins are all keyed by owner, and nothing is shared across owners. |
| Unauthorized commit or read | Caller identity on every op (§5.2). |
| Graph binds a dangerous tool | A binding names a tool; it never grants one. Grants stay in the core, and a missing tool makes its node inert. |

## 7. Reproduction protocol (pre-registered)

We fix the claims, splits, seeds, metrics and budgets here, before any run, so the
results cannot choose the question.

**Benchmarks.**

- **HotpotQA.**
  - The paper's splits are 1,000 train, 1,000 validation and 1,000 test, of an
    unspecified source.
  - We use: train and validation as disjoint slices of `train`; confirm as another
    disjoint slice of 500; test = `dev_distractor` (1,000 sampled with a fixed seed).
  - Tools follow the paper's node names (`first_hop_retrieve` and so on) over the task's
    own passages.
  - The primary metrics are EM and F1 (Table 2). Normalized-EM accuracy is secondary.
    Table 1 reports "Acc.", where HotpotQA margins were −0.90 to +1.30, and B.5's pitfall
    about "exact Wikipedia capitalization" points to formatting gains.
  - Batch 100, 10 rounds.
- **MultiChallenge.**
  - The splits are the paper's: 100 train, 100 validation, 56 test. We add no confirm
    split, so claims use test with a Holm correction.
  - It is judged by the catalog's best reachable judge, with judge probability as the
    score.
  - Batch 20, 10 rounds, with strides wrapping over train.
  - The solver has no tools here, so `Match` only ever sees `Start`. Localization
    claims on MultiChallenge are therefore limited to "Start's neighborhood versus the
    full graph", and C2 is tested on HotpotQA only.
- **Synthetic treasury.** Integration and promotion only; no paper claims.

**Arms.** Every arm uses the `text-react` solver, unless it says `tool-calling`.

1. No graph.
2. Lessons (our ExpeL-like baseline).
3. Mode 4: scratch, one-time build.
4. Mode 5: scratch, `paper` gate.
5. Mode 5 under the `harness` preset, with `tool-calling`.
6. A localization ablation on arm 4's returned graph: full graph raw, full graph
   generative, subgraph generative.
7. A match ablation: `exact` or `case-insensitive`.

Expert modes (1 to 3) need expert graphs, which the paper did not publish. We run them
only on graphs we write ourselves, imported with `origin: "import"`, and label them so.

**Seeds.** Each loop arm (3, 4, 5) runs 3 times, with stride orders shuffled by seeds
0, 1 and 2, so a result includes the variance of which graph the loop returns.

**Models.**
- One generator plays solver, guidance and refiner. It is pinned by the run config
  (`pin`), so selection is bypassed, and its id is recorded.
- Temperature 0, top-k 1, and max tokens 2,048 (solver) and 8,192 (refiner), per App. D.3.
- Model ids are catalog data.

**Claims.** Each claim is tested once, on the confirm split (HotpotQA) or the test split
(MultiChallenge). The interval is a hierarchical bootstrap: over loop seeds, then over
tasks. Holm correction is applied across C1 to C4 at family α = 0.05.

- **C1.** Arm 4 is superior to arm 1 on HotpotQA F1. The paper reports +7.58.
- **C2.** Subgraph generative is superior to full-graph generative on HotpotQA, on arm 4's
  graph. This follows the direction of the paper's Table 3.
- **C3.** Arm 4 is non-inferior to arm 3 at a margin of 2 points on both benchmarks, with
  superiority reported as secondary. This is the claim that gated iteration is at least
  as good as one-shot.
- **C4.** Arm 5 is non-inferior to arm 4 at a margin of 2 points. Its edge count is
  reported with a bootstrap interval, but it is not part of the claim.

**Report.**
- For every arm: score with interval, tokens, steps, parse failures, and match, fallback
  and cache-hit rates.
- For every round: its decision and its δ.
- For the returned graph: the graph itself, as JSON and as Mermaid.

A failed replication is reported as failed.

**Budget.** Each run declares a token budget up front. The meter stops it, and the run is
then `inconclusive`. Paper fidelity at 1,000 validation tasks for 10 rounds costs roughly
1.1 × 10⁸ tokens per loop seed. That is 10 rounds × (100 train + 1,000 validation) episodes at the
roughly 10k tokens per HotpotQA sample reported in Table 9, before the test split. So arm 4 may run at a declared,
smaller validation size, labeled as a departure, if the owner's budget (§10) requires it.

## 8. Phases

Each phase updates its row in `docs/features.md` in the same change. The assertion-id
prefixes are `PG` (the pure core), `PS` (the store), `PE` (evals), `PX` (the extension),
`PW` (the worker) and `PC` (composition).

| Phase | Deliverable | Tests (ids) |
|---|---|---|
| P1 | Package with pure lint, tsconfig and Stryker entries; graph, candidate and settings schemas; canonical JSON; `RevisionId`; schema drift tests | PG1.x; PG1.P (canonical form invariant under array permutation; the id ignores `$schema`; changing `format` changes the id) |
| P2 | Edit schema; `prepareCandidate`; cycle repair; edit filter | PG2.x; PG2.P (a copy is never mutated; accepted implies parses; rejected implies diagnostics; `delete_edges` removes every relation; the filter rejects any shared 8-gram) |
| P3 | `match` (exact, case-insensitive); `neighborhood`; `serialize` (golden file of App. B.5's excerpt) | PG3.x |
| P4 | `guide` and `refine` on `ai/test` mocks; the constraint is sent; cache key and scope | PG4.x (two queries at `Start` never share a cache entry) |
| P5 | Reducer (both modes, strides wrap); both gates with the power-derived δ; rejection memory | PG5.x; PG5.M model-based: a rejected candidate never becomes head; an invalid one is never validated; the retained mean never drops under `atLeastRetained`; under `anchoredNonInferiority` the head is never below `G_0 − totalLoss` on validation; with `dedupe` a duplicate is never re-validated |
| P6 | Revision store port, contract and memory store; round runner on an event log (resume and lease); evals metric cases, concurrency, `runSession` updates, datasets, budget meter, text-react solver, synthetic treasury | PS1.x (contract); PG6.x (resume after a crash re-issues only unfinished commands; a stale epoch cannot commit); PE1.x |
| P7 | Reproduction runs per §7; report in `docs/research/procedural-graphs.md` | the evals `procedural` suite |
| P8 | Session metadata through core; caller identity on model work; host publish API | DM additions; RT additions |
| P9 | Extension `procedural.graph/history/observe` with caller rules; pins; revocation; redaction | PX1.x |
| P10 | Worker `prepareStep`: localization from messages; delivery; `report`; step records; turn-level mode for harness workers | PW1.x (AI SDK scripted harness: after an approval round the node is not reset; guidance never stacks; the pin survives a restart) |
| P11 | Projection of logs into scored trajectories for owners' sessions (training input only) | PG7.x (property: the projection does not throw on any log the daemon writes, including compacted logs, where it reports the gap) |
| P12 | Composition: `compilePath`, staging library, per-revision tools, promotion through the gate | PC1.x on the synthetic treasury suite |

Later, each with its own plan: online evolution (unpaired, capped canary); domain
routing; `state-tracker` match; hard-constraint ablation; plans instantiated from
subgraphs.

## 9. What the reviews changed (from revision 1)

The red-team and the rubber-duck walkthrough found the following in revision 1. Each is
fixed where noted.

- **Blockers:**
  - Ops had no caller identity (§5.2).
  - The guidance cache key omitted the query (§5.3).
  - Validation assumed live sessions could be re-run. Evolution is now offline over task
    suites (§1, §4.3).
- **Design flaws:**
  - The domain had no path to the worker (§5.1).
  - `prepareStep` localized from `steps`, which reset every stream call, and could not
    reach `emit` (§5.3).
  - The evolution loop as a code-mode workflow: timeouts are terminal, and journals
    rewrite quadratically (§4.4).
  - `compileProcedure` cannot carry data flow, and the shared library bypasses the gate
    (§5.4).
  - The evals runner had no metric cases, budget or concurrency (§4.5).
  - The bus had no publish path (§5.2).
  - Pins lived in worker memory (§2.4).
- **Statistics:**
  - Non-inferiority against a moving head creeps.
  - Margin 0.02 at n = 200 rejects equal candidates.
  - The tie-break was undefined.
  - No test statistic was named.
  - Excluding `inconclusive` is non-random.
  - Validation was reused adaptively.
  - Claims ignored loop variance and multiplicity (§4.3, §7).
- **Fidelity:**
  - The `paper` preset had departures: validation size, global batch, no one-time mode,
    missing decoding settings, a native tool-calling solver, a required `End`,
    lower-case types.
  - "Distractor" and the tool names were ours, not the paper's (§2, §4.5, §7).
- **Security:** mitigations were prose. There is now an edit filter, approval for
  side-effecting routes, revocation, and owner-only data (§6).
- **Scope:** P0 (write-ahead) is out, promotion comes after reproduction, and online
  work waits (§0, §4.1).

## 10. Open decisions (the owner's call)

1. **The reproduction model and token budget:** which generator (a gateway key) and how
   many tokens per run. This decides whether arm 4 runs at the paper's validation size.
2. **Approval policy:** required for side-effecting routes (default), or for every
   commit.
3. **Graph scope:** per owner (default). Team sharing waits for features §B.
4. **Whether online evolution is wanted at all:** it needs its own plan and an unpaired
   gate.
