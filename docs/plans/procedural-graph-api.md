# Procedural graphs: API contract

This is the contract that parallel implementation work builds against. The plan says
what the package does and why (`docs/plans/procedural-graph.md`); this file fixes module
boundaries and exported names so phases built in parallel fit together.

A phase may add exports, and may refine a signature within its own module when a test
shows it is needed, provided that every export another phase uses keeps its name and
meaning. A change to a shared shape is recorded here in the same commit.

All modules live under `packages/procedural/src/`, are pure (no host globals, no Node
builtins, no `Date.now`, no `Math.random`), import siblings with `.ts`, and use erasable
syntax only. Refined types are zod-branded and made by parsing. Errors that callers
handle are values (`Diagnostic[]`, result unions), not exceptions.

## P1: schemas and types (`graph.ts`, `overlay-types.ts`, `trajectory.ts`, `settings.ts`, `canonical.ts`)

### `canonical.ts`

- `canonicalJson(value: unknown): string`: sorted object keys, no whitespace, arrays in
  the order given.
- `sha256Hex(text: string): string`: via `@noble/hashes/sha2.js` and
  `@noble/hashes/utils.js`.

### `graph.ts`

- Refined schemas and types (each exported as `XSchema` and `type X`):
  - `GraphId`: `^[a-z0-9][a-z0-9._/-]*$`, max 200.
  - `NodeName`: `^[A-Za-z][A-Za-z0-9_.-]*$`, max 120.
  - `NodeTypeName`: `^[A-Z][A-Z0-9_]*$`.
  - `RelationName`: `^[A-Z][A-Z0-9_]*$`.
  - `RevisionId`: a 64-character lowercase hex sha256, with its own brand.
  - `EntryId`: a 64-character lowercase hex sha256, with its own brand.
  - `TrajectoryId`: a non-empty string, max 200, with its own brand.
  - `DreamId`: a non-empty string, max 200, with its own brand.
- `Score` is re-exported as cognitive's `Probability`.
- `DEFAULT_NODE_TYPES = ["ACTION","REASONING","STATUS"]`.
- `DEFAULT_RELATIONS = ["LEADS_TO","TRIGGERS","PROVIDES_INPUT_FOR","CONVERGES_TO"]`.
- `START = "Start"`, `END = "End"`.
- `Binding` is a discriminated union on `kind`:
  - `{kind:"tool", name}`;
  - `{kind:"workflow", name, code: Sha256}`;
  - `{kind:"skill", name, content: Sha256}`.
- `GraphNode = { id: NodeName; type: NodeTypeName; description: string; binding?: Binding }`
- `GraphEdge = { from: NodeName; relation: RelationName; to: NodeName; condition: string | null; guidance: string; pitfalls: string }`
- `CandidateDocumentSchema` has these fields, with no cross-field checks:
  - `$schema?`;
  - `format: "harness.procedural-graph/v1"`;
  - `nodeTypes`;
  - `relations`;
  - `nodes`;
  - `edges`.
- `type CyclePolicy = "allowed" | "forbidden"`.
- `interface Diagnostic { code: DiagnosticCode; message: string; at?: string }` has
  these codes:

  | Code | Meaning |
  |---|---|
  | `malformed` | the document is not well formed |
  | `duplicate-node` | two nodes share an id |
  | `unknown-type` | a node type is outside the vocabulary |
  | `unknown-relation` | a relation is outside the vocabulary |
  | `missing-endpoint` | an edge names a node that does not exist |
  | `missing-start` | there is no `Start` node |
  | `no-terminal` | a node cannot reach a terminal |
  | `cycle` | a cycle under `forbidden` |
  | `tool-not-in-catalog` | an action node names a tool outside the catalog |
  | `binding-not-allowed` | a binding appears where bindings are not allowed |
  | `filtered` | the edit filter rejected text |
- `checkGraph(doc: CandidateDocument, cycles: CyclePolicy): Diagnostic[]` runs the
  structural checks of App. B.6:
  - ids are unique;
  - types and relations are in their vocabularies;
  - endpoints exist;
  - `Start` exists;
  - every node reaches some node with out-degree 0;
  - under `forbidden`, there are no cycles.
- `parseGraph(input: unknown, cycles?: CyclePolicy): { ok: true; graph: ProceduralGraph } | { ok: false; diagnostics: Diagnostic[] }`.
  `cycles` defaults to `"allowed"`.
- `ProceduralGraph` is the branded, checked document. `ProceduralGraphSchema` is
  `CandidateDocumentSchema` refined with `checkGraph(…, "allowed")` and branded.
- `graphJsonSchema()` returns the JSON Schema of `CandidateDocumentSchema`. It is written
  to `data/graph.schema.json`, and a drift test checks it.
- `revisionId(doc: CandidateDocument): RevisionId` is the sha256 of `canonicalJson` of
  the document:
  - without `$schema`;
  - with nodes sorted by id;
  - with edges sorted by `(from, relation, to)`;
  - with vocabularies sorted.
- `seedGraph(): ProceduralGraph` returns the scratch skeleton `Start → End` (both typed
  `STATUS`, a `LEADS_TO` edge with empty guidance and pitfalls, and condition `null`).
- `outgoing(g, node)` and `incoming(g, node)` return edges in document order.
  `nodeById(g, id)`.
- `EditSetSchema` is the paper's refiner output, exactly:
  - `add_nodes: {id, type, description}[]`;
  - `delete_nodes: NodeName[]`;
  - `add_edges: {source, target, relation, condition: string|null, guidance, pitfalls}[]`;
  - `delete_edges: {source, target}[]`.

  All four lists default to `[]`. `type EditSet`. `editSetJsonSchema()` is the JSON
  Schema sent to the refiner as its constraint.
- `RevisionRecordSchema` and `type RevisionRecord` have these fields:
  - `id: RevisionId`;
  - `graph: GraphId`;
  - `parents: RevisionId[]`;
  - `document: CandidateDocument`;
  - `edits: EditSet | null`;
  - `origin: "seed"|"dream"|"merge"|"revert"|"import"`;
  - `dream?: DreamId`;
  - `evidence: Record<string, unknown>`;
  - `decision`, a discriminated union on `kind`:
    - `{kind:"head"}`;
    - `{kind:"rejected-structure", diagnostics: Diagnostic[]}`;
    - `{kind:"rejected-gate", gate: string, reason: string}`;
    - `{kind:"pending-approval"}`;
  - `at: number` (milliseconds from the Clock port);
  - `redacted?: true`.

### `overlay-types.ts`

- `OverlayEntry` is a discriminated union on `kind`:
  - `{kind:"edge", from, relation, to, condition, guidance, pitfalls}`;
  - `{kind:"node", id, type, description}`;
  - `{kind:"note", on:{from,to}, text}`;
  - `{kind:"caution", on:{from,to}, text}`.

  There is no `binding` anywhere.
- `EntryStatus = "probation" | "active" | "retired"`.
- `OverlayEvent` is a discriminated union on `kind`:
  - `observed`:
    `{kind:"observed", turnKey: string, path: NodeName[], unmatched: string[], score: Score | null, exposure: EntryId[]}`.
    `turnKey` is `"<sessionId>/<turnId>"`, and the fold ignores a repeated `turnKey`.
  - `proposed`:
    `{kind:"proposed", entry: OverlayEntry, source: {sessions: string[], by: "stats" | "reflection"}}`.
  - `status`: `{kind:"status", entry: EntryId, to: "active" | "retired", reason: string}`.
  - `rebased`:
    `{kind:"rebased", core: RevisionId, absorbed: EntryId[], dropped: EntryId[], frozenAt: number}`.
    `frozenAt` is the overlay version that sessions still pinned to the old core keep.
- `EdgeStats = { traversals: number; scored: number; scoreSum: number; lastSeen: number }`.
  `lastSeen` is the overlay version.
- `TransitionStats = { sessions: string[]; scored: number; scoreSum: number }`. The
  sessions are distinct and capped at 64.
- `EntryEvidence = { exposed: {n, scored, scoreSum}; unexposed: {n, scored, scoreSum}; support: string[]; firstSeen: number; lastSeen: number }`.
- `OverlayState` has these fields:
  - `base: RevisionId`;
  - `version: number` (the count of events folded);
  - `entries: Record<EntryId, {entry, status, evidence}>`;
  - `stats: Record<string /* "from→to" */, EdgeStats>`;
  - `transitions: Record<string /* "from→to" */, TransitionStats>`;
  - `turns: string[]` (the turn keys seen; bounded, with the oldest dropped after 10,000).
- `EffectiveNode = GraphNode & { origin: "core" | "overlay"; status?: EntryStatus }`.
- `EffectiveEdge = GraphEdge & { origin: "core" | "overlay"; status?: EntryStatus; notes: {text, status}[]; cautions: {text, status}[] }`.
- `EffectiveGraph = { core: RevisionId; overlay: number | null; nodes: EffectiveNode[]; edges: EffectiveEdge[] }`.
- `coreView(g: ProceduralGraph): EffectiveGraph` gives the core alone: `overlay: null`,
  every item `origin: "core"`, and no notes or cautions.

### `trajectory.ts`

- `ScoredTrajectorySchema` / `type ScoredTrajectory` has these fields:
  - `id: TrajectoryId`;
  - `graph: GraphId`;
  - `core: RevisionId`;
  - `overlay: number | null`;
  - `session: string`;
  - `turn: string`;
  - `query: string`;
  - `steps`: learning's `StepSchema` array;
  - `score: Score | null`;
  - `scoreSource: "metric" | "judge-probability" | "judge-verdict" | "outcome" | "feedback" | null`;
  - `localization: {matched: number, fallback: number, inert: number}`;
  - `usage: {steps: number, inputTokens: number, outputTokens: number, guidanceTokens: number}`.

### `settings.ts`

- `SettingsSchema` and `parseSettings(input)` follow the plan's §4.6 shape:
  - `presets: {paper, harness}` and optional custom presets;
  - `decoding`;
  - `prompts`.
- `settingsJsonSchema()`, `data/settings.json` and `data/settings.schema.json`, with a
  drift test.
- The paper's prompts (App. B.5) are stored verbatim in the data file: solver slot,
  guidance and refiner.
- `Preset` type. `presetOf(settings, name): Preset`.
- Constants `HOPS = 2` and `WINDOW = 3`.

As built (P1). These are additions; nothing above changed meaning.

- `parseSettings` throws on invalid input, naming where, as learning's does.
  `presetOf` throws a `RangeError` for an unknown name.
- A `Preset` has these fields:
  - `overlay: boolean`;
  - `match: "exact" | "case-insensitive"`;
  - `turnBoundary: "start" | "carry"`;
  - `delivery: "system" | "trailing-message"`;
  - `guidancePrompt: "paper" | "harness"`;
  - `guidanceCache: boolean`;
  - `overlayRefresh: "turn" | "session"`, which defaults to `"turn"` (plan §5.1);
  - `repinOnDream: "turn" | "never"`, which defaults to `"turn"` (plan §5.1);
  - `live?: LiveSettings`, which is required when `overlay` is true;
  - `dream: DreamSettings`.
- `LiveSettings` has these fields:
  - `reflection: "off" | "turn" | "batch"`;
  - `probationShare: Probability`;
  - `minSupport: int ≥ 1`;
  - `promote: {confidence: Probability}`;
  - `halfLifeDays: number > 0`, named as in plan §4.6;
  - `maxEntries: int > 0`.
- `DreamSettings` has these fields:
  - `mode: "incremental" | "onetime"`;
  - `rounds` (K);
  - `cycles: CyclePolicy` (c);
  - `contextTokens` (L_max);
  - `context: "tail-concatenated" | "tail-per-trajectory"`;
  - `gate: Gate[]`, at least one;
  - `rejections: {dedupe, show: "all" | "recent-and-similar", limit?}`, where `limit`
    is required for `recent-and-similar`;
  - `enforceToolCatalog: boolean`;
  - `editFilter: boolean`;
  - `noninferiority?: {totalLoss, confidence, power}`, all `Probability`. It is required
    when the anchored non-inferiority gate is listed.
- `GATES` lists `structure`, `evidence`, `evaluator-at-least-retained`,
  `evaluator-anchored-noninferiority`, `approval` and `approval-for-side-effects`. A
  `Gate` is one of them, or an evaluator gate with a trailing `?`.
- `decoding` holds `temperature`, `topK`, `solverMaxTokens` and `refinerMaxTokens`.
- `sessions: {idleMs, max}` (positive ints; shipped as 30 minutes and 1024) bounds the
  step hook's per-session state (P10).
- `graphContext: {local: {desc, source}, full: {desc, source}}` fills
  `{graph_context_desc}` and `{graph_source}`. `full` is App. B.5's wording.
- `prompts` holds `solver`, `guidance`, `guidanceHarness`, `refiner`, `dream` and
  `reflection`. `PLACEHOLDERS` names the `{slots}` each must keep, and parsing checks
  them:

  | Prompt | Slots |
  |---|---|
  | `solver` | `system_prompt`, `procedural_graph_guidance`, `trajectory` |
  | `guidance`, `guidanceHarness` | `task_description`, `graph_context_desc`, `subgraph_summary`, `query`, `recent_context`, `graph_source` |
  | `refiner` | `task_description`, `mode`, `available_tools_list`, `attempts_block`, `current_graph_json`, `rejected_block` |
  | `dream` | the refiner's, plus `overlay_entries_block`, `cautioned_edges_block`, `rejection_reasons_block` |
  | `reflection` | `graph_context`, `trajectory` |

  The refiner prompt also contains literal JSON braces, so a renderer fills only
  `{identifier}` slots.
- `guidancePromptOf(settings, preset): string` returns the guidance template the
  preset names.
- Also exported:
  - `FORMAT`;
  - `DIAGNOSTIC_CODES` and `DiagnosticSchema`;
  - `BindingSchema`, `GraphNodeSchema`, `GraphEdgeSchema` and `DecisionSchema`;
  - `type ParsedGraph`;
  - `OverlayEntrySchema`, `OverlayEventSchema` and `EntryStatusSchema`;
  - `type Arm` (`{n, scored, scoreSum}`).
- `NodeTypeName` and `RelationName` are checked strings without a brand. The other ids
  are branded, and a lint rule forbids casting to them.
- A parsed document or graph is deeply frozen. Build a new one rather than mutating it.
- `RevisionRecordSchema` also checks that `id` is `revisionId(document)`, unless the
  record is `redacted`.
- A turn key must match `^[^/]+/.+$`.

## P2: edits (`edits.ts`, `filter.ts`)

- `applyEdits(base: CandidateDocument, edits: EditSet): CandidateDocument` works on a
  copy. It deletes nodes and edges first; deleting a node removes its incident edges, and
  `delete_edges` removes every relation between the endpoints. Then it adds nodes, then
  edges.
- `prepareCandidate(base: ProceduralGraph, edits: EditSet, options: { cycles: CyclePolicy; tools?: readonly string[]; filter?: { observations: readonly string[] } })`
  returns `PreparedCandidate`, which has these fields:
  - `document`;
  - `id: RevisionId`;
  - `graph?: ProceduralGraph`, present only when the diagnostics are empty;
  - `diagnostics: Diagnostic[]`;
  - `repaired: {from, to}[]`.

  The options work as follows:
  - Under `forbidden`, edges that close a cycle are removed (repair) before the checks.
  - When `tools` is given, every `ACTION` node must name a tool in it; a node's binding
    name counts, and so does its id.
  - When `filter` is given, `editFilter` runs over the edit text.
- `editFilter(texts: readonly string[], observations: readonly string[], options?: { ngram?: number /* 8 */ }): FilterFinding[]`.
  `FilterFinding = { code: "shared-ngram" | "url" | "absolute-path" | "high-entropy" | "secret"; text: string; detail: string }`.

As built (P2). These are additions; nothing above changed meaning.

- `prepareCandidate` validates the edit set again (it may come from stored JSON). A
  malformed set gives `malformed` diagnostics at `edits.<path>` (or
  `binding-not-allowed` when an edit sets `binding`), and the document is then the base,
  unedited.
- A deletion naming a node the base does not have is `missing-endpoint` at
  `edits.delete_nodes[i]` or `edits.delete_edges[i].source|target`. Deleting edges
  between existing nodes that have none is a no-op.
- Diagnostics come in this order: the edit set, the structure (`checkGraph`, with its
  `nodes[i]`/`edges[i]` paths into the returned document), the catalog (`nodes[i]`),
  then the filter (`filtered`, at `edits.add_nodes[i].id|description` or
  `edits.add_edges[i].condition|guidance|pitfalls`, message `<finding code>: <detail>`).
- Repair cuts the back edges of a depth-first walk from `Start`, then from the other
  nodes in document order, following edges in document order; edges with a missing
  endpoint are left to the checks. `repaired` lists the cut edges in document order as
  `RepairedEdge = {from, relation, to}`.
- `PrepareOptions.filter` also takes `options?: FilterOptions`.
- `editFilter`'s options also take `entropy?: { minLength?: number /* 20 */; hexBits?: number /* 3 */; base64Bits?: number /* 3.5 */ }`.
  A high-entropy run is a run of base64 characters at least `minLength` long that holds
  a digit and a letter and reaches `hexBits` (all-hex runs, one case) or `base64Bits`
  bits per character. Each detector reports at most once per text; `detail` never
  quotes the matched text (a secret or an injected instruction), and a shared n-gram
  names the index of the first observation it occurs in.
- Also exported: `type PreparedCandidate`, `type PrepareOptions`, `type RepairedEdge`,
  `type FilterCode`, `type FilterOptions`, `type EntropyOptions`.

## P3: localization and serialization (`locate.ts`, `serialize.ts`)

- `match(action: string | undefined, g: EffectiveGraph, mode: "exact" | "case-insensitive"): NodeName | undefined`
  returns `Start` when `action` is undefined, and undefined when nothing matches.
  - `exact` compares the node id or the binding name to the action.
  - `case-insensitive` compares both case-insensitively.
- `neighborhood(g: EffectiveGraph, node: NodeName, hops: number): Neighborhood`.
  `Neighborhood = { active: NodeName; hops: EffectiveEdge[][] }`, where index 0 is hop 1.
  Each hop holds outgoing edges reached in exactly that many steps, and an edge appears
  only once.
- `serializeNeighborhood(g: EffectiveGraph, n: Neighborhood): string` follows App. B.5:
  1. "Active Cognitive Node: [X] (Type: T)".
  2. "Description: …".
  3. "Immediate Transition Options (Hop 1):", then "Subsequent Horizon (Hop 2):", with
     "Hop k" for hop 3 and beyond.
  4. Each transition renders as follows. A `null` condition prints nothing in the
     parentheses.

     ```
     - Transition: [A] → [B] (Condition: c)
       * Guidance: g
       * Pitfalls to Avoid: p
     ```

  Overlay content is labeled:
  - an overlay edge's line starts with "Learned (provisional): " or "Learned: ";
  - notes render as "  * Learned note: …", marked provisional while on probation;
  - cautions render as "  * Caution: …".

  A `coreView` graph therefore reproduces the paper's text exactly.
- `serializeGraph(g: EffectiveGraph): string` renders the full-graph variant.
- `serializeWindow(steps, w)` renders the last `w` trajectory steps as text.

As built (P3). These refine the shapes above; no name or meaning another phase uses
changed.

- `type MatchMode = "exact" | "case-insensitive"` and `type Neighborhood` are exported.
- `match` tries, in order, an exact id, an exact binding name, then (case-insensitive
  only) the id and the binding name ignoring case; within a rule the first node in
  document order wins. It reads every node of the effective graph, overlay nodes
  included.
- `neighborhood` always returns exactly `hops` hops; hops past the horizon are empty.
  Hop k holds the outgoing edges, in document order, of the nodes first reached in
  k − 1 steps. It throws a `RangeError` for a node outside the graph or a `hops` that
  is not a whole number.
- `serializeNeighborhood`:
  - A hop with no edges prints nothing, heading included. Hop k ≥ 2 is headed
    "Subsequent Horizon (Hop k):".
  - A null condition prints `(Condition: )`. An empty guidance or pitfalls keeps its line.
  - Bullets are indented by two spaces under their transition.
  - The label follows the list bullet: `- Learned (provisional): Transition: …` on
    probation, `- Learned: Transition: …` once active. An overlay node that is the active
    node prefixes its header the same way: `Learned (provisional): Active Cognitive Node: …`.
  - Notes follow the pitfalls, then cautions:
    `  * Learned note (provisional): …` on probation, `  * Learned note: …` once active,
    and `  * Caution: …` whatever the status.
  - It throws a `RangeError` when the active node is not in the graph.
- `serializeGraph` prints "Procedural Graph Nodes:" with one
  `- Node: [X] (Type: T)` / `  * Description: …` pair per node, then
  "Procedural Graph Transitions:" with every edge in the local format, in document order.
  Labels are as above.
- `serializeWindow(steps: readonly Step[], w: number)` takes learning's steps. `w`
  counts decisions, as the paper's `T_{t-w:t}` counts actions: a decision is a run of
  assistant steps with the steps that follow it. Steps before the first decision (the
  query) are never in the window. A step renders as `User: `, `Thought: ` (assistant) or
  `Observation: ` (tool, observation) and its content, omitted when empty, then
  `Action: name(k=v, …)` when it has a call, each value as canonical JSON. It throws a
  `RangeError` when `w` is not a whole number.

## P4: overlay (`overlay.ts`, `overlay-policy.ts`)

- `entryId(entry: OverlayEntry): EntryId` is the sha256 of the entry's canonical JSON.
- `emptyOverlay(base: RevisionId): OverlayState`.
- `foldOverlay(state: OverlayState, event: OverlayEvent): OverlayState` is pure and does
  not mutate its input. It is idempotent for `observed` events, by `turnKey`, and for
  `proposed` events: a re-proposal adds support. `version` increments per event applied.
- `foldAll(base, events)`.
- `effectiveGraph(core: ProceduralGraph, overlay: OverlayState, view: { salt: string; probationShare: number }): EffectiveGraph`:
  - It includes the core unchanged (I2).
  - It includes `active` entries.
  - It includes `probation` entries only when `exposed(view.salt, id, share)` is true.
  - It never includes `retired` entries.
  - An entry whose anchors are missing is skipped.
- `exposed(salt: string, id: EntryId, share: number): boolean` is deterministic: the
  first 8 hex digits of `sha256(salt + id)`, divided by 2³², is below `share`.
- `rebaseOverlay(state: OverlayState, core: ProceduralGraph, absorbed: readonly EntryId[]): { state: OverlayState; event: OverlayEvent /* rebased */ }`.
  Absorbed entries are retired with reason `absorbed`. Entries with missing anchors are
  dropped. The rest carry over, and statistics carry over for edges that still exist.
- In `overlay-policy.ts`:
  - `proposals(state: OverlayState, core: ProceduralGraph, live: LiveSettings): OverlayEvent[]`
    covers two cases:
    - a missing transition with at least `minSupport` distinct sessions becomes a
      templated `edge` entry;
    - an edge with poor scored statistics becomes a templated `caution`.
  - `statusChanges(state: OverlayState, live: LiveSettings): OverlayEvent[]` promotes an
    entry when exposed sessions are non-inferior at `promote.confidence`. It retires an
    entry when they are inferior, when it has gone stale (half-life measured in overlay
    versions), or when it is displaced beyond `maxEntries`.

As built (P4). These refine the above; every name keeps its meaning.

- `version` counts the events that changed the state. A redelivered `observed` (a turn
  key seen) or `proposed` (no new support) event, and a `status` event naming an unknown
  entry or its current status, leave the state, `version` included, as it was (I4). So
  `version` is not the log offset when the log holds redeliveries.
- The fold cannot see the core, so `stats` and `transitions` hold every observed pair of
  consecutive path nodes, edge or not. `proposals` treats the pairs the effective
  structure lacks as missing transitions. Each entry's support and each transition's
  sessions keep at most `MAX_SESSIONS` (64); `turns` keeps `MAX_TURNS` (10,000).
- An `observed` turn is evidence for each entry that is not retired when its path
  reaches the entry's anchor node: an edge's `from`, a node's `id`, a note's or caution's
  `on.from`. It goes to the `exposed` arm when `exposure` names the entry, and to the
  `unexposed` arm otherwise. It also sets the entry's `lastSeen`.
- `rebased` folds by setting `base`, retiring `absorbed` and removing `dropped`.
  `rebaseOverlay` returns exactly that fold, so a replay reproduces it. Only live overlay
  entries (neither retired nor absorbed) anchor others. Statistics carry over unchanged,
  and those of vanished edges stay dormant.
- `effectiveGraph` lists core items first, then overlay nodes, then overlay edges, in
  proposal order. It skips an overlay node that names an existing node, and an overlay
  edge that repeats a `(from, relation, to)` already shown. Notes and cautions attach to
  every edge between their endpoints.
- `exposed(salt, id: string, share)` takes any string id.
- Also exported:
  - `edgeKey(from, to)`, the `"from→to"` key;
  - `MAX_TURNS` and `MAX_SESSIONS`;
  - `differenceBounds(a: Arm, b: Arm, confidence)`, which returns
    `{difference, lower, upper}`;
  - `decayedSupport(evidence, version, halfLife)`.
- The statistic is one-sided Hoeffding bounds on the difference of two means of scores
  in [0, 1]. The margin is `t = sqrt(ln(1/(1−c)) · (1/n_a + 1/n_b) / 2)`. It is valid at
  every sample size for fractional scores, and conservative.
- `statusChanges(state, live, options?: { margin?: number })` works on entries that are
  not retired, once both arms have `minSupport` scored turns:
  - It retires an entry as inferior when the upper bound of `exposed − unexposed` is
    below `−margin`.
  - Otherwise it retires an entry as stale when its decayed support is below 0.5
    sessions. Support halves every `halfLifeDays` overlay versions without evidence.
  - Otherwise it promotes a probationary entry as non-inferior when the lower bound is
    above `−margin`. All bounds are at `promote.confidence`.
  - Beyond `maxEntries` live entries, it displaces the lowest-ranked: probation before
    active, then by decayed support, then by `lastSeen`, then by id.

  `margin` defaults to 0, where promotion needs confidently better outcomes, because
  `LiveSettings` has no margin yet.
- `proposals` works as follows:
  - A missing transition becomes an edge entry. Its relation is `LEADS_TO` when the
    core's vocabulary has it, and the core's first relation otherwise. It has condition
    `null`, guidance `"Observed after <from> in <N> sessions[, mean score <m>]."` and
    empty pitfalls.
  - A caution requires `minSupport` scored traversals on the edge and elsewhere, and a
    Hoeffding upper bound below 0 against the rest of the graph.
  - Any existing entry for the pair, in any status, blocks a re-proposal.

## P5: model calls (`guide.ts`, `refine.ts`, `reflect.ts`)

All of these use AI SDK `generateText` on a `LanguageModel`. Our settings go under
provider options `harness` (`@harness/cognitive` `constrain`).

- `renderPrompt(template: string, vars: Record<string, string>): string` fills
  `{placeholders}`.
- `guide({ model, template, task, graphContext, graphContextDesc, graphSource, query, recent, maxOutputTokens?, temperature?, topK?, abortSignal? }): Promise<{ text: string; usage }>`.
- `class GuidanceCache`:
  - `key({core, overlay, node, query, window, model}): string`;
  - `get(key)`;
  - `set(key, text)`;
  - `hits()`;
  - `misses()`.

  The cache is scoped by its instance, which is per session.
- `refine({ model, template, task, mode, tools, attempts, graphJson, rejected, consolidation?, maxOutputTokens? }): Promise<{ edits: EditSet; raw: string } | { error: string; raw: string }>`.
  It is constrained by `editSetJsonSchema()`.
- `reflect({ model, template, graphContext, trajectory, maxOutputTokens? }): Promise<OverlayEntry[]>`.
  It is constrained to an entries schema, and never includes a binding.

As built (P5). These are additions; nothing above changed meaning.

- `type Decoding` is `{ temperature?, topK?, maxOutputTokens?, abortSignal? }`, the AI SDK's
  own settings. `guide`, `refine` and `reflect` each accept all four and pass them through
  to `generateText`; an omitted one is not sent.
- `renderPrompt` fills `{identifier}` slots in one pass: a value is inserted verbatim and
  never filled again, and a slot with no value (or any other braces) stays as it is.
- `readJsonBlock(text): { ok: true; value: unknown } | { ok: false; error: string }` reads
  the whole answer as JSON, or else its block from the first `{` to the last `}`.
- `guide` returns `usage` as the AI SDK's `LanguageModelUsage`, and sends no constraint.
- `GuidanceCache.key` takes `GuidanceKeyParts`:
  `{ core: RevisionId; overlay: number | null; node: NodeName | undefined; query: string; window: string; model: LanguageModel }`.
  `node` is undefined for the full-graph fallback. `model` is a model or its id; a model
  counts as `"<provider>:<modelId>"`. The key is canonical JSON of
  `[core, overlay, node ?? null, sha256(query), sha256(window), model]`, so it holds no
  query or window text. `get` returns `string | undefined` and counts a hit or a miss.
- `refine` takes these, beside `model`, `template` and the decoding settings:
  - `task`, `mode`, `attempts`, `graphJson` and `rejected`, all strings, filling
    `{task_description}`, `{mode}`, `{attempts_block}`, `{current_graph_json}` and
    `{rejected_block}`;
  - `tools: readonly string[]`, joined with `", "` into `{available_tools_list}`;
  - `consolidation?: { overlayEntries: string; cautionedEdges: string; rejectionReasons: string }`,
    filling dream's three blocks.

  Its constraint is `{type: "json-schema", schema: editSetJsonSchema()}` through
  `constrain`. An answer that is not JSON, or not an edit set, is `{error, raw}`, with the
  error naming where. A failing model call still rejects.
- `reflect` takes `graphContext` and `trajectory` (strings). Its constraint is
  `reflectionJsonSchema()`, `{entries: (note | edge)[]}`: reflection proposes only notes
  and edges. Each entry is parsed on its own, and one that is malformed, of another kind or
  carries a binding is dropped. A malformed answer yields `[]`.
- Exported types: `GuideRequest`, `GuidanceKeyParts`, `RefineRequest`, `RefineResult`,
  `ReflectRequest`.

## P6: dream (`dream.ts`, `gates.ts`, `dream-runner.ts`)

- The reducer:
  - `dreamStart(input: DreamInput): DreamState`.
  - `dreamStep(state: DreamState, event: DreamEvent): { state: DreamState; commands: DreamCommand[] }`.
- Commands are a discriminated union on `kind`:
  - `evaluate {revision, graph, tasks: "validation"}`;
  - `rollout {revision, batch}`;
  - `select {revision, limit}`;
  - `refine {…}`;
  - `prepare {…}`;
  - `approve {candidate}`;
  - `commit {record}`;
  - `reject {record}`;
  - `rebase {…}`;
  - `done {result}`.

  Every event carries the result of one command. The reducer implements Algorithm 1 for
  `incremental` and `onetime`, and the consolidation inputs of plan §7.
- Gates in `gates.ts` are pure `(evidence) → {pass: boolean; reason: string}`:
  - `structureGate`;
  - `atLeastRetained`;
  - `anchoredNonInferiority`, with a power-sized δ helper `powerMargin(n, discordance, confidence, power)`;
  - `evidenceGate`;
  - `approvalGate`.
- `runDream({ store, graph, settings, ports: { refiner, evaluator?, approver?, trajectories, clock, entropy } }): Promise<DreamResult>`.
  It drives the reducer, appends every event to the store's dream log, resumes by replay,
  and holds the lease.
- `interface Evaluator { evaluate(graph: ProceduralGraph, split: "train" | "validation", batch?: readonly string[]): Promise<{ task: string; score: number }[]> }`.

As built (P6). These refine the shapes above; the names other phases use keep their meaning.

- Commands carry an `id`, and every event is `{command, at, kind, …}`: the id of the
  command it answers and the Clock's time, which stamps the records the reducer builds.
  `DreamEventSchema` parses events (the runner parses the log on replay). The pairs are
  `evaluate → evaluated {scores, seed}`, `rollout → rolled-out {results}`,
  `select → selected {trajectories}`, `refine → refined {result: RefineResult}`,
  `approve → approved {approved}`, `commit → committed {ok}`, `reject → recorded` and
  `rebase → rebased {event}`. `done` has no event. An event for a command that is not
  pending is ignored (a redelivery); an event of the wrong kind throws a `RangeError`.
- `DreamState.pending` holds the commands issued and not answered: `dreamStart`'s state
  holds the first, and after a replay it holds exactly those to re-issue.
- There is no `prepare` command: the reducer runs `prepareCandidate` itself (pure), with
  the tool catalog when `enforceToolCatalog` and the edit filter over the round's tool
  observations when `editFilter`.
- `DreamInput` has `dream`, `graph`, `head` (G₀), `settings: DreamSettings`,
  `evaluator` and `approver` (booleans), `train` (task ids), `stride`, `task`, `tools`,
  `sideEffectFree`, `overlay?: {state, live}` and `rejections: RevisionRecord[]`.
- With an evaluator a round rolls out a stride of training tasks
  (`rollout {revision, graph, batch}`), strides wrapping in order; without one it selects
  recorded trajectories (`select {revision, limit: stride}`). `onetime` is one round over
  every training task with no S₀ and no evaluator or evidence gate; approval gates still
  apply. The refiner's `{mode}` is `static_…` or `scratch_…` (G₀ is the seed skeleton)
  with the dream's mode.
- Context: `tail-concatenated` keeps the last `contextTokens` tokens of the concatenated
  trajectories; `tail-per-trajectory` orders them from the highest and lowest scores
  inward (unscored last) and keeps each body's last `contextTokens / k` tokens under its
  header. `tailTokens(text, limit)` counts whitespace-separated tokens.
- Gates run in the order structure, evidence, evaluator gates (listed order), approval.
  A gate listed without `?` that needs an evaluator fails without one. `evidence`
  without an overlay fails. Approval asks the approver (`approve {candidate, tools}`)
  under `approval`, or under `approval-for-side-effects` when an added (or re-added)
  edge routes into an `ACTION` tool not declared free of side effects.
- A refiner answer that is not an edit set is a structural rejection kept in memory
  without a record. A rejected candidate whose id is G₀, the retained graph or one of
  the dream's commits is kept in memory and never stored. With `rejections.dedupe`, a
  candidate whose id is a known rejection is not evaluated (`known-rejection`), and one
  equal to the retained graph is skipped (`unchanged`). Without dedupe (the paper) an
  unchanged candidate is evaluated, and accepting it only updates the cached score.
- `recent-and-similar` shows up to `limit` rejections, one per id, those proposed
  against the retained graph first, then the most recent.
- Consolidation: live entries with status, support and both arms; the retained graph's
  edges with a live caution or `poorStatistics`; the shown rejections' reasons. Each
  block is `None` when empty.
- A commit issues `rebase {core, absorbed}` when the dream has an overlay;
  `absorbedEntries(overlay, base, candidate)` names the live entries the candidate
  absorbs: an edge (same triple) or node it has, a note whose text an edge between its
  endpoints now carries, a caution on an edge it pruned. A failed compare-and-set ends
  the dream (`conflict`).
- Gates, as built:
  - `structureGate({diagnostics})`; `atLeastRetained({candidate, retained})` (means);
  - `anchoredNonInferiority({candidate, retained, anchor, sizes, totalLoss, confidence, power, seed, resamples?})`
    on per-task `TaskScore = {task, score}` lists, with `pairedDifference(a, b, confidence, seed, resamples = 2000)`
    (`newcombe` when every paired score is 0 or 1, else `bootstrap`), `graphSize(doc)`
    (`{items: nodes + edges, chars}`) and `normalQuantile(p)`. δ is
    `powerMargin(n, n · (w / z_c)², confidence, power)`, where w is the lower half-width
    of the interval. It throws for a confidence not above 0.5;
  - `evidenceGate({base, candidate, overlay, minSupport, confidence})`, with
    `poorStatistics(overlay, from, to, {minSupport, confidence})`;
  - `approvalGate({required, approved?})` and
    `routesIntoSideEffects(base, candidate, sideEffectFree)`.
- The runner: `runDream({store, graph, settings: Preset, ports, task?, tools?, sideEffectFree?, stride?, holder?, dream?})`
  returns `DreamResult`: `{status: "done", …DreamOutcome}`, `busy`, `no-head` or
  `lease-lost`. The dream log holds `{kind: "started", dream, head, overlay, rejections, train, stride}`
  and `{kind: "event", dream, event}` entries. The stride defaults to the training tasks
  once over the rounds with an evaluator, and `DEFAULT_SELECT` (20) without one. The
  paper preset starts every dream with an empty rejection memory (`H_rejected ← []`);
  with `dedupe` the rejection records already stored are remembered.
- Ports: `Evaluator` also has `tasks(split)`, and `evaluate` may return each training
  task's `query` and `steps` (`RolloutResult`); `Refiner.refine(DreamRefineRequest)`;
  `Approver.approve({graph, candidate, tools})`; `TrajectorySource.select({graph, revision, limit})`;
  `clock` and `entropy` are structural (`now()`, `bytes(n)`). `modelRefiner({model, settings})`
  adapts `refine`, with the dream prompt when there is consolidation.

## P7: stores (`store.ts`, `memory-store.ts`, `snapshot-store.ts`)

- `interface AppendLog<E> { append(events: readonly E[]): Promise<number>; read(from: number, limit?: number): Promise<{ offset: number; event: E }[]>; head(): Promise<number> }`.
- `interface ProceduralStore` has these members:

  | Member | Methods |
  |---|---|
  | `revisions` | `put(r)`, `get(id)`, `list(graph)` |
  | `heads` | `get(graph)` returns `{revision, history: RevisionId[]}` or undefined; `set(graph, expected: RevisionId \| undefined, next): Promise<boolean>`, a compare-and-set |
  | `overlay(graph)` | returns an `AppendLog<OverlayEvent>` |
  | `dreams(graph)` | returns an `AppendLog<unknown>` |
  | `pins` | `get(session)` returns a `Pin` or undefined; `set(session, pin)` |
  | `guidance` | `put(id, text)`, `get(id)` |
  | `lease` | `acquire(graph, holder)` returns `{epoch}` or undefined; `renew(graph, holder, epoch)`; `release(graph, holder, epoch)` |
  | `redact(id)` | redaction |

- `Pin = { graph: GraphId; core: RevisionId; overlay: number; salt: string; at: number }`.
- `MemoryProceduralStore` holds everything in memory.
- `SnapshotProceduralStore(storage: SnapshotStorage)` persists through the core
  `SnapshotStorage` port, which covers every host.
- `proceduralStoreContract` lives in `@harness/testkit`, with tests `PS1.x`.
- Semantics both implementations share (the contract checks them):
  - a put with a known id replaces the record in place; a redacted id stays redacted;
  - setting a head to the revision it already names succeeds and adds no history;
  - an empty append changes nothing; `read` with a negative or fractional offset or
    limit rejects with a `RangeError`;
  - lease epochs only grow per graph (across releases and reopens), and a lease has no
    expiry: its holder re-acquires under a new epoch;
  - redaction (`redactRecord`) replaces every text with `TOMBSTONE` (descriptions,
    non-null conditions, guidance, pitfalls, edit texts, decision reasons, diagnostic
    messages, strings in evidence) and sets `redacted: true`.
- Also exported: `MemoryProceduralStore.document()` and `new MemoryProceduralStore(document)`
  (`ProceduralStoreDocument`, `STORE_FORMAT`), `ProceduralStoreDocumentSchema` and
  `PinSchema`. The snapshot store runs operations one at a time in issue order, saves
  after each change, and rejects a malformed saved document rather than resetting it.

As built (A1). These change P7's keys; every other name keeps its meaning.

- Revision records are keyed by graph and id: `revisions.get(graph, id)`. The same
  document in two graphs is two records, each with its own origin, parents and decision,
  and a put replaces only its own graph's record (PST1.49). Callers read a graph's records
  only: import, read, pinning's ancestry, the step hook, the learner and dream all pass
  the graph they work on, so an import into one graph never overwrites another's record
  (PX2.71).
- `redact(id)` is by content: it tombstones every graph's record of the id, and a record
  put under that id later, in any graph, is stored redacted (PST1.50).
- The saved document's format is `harness.procedural-store/v2` (`STORE_FORMAT`). The
  snapshot store still loads a `v1` document (`STORE_FORMAT_V1`,
  `ProceduralStoreDocumentV1Schema`, checked like v2) through
  `migrateStoreDocument(v1): ProceduralStoreDocument`, and its first change saves v2
  (PST1.51). The migration turns each v1 `revert` record back into the record it replaced
  (`evidence.replaces`, through reverts of reverts; a redacted one, which no longer
  parses, stays) (PST1.53), and gives a graph whose head or earlier head has no record of
  its own a copy of the record another graph wrote last (PST1.52). A malformed v1 store is
  rejected like a malformed v2 one, never migrated or overwritten (PST1.54).

## P8: core, generic (`packages/core`, `packages/protocol`)

- `session/new` accepts `_meta.harness.session`, an arbitrary JSON object. It is stored on
  the session and in `DaemonSnapshot`, and passed on every prompt command as
  `sessionMeta?: Record<string, unknown>`. Core never interprets it.
- `Daemon.publish(input: { source: string; type: string; sessionId?: string; correlationId?: string; cause?: string; payload: unknown }): Result<HookEvent, HookError>`
  is host-side only. Peers cannot choose `source`.

As built (A1). These are additions; nothing above changed meaning.

- `Daemon.readLog(sessionId: string, from = 0, to = Infinity): readonly LogEntry<unknown>[]`
  is host-side only. It returns the session's entries in `[from, to)` without copying
  any other session's log (`snapshot()` copies them all). Entries compacted below the
  log's base are gone, so a read starts there; a read past the head, or of an unknown
  session, is empty; a negative or fractional bound is a `RangeError` (DM10.12–DM10.15).
- `Daemon.sessionIds(): string[]`, host-side, names every session the daemon holds in
  creation order, restored ones included (DM10.16), so a host reads every log with
  `readLog` instead of a snapshot.

## P9: resolver and policy (`resolver.ts`, `policy.ts`, `pinning.ts`)

- `ResolverSchema` (data plus `resolverJsonSchema()`, drift-tested). Its rules are
  `{ when: { meta?: Record<string,string|"*">; cwdUnder?: string; principal?: string }, graph: string | null }`,
  where `graph` is a template with `${meta.x}`, `${principal}` and `${cwd}`. The first
  match wins.
- `resolveGraph(resolver, context: { meta?: Record<string, unknown>; cwd?: string; principal?: string }): GraphId | undefined`.
- `authorize(policy, action: "read" | "write" | "dream" | "revert" | "import", graph: GraphId, context): boolean`.
  The default is to allow.
- `pinSession({ store, session, graph, entropy, clock, repinOnDream }): Promise<Pin>` pins
  the head. On a turn boundary it re-pins when the pin's core was reverted, and when the
  head moved under `repinOnDream: "turn"`. With `"never"` it keeps the pin's core and the
  overlay version recorded by `rebased.frozenAt`.

As built (P9). These are additions; nothing above changed meaning.

- `resolver.ts`:
  - `parseResolver(input): Resolver` (branded; throws a `RangeError` naming where) and
    `ResolverSchema`. A template naming anything but `meta.<key>`, `principal` or `cwd`,
    or an unterminated `${`, is refused at parse time.
  - `explainResolve(resolver, context): Resolution`, where
    `Resolution = { graph: GraphId | undefined; rule: number | undefined; reason: string }`.
    `resolveGraph` is its `graph`. The first matching rule decides even when its result
    is invalid: a missing or non-scalar template value, or a result that is not a
    `GraphId`, resolves to no graph with that reason (no fall-through).
  - `ResolveContext = { meta?, cwd?, principal? }`, `WhenSchema`, `type When` and
    `matches(when, context)`. A meta key is a flat key or a dotted path into nested
    records. A meta value matches as its string form (strings, numbers, booleans); `"*"`
    matches any value that is not null. `cwdUnder` matches on a path boundary (`/` or
    `\`). `principal` is exact, or `"*"` for any.
- `policy.ts`:
  - `ACTIONS`, `type Action`, `AccessPolicySchema`, `parsePolicy(input): AccessPolicy`
    (branded) and `policyJsonSchema()`. A policy is
    `{ rules: [{ when: When & { actions?: Action[]; graph?: pattern }, allow: boolean }], default: "allow" | "deny" = "allow" }`.
    A graph pattern's `*` is any run of characters (`globMatches(pattern, text)`).
  - `authorize(policy: AccessPolicy | undefined, …)`: no policy allows everything; else
    the first matching rule decides, then the default.
  - `ACTIONS` also has `approve`: deciding the candidates in a graph's approvals inbox
    (listing them included), so a policy can give that to fewer principals than `dream`.
- `pinning.ts`:
  - `PinRequest` also takes `overlayRefresh?: "turn" | "session"` (default `"turn"`):
    with the core kept, `"turn"` moves the pin to the overlay's latest version on that
    core and `"session"` keeps it. `clock` and `entropy` are structural
    (`{ now() }`, `{ bytes(n) }`), so core's `Clock` and `Entropy` fit.
  - The salt is `SALT_BYTES` (16) bytes from `Entropy` as hex, drawn once per session and
    kept across graphs and re-pins. `at` is the Clock time of the last change; a pin
    that did not change is not written.
  - "Reverted" means the head no longer descends from the pinned core through revision
    `parents`, or the head's record has origin `revert` (or is missing). Under `"never"`
    the old core is kept only when the head descends from it.
  - The overlay log starts on the graph's first head (the oldest in `Head.history`).
    Version 0 is the empty overlay and pairs with any core, so a head whose rebase has
    not landed is pinned with overlay 0 until it does.
  - `pinSession` throws a `RangeError` for a graph with no head.
  - Also exported: `overlayBases(initial, events)` (the core each version is built on),
    `latestOn(bases, core)`, `overlayAt(core, events, version)` and
    `readOverlay(store, pin): Promise<OverlayState>` (the state a pin reads).

## P10: worker hook (`packages/workers`, plus `procedural/src/step.ts`)

- In workers:
  - `TurnOptions` gains `sessionMeta?` and `report?(update: SessionUpdate)`.
  - `AgentWorker` passes both through.
  - `sessionAgent({ …, step?: StepHook })` wires AI SDK `prepareStep` to
    `step.prepare({ sessionId, sessionMeta, messages, initialInstructions, stepNumber, report })`.
    That returns `{ instructions?, messages? }`.
  - The hook localizes from `messages`, not from `steps`.
- In procedural:
  - `proceduralStep(deps: { store, resolver, settings, model, clock, entropy }): StepHook`
    implements plan §5 (resolve, pin, match, neighborhood, serialize, cache, guide,
    delivery, step record).
  - The step record is a notice with `_meta.harness.procedural.step`.
  - A turn-level variant serves `harnessSessions`.

As built (P10). These refine the shapes above; no name or meaning another phase uses
changed.

- Workers:
  - `TurnOptions` is `{ sessionId; turnId?; cwd?; sessionMeta?; report? }`. `AgentWorker`
    fills all of them from the prompt command; `report` is its own `update`. The agent's
    `callOptionsSchema` keeps every field.
  - `StepHook = { prepare(StepContext): Promise<{ instructions?; messages? } | undefined>; turn?(TurnContext): Promise<string | undefined>; end?(StepEndContext): Promise<void> }`.
    `TurnScope = { sessionId; turnId?; cwd?; sessionMeta?; report }`.
    `StepContext = TurnScope & { messages; initialInstructions; stepNumber; model; tools }`
    (`model` is the step's; `tools` names the tools the turn offers).
    `TurnContext = TurnScope & { messages; lastAction: string | undefined; tools }`.
    `StepEndContext = TurnScope & { stepNumber; usage: LanguageModelUsage }`: a step's
    model usage once it ended. `sessionAgent` returns a `ToolLoopAgent` whose `stream` and
    `generate` add an AI SDK `onStepEnd` (after the caller's own, or its deprecated
    `onStepFinish`) that calls `end`; `harnessSessions` calls it from the harness's
    `onStepEnd`. A failing `end` reports a `warning` notice "Step usage failed".
  - `sessionAgent({ step })` returns a per-call `prepareStep` from `prepareCall`, which
    closes over the turn's options (rather than `runtimeContext`). A hook that throws
    leaves the step as it was and reports a `warning` notice "Step guidance failed".
  - `harnessSessions(agent, { step })` calls `step.turn` in `stream` when the last message
    is a user message (a continuation after an approval round ends with tool results and
    is not guided again), and prepends the returned text, followed by a blank line, as the
    first text part of that message. `lastAction` is the last tool call of the session's
    earlier steps, from `onStepEnd`. A failing `turn` reports "Turn guidance failed".
- Procedural (`step.ts`):
  - `proceduralStep(deps: ProceduralStepDeps): ProceduralStepHook`, structurally a workers
    `StepHook` (procedural does not depend on workers). `ProceduralStepDeps` is
    `{ store; resolver: Resolver; principal?; settings; preset? /* "harness" */; model? /* the step's own */; clock; entropy }`;
    `principal` is the owner the resolver sees for every session (the host's).
    The turn variant needs `model`, since a harness turn has none.
  - A turn boundary is a new `turnId` (or, without one, step 0). At a boundary the session
    re-resolves (`resolveGraph` over its meta and cwd), re-pins (`pinSession` with the
    preset's `repinOnDream` and `overlayRefresh`), reads the pinned core, and reads the
    overlay at the pin (`readOverlay`). An overlay whose base is not the pinned core is
    replaced by an empty one. Every step until the next boundary reads that pair (I3). A
    missing or unparsable (for example redacted) pinned revision throws.
  - Per-session state (the pinned view and the guidance cache) is kept in least recently
    used order and evicted: by `forget(sessionId)` (the host's call when the daemon
    detaches the session; the daemon has no session close), when the session has been
    idle for longer than `settings.sessions.idleMs` by the `clock` (swept at the next step
    or turn of any session), and, beyond `settings.sessions.max` sessions, the least
    recently used one. A step of a session whose state is gone that continues its turn
    (`stepNumber > 0`, or a restarted stream whose conversation does not end with a user
    message, as after an approval round) reads the stored pin as it is when it is on the
    resolved graph, so the turn keeps its pair (I3); otherwise the step is a boundary.
  - Localization reads `messages` without system messages and advisories; under `start`
    only from the last user message on. The action is the last `tool-call` of the last
    assistant message that has one. The task is the first user message's text, the query
    the last one's; the window is `serializeWindow` over those messages as learning steps.
  - Delivery: `system` returns `instructions` rebuilt from `initialInstructions` plus
    `GUIDANCE_LABEL + text` (`"Procedural Graph Guidance: "`, the paper's solver slot):
    appended after a blank line to a string, or as one more system message.
    `trailing-message` returns `messages` without earlier advisories plus one user message
    `GUIDANCE_LABEL + text` with `providerOptions.harness = ADVISORY` (`{advisory: "procedural"}`).
  - `StepRecordSchema` / `StepRecord`: `{ graph, core, overlay: int | null, node: NodeName | null, action: string | null, matched, inert, others: string[], cached, guidanceId: Sha256, digest: Sha256, exposure: EntryId[], usage: {inputTokens, outputTokens} }`.
    The notice is `{ sessionUpdate: "notice", severity: "info", title: "Procedural step", description, _meta: { harness: { procedural: { step } } } }`
    (`StepNotice`), reported before the step's model call. `digest` is the sha256 of the
    text; `guidanceId` is the sha256 of canonical JSON `[cacheKey, digest]`, and the text
    is `store.guidance.put(guidanceId, text)` when it was generated. `exposure` lists the
    probationary entries (entry ids recomputed from the shown items) among the nodes and
    edges the guidance model was shown: the whole graph, or the neighborhood's edges, its
    active node and their endpoints. `inert` is true when the tools are known and the
    active node is an `ACTION` that neither its id nor its binding's name offers. A
    record's `usage` is the guidance model's.
  - The step's own model usage is known only once the step ends, after its record, so
    `end(StepEndInput)` (the workers' `end`) reports it as a second notice for any session
    that resolves to a graph: `StepUsageNotice`, `{ sessionUpdate: "notice", severity: "info", title: "Procedural step usage", description, _meta: { harness: { procedural: { usage: StepUsage } } } }`
    with `StepUsageSchema` `{ inputTokens, outputTokens }` (ints ≥ 0; an undefined count
    is 0). It reads no store. `StepScope<N = StepNotice>` names what a scope reports;
    `StepEndInput = StepScope<StepUsageNotice> & { stepNumber; usage }`.

## P11: live learner (`learner.ts`, `projection.ts`)

- `projectTurn(entries: readonly LogEntryLike[], context): ScoredTrajectory | undefined`.
  It maps ACP updates (`tool_call`, `tool_call_update`, agent text, and
  `_meta.harness.procedural.step` notices) into steps, the path of matched nodes, and
  exposure.
- `class LiveLearner({ store, settings, clock, readLog: (sessionId, from, to) => Promise<LogEntryLike[]>, score?: (trajectory) => Promise<{score, source} | null> })`:
  - `onHookEvent(event)` handles `turn.ended`: project, append `observed`, then append
    `proposals` and `statusChanges`. It is idempotent by `turnKey`.
  - `feedback(session, turn, score)`.

As built (P11). These refine the above; the names keep their meaning.

- `LogEntryLike = { offset: number; payload: unknown; at?; kind? }`: core's `LogEntry` of
  the daemon's `LogPayload` (`{update}` or `{event, data}`) is one.
- `projectTurn(entries, context)` is `turnProjection(entries, context)?.trajectory`.
  `turnProjection` returns `TurnProjection`:
  `{ trajectory, path: NodeName[], unmatched: string[], shown: EntryId[], gaps: LogGap[], started, ended, next }`.
  - `ProjectionContext = { sessionId; turnId; from?; pin?: VersionPair; locate?: (action) => NodeName | undefined; terminal?: (node) => NodeName | undefined; score?: {score, source} | null }`,
    with `VersionPair = { graph; core; overlay: number | null }` and
    `ScoreSource` the trajectory's non-null `scoreSource`.
  - The turn is the entries after its `turn.started` and before its `turn.ended` (by
    `data.turnId`). Without its start, it runs back to the previous turn boundary
    (`turn.started`/`turn.ended`/`turn.interrupted` of another turn), and `started` is
    false; without its end, it runs to the next turn's start or the last entry.
  - Steps: `user_message_chunk` text is a user step; agent message and thought chunks
    are assistant steps (consecutive chunks merge); a `tool_call` (title = tool name,
    re-emissions by `toolCallId` counted once) is an assistant step with
    `call {name, arguments: rawInput, or {input: rawInput} when not an object}`; a
    `completed`/`failed` `tool_call_update` is a tool step with its `rawOutput` as text
    (canonical JSON unless a string). The query is the turn's user text.
  - The step record read from `update._meta.harness.procedural.step` is
    `{graph, core, overlay, node?, matched, inert?, exposure?, usage?: {inputTokens?, outputTokens?}}`
    (other fields ignored; a record failing this is skipped). The first record gives the
    version pair; with none, `context.pin` does; with neither the result is undefined.
    `localization` counts records (`inert`, else `matched`, else `fallback`);
    `usage.guidanceTokens` sums their usage. `usage.inputTokens`/`outputTokens` sum the
    turn's step usage records (`_meta.harness.procedural.usage`, `{inputTokens, outputTokens}`,
    reported by the step hook's `end`), which are no steps; a malformed one is skipped.
  - `path` is the first record's node (when the turn started in view, it matched, and no
    tool call preceded it), then `locate(title)` for each tool call in emission order;
    `unmatched` lists the titles `locate` did not match. `shown` is the union of the
    records' `exposure`.
  - Transitions into a terminal have no action, so the path records them by rule: when
    the turn ended (its `turn.ended` in view, with stop reason `end_turn` or none), its
    latest update of substance is agent message text that is not blank (no tool call or
    result after it; thoughts do not count), and the node it answered from is known (its
    last action matched, or with no action it began at a matched node), the path walks on
    to `context.terminal(node)`. The learner passes `terminalAfter(view, node)`
    (`locate.ts`): the one terminal (a node with no outgoing edges in the effective graph
    the session saw) that node has an edge to, or none when it has none or several. So
    edges into `End` get statistics, cautions and entry evidence like any other.
  - `gaps` are the missing offsets `[from, to)` inside the turn, and before it when its
    start was not seen (from `context.from` when nothing bounds it). `next` is the offset
    after `turn.ended`. It never throws.
- `new LiveLearner({ store, settings: Preset, readLog, score?, clock? })`. `settings` is
  the preset in force (its `overlay`, `live` and `match`). `readLog(sessionId, from, to?)`
  reads to the head when `to` is omitted. `clock` is accepted and unused (the fold counts
  versions). `onHookEvent(event: LearnerEvent)` and `feedback(session, turn, score: number)`
  return `Promise<LearnerResult>`: `ignored` (not a `turn.ended` whose `source` is
  `daemon`, or a preset without an overlay), `skipped` with a `code: SkipCode`
  (`unknown-turn`: the turn or its version pair is not found; `no-pin`: feedback for a
  session with no pin; `invalid`: a session id containing `/`, a score outside [0, 1])
  and a reason, `duplicate`,
  `unchanged`, `observed {turnKey, graph, trajectory, gaps, appended}` or
  `rescored {turnKey, graph, appended}`. Store failures reject, so the bus redelivers.
- Localization matches in the graph the session saw: the turn's core with the overlay
  folded to the records' version, viewed through the pin's salt (without a pin, no
  probationary entry), in the preset's match mode. Exposure comes only from the pin's salt: the entries on probation at that version
  that `exposed(salt, id, probationShare)` selects (none without a pin or an overlay
  version).
- Deliveries run one at a time. A turn whose original `observed` event is in the overlay
  log is a duplicate. Observed, proposals (against the head core) and status changes go
  in one `append`.
- Feedback is a re-observation: `observed` gains an optional
  `rescore: { seq: int ≥ 1; previous: Score | null; observedAt: int ≥ 1 }` (P1's schema,
  changed here). The fold moves the turn's score from `previous` to `score` on the
  pairs of its path (no new traversal or session) and in the arm of each non-retired
  entry proposed before version `observedAt` whose anchor the path reached. It keys a
  re-observation `"/<seq>/<turnKey>"` in `turns` (never a turn key), so a redelivered one
  is ignored. Consumers that count turns skip events with `rescore`.

## P12: extension and CLI

- `proceduralExtension({ store, settings, resolver, policy, … })` is a
  `CognitiveExtension` with id `procedural`. Its ops are `graph`, `history`, `feedback`,
  `dream`, `revert`, `import`, `export`.
- `exportMermaid(g: EffectiveGraph): string`.
- Native host: `--procedural <dir>`, and a `harness-procedural` CLI with `dream`,
  `export`, `import`, `revert` and `history`.

As built (P12). These refine the shapes above; no name another phase uses changed.

- `proceduralExtension(options: ProceduralExtensionOptions)` takes:
  - `store`, `settings`, `preset?` (default `harness`; import checks cycles under its
    `dream.cycles`) and `clock: { now(): number }`;
  - `authorize?: (action: ProceduralAction, graph: GraphId) => boolean`, the policy bound
    by the host (P9's `authorize(policy, action, graph, context)` with its context), which
    allows by default. `ProceduralAction` is `"read" | "write" | "dream" | "revert" | "import" | "approve"`;
  - `dream?: (graph) => Promise<unknown>` (the host's P6 `runDream`) and
    `feedback?: (session, turn, score) => Promise<LearnerResult | undefined>` (P11's
    `LiveLearner.feedback`; undefined while no learner runs);
  - `notify?: (notice: ApprovalNotice) => void | Promise<void>`, where the host publishes
    the approvals inbox's notices (an import proposal is `requested`, a decision
    `decided`).

  It takes no resolver: `feedback` finds the graph from the session's pin, and answers
  what the learner did with the score: `recorded` for `observed`, `rescored` and
  `unchanged` (the score is in the overlay), the skip's code for `skipped`
  (`unknown-turn`, with the pin's graph; `no-pin`, when the pin went before the learner
  read it; `invalid`), and `unavailable` when the learner is `ignored` (its preset keeps
  no overlay) or no learner answered. A session with no pin is `no-pin` before the
  learner is asked. Each operation
  parses its input (malformed input throws `invalid procedural.<op> input`), then checks
  the policy for its action (a refusal throws `procedural.<op>: <action> on graph <g> is
  not allowed`), then runs. The ops and their actions:

  | Op | Input | Action | Result |
  |---|---|---|---|
  | `graph` | `{graph, revision?, overlay?}` | read | `{status:"ok", head, revision, origin, document, effective}` or `missing` |
  | `history` | `{graph}` | read | `GraphHistory` |
  | `export` | `{graph, revision?, format?: "json" \| "mermaid", overlay?}` | read | `ExportResult` |
  | `feedback` | `{session, turn, score}` | write (on the pin's graph) | `FeedbackOutcome`: `{status:"recorded", graph}`, `{status:"unknown-turn", graph, reason}`, `{status:"no-pin" \| "invalid", reason}` or `unavailable` |
  | `dream` | `{graph}` | dream | `{status:"done", result}` or `unavailable` |
  | `revert` | `{graph, to?}` | revert | `RevertResult` |
  | `import` | `{graph, document?}` | import | `ImportResult` |
  | `approvals` | `{graph}` | approve | `ApprovalList` |
  | `approve` | `{graph, candidate}` | approve | `ApprovalResult`, or `missing` for an id the graph has no record of |
  | `decline` | `{graph, candidate}` | approve | `ApprovalResult`, or `missing` for an id the graph has no record of |

- `import-export.ts` holds the operations over a store, which the CLI shares:
  - `importGraph({store, graph, document?, clock, cycles?})`: no document is `seedGraph()`.
    Results: `{status:"head"}` for a graph with no head (the record has no parents),
    `{status:"proposed", head}` otherwise (a `pending-approval` import record whose parent
    is the head, for dream or an approver to take up), `{status:"known", decision}` when
    the graph already recorded that revision (nothing is written), or
    `{status:"invalid", diagnostics}`. When another writer sets the head between the
    record and the compare-and-set, the import becomes a proposal on their head.
  - `readGraph({store, graph, revision?, overlay?})` returns `GraphView`. On the head, the
    overlay log is folded from the graph's first head and shown with probation share 1
    (every non-retired entry, the operator's view) when its base is the head; otherwise the
    core alone (`coreView`).
  - `exportGraph({..., format})`: `json` is the stored document, `mermaid` is
    `exportMermaid(effective)`; both end with a newline.
  - `graphHistory({store, graph})`: `{head?, heads (head then history), revisions}`, the
    revisions oldest first, as `RevisionSummary` without documents.
  - `revertGraph({store, graph, to?})`: `to` defaults to the previous head and must
    be an earlier head (not the head itself), recorded and not redacted. The target is
    already recorded under the graph, so no record is written and the target's stays as
    it was (A1: the revert no longer replaces it); the heads record the revert, since the
    head names an earlier head again. A compare-and-set moves the head (a lost race is
    refused, with nothing written), and a `rebased` event onto the target is appended, so
    the overlay follows the head and entries the target cannot anchor are dropped. P9's
    `pinSession` sees a head that is in its own history as a revert and re-pins (PX1.46),
    as it does for a `revert` record a store saved before A1.
- `exportMermaid(g)` renders `flowchart TD`, a `%% core <id>, overlay <n|none>` comment,
  nodes as `n<index>` with the name and type as the label (statuses as stadiums, reasoning
  as rhombi, other types as boxes), edges with the relation and `when: <condition>`,
  overlay nodes in the dashed `overlay` class and overlay edges dashed (`-.->`), labeled
  `learned` or `learned (provisional)`, cautions as `Caution: <text>` lines on their edge's
  label with a `linkStyle` for the cautioned edges. Notes and guidance are left out. Label
  text escapes `# " < > | \`` as Mermaid entities and line breaks as `<br/>`.
- Native host (`packages/platform-native`):
  - `loadProceduralSettings(file?)` and `loadProceduralResolver(file?)` read procedural's
    data files by default, or a deployment's copies; `loadProceduralPolicy(file)` reads an
    access policy.
  - `proceduralStore(dir)` is a `SnapshotProceduralStore` over `FileStorage` at
    `<dir>/procedural.json`.
  - `buildNativeEnsemble({ procedural: { dir, store?, settings?, preset?, authorize?, dream?,
    feedback? } })` installs the extension and returns `procedural: {store, settings}`;
    given `store` (the one `main.ts` opens in `dir`), the extension, the step hook, the
    learner and dream share it.
  - `nativeProceduralStep({store, settings, resolver, principal?, preset?, model?})` is
    P10's `proceduralStep` with `resolveGraph` (the host's principal as the owner),
    `pinSession`, and the host's clock and entropy (`hostPorts`).
    `hostAuthorizer(policy, principal)` is P9's `authorize` bound to the host's principal.
  - `nativeStepEvictions({runtime, step, intervalMs?, log?})` pumps the daemon's
    `session.detached` hook events (plugin `procedural-step`) to `step.forget`; `main.ts`
    starts it with the daemon when it has a step hook.
  - `pumpHookEvents(runtime, {plugin, types, onEvent, intervalMs?, log?})` is an in-process
    plugin connection with a durable hook-bus cursor, acknowledging each event after its
    handler resolves; `sessionLogReader(daemon)` reads a session's log entries in
    `[from, to?)` through the daemon's host-side `readLog`, which copies no other
    session's log (PX2.69).
  - `nativeDream(…)` runs P6's `runDream` on this host; its shape and ports are under
    "Dream from the host" in the finalization's notes below.
  - `nativeLiveLearner({runtime, store, settings, preset?, intervalMs?, log?})` is P11's
    `LiveLearner` (the preset's settings, `readLog` from the daemon) fed by
    `pumpHookEvents` as plugin `procedural-learner` on `turn.ended`; `main.ts` starts it
    with the daemon, and the extension's `feedback` goes to `learner.feedback`.
  - `main.ts` takes `--procedural <dir>` with `--procedural-settings`,
    `--procedural-resolver`, `--procedural-policy` and (P13) `--procedural-composition` files. The step hook goes to
    `sessionAgent` for the model and ensemble workers (guided by the session's own model)
    and to `harnessWorker({ step })` for harness workers (guided by the ensemble's chat
    model, or the gateway model). With the cognitive core, `procedural.*` is served under the
    policy.
- One owner per store directory (A1). `lockStore(dir, holder, {alive?})` takes
  `<dir>/procedural.lock` (`STORE_LOCK`): a complete file hard-linked into place, naming
  `{pid, holder, socket?}`; it returns `{status: "acquired", lock}` (`advertise(socket)`,
  `release()`) or `{status: "held", owner}`. A lock whose process has exited, or that does
  not parse, is stale and taken over (PX2.72–PX2.75). The daemon (`--procedural`) takes it
  as `harness` before it opens the store and exits 1 while another process holds it
  (PX2.78); once it listens on `--socket` it advertises the socket's absolute path, and it
  releases the lock on shutdown. `invokeDaemon(socket, op, input)` runs one
  `_harness/cognitive/invoke` on a daemon over its socket (DL1.3–DL1.4).
- `harness-procedural <history|export|import|revert|dream> <graph>` runs the extension's
  operations on the store in `--procedural <dir>` (default `~/.cache/harness/procedural`),
  holding the directory's lock as `harness-procedural` for the run (PX2.79). When a daemon
  holds it and advertises a socket, the CLI sends `procedural.<command>` to that daemon
  instead, which runs it under its policy with its own settings and models (options for a
  local run are named on stderr as ignored) (PX2.76); a holder with no socket (a daemon on
  `--stdio` or `--ws` only) makes the CLI exit 1 without touching the store (PX2.77). The
  daemon serves `procedural.*` only with the cognitive core, so without it the daemon's
  refusal is the CLI's error.
  `export` takes `--format`, `--revision`, `--no-overlay` and `--out`, `import` an optional
  file, `revert` `--to`, and `dream` `--model` (a gateway id) or else `--model-cache`,
  `--llama-server` and `--no-hosted` (the ensemble's reasoning model), and `--state`. A
  result a caller handles (a dream that did not finish included) exits 1, bad usage 2.
  `harness-procedural approvals <graph>`, `approve <graph> <candidate>` and
  `decline <graph> <candidate>`
  run the inbox's operations; a dream without a terminal leaves candidates that need
  approval in the inbox (saying so on stderr) instead of rejecting them.
- Browser host: `browserProcedural(ensemble, {storage, settings, ...})` installs the
  extension over a `SnapshotProceduralStore` in the given `SnapshotStorage`.

## P13: composition (`compose.ts`)

- `pathCandidates(core, overlayStats, settings)`.
- `compilePath(path, recordedCalls, toolSpecs): Workflow`, a `@harness/workflows`
  `Workflow`.
- `StagingLibrary`, a `WorkflowLibrary` that is never the shared one.
- `revisionTools({ base, pinnedCore, staging })` returns the base tools plus exactly the
  workflows the pinned core binds.

As built (P13). The names above keep their meaning; these are the refinements.

- `pathCandidates(core: ProceduralGraph, events: readonly OverlayEvent[], settings: CompositionSettings): PathCandidate[]`.
  The overlay's `observed` events are the statistics, because support counts distinct
  sessions per path, which `EdgeStats` does not keep. A redelivered turn counts once.
  A turn's score is its latest re-observation's (feedback's `rescore`, by `seq`), so a
  turn scored only by `procedural.feedback` after it was observed counts; a
  re-observation of a turn never observed counts nothing.
  - `PathCandidate = { path: NodeName[]; support: number; turns: number; meanScore: Score }`.
  - `CompositionSettings = { support, minScore: Score, maxLength }`, parsed by
    `parseCompositionSettings`, with `data/composition.json` and a drift-tested
    `data/composition.schema.json` (`compositionJsonSchema()`).
- `recordedRuns(core, trajectories: readonly ScoredTrajectory[], path, mode: MatchMode): RecordedCall[][]`
  takes each window of consecutive tool calls that walked the path.
  `RecordedCall = { name: string; arguments: Record<string, unknown> }`.
- `compilePath(path, recordedCalls, toolSpecs: Record<string, ToolSpec>)` returns
  `{ ok: true; workflow: Workflow } | { ok: false; error: string }`. `ToolSpec` is the
  workflows one. The workflow returns `{ steps }`, every call's result in order.
- `StagingLibrary(staged?: WorkflowLibrary)` refuses code that does not compile and
  keeps a name's code immutable. `stage(workflow)` returns its `WorkflowBinding`
  (`workflowBinding(workflow)`: the name and the sha256 of the code).
- `composeCandidate(core, path, workflow)` returns
  `{ ok: true; node; binding; edits: EditSet; document: CandidateDocument } | { ok: false; error }`.
  An `EditSet` carries no binding, so `document` is the edited core with the binding
  set. That document is what dream gates.
- `revisionTools({ base: ToolSet, pinnedCore: ProceduralGraph, staging: WorkflowHost })`.
  `staging` is a `WorkflowHost` over the staging library. The code hash is checked when
  the tools are built and again at each call.

## Finalization: cross-phase wiring

As built. These close the cross-phase issues the phases recorded; the names above keep
their meaning.

- **Dream composes (P6 × P13).**
  - `DreamSettings` gains `compose?: boolean` (the harness preset sets it; the paper's
    does not). `DreamInput` gains `compose?: boolean`, which the runner sets when the
    settings ask and `DreamPorts.composer` is given.
  - After the last round a composing dream issues one more round's command,
    `compose {revision, graph, known}` (`known`: the ids of the rejections it remembers).
    The runner answers `composed {result}`: a `DreamComposition`
    (`CompositionSchema`: `{path, support, node, binding, edits}`), or `{none: reason}`.
  - The runner's `Composer` port is `{settings: CompositionSettings; toolSpecs; staging: {stage(workflow)}; runs?}`.
    It takes `pathCandidates` over the overlay log's events, reads `runs` (default
    `DEFAULT_SELECT`) recorded trajectories under the head, and for each candidate in rank
    order tries `recordedRuns`, `compilePath`, `composeCandidate` and `staging.stage`.
    The first candidate that composes and is not a known rejection is the answer;
    otherwise the reason names each path and why it failed.
  - The reducer prepares the composition's edits like a refiner's (its node counts as a
    catalog tool), binds the node to the staged workflow, and sends that document through
    the rejection memory and the same gates as any candidate. The record's `edits` are the
    composition's and its `evidence.composition` is `{path, node, support}`. A round with
    nothing to compose ends as `{outcome: "no-composition", reason}`.
  - `evidenceGate` takes `composition?: {node, support}`: the workflow node, and each
    edge into or out of it, are justified when the path's distinct-session support is at
    least `minSupport`. `approval-for-side-effects` sees the workflow node as a tool with
    side effects unless it is declared free of them.
  - The tool catalog check passes an `ACTION` node bound to a workflow: it was compiled
    from catalog tools and is offered only through `revisionTools`.
- **Live reflection (plan §6.2.4).** `LiveSettings` gains `reflectionBatch?` (required
  under `batch`). `LiveLearnerDeps.reflect?: Reflector`, where
  `Reflector = (request: {graphContext, trajectory}) => Promise<readonly OverlayEntry[]>`
  and `modelReflector({model, settings})` is `reflect` with the reflection prompt and the
  refiner's decoding. Under `turn` a scored turn is reflected on at once; under `batch`
  once per `reflectionBatch` scored turns of a graph (held in memory). `graphContext` is
  `serializeGraph` of the graph the turn saw; `trajectory` is each turn's `Score`,
  `Query` and `serializeWindow`. Only notes and edges are kept; each must pass
  `editFilter` against the turns' tool observations, be anchored in the head core or live
  overlay nodes, and be new. It is then `proposed` with `source: {sessions, by: "reflection"}`
  in the turn's one append. A failing reflector proposes nothing. The harness preset keeps
  reflection `off`.
- **Dream from the host.**
  - `logTrajectories({store, sessions}): TrajectorySource` (`SessionLog = {id, entries}`)
    projects each ended turn of the session logs (the version pair from its step records
    or the session's pin), keeps those under the revision asked, scores them from the
    overlay log's latest `observed` event (source `feedback` for a re-observation, else
    null), and selects them balanced from the highest and lowest scores inward, the
    unscored last.
  - Native host: `nativeDream({store, settings, preset?, model, sessions, evaluator?, approver?, composer?, task?, tools?, sideEffectFree?, holder?})`
    returns `(graph) => runDream(…)` with `modelRefiner` on the model, `logTrajectories`
    and the host's clock and entropy, holding the graph's lease as `holder` (default
    `native-host`; the CLI's is `harness-procedural`), so a dream another process holds
    is `busy`. `daemonSessions(daemon)` reads every session's log from the live daemon
    through `sessionIds` and `readLog` (PX2.70), and `snapshotSessions(snapshot)` reads
    the session logs of a saved daemon snapshot (its state file's). `terminalApprover(input, output)`
    asks `[y/N]` on a terminal. With the cognitive core, `main.ts` serves `procedural.dream`
    with the ensemble's `reasoning` generator over the daemon's logs; the live learner gets
    `modelReflector` on the same generator (the gateway `--model` without the core). `harness-procedural dream <graph>`
    runs it from the CLI on `--model <gateway id>`, or else on the ensemble's `reasoning`
    model (`--model-cache`, `--llama-server`, `--no-hosted`; it loads only when the refiner
    is asked), over the session logs of the daemon state file `--state` names, with the
    terminal approver when stdin is a terminal; a dream that is `busy`, `no-head` or
    `lease-lost` exits 1. The daemon has no approver (the permission flow is per session,
    and dream runs outside any session): its dream has the approvals inbox instead (see
    "Approvals inbox").
- **P6's notes.**
  - `DreamSettings.stride?` is the paper's S; `runDream`'s `stride` option overrides it.
  - `DreamInput.tokenizer?` and `runDream`'s `tokenizer?` (`Tokenizer = {encode, decode}`)
    count `contextTokens` in the refiner's tokens; `tailTokens(text, limit, tokenizer?)`.
    Without one, whitespace-separated words are counted, as before.
  - `@harness/testkit` has `evaluatorContract(name, make)` (PD3.1–PD3.4) and
    `ScriptedEnvironment`, a deterministic evaluator over tasks with known routes.
  - A rejection is stored only over no record or another rejection: a candidate equal to
    an older head or an import proposal keeps that record. A commit that loses the head
    race puts back the record it replaced, when that record was not the dream's own.

## Localization extensions (plan §5.2's later list)

As built. These are additions; the paper preset keeps the paper's mechanism exactly.

- **Action hops.** `neighborhood(g, node, hops, unit?: HopUnit)` with
  `type HopUnit = "edge" | "action"` (default `edge`, the paper's). In `action` hops a
  step ends only at an `ACTION` node: the outgoing edges of a non-action node a hop
  reaches first belong to that same hop (breadth first), and the action nodes it reaches
  start the next. Two reasoning nodes after an action (research §2.2 item 3) then no
  longer hide the next tool: from `Retrieve → Scan_Index → Decide_Capital → Answer_Lookup`,
  hop 1 runs to `Answer_Lookup`. An edge still appears once; with every node an action the
  two units agree. `Preset.hopUnit: "edge" | "action"` (default `edge`; both shipped
  presets say `edge`) is the unit `proceduralStep` passes; `h` stays `HOPS`.
- **Argument predicates.** A tool binding may carry `arguments: ArgumentPredicate`, a
  JSON Schema over the call's arguments (`{kind: "tool", name: "Bash", arguments: {type: "object", properties: {command: {type: "string", pattern: "^npm test"}}}}`).
  `ArgumentPredicateSchema` refuses a schema whose top-level `type` is not `"object"` or
  that zod's `z.fromJSONSchema` cannot compile (a `malformed` diagnostic at
  `nodes[i].binding.arguments`). The converter reads a keyword only under a declared
  `type`. `acceptsArguments(predicate, args)` tests a call, compiling each predicate once.
  The predicate is part of the document, so of its revision id; like any binding, only
  seeding, import or dream's composition writes it (I5).
- **State tracker.** `MatchMode` gains `"state-tracker"`, and `match` takes
  `string | ObservedAction | undefined`, where
  `ObservedAction = {name; arguments?; declared?}`: the tool called, the call's
  arguments, and the node the tool's result declared active. Under `state-tracker` the
  rules are, in order, each exact and each the first node in document order: the declared
  node, when the graph has it; a node bound to the tool whose argument predicate accepts
  the arguments; a node bound to the tool without a predicate; a node whose id is the
  tool's name. A node whose predicate rejects the call is never matched by its binding.
  `exact` and `case-insensitive` read only the name, so the paper's `Match` is unchanged.
  `Preset.match` accepts `"state-tracker"`; both shipped presets stay `exact`.
  A result's declared node counts only when the core binds the calling tool with
  `declares: true` (a tool binding field that only dream, a seed or an import can set;
  neither the refiner nor the overlay writes bindings). A tool that passes outside
  content through, such as a fetched page, therefore cannot steer localization,
  successor-only tools or the learner's projected path (PGR3.37).
- **The step hook as a state tracker.** `proceduralStep` observes the last action with its
  call's `input` as the arguments and, as `declared`, `_meta.harness.procedural.node` (a
  string) of the call's own result (the `tool-result` with its `toolCallId` in a later
  tool message, `json` or `error-json` output). A tool, an MCP server (whose
  `CallToolResult._meta` is where the AI SDK puts it) or an environment wrapping tools
  declares the state this way. The step record's `action` is still the tool name.
- **Harness turns as a state tracker.** The workers' `TurnContext` gains
  `lastCall?: LastCall` (`{name, input, output?}`): `harnessSessions` remembers the
  session's last tool call from `onStepEnd` with its id, and pairs it with the result a
  later step reports (a host-executed tool's result arrives in the next step); a call
  whose result never came has no `output`. `lastAction` is its name, as before.
  `TurnInput.lastCall` is the same; the turn variant observes `{name, arguments: input,
  declared: _meta.harness.procedural.node of output}`, and falls back to `lastAction`
  alone without it.
- **Learning and composition locate as guidance did.** `declaredNode(result)` (in
  `locate.ts`) is the one reader of `_meta.harness.procedural.node`. `ProjectionContext.locate`
  takes an `ObservedAction`: each `tool_call` is `{name: title, arguments: rawInput}`, and a
  `completed` or `failed` `tool_call_update` with the same `toolCallId` adds the node its
  `rawOutput` declared (results may arrive in any order; one of no call in view declares
  nothing). `unmatched` still lists names. The live learner locates with the preset's
  mode over these, so a state tracker's paths are the ones guidance saw. `recordedRuns`
  matches each recorded call with its arguments; recorded steps keep a tool's result as
  text, so a declared node is not read there (a path through a declared node that its
  calls' names and arguments do not reach has no recorded run, and composition reports
  it as not composable).
- **Successor-only tools (an ablation).** `Preset.delivery` is now
  `Delivery = {to: "system" | "trailing-message"; activeTools: "all" | "successors"}`
  (`activeTools` defaults to `all`; a bare placement string still parses, as that
  placement with every tool). Both shipped presets say `all`. Under `successors`,
  `prepare` also returns `activeTools`: for each `ACTION` node an edge of hop 1 of the
  neighborhood reaches (so under action hops the first actions past reasoning and status
  nodes), the first of its binding's name and its id that the step's `tools` offer (the
  first, when the tools are unknown), once each. With no matched node, or none of these
  offered, it returns none, and every tool stays offered. The step record then carries
  `activeTools?: string[]` (absent when every tool was offered). The workers' `StepHook.prepare`
  may return `activeTools`, which `sessionAgent` passes to AI SDK `prepareStep` for that
  step only. The turn variant limits a harness turn the same way, for the whole turn
  (the harness runs its own steps): it returns `{ text, activeTools }` in place of the
  text (PW1.99), and `harnessSessions` offers only those of the turn's own host tools
  (`harnessSessions({ tools })`, PW1.98). The harness's builtin tools stay offered: a
  turn cannot limit them (`HarnessAgent`'s `activeTools` is fixed when it is built, and
  filtering builtins needs the adapter's support), nor the agent's own tools, which a
  turn cannot tell from its builtins.

## Routing sessions to graphs (`resolver.ts`, `routing.ts`)

As built. A resolver rule may route instead of naming a graph (plan §8.1).

- A rule is `{ when, graph }` or `{ when, route }`, never both or neither.
  `route = { candidates: (GraphId | { graph: GraphId; description: string })[]; minConfidence: Probability }`
  (`RouteSchema`), with at least one candidate, each named once. `data/resolver.schema.json`
  is regenerated.
- `ResolveContext` gains `prompt?` (the session's first prompt) and `pinned?: GraphId`
  (the graph the session is pinned to).
- `GraphRouter = (request: RouteRequest) => Promise<RouteAnswer>`, where
  `RouteRequest = { prompt; candidates: RouteCandidate[] }` (`{ graph, description? }`) and
  `RouteAnswer = { graph: GraphId | undefined; confidence: Probability }`.
- `explainRoute(resolver, context, router?): Promise<Resolution>` and
  `routeGraph(…)`: template rules resolve as in `explainResolve`. For a route rule:
  - a session pinned to a candidate keeps it without asking the router, so a session is
    routed once and keeps its graph across restarts;
  - otherwise no router, or no prompt yet (empty or blank), is no graph;
  - the router's choice is the graph when it is a candidate chosen at `minConfidence` or
    above; below it, no choice, a choice outside the candidates, or a router that throws
    is no graph, with the reason (the rule still decides: no fall-through).
- `explainResolve` (synchronous) gives a route rule the pinned candidate, or no graph with
  "needs the router".
- `modelGraphRouter({ model, settings }): GraphRouter` calls cognitive's `route` (the
  cascade's router step, with its calibrated confidence from provider metadata
  `harness.confidence`, 0 without it) with the first prompt as input and one tool,
  `GRAPH_TOOL` (`choose_graph`). The tool's description is `settings.prompts.route` with
  `{graphs}` filled by one line per candidate (`- id` or `- id: description`); its input
  schema is `{ graph: { enum: candidates } }`, the constraint. A valid call names the
  choice; no call chooses none. `settings.json` gains `prompts.route`
  (`PLACEHOLDERS.route = ["graphs"]`).
- `routes(resolver, context): boolean` says whether the deciding rule routes.
- The step hook: `ProceduralStepDeps.router?: GraphRouter`. At a turn boundary a session
  whose rule routes is resolved with `explainRoute`, its prompt the first user message of
  the conversation (system and advisory messages aside) and `pinned` its stored pin's
  graph; other sessions resolve as before, without reading the pin. The router's answers
  are kept per session by request, so a session routed to no graph is not asked again for
  the same prompt; a router that throws is asked again at the next turn. Harness turns
  (`turn`) route the same way. `core(scope)`, which composition asks for a turn's tools
  before its first step, routes by `scope.messages` (the turn's conversation): workers'
  per-turn `tools` are told it (`ToolContext`), and `sessionTools` passes it on
  (`ToolsScope`), so a routed session is offered the workflows of the graph it is
  routed to (PW1.92, PC1.53, AW1.22). Without the messages a routing session has no graph
  for that turn. A step's usage record (`end`) finds a routed session's graph by its pin.
- Native host: `nativeProceduralStep({ …, router?: LanguageModel })` wraps it in
  `modelGraphRouter` with the host's settings. With the cognitive core, `main.ts` passes
  the ensemble's `languageModel("tool-calling", "router")`; without it a routing rule
  gives no graph, and an ensemble with no router member fails the route (no graph) at
  each turn until one serves.

## Plans from subgraphs (`plan.ts`, core `task-graph.ts`)

As built. Plan §7.6's task-graph item and ADR 0017's "the task graph gains payloads".

- Core's `TaskGraph<P = unknown>`:
  - `NodeSpec<P>` gains `payload?: P`, opaque to the graph; `payload(id): P | undefined`.
  - `toJSON(): TaskGraphData<P>` is `{ nodes: TaskNodeData<P>[]; edges: TaskEdgeData[] }`
    in the order added (`TaskNodeData = { id, join, resources, awaits, status, sealed, payload? }`,
    `TaskEdgeData = { from, to, kind }`). The revision is not stored: it is the count of
    structural changes, which rebuilding repeats.
  - `static fromJSON<P>(data: unknown, payload?: (raw: unknown) => P): TaskGraph<P>`
    rebuilds nodes, edges and seals through `addNode`, `addEdge` and `seal`, so restored
    data obeys every rule they enforce, then sets statuses and refuses any no execution
    reaches: a running, succeeded or failed node that was never ready (its join unmet or
    an awaited group unsealed), or a skipped node that can still be satisfied. `payload`
    checks each payload (its error is named); without it payloads are kept as given.
    Anything invalid throws an `Error` saying what and where.
- `planFromSubgraph(graph: EffectiveGraph, from: string, to: string, options?: PlanOptions): PlanResult`:
  - The subgraph is every node on some path from `from` to `to` (both included), over
    edges whose relation is a dependency.
  - Its `ACTION` nodes become tasks, in the graph's node order, each with
    `PlanPayload = { node: { id, type, description }; binding: Binding | null }`
    (`PlanPayloadSchema`).
  - `PlanOptions.relations: PlanRelations` maps each relation to a `DependencyKind` or
    null (no dependency). The default `PLAN_RELATIONS` makes `PROVIDES_INPUT_FOR` data and
    `LEADS_TO`, `TRIGGERS` and `CONVERGES_TO` control. An edge whose relation it does not
    name is an `unknown-relation` diagnostic (at `edges[i]`), so a custom vocabulary says
    what its relations mean.
  - Reasoning and status nodes contract away: a task depends on every task it reaches
    through them, nearest first. Such a dependency is data only when every edge on the way
    is data (the same kind when they agree, else control); two ways of different kinds
    give an edge of each kind.
  - `PlanResult = { ok: true; plan: TaskGraph<PlanPayload> } | { ok: false; diagnostics }`.
    Diagnostics: `missing-endpoint` (at `from` or `to`), `unreachable` (a new
    `DiagnosticCode`: `to` is not reachable from `from`) and `cycle`, for a cycle through a
    task, which the task graph refuses (a plan runs each task once, though the paper allows
    cycles). A loop among reasoning and status nodes alone contracts away.
  - `parsePlan(data): TaskGraph<PlanPayload>` is `TaskGraph.fromJSON` with every payload
    parsed by `PlanPayloadSchema`.
  - Plans run from the daemon (below); dream does not emit plans.

## Running plans (`plan-run.ts`, `plan-task.ts`, `plan-runner.ts`)

As built. This closes the gap "nothing runs plans yet".

- **Settings are data.** `Settings` gains `plans: { concurrency }` (a positive whole
  number; 4 in the shipped file) and the prompt `planTask`, whose placeholders are
  `{task}`, `{guidance}` and `{inputs}` (`PLACEHOLDERS.planTask`).
- **`runPlan(options: RunPlanOptions): Promise<PlanRunResult>`** (pure) runs a plan with
  the task graph's own scheduler: each round it starts `plan.schedule(concurrency - running)`
  (the ready tasks, in order, within joins, exclusions and resources) and waits for one to
  finish. `RunPlanOptions = { plan; outcomes?; task: PlanTask; settings: Pick<Settings, "plans">; save? }`.
  - `PlanTask = (input: PlanTaskInput) => Promise<TaskOutcome>`, with
    `PlanTaskInput = { id; payload: PlanPayload; inputs }`: `inputs` are the outputs of the
    task's `data` predecessors by task id (control predecessors give none).
    `TaskOutcome = { ok: true; output } | { ok: false; error }` (`TaskOutcomeSchema`). A
    task that throws fails with the error's message; the task graph then skips what can
    no longer run (`complete`'s rules).
  - `save(state: PlanRunState)` is called after every change (a task started, a task
    finished), one call at a time and in order, with
    `PlanRunState = { plan: TaskGraphData<PlanPayload>; outcomes: Record<id, TaskOutcome> }`.
    A save that fails stops the run: `runPlan` rejects with its error and starts nothing
    more (tasks already running finish unsaved).
  - A run is resumable. `parsePlanRun(data): RestoredPlanRun` (`{ plan, outcomes }`)
    restores a saved state, checking the plan as `parsePlan` does and the outcomes against
    its statuses (a succeeded task has a success, a failed one a failure, no other task
    has one). `runPlan({ ...restored, ... })` continues from the statuses: finished tasks
    are not run again and their outputs feed their dependents; a task restored as
    `running` was interrupted and runs again, so a task runs at least once (a bound
    workflow's journal makes its steps once). A plan restored by `parsePlan` alone also
    runs, without the outputs of tasks it has no outcome for.
  - `PlanRunResult = { status: "succeeded" | "failed"; tasks: PlanTaskReport[]; state }`:
    `succeeded` when every task did; `PlanTaskReport = { id; status; output? | error? }`
    in plan order. A run's result does not depend on where it was interrupted and resumed
    (PC1.P5).
- **`modelTask({ model, tools, settings, graph? }): PlanTask`** runs a task on an AI SDK
  model. A bound task (tool, workflow or skill binding, called by its name) is one
  `generateText` step offered only that tool, with `toolChoice: { type: "tool" }`: the
  tool's input schema constrains the answer. The prompt is `prompts.planTask` with
  `{task}` (`[id] (Type: type)` and the node's description), `{guidance}` (the node's
  incoming transitions in `graph`, as `serializeTransitions` writes them, the guidance
  serializer's lines; empty without a graph) and `{inputs}` (JSON); decoding is the
  solver's (`temperature`, `topK`, `solverMaxTokens`). The tool's result is the output;
  its error, arguments its schema refuses and a tool without a result are failures; a
  bound tool not in `tools` fails without a model call; an answer with no call throws the
  SDK's `ToolChoiceViolationError`, which `runPlan` takes as a failure. An unbound task is
  done by the model in text, offered no tools.
- **`planRunner(options: PlanRunnerOptions): PlanRunner`** (pure) is what a host runs
  plans with: `{ store; runs: PlanRunStore; settings; entropy; task; notify? }`.
  - `run(graph, plan)` keeps the run in `runs` (a `PlanRunRecord = { id: PlanRunId; graph; state }`,
    `PlanRunId` 16 hex digits from the entropy port) before its first task starts and
    after every change, runs it with the tasks `task(context)` gives
    (`PlanTaskContext = { graph; view?: { core; effective } }`, the graph's head and its
    effective graph when it has a head), drops it when it ends, announces
    `PlanNotice = { type: "procedural.plan.completed"; payload: PlanRunOutcome }` and
    returns `PlanRunOutcome = { run; graph; status; tasks }`.
  - `resume()` runs every kept run to its end, one after another, from its state; a kept
    run whose state does not parse is dropped and reported as
    `InvalidPlanRun = { run; graph; status: "invalid"; reason }`.
  - `SnapshotPlanRuns(storage: SnapshotStorage)` is the `PlanRunStore` over the core
    storage port: `{ runs: PlanRunRecord[] }`, saved whole after every change, one change
    at a time; a change whose save fails is rejected and forgotten.
  - `modelTasks({ model, tools, settings })` is the `task` port over `modelTask`: `tools`
    is a tool set, or a function of the run's context; the effective graph guides.
  - `HostComposition.planTools(core)` is a plan's tools on a host with composition: the
    base tools as they are then plus exactly the workflows `core` binds (`revisionTools`).
- **Operations.** `procedural.plan { graph, from, to }` (action `read`) answers
  `{ status: "ok", revision, overlay, plan }` (the plan's JSON, from the head with its
  overlay), `{ status: "invalid", diagnostics }` or `missing`. `procedural.run { graph, plan }`
  or `{ graph, from, to }` (never both; action `run`, and `read` too when it builds the plan)
  runs it with `ProceduralExtensionOptions.plans` (`Pick<PlanRunner, "run">`) and answers
  the `PlanRunOutcome`; a plan JSON that does not parse is `{ status: "invalid", reason }`,
  and without a runner it is `unavailable`. The policy's `ACTIONS` gain `run`
  (`data/policy.schema.json` regenerated).
- **Native host.** `nativePlanRunner({ dir, store, settings, model, tools?, notify? })`
  keeps runs in `plan-runs.json` in the `--procedural` directory (`planRunsStore(dir)`, a
  `FileStorage`, under the directory's lock). With the cognitive core the daemon runs plans
  on the ensemble's chat model, with the session tools plus the workflows the graph's head
  binds (`composition.planTools`; the workflow library's tools without composition),
  announces each end on the hook bus (`hookNotifier` takes `ApprovalNotice | PlanNotice`),
  and once up resumes the runs a stopped daemon left, logging each end
  (`describePlanRun`). `harness-procedural plan <graph> <from> <to> [--run]` prints the
  plan or runs it, sent to a daemon that holds the store; run locally, its tasks run on
  `--model` or else the ensemble's chat model and call only the workflows the head binds
  (the CLI has no session tools), and a run it leaves behind is resumed by the next
  daemon on the directory. A failed run exits 1.
- **Browser host.** `browserProcedural` takes `plans`, and
  `browserPlanRunner(ensemble, { store, storage, settings, model?, tools?, notify? })` is
  the runner over a page's store, on the ensemble's chat model by default, with runs kept
  in `storage` (an `IndexedDbStorage` under its own key); a page resumes with `resume()`.

## Scheduled dream and the task-suite evaluator

As built. These close the gap "dream runs on demand only; no host configures an
evaluator"; the names above keep their meaning.

- **The schedule is data.** `DreamSettings` gains `every?: Duration` and `afterTurns?`
  (a positive count). `Duration` is a refined type (`DurationSchema`, `duration(text)`):
  days, hours, minutes and seconds in that order (`90s`, `15m`, `6h`, `1d`, `1h30m`),
  parsed into positive whole milliseconds; a number is milliseconds already, so parsed
  settings parse again to themselves. `afterTurns` counts observed turns, so a preset
  without an overlay refuses it. The harness preset dreams every `7d` or after `50`
  observed turns, whichever comes first; the paper preset has no schedule.
- **The runner.** A dream's `started` entry records the Clock's time as `at` (entries
  written before have none and still replay); `DreamLogEntrySchema` (and `DreamLogEntry`)
  parses the dream log's entries for readers such as the schedule. A run that throws
  releases its lease (its epoch, so a lease another run took is left alone): the log
  keeps every finished command, so any holder resumes the dream.
- **Graphs of a store.** `MemoryProceduralStore.graphs()` and
  `SnapshotProceduralStore.graphs()` name every graph with a head, in the order each got
  its first. It is not on the `ProceduralStore` port: a host that tends every graph (the
  schedule) takes the list from its own store.
- **The schedule (`dream-schedule.ts`).** `new DreamSchedule({store, settings: Preset, graphs, dream: DreamRun, clock})`,
  where `DreamRun = (graph) => Promise<DreamResult>` is the host's `runDream` under its
  lease holder. `due(graph)` returns `DreamDue = {due, reason?: "every" | "afterTurns", last, turns, overlay}`:
  `last` is the latest time in the graph's dream log (a `started` entry's `at` or an
  event's), or the head record's `at` before any dream; `turns` counts the overlay log's
  `observed` events without `rescore` from the offset the last dream started from; an
  unset condition never holds, and a graph with no head is never due. `tick()` checks
  every graph `graphs()` names and dreams those due, and resolves with a
  `ScheduledDream` per graph it acted on (`{graph, reason, result}`, or `{graph, reason?, error}`
  for a dream that threw or a dream log that does not parse); it never throws. A graph
  whose scheduled dream is running is skipped, a tick while another is still checking
  does nothing, and a preset without a schedule reads nothing (`enabled` is false). The
  dream log is read incrementally; the schedule also remembers when it started each
  graph's dream (and the overlay head then), so a dream that throws before it logs
  anything waits until it is due again. Everything else it reads is in the store, so a
  restarted host keeps the schedule.
- **`exclusiveDream(run)`** runs one dream per graph at a time in a process: a call for a
  graph whose dream is running answers `busy` at once and leaves the lease alone (a
  holder may take its own lease again, which would strand the running dream). Another
  process's dream holds the lease, so `runDream` answers `busy`.
- **The runtime's tick (`packages/runtime`).** `DaemonRuntime.onTick(listener)` runs a
  listener on every `tick()`, after the daemon's own, and returns a function that removes
  it; listeners are not awaited, a failure (thrown or rejected) is logged as
  `tick listener failed: …`, and `close()` removes them all. Hosts already call `tick()`
  from their ticker, so periodic host work needs no timer of its own.
- **The schedule on the native host.** `nativeDreamSchedule({runtime, store, settings, preset?, dream, log?})`
  builds a `DreamSchedule` over the preset (default `harness`), every graph
  `store.graphs()` names and the host's clock, and runs its `tick()` on every tick of
  the runtime (`onTick`); it returns `{schedule, close}`. Each outcome is one line:
  `procedural: scheduled dream of <graph> (<reason>): done, <n> rounds, head unchanged|now <id>`,
  `…: busy|no-head|lease-lost`, or `… failed: <why>`. `proceduralStore(dir)` now returns
  its `SnapshotProceduralStore`. `main.ts` wraps `nativeDream` in `exclusiveDream` and
  gives the same function to `procedural.dream` and to the schedule, whose lines go to
  stderr; `--procedural` alone turns the schedule on, with the preset's `every` and
  `afterTurns` (a deployment's `--procedural-settings` may unset both for on-demand only).
- **Task suites (`task-suite.ts`).** A user's task file parses with `parseTaskSuite(json)`
  into a branded `TaskSuite` (`TaskSuiteSchema`; its JSON Schema is
  `data/task-suite.schema.json`, drift-tested, from `taskSuiteJsonSchema()`):
  `{$schema?, description?, instructions?, scorer, judge?: {instructions}, tools?: [{name, description?}], tasks: [{id, prompt, expected?, split: "train" | "validation"}]}`.
  `scorer` is one of `TASK_SCORERS` (`exact`, `normalized-exact`, `f1`, `judge`). Task
  ids and tool names are unique, every task has `expected` unless the scorer is `judge`,
  and there is at least one validation task. `description` is the refiner's
  `{task_description}`, `instructions` the solver's. The metrics: `normalizeAnswer`
  (SQuAD's: lower case, no punctuation, no articles `a`/`an`/`the`, single spaces),
  `f1Score(answer, expected)` (token F1 over normalized tokens, repeats counted; two
  empty answers agree), and `scoreAnswer(metric, answer, expected)` (`exact` compares
  trimmed text).
- **The task-suite evaluator (`task-evaluator.ts`).** `taskSuiteEvaluator({suite, settings, preset?, model, guidance?, judge?, tools?, clock, entropy})`
  is an `Evaluator`. `tasks(split)` lists the split's ids in file order. `evaluate(graph, split, batch?)`
  holds the candidate as the only head (graph `candidate`) of a `MemoryProceduralStore`
  of its own, so it never touches the host's graphs, and runs each task, one after
  another, on a `sessionAgent` (`@harness/workers`, now a dependency) with the
  `proceduralStep` hook over that store (the preset named, `harness` by default; the
  guidance model, or the solver's), the suite's `instructions`, and the suite's tools:
  those `tools` (a `ToolSet`, or a function called once per evaluation) names, with the
  suite's descriptions where it gives them; nothing else is offered, and a name the host
  lacks rejects the evaluation. The final text is the answer: a metric scores it, or the
  judge (resolved once per evaluation) is asked with `experimental_evaluate` the boolean
  question `correct` (the suite's `judge.instructions`, else the settings' new optional
  `prompts.taskJudge`) about `{task, expected?, answer}`, and its probability is the
  score. Validation returns `{task, score}`; training also `query` (the prompt) and
  `steps` (`trajectorySteps`, now exported from `step.ts`, over the prompt and every
  step's response messages). Building one refuses a `judge` scorer without a judge or a
  question; an unknown batch id is a `RangeError`, and a failing solver names its task.
  `evaluatorContract` (PD3.1–PD3.4) runs against it on scripted models.
- **The evaluator on the native host.** `loadTaskSuite(file)` reads and parses a task
  file; `nativeTaskEvaluator({suite, settings, preset?, model, guidance?, judge?, tools?})`
  is `taskSuiteEvaluator` with the host's clock and entropy. `main.ts` takes
  `--procedural-eval <tasks.json>` (with `--procedural`): the solver is the ensemble's
  `chat` model with the cognitive core, else the gateway `--model`; the judge is the
  catalog's (`ensemble.resolve("judgment", "judge")`, resolved when a judge-scored suite
  runs); the tools are the workflow library's (`workflowTools`, with `--workflows`);
  and `nativeDream` gets the evaluator and the suite's `description` as its task, for
  `procedural.dream` and the schedule alike. It refuses to start (exit 2) without
  `--procedural`, with a file that does not parse, with a judge-scored suite and no
  cognitive core, or with a suite naming tools and no workflow library.
  `harness-procedural dream <graph> --procedural-eval <tasks.json>` does the same from
  the CLI: the solver is the `--model` gateway model, or else the ensemble's `chat`
  model, and the judge the catalog's; it refuses (exit 2) a malformed file, a
  judge-scored suite with `--model` (no ensemble to judge), and a suite naming tools
  (the CLI has no workflow library).

## Approvals inbox

As built. Candidates that need approval no longer need someone to ask during the dream;
the names above keep their meaning.

- **Dream proposes (P6).** `DreamInput.inbox?: boolean` (the runner sets it when
  `DreamPorts.inbox` is given). When an approval gate applies and there is no approver,
  the reducer issues `propose {record, tools}` instead of rejecting: the record is the
  candidate with decision `pending-approval` and `evidence.approval = {gate, tools}`. The
  runner answers `proposed`, and the round's outcome is
  `{outcome: "pending-approval", revision, gate}`. The retained graph stays, the candidate
  is not a rejection (nothing is remembered against it), and the next round starts. An
  approver, when there is one, is still asked instead; with neither, the candidate is
  rejected as before.
- **The runner stores and announces.** `ApprovalInbox = {pending({graph, candidate, tools})}`.
  `propose` puts the record unless its id already holds a record that is not a rejection
  (one already waiting, from an earlier round, a replay or an import, is not announced
  again; a head's record stays), then calls `inbox.pending`.
- **The inbox (`approvals.ts`).** Every record of a graph with decision `pending-approval`
  waits: a dream's proposals and import proposals alike.
  - `listApprovals({store, graph})` returns `ApprovalList = {graph, head?, approvals}`,
    oldest first, each an `ApprovalSummary`: `{candidate, graph, origin, parent, onHead,
    dream?, at, edits, gate?, tools}` (the gate and tools from `evidence.approval`).
  - `approveCandidate({store, record, preset, clock})` re-runs, against the current head,
    the gates that need no evaluator. Structure: on the head it was proposed on (and for
    an import) the document as it is under the preset's cycle policy; on a later head the
    candidate's edits applied there by `prepareCandidate`, leaving out additions the head
    already has (the same node, or the same edge the deletions leave) and carrying the
    workflow bindings of the nodes it adds (a composition). Evidence, when the preset
    lists it and the candidate has edits: `evidenceGate` over the overlay folded from the
    graph's first head, which must be on the current head (`no live evidence yet: …`
    otherwise; a preset without an overlay fails as in dream); a composition's
    `evidence.composition` support counts. An import has no live evidence to show, and
    approving it is the decision. Then the revision (parents: the head; the candidate's
    origin, dream, edits and evidence plus `approved: {candidate, on, gates}`) commits by
    compare-and-set and the overlay is rebased onto it (`absorbedEntries`), as a dream
    commit is. A candidate rebased onto a later head commits under its new id, and its own
    record's decision becomes `{kind: "approved", revision}`, a new `Decision` kind; one
    whose edits the head already has is `unchanged` and marked approved as the head.
  - `ApprovalResult` is `committed {revision, previous}`, `unchanged {head}`, `declined`,
    or `refused {reason, gate?}` where `gate` is `structure`, `evidence` or `head` (a lost
    compare-and-set: the id's earlier record is put back, or the rebased candidate is
    remembered as rejected by `head`, as a dream's lost race is). A candidate that is not
    waiting, is redacted, or whose graph has no readable head is refused. A refused
    candidate keeps waiting.
  - `declineCandidate({store, record})` records `rejected-gate` under the gate that asked
    (`approval` for an import) with the approval gate's reason, `declined by the
    approver`, so a dream with deduplication remembers it.
  - Notices for the host's hook bus: `ApprovalNotice` is
    `procedural.approval.requested {graph, candidate, origin, parent, dream?, gate?, tools}`
    (`requestedNotice(record)`) or `procedural.approval.decided {graph, candidate,
    decision: "approved" | "declined", revision?}` (`decidedNotice(result)`, none for a
    refusal). `approvalInbox(notify)` is dream's `ApprovalInbox` over a notifier.
  - Records are keyed by graph and id (a candidate id is its document's hash, and two
    graphs may hold the same one), so `procedural.approve` and `procedural.decline` name
    the graph with the candidate; the policy is checked on that graph before the record
    is looked up, and a candidate recorded only under another graph is `missing`
    (PX2.113).
- **Hosts.** `DaemonRuntime.publish(input)` is core's host publish API through the
  runtime, which saves the snapshot (hook events are part of it). On the native host,
  `hookNotifier(runtime)` publishes each `ApprovalNotice` under source `procedural`;
  `nativeDream` takes `inbox?: ApprovalInbox`, and `buildNativeEnsemble`'s `procedural`
  takes `notify`. `main.ts` gives both the host's notifier once the daemon is up, so its
  dream proposes to the inbox and plugins subscribed to `procedural.approval.*` hear of
  proposals and decisions. `browserProcedural` takes `notify` too; a page publishes the
  notices where it likes.

## Composition in the daemon

As built. Hosts give dream a composer and sessions their revision's workflows; the names
above keep their meaning.

- **The step hook's core (P10).** `ProceduralStepHook.core(scope)` returns the core
  revision (`ProceduralGraph`) the session reads this turn, or undefined without a graph.
  It resolves and pins at a turn boundary exactly as a step does, so the tools built from
  it and the turn's guidance read one core (I3). Without a turn id every call is a
  boundary.
- **Host pieces (`compose-host.ts`, portable).** The host brings files, a code mode and a
  model for `tools.ask`:
  - `StagingFiles` is a `WorkflowLibrary` with `journal(run): SnapshotStorage`, the
    host's durable store of its own (never the shared library).
  - `staging({files, codeMode, ask}): Staging` is `{library: StagingLibrary over the files,
    host(tools): WorkflowHost}`; `host` runs staged workflows on a session's base tools,
    journaled in the files.
  - `toolSpecs(tools)` is each tool's input JSON Schema (and description): what
    `compilePath` types a compiled workflow's inputs and questions by.
  - `composer({settings, staging, tools, runs?})` is dream's `Composer` over those specs
    and the staging library.
  - `sessionTools({step, staging, base?})` is a worker's per-turn tools
    (`(scope) => Promise<ToolSet>`, for `sessionAgent({ tools })`): the base (a `ToolSet`,
    or a function told the turn's scope) plus `revisionTools` on `step.core(scope)`, with
    `staging.host(base)` running the workflows; without a graph, the base.
  - `composition({staging, settings, step, base?, builtins?}): HostComposition` is what a
    host whose sessions share one set of base tools hands out: `{staging, tools,
    composer(), catalog()}`, `composer` and `catalog` reading `base` anew each time (once
    per dream). `builtins` names tools sessions have that the host does not run (an opaque
    harness's own): `catalog` lists them first, once each, but they are neither session
    tools nor in the composer's specs, so a compiled path calls host tools only (PC1.55).
- **Workers (`@harness/workers`).** `sessionAgent({ tools })` given a function calls it
  each turn with the turn's scope (`TurnScope`: session, turn, cwd, meta, report), so a
  session gets tools of its own. `harnessSessions({ tools })` does the same for opaque
  harness workers (HS1.12–HS1.14): the turn's tools reach the harness as host-executed
  user tools, in place of the agent's own, through the call options and the agent's
  `prepareCall: harnessTurnTools` (the AI SDK harness freezes a turn's tools for its
  continuations, so a turn resumed after an approval round keeps them); the harness's
  builtin tools stay its own. The turn hook is told the harness's tools and the turn's.
- **Native host.**
  - `loadProceduralComposition(file?)` reads `data/composition.json`, or a deployment's
    copy (`--procedural-composition`).
  - `nativeComposition({dir, settings, step, ask, base?, shared?, builtins?})` is
    `composition` with staging in `<dir>/staging` (`WorkflowFiles`: a file per workflow,
    run journals under `.runs/`) on AI SDK code mode; `shared` (the `--workflows`
    directory) is never written and may not be that directory (it throws). `base` is the
    host's session tools, the same for every session; `builtins` a harness adapter's
    builtin tool names (PX2.121).
  - `harnessWorker({harness, …, tools?})` builds its `HarnessAgent` with
    `prepareCall: harnessTurnTools` and gives `harnessSessions` the tools (PX2.120).
  - `nativeDream`'s `composer` and `tools` may be functions, called at the start of each
    dream.
  - `main.ts`, for `--worker model`, `--worker ensemble` and `--worker harness` with
    `--procedural`: the worker's tools are `composition.tools` (base: none for the model
    worker, the shared library's `workflowTools` for the ensemble and harness workers),
    `ask` is the ensemble's default model or the gateway model, and the daemon's dream
    gets `composer` and `catalog` as its tool catalog (so `enforceToolCatalog` sees the
    session tools, and for a harness worker its adapter's builtins too, PX2.125). Without
    `--procedural`, a harness worker's turns get the shared library's workflows, as the
    ensemble worker's do.
  - `loadProceduralTools(file?)` reads `data/tools.json` (`{sideEffectFree: string[]}`,
    parsed by `parseToolDeclarations`, its schema generated from zod; none by default,
    PGR1.58–PGR1.59), or a deployment's copy (`--procedural-tools`, on the daemon and on
    `harness-procedural dream`), whose tools dream's `approval-for-side-effects` gate lets
    a candidate route into without approval (PX2.122–PX2.124).
  - `harness-procedural dream` runs outside the daemon and does not know which worker's
    tools its sessions had, so it refines without a composition round; the daemon's
    `procedural.dream` composes.
- **Browser host.** `browserComposition(ensemble, {settings, step, base?, name?, shared?,
  factory?, codeMode?})` is `composition` with staging in an IndexedDB database of its own
  (`IndexedDbWorkflows`, `harness-procedural-staging` by default; the shared library's,
  `harness-workflows` by default, may not be the same one), on QuickJS by default, the
  ensemble's default model answering `tools.ask`. The page, which runs its own dream and
  workers, hands `tools` to `sessionAgent` and `composer` and `catalog` to `runDream`.

## Open issues

The finalization resolved the cross-phase wiring the phases recorded here (composition in
dream, live reflection, dream from the host, the stride as settings data, the tokenizer,
the evaluator contract and scripted environment, rejection records), and the sections
above gave dream a schedule, a configured evaluator and an approvals inbox. A1 resolved
the store and log plumbing (records keyed by graph and id with a v1 migration, reverts
that write no record, `Daemon.readLog`, one owner per store directory), and
`procedural.feedback` answers what the learner did with the score. The last cross-phase
item, P6 × P12, is resolved too: the tools a deployment declares free of side effects are
data (`data/tools.json`, `--procedural-tools`) handed to dream, and a harness worker's
sessions get the workflow tools their pinned core binds, its dream a composer and a tool
catalog of the harness's builtins and the host tools. None is open.

Limits of the AI SDK harness that stay, by design rather than as open work:

- A harness runs its own steps, so successor-only tools limit a harness turn as a whole,
  and only its host tools: the harness's builtins stay offered (`HarnessAgent` fixes
  `activeTools` when it is built, and filtering builtins needs the adapter's support).
- A compiled workflow calls host tools only: a path of a harness's builtin calls (which
  its runtime executes, not the host) has no input schema on the host and is not composed.
- A turn suspended with host tools and resumed in another process continues with the
  agent's own tools (`HarnessAgent` re-reads its settings there, not the turn's), so a
  turn tool it had is missing. The daemon never continues a turn across a restart (it
  marks a turn in flight interrupted, and the next is a new prompt), so this does not
  arise there.
