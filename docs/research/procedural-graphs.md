# Procedural Graphs: what the paper does, what holds up, what we change

Source: Yuxing Lu, Yicheng Chen, Shanchan Wu, Sercan Ö. Arık, *Procedural Graphs:
Self-Evolving Execution Structures for LLM Agents*, arXiv:2609.09153v1 (8 Sep 2026).
The authors released no code. An independent reimplementation
(`github.com/vikm2o/proceduralgraph`, Apache-2.0) exists; we read it for its departures
list, not as a dependency.

This note is the input to ADR 0011 and the plan in `docs/plans/procedural-graph.md`.
Part 1 restates the mechanism exactly (the reproduction target). Part 2 reads the evidence
adversarially. Part 3 maps it onto the harness.

## 1. The mechanism, exactly

### 1.1 Representation (paper §3.1, App. B.4)

A Procedural Graph (PG) is a directed, attributed multigraph

    G = (V, R, E, Φ),   E ⊆ V × R × V

- **Nodes** `V`: each abstracts a tool function, a skill, a reasoning step, or a task
  status. The serialized form carries `id`, `type` (`ACTION` for tool nodes; the rest are
  reasoning/status types), `description`. `Start` and `End` exist in every graph; the
  scratch skeleton is exactly `Start → End`.
- **Relations** `R`: a vocabulary. Across all published graphs it is four labels:
  `LEADS_TO`, `TRIGGERS`, `PROVIDES_INPUT_FOR`, `CONVERGES_TO`. The paper's own serializer
  does not print them to the guidance model (App. B.5), so they carry no signal in the
  reported numbers.
- **Attributes** `Φ(e)`: a per-task schema; the implementation uses three text fields per
  edge: `condition` (when the transition applies, or null), `guidance` (how to proceed;
  the most consistently populated), `pitfalls` (what to avoid).
- **Size**: small. 7 to 17 nodes and 7 to 27 triplets per benchmark, except BFCL (131
  nodes, 265 triplets, mirroring its function catalog).

### 1.2 Online guidance (paper §3.2, eq. 2–3)

Per decision step `t`, with query `q` and trajectory `T_t = (a_1, o_1, …, a_{t-1}, o_{t-1})`:

    u_t = Match(a_{t-1}, V)                         (a_0 = Start, so u_1 = Start)
    G_t = N_h(u_t)  if u_t ≠ ∅   else  G            (fallback: the full graph)
    g_t = Ψ(G_t, q, T_{t-w:t})                      (guidance LLM)
    a_t ~ P_solver(· | q, T_t, g_t)                 (g_t appended to the solver prompt)

- `Match` is **exact**: the most recent procedure (a tool call's name) equals a node id.
- `N_h(u)` is `u` plus outgoing transitions expanded up to `h` hops. `h = 2`, `w = 3`.
- The serializer groups transitions by hop: "Immediate Transition Options (Hop 1)",
  "Subsequent Horizon (Hop 2)", each with condition/guidance/pitfalls (App. B.5).
- The graph is **frozen** within an episode and during test evaluation.
- Guidance **biases, never dictates**: the solver is a plain ReAct loop and may take any
  action.

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

- **Edit set** (refiner output, one raw JSON block): `add_nodes`, `delete_nodes`,
  `add_edges` (with relation and the three attributes), `delete_edges` (by source/target;
  removes *every* relation between the endpoints). Attribute revision is delete + re-add.
- **PrepareCandidate**: apply to a copy, deletions before additions. Fail on malformed
  edits, unknown node or relation types, missing endpoints. Cycle policy: when cycles are
  disallowed, remove cycle-closing edges (repair); when allowed, skip. Then require a
  directed path from every node to *some* terminal (out-degree 0), not necessarily `End`.
  Tool-catalog membership of `ACTION` nodes is a prompt rule only; the validator does not
  check it.
- **Refiner prompt rules** (App. B.5): action nodes must be available tools; conditions
  are natural-language preconditions or null; every added edge has guidance; pitfalls;
  "generality and leak prevention" (no trajectory specifics); preserve existing node ids;
  obey the cycle policy; every node reaches a terminal.
- **Modes** (App. D.2): `static_onetime` (expert + one ungated update), `static_incremental`
  (expert + gated rounds), `scratch_onetime`, `scratch_incremental`. Strides of 100
  (HotpotQA) or 20 (MultiChallenge) training samples per round; `K = 10`.
- **Decoding**: temperature 0, top-k 1; max 2,048 tokens for the solver and 8,192 for the
  refiner. Guidance model and refiner are the same LLM as the solver.

## 2. The evidence, read adversarially

We read every claim as a hypothesis to break. Each item says what the paper shows, the
strongest objection, and what we do about it.

### 2.1 What survives

1. **Localized, generated guidance beats the alternatives on the same graph** (Table 3,
   Gemini 3.5 Flash). Subgraph + generative: 89.31 / 63.99 / 81.53 on MultiChallenge /
   GDPval / ALFWorld versus the no-graph baseline's 80.27 / 54.80 / 72.58. This is the
   cleanest ablation in the paper: one model, one graph, one prompt template.
2. **Full-graph guidance is actively harmful on embodied tasks**: ALFWorld drops from
   72.58 (no graph) to 54.48 (full graph, generative) and costs 5.3× the tokens.
   *Consequence the paper does not draw*: the `Match` failure path *is* the full-graph
   path. Every unmatched step falls back to the configuration that hurt most. Match rate
   is therefore a first-order quantity, and we must measure it.
3. **Ungated updates are dangerous; gated iteration repairs.** On MultiChallenge the
   expert graph drops success from 87.50 to 58.93; one ungated update drops it further to
   53.57; gated rounds recover to 92.86 (Table 2). Scratch + one-time build *lowers*
   HotpotQA EM below baseline (55.40 vs 58.80). The gate and the iteration are the
   mechanism, not decoration.
4. **The overall sign is positive**: 19 wins, 2 ties, 3 losses against the strongest
   baseline in 24 model × benchmark cells (sign test p = 4.3e-4).

### 2.2 What does not (or not yet)

1. **Effect sizes are mostly inside the confidence intervals.** HotpotQA margins are
   −0.90 to +1.30. BFCL intervals are about ±9 points on 100 samples, so its headline +9
   is one interval wide. The sign test is the robust claim; per-cell gains are not.
2. **The gate is a noise filter with ties.** EnterpriseArena uses 20 validation
   episodes; the authors say decisions "turn on one or two episodes and should be read as
   a search trace rather than as significance tests". Accepting ties on a noisy estimate
   lets the graph random-walk and grow. Ten rounds of `≥` against the best-so-far also
   select the luckiest candidate (winner's curse): the Round 10 candidate was 90%
   training, 85% validation. *We keep the paper's gate as `paper` mode for reproduction,
   and default to a statistical gate* (paired comparison on the same tasks, a
   non-inferiority margin, and a size tie-break so a tie never grows the graph).
3. **Exact `Match` cannot localize reasoning or status nodes.** Only tool calls produce
   actions, so a node like `Scan_Index` or `Decide_Capital` is never active; it is only
   visible as a hop target. With `h = 2`, two reasoning nodes after an action hide the
   next tool node from the guidance model. *We measure horizon in ACTION hops as an
   ablation*, and record match rate per revision.
4. **Relations are unused at inference.** The serializer drops the labels. Their only
   role is structural. We keep the vocabulary (the refiner is told to use it and a later
   serializer may print it), but no code branches on relation labels until an ablation
   shows they matter.
5. **The refiner's context is biased toward the batch's last trajectories.** `Tail` keeps
   the end of the *concatenation*, so with a large batch the earliest trajectories vanish
   entirely, whatever their outcome. *Deviation*: we budget per trajectory (each keeps its
   own tail) and balance high- and low-scoring traces. `paper` mode keeps the original.
6. **Rejection memory grows without bound** and duplicates are re-validated. We key
   candidates by a canonical hash of the resulting graph and skip validating a graph that
   was already rejected (the reimplementation does the same), and cap what the refiner
   sees (most recent and most similar rejections).
7. **One graph per benchmark, chosen by hand.** Nothing in the paper routes a task to a
   graph. A daemon serving mixed sessions must, and a wrong graph is the MultiChallenge
   expert-prior failure (−28.6 points). Graph selection is ours to design and to gate.
8. **Cost.** Localized guidance still costs 33–55% more tokens than no graph on GDPval
   and ALFWorld, even with fewer solver steps. The paper suggests reusing guidance across
   steps or generating it selectively. We cache by `(revision, node, window digest)` and
   render a template instead of calling a model when the neighborhood leaves one
   unconditional choice.
9. **Leak prevention and safety are a prompt rule.** Trajectories contain tool output,
   including untrusted text. A refiner can copy an injected instruction into an edge's
   `guidance`, and every later session on that graph then reads it: a persistent,
   self-propagating prompt injection. The paper has no defense beyond "use high-level
   descriptions". See §3.4.
10. **Tool-catalog membership is not enforced.** We enforce it structurally, against the
    capability registry at the revision's time, and treat a tool's disappearance as
    evidence invalidation (the node is stale, the revision is flagged).

### 2.3 The one-sentence reading

Localization and gated iteration carry the result; the graph is a compact, inspectable
carrier for conditional advice between tool calls, and it is only as good as the gate
that admits edits to it.

## 3. Mapping onto the harness

### 3.1 What we already have that the paper had to build

| Paper piece | Harness piece today | Gap |
|---|---|---|
| Trajectory `T_t` | Session log (SL1–SL4): ordered, durable, replayable; hook bus (HK1–HK5) with per-plugin cursors and saga correlation | A projection from log entries to `(action, observation)` steps |
| Score `S ∈ [0,1]` | Evals: judge verdicts `passed / failed / inconclusive / blocked` with the catalog's best reachable judge | Map verdicts to scores; `inconclusive` and `blocked` are *excluded*, never 0 |
| Refiner, guidance model | Cognitive core: task taxonomy, selection, cascade; constrained decoding (JSON Schema) | Two new task categories in the catalog data |
| Candidate evaluation on `D_val` | Evals runner, suites | A PG-aware suite and a rollout port |
| Durable offline loop | Durable workflows (journaled calls, resume by replay) | The evolution loop as a workflow |
| Baselines ExpeL / AutoGuide / AWM / MemoryBank / RAP | Lessons (ExpeL, ReasoningBank, ACE deltas), workflow builder (AWM-like), session memory (MemoryBank/RAP-like) | Nothing: our reproduction can compare PG against our own baselines |
| Solver | Agent worker (`ToolLoopAgent`), harness sessions | A per-step guidance hook |

### 3.2 Procedural beside semantic and episodic memory

The paper places PG in CoALA's procedural-memory quadrant. The harness has episodic and
semantic memory (vector recall) and lessons (distilled text). The PG does not replace any
of them: it is the *connective structure* between procedures. Lessons that are about a
transition become candidate edge attributes; lessons that are about facts stay lessons.
Memory items can be cited by edges as evidence. A node can be a durable workflow, so the
graph is also the index of what the workflow library can do next.

### 3.3 The three integrations the request names

1. **The agent bus write-ahead log.** Every guidance step is an effect: its inputs (graph
   revision, active node, window digest) and its output are recorded in the session log
   before the solver sees them, like a workflow journal entry. Replay reuses recorded
   guidance and never regenerates it. The pinned graph revision is recorded at session
   start, so a trajectory always names the exact graph that shaped it. Evolution
   decisions (proposed, prepared, validated, committed, rejected) are events on the hook
   bus, so plugins and other daemons can follow them as a saga.
2. **Agent trajectory evolution.** Trajectories are projections of the log, keyed by the
   revision they ran under. Each revision accumulates evidence: match rate, per-edge
   traversal counts and outcomes, steps, tokens. Evolution consumes scored trajectories
   and produces revisions; the population of trajectories evolves because the graph they
   run under does.
3. **Dynamic workflow composition.** Nodes can be tools, skills or library workflows. A
   path that is traversed often, succeeds, and has one unconditional choice at each step
   is a candidate to *compile*: the workflow builder writes a durable workflow for it from
   the trajectories that took it, and a candidate revision replaces the path with one node
   that calls it. The same gate decides. In the other direction, at run time the agent's
   path through the graph composes tools and workflows, and a task-graph plan can be
   instantiated from a subgraph (features D: "compiler for known workflows, planner for
   novel parts").

### 3.4 Invariants the paper does not need but we do

- **Advisory, never authority.** Guidance cannot grant or widen capabilities; grants and
  approvals stay in the core. A graph edit that names a tool the session cannot use is
  inert for that session.
- **Provenance on every edit.** Each revision records its parent, its edit set, the
  trajectories the refiner saw, the gate's evidence, and who committed it (the loop, or an
  approver).
- **Tainted text stays quarantined.** Tool output is untrusted; the refiner is told so,
  guidance is framed to the solver as advice, and optional human approval of commits uses
  the existing approver routing.
- **Scope.** A graph belongs to an owner and a procedure domain. Nothing is shared across
  owners by default.
- **Frozen per episode.** A session pins one revision; evolution never changes a running
  session's graph.
