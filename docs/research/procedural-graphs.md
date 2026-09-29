# Procedural Graphs: what the paper does, what holds up, what we change

Source: Yuxing Lu, Yicheng Chen, Shanchan Wu, Sercan Ö. Arık, *Procedural Graphs:
Self-Evolving Execution Structures for LLM Agents*, arXiv:2609.09153v1 (8 Sep 2026).
The authors released no code and no graphs. An independent reimplementation
(`github.com/vikm2o/proceduralgraph`, Apache-2.0) exists. We read its list of departures;
we do not depend on it.

This note is the input to ADR 0017 and to the plan in `docs/plans/procedural-graph.md`:

- Part 1 restates the mechanism exactly. It is the reproduction target.
- Part 2 reads the evidence adversarially.
- Part 3 maps the paper onto the harness.

Revision 2 (2026-09-27) corrects readings that a red-team review of revision 1 found
wrong. It revises §1.1, §1.2, §1.3, §2.2.2, §2.2.3, §2.2.8, §2.2.9 and §3.3, and adds
§2.2.11.

## 1. The mechanism, exactly

### 1.1 Representation (paper §3.1, App. B.4)

A Procedural Graph (PG) is a directed, attributed multigraph:

    G = (V, R, E, Φ),   E ⊆ V × R × V

- **Nodes** `V`. Each node abstracts a tool function, a skill, a reasoning step, or a task
  status. The serialized form carries `id`, `type` and `description`. The only type named
  in the paper is `ACTION`, the type for tool nodes. The serializer prints it as
  "(Type: ACTION)", and the refiner prompt asks for `"type": "ACTION"`. `Start` begins
  every graph, and the scratch skeleton is exactly `Start → End`.
- **Relations** `R`. This is a vocabulary. Every graph used in the experiments draws on
  the same four labels: `LEADS_TO`, `TRIGGERS`, `PROVIDES_INPUT_FOR` and `CONVERGES_TO`.
  The paper's own serializer does not print the labels to the guidance model (App. B.5),
  so they carry no signal in the reported numbers.
- **Attributes** `Φ(e)`. The schema is set per task. The implementation uses three text
  fields per edge:
  - `condition`: when the transition applies, or null;
  - `guidance`: how to proceed (the most consistently populated field);
  - `pitfalls`: what to avoid.
- **Size.** The graphs are small: 7 to 17 nodes and 7 to 27 triplets per benchmark. BFCL
  is the exception, with 131 nodes and 265 triplets, mirroring its function catalog.

### 1.2 Online guidance (paper §3.2, eq. 2–3)

At decision step `t`, the agent has query `q` and trajectory
`T_t = (a_1, o_1, …, a_{t-1}, o_{t-1})`. The step computes:

    u_t = Match(a_{t-1}, V)                         (a_0 = Start, so u_1 = Start)
    G_t = N_h(u_t)  if u_t ≠ ∅   else  G            (fallback: the full graph)
    g_t = Ψ(G_t, q, T_{t-w:t})                      (guidance LLM)
    a_t ~ P_solver(· | q, T_t, g_t)                 (g_t appended to the solver prompt)

- **Match.** The paper defines `Match` as **exact**: the most recent procedure, for
  example a tool call, equals a node id. Its implementation may differ:
  - The HotpotQA excerpt pairs node `First_Hop_Retrieve` with tool `first_hop_retrieve`.
    Its edge conditions read `first_hop_retrieve` and `scan_index`.
  - The refiner prompt requires node ids such as `Month_Start` and `Decide_Capital` to
    stay "compatible with the environment's state tracker" (rule 6).

  So the implementation may normalize case, or let an environment declare the active
  node. We treat this as **unknown**, and we ablate it.
- **Neighborhood.** `N_h(u)` is `u` plus the outgoing transitions reached in up to `h`
  hops. The paper uses `h = 2` and `w = 3`.
- **Serializer.** It groups transitions by hop: "Immediate Transition Options (Hop 1)",
  then "Subsequent Horizon (Hop 2)". Each transition lists its condition, guidance and
  pitfalls (App. B.5).
- **The guidance prompt** tells the model to "include any specific command patterns,
  file paths, tools, or arguments defined in the graph context".
- **The solver** is a text ReAct loop: exactly one "Thought:" and one "Action:
  tool(args)" per step, parsed from text. Parse failures are a reported metric
  (App. D.1).
- **Frozen graph.** The graph does not change within an episode or during test
  evaluation.
- **Guidance biases the solver, never dictates.** The solver may take any action.

### 1.3 Offline self-evolution (paper §3.3, Algorithm 1, App. B.6)

    S_0 ← Evaluate(G_0, D_val);  H_rejected ← []
    for k = 1..K:
      G_k ← G_{k-1};  S_k ← S_{k-1}
      B_k ⊂ D_train;  E_k ← Rollout(G_{k-1}, B_k)          # traces + scores S_i ∈ [0,1]
      C_k ← Tail_{L_max}(Concat(E_k))                      # keep the END of the concatenation
      ΔG_k ← Refiner(G_{k-1}, C_k, {S_i}, Serialize(H_rejected))
      (G_cand, d_k) ← PrepareCandidate(G_{k-1}, ΔG_k, cyclePolicy)
      if d_k ≠ ∅: H_rejected += (ΔG_k, G_cand, E_k, d_k); continue      # no validation rollout
      S_cand ← Evaluate(G_cand, D_val)
      if S_cand ≥ S_{k-1}: G_k ← G_cand; S_k ← S_cand                   # ties accepted
      else: H_rejected += (ΔG_k, G_cand, E_k, S_cand)
    return G_K

- **Edit set.** The refiner outputs one raw JSON block with four lists:
  - `add_nodes`;
  - `delete_nodes`;
  - `add_edges`, each with a relation and the three attributes;
  - `delete_edges`, by source and target. It removes *every* relation between the two
    endpoints.

  An attribute is revised by deleting the edge and adding it again.
- **PrepareCandidate.**
  - It applies the edits to a copy, deletions before additions.
  - It fails on malformed edits, unknown node or relation types, and missing endpoints.
  - Cycle policy: when cycles are disallowed, it removes the edges that close a cycle
    (repair). When cycles are allowed, it skips that step. The policy is set per task,
    and its value for each benchmark is not reported.
  - It then requires a directed path from every node to *some* terminal (a node with
    out-degree 0), not necessarily `End`.
  - That `ACTION` nodes are available tools is a prompt rule only. The validator does not
    check it.
- **Refiner prompt rules** (App. B.5):
  - Action nodes must be available tools.
  - A condition is a natural-language precondition, or null.
  - Every added edge has guidance.
  - Edges carry pitfalls.
  - "Generality and leak prevention": no specifics from one trajectory.
  - Existing node ids are preserved.
  - The cycle policy is obeyed.
  - Every node reaches a terminal.
- **Modes** (App. D.2):
  - `static_onetime`: an expert graph and one ungated update, over the whole training
    split in one context.
  - `static_incremental`: an expert graph and gated rounds.
  - `scratch_onetime` and `scratch_incremental`: the same two, starting from
    `Start → End`.

  Each round uses a stride of 100 training samples (HotpotQA) or 20 (MultiChallenge), and
  `K = 10`. Two details are unclear:
  - How strides wrap is unstated. MultiChallenge has 100 training tasks, which is 5
    strides.
  - D.2 says the incremental refiner uses "the latest failure logs", but §3.3 says it
    contrasts high- and low-scoring traces.
- **Splits** (App. B.1, D.3), as train / validation / test:

  | Benchmark | Split |
  |---|---|
  | HotpotQA | 1,000 / 1,000 / 1,000; the source is unspecified, and the paper never says "distractor" |
  | MultiChallenge | 100 / 100 / 56 |
  | EnterpriseArena | 20 episodes per split |

  So the gate runs on 20 to 1,000 validation tasks.
- **Decoding.** Temperature 0 and top-k 1. The solver may produce at most 2,048 tokens,
  and the refiner at most 8,192. The guidance model and the refiner are the same LLM as
  the solver.
- **`L_max`.** The paper gives no value.

## 2. The evidence, read adversarially

We treat every claim as a hypothesis to break. Each item says what the paper shows, the
strongest objection, and what we do about it.

### 2.1 What survives

1. **On the same graph, localized generated guidance beats the alternatives.** Table 3
   runs Gemini 3.5 Flash with one graph and one prompt template, which makes it the
   paper's cleanest ablation.

   | Configuration | MultiChallenge | GDPval | ALFWorld |
   |---|---|---|---|
   | Subgraph + generative | 89.31 | 63.99 | 81.53 |
   | No graph | 80.27 | 54.80 | 72.58 |
2. **Full-graph guidance actively hurts embodied tasks.** On ALFWorld, full-graph
   generative guidance scores 54.48, against 72.58 with no graph, and costs 5.3× the
   tokens. The paper does not draw the consequence: the fallback taken when `Match` finds
   nothing *is* the full graph. So match rate is a first-order quantity, and we measure it.
3. **Ungated updates are dangerous, and gated iteration repairs them.** Table 2 shows
   both effects:
   - MultiChallenge: the expert graph drops success from 87.50 to 58.93. One ungated
     update drops it further, to 53.57. Gated rounds recover it to 92.86.
   - HotpotQA: scratch plus a one-time build *lowers* EM below the baseline, 55.40
     against 58.80.

   The gate and the iteration are the mechanism, not decoration.
4. **The overall sign is positive.** Against the strongest baseline in each of the 24
   model × benchmark cells, PG has 19 wins, 2 ties and 3 losses (sign test p = 4.3e-4).

### 2.2 What does not hold up (or not yet)

1. **Most effect sizes are inside their confidence intervals.**
   - HotpotQA margins run from −0.90 to +1.30.
   - BFCL intervals are about ±9 points on 100 samples, so its headline +9 is one
     interval wide.

   The sign test is the robust claim. The per-cell gains are not.
2. **The gate is a noise filter that accepts ties.**
   - EnterpriseArena uses 20 validation episodes. The authors say decisions "turn on one
     or two episodes and should be read as a search trace rather than as significance
     tests".
   - Accepting ties on a noisy estimate lets the graph random-walk and grow.
   - Ten rounds of `≥` against the best so far also select the luckiest candidate (the
     winner's curse). The Round 10 candidate scored 90% on training and 85% on
     validation.
   - Rejected candidates' validation scores are fed back to the refiner
     (`SerializeRejections`), so the validation set is reused adaptively.

   We keep the paper's gate as the `paper` preset. The `harness` preset uses a paired
   gate:
   - It requires superiority, or non-inferiority *and* a smaller graph.
   - It is anchored to `G_0`, so the loss cannot compound across rounds.
   - Its margin is derived from power.
   - It is applied only when a user supplies an evaluator. Without one, dream is gated
     by live evidence and approval.

   The plan (§7.4) has the details, including a worked example. That example shows why a
   fixed 2-point margin at n = 200 would reject nearly every *equal* candidate.
3. **We cannot tell how reasoning and status nodes become active.** Under exact matching
   on tool calls, a node like `Scan_Index` or `Decide_Capital` would never be active. It
   would only be visible as a hop target, and with `h = 2` two such nodes after an action
   would hide the next tool node. Rule 6's "state tracker" suggests the implementation
   localizes more than tool names (§1.2). So `exact`, `case-insensitive` and
   `state-tracker` matching are settings (the last reads a node a tool's result declares
   and argument predicates on bindings), and the horizon can be counted in action hops, so
   reasoning nodes cannot hide the next tool. Both presets keep `exact` and edge hops.
4. **Relations are unused at inference.** The serializer drops the labels, so their only
   role is structural. We keep the vocabulary, because the refiner is told to use it and a
   later serializer may print it. But no code branches on relation labels until an
   ablation shows they matter.
5. **The refiner's context favors the batch's last trajectories.** `Tail` keeps the end
   of the *concatenation*. With a large batch, the earliest trajectories disappear
   entirely, whatever their outcome. The `harness` preset instead keeps each
   trajectory's own tail, and balances high- and low-scoring traces.
6. **Rejection memory grows without bound, and duplicates are validated again.** The
   `harness` preset keys candidates by their revision id, skips re-validating a known
   rejection, and shows the refiner only recent and similar rejections.
7. **Each benchmark has one graph, chosen by hand.** Nothing in the paper routes a task
   to a graph. A daemon serving mixed sessions must, and a wrong graph produces the
   MultiChallenge expert-prior failure (−28.6 points). Domains start explicit.
8. **Guidance is expensive.** On GDPval and ALFWorld, localized guidance still costs 33%
   to 55% more tokens than no graph, even with fewer solver steps. A cache helps only if
   its key is right.
   - Guidance depends on the query as well as the neighborhood and window, so the key
     must include it. Otherwise every session at `Start` gets the first session's advice.
   - The window's tool output makes exact hits rare past `Start`.

   So the cache is scoped per session, and its hit rate is measured, not assumed.
9. **Leak prevention and safety rest on a prompt rule.**
   - Trajectories contain tool output, including untrusted text.
   - A refiner can copy an injected instruction into an edge's `guidance`. Every later
     session on that graph then reads it: a persistent, self-propagating prompt
     injection.
   - The guidance prompt makes this worse by asking to "include any specific command
     patterns, file paths".

   The plan (§9) replaces prose with controls:
   - a deterministic edit filter;
   - probation with randomized exposure for anything learned live;
   - an overlay that cannot delete core structure or bind tools;
   - approval for edits that route to tools with side effects;
   - revert.
10. **Tool-catalog membership is not enforced.** The `harness` preset enforces it, both
    when a candidate is prepared and when a session pins a revision.
11. **HotpotQA's two tables use different metrics.** The +7.58 F1 gain comes from the
    construction study, which uses exact EM and F1 (Table 2). The main table reports
    "Acc." (Table 1), where HotpotQA margins are −0.90 to +1.30. One refiner pitfall
    ("matches exact Wikipedia capitalization") suggests part of the EM/F1 gain is
    formatting. This matters to anyone who evaluates a graph with the Evaluator port, not
    to the framework.

### 2.3 The one-sentence reading

Localization and gated iteration carry the result. The graph is a compact, inspectable
carrier for conditional advice between tool calls, and it is only as good as the gate
that admits edits to it.

## 3. Mapping onto the harness

### 3.1 What we already have that the paper had to build

| Paper piece | Harness piece today | Gap |
|---|---|---|
| Trajectory `T_t` | Session log (SL1–SL4) and hook bus (HK1–HK5) | Tool calls exist only as ACP `tool_call` updates. There is no projection into trajectories, and learning's `Trajectory` has no score or revision. |
| Score `S ∈ [0,1]` | Judge probabilities, learning outcomes | Scores are optional live. A null score still counts as traversal evidence. |
| Refiner, guidance model | Cognitive core: selection, constrained decoding | None. They use existing task categories. |
| Candidate evaluation on `D_val` | Nothing general | An Evaluator port. Users bring task sets; the framework does not. |
| Offline loop | The daemon's pattern: a pure reducer with an event log | The dream runner. Code-mode workflows do not fit, because their timeout is terminal and their journals are rewritten whole. |
| Solver | Agent worker (`ToolLoopAgent`) | A per-step hook (`prepareStep`), session metadata, and a path to the log |
| (nothing: the paper is frozen online) | Hook bus actors with cursors | The dynamic layer: a live learner and an event-sourced overlay |

### 3.2 Procedural beside semantic and episodic memory

The paper places PG in CoALA's procedural-memory quadrant. The harness already has two
kinds of memory:

- episodic and semantic memory (vector recall);
- lessons (distilled text).

The PG replaces neither. It is the *connective structure* between procedures:

- Lessons about a transition inform edge attributes, through dream's context.
- Lessons about facts stay lessons.
- A node can bind a durable workflow, so the graph is also an index of what can be done
  next.

### 3.3 Two layers: what the paper leaves out

The paper's graph is frozen online and changes only in offline rounds against a
validation set. A deployed harness has live traffic and usually no validation set. So we
split the graph in two:

- **The static core** is the paper's graph. It changes only through **dream**, a
  separate consolidation process. With an evaluator, dream is the paper's Algorithm 1.
  Without one, it is gated by live evidence and approval.
- **The dynamic layer** is new. It is an event-sourced overlay, learned from live
  traffic, that can only *add and annotate*. It holds:
  - edge statistics;
  - transitions the core lacks;
  - cautions;
  - optional notes from reflection.

  Its entries are on probation, shown to a random share of sessions, and promoted only
  when exposed sessions do no worse.

Dream absorbs what the overlay proved, prunes what it condemned, and rebases the rest.
This keeps the core stable, the property the paper's gate protects, while the system
still learns between dreams.

### 3.4 The three integrations the request names

1. **The agent bus and its log.**
   - Each step records its `(core revision, overlay version)` pair, the active node, the
     match result, the exposures and a guidance digest in the session log.
   - The live learner is a hook-bus actor. On `turn.ended` it projects the log into a
     scored trajectory and appends overlay events.
   - Dream publishes its decisions as notifications.

   Guidance is evidence, not a replayed effect. The session log is not write-ahead
   today: the runtime dispatches before it saves. Nothing here depends on write-ahead.
2. **Agent trajectory evolution.**
   - Trajectories are keyed by the version pair they ran under.
   - Live trajectories feed the overlay continuously.
   - Dream consumes the overlay and the trajectories, and produces core revisions.

   The population of trajectories evolves because the graph they run under does.
3. **Dynamic workflow composition.** It is a dream output:
   1. A frequent, successful, unbranched path is compiled from its recorded calls into a
      durable workflow. The compiler keeps data flow.
   2. The workflow goes into a staging library.
   3. A candidate core revision binds it to a node, by the sha256 of its code.
   4. The candidate goes through the gates.

   Sessions get only the workflows their pinned core binds.

### 3.5 Invariants the paper does not need but we do

- **Advisory, never authority.** Guidance cannot grant or widen capabilities. A node
  whose tool the session lacks is inert.
- **The core is static between dreams.** Nothing writes it but a dream commit, a seed, a
  merge or a revert.
- **The overlay is monotone.** The effective graph always contains the core.
- **Provenance on every revision.** Each revision records its parents, its edits, the
  evidence behind them and the gates' decisions.
- **Tainted text is filtered, not trusted.** Tool output is untrusted.
- **Scope is configuration.** A graph id is opaque. A resolver maps sessions to graphs,
  and a revision can have several parents, so graphs can be merged later.
