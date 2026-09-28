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

## P8: core, generic (`packages/core`, `packages/protocol`)

- `session/new` accepts `_meta.harness.session`, an arbitrary JSON object. It is stored on
  the session and in `DaemonSnapshot`, and passed on every prompt command as
  `sessionMeta?: Record<string, unknown>`. Core never interprets it.
- `Daemon.publish(input: { source: string; type: string; sessionId?: string; correlationId?: string; cause?: string; payload: unknown }): Result<HookEvent, HookError>`
  is host-side only. Peers cannot choose `source`.

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
  - `StepHook = { prepare(StepContext): Promise<{ instructions?; messages? } | undefined>; turn?(TurnContext): Promise<string | undefined> }`.
    `TurnScope = { sessionId; turnId?; cwd?; sessionMeta?; report }`.
    `StepContext = TurnScope & { messages; initialInstructions; stepNumber; model; tools }`
    (`model` is the step's; `tools` names the tools the turn offers).
    `TurnContext = TurnScope & { messages; lastAction: string | undefined; tools }`.
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
    active node is an `ACTION` that neither its id nor its binding's name offers.

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
  - `ProjectionContext = { sessionId; turnId; from?; pin?: VersionPair; locate?: (action) => NodeName | undefined; score?: {score, source} | null }`,
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
    `usage.guidanceTokens` sums their usage. The log holds no turn usage, so
    `inputTokens`/`outputTokens` are 0.
  - `path` is the first record's node (when the turn started in view, it matched, and no
    tool call preceded it), then `locate(title)` for each tool call in emission order;
    `unmatched` lists the titles `locate` did not match. `shown` is the union of the
    records' `exposure`.
  - `gaps` are the missing offsets `[from, to)` inside the turn, and before it when its
    start was not seen (from `context.from` when nothing bounds it). `next` is the offset
    after `turn.ended`. It never throws.
- `new LiveLearner({ store, settings: Preset, readLog, score?, clock? })`. `settings` is
  the preset in force (its `overlay`, `live` and `match`). `readLog(sessionId, from, to?)`
  reads to the head when `to` is omitted. `clock` is accepted and unused (the fold counts
  versions). `onHookEvent(event: LearnerEvent)` and `feedback(session, turn, score: number)`
  return `Promise<LearnerResult>`: `ignored` (not a `turn.ended` whose `source` is
  `daemon`, or a preset without an overlay), `skipped` (turn or version pair not found,
  a session id containing `/`, no pin for feedback, a score outside [0, 1]), `duplicate`,
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
    allows by default. `ProceduralAction` is `"read" | "write" | "dream" | "revert" | "import"`;
  - `dream?: (graph) => Promise<unknown>` (the host's P6 `runDream`) and
    `feedback?: (session, turn, score) => Promise<unknown>` (P11's `LiveLearner.feedback`).

  It takes no resolver: `feedback` finds the graph from the session's pin. Each operation
  parses its input (malformed input throws `invalid procedural.<op> input`), then checks
  the policy for its action (a refusal throws `procedural.<op>: <action> on graph <g> is
  not allowed`), then runs. The ops and their actions:

  | Op | Input | Action | Result |
  |---|---|---|---|
  | `graph` | `{graph, revision?, overlay?}` | read | `{status:"ok", head, revision, origin, document, effective}` or `missing` |
  | `history` | `{graph}` | read | `GraphHistory` |
  | `export` | `{graph, revision?, format?: "json" \| "mermaid", overlay?}` | read | `ExportResult` |
  | `feedback` | `{session, turn, score}` | write (on the pin's graph) | `{status:"recorded", graph}`, `missing` (no pin) or `unavailable` |
  | `dream` | `{graph}` | dream | `{status:"done", result}` or `unavailable` |
  | `revert` | `{graph, to?}` | revert | `RevertResult` |
  | `import` | `{graph, document?}` | import | `ImportResult` |

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
  - `revertGraph({store, graph, to?, clock})`: `to` defaults to the previous head and must
    be an earlier head (not the head itself), recorded and not redacted. A revision's id is
    its content, so the `revert` record (parent: the head it leaves) takes the target's id
    and replaces its record; `evidence` is `{reverted, replaces}` with the replaced record
    minus its id, graph and document. Then a compare-and-set moves the head (on a lost race
    the replaced record is put back and the revert is refused), and a `rebased` event onto
    the target is appended, so the overlay follows the head and entries the target cannot
    anchor are dropped. P9's `pinSession` sees the `revert` origin and re-pins.
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
  - `pumpHookEvents(runtime, {plugin, types, onEvent, intervalMs?, log?})` is an in-process
    plugin connection with a durable hook-bus cursor, acknowledging each event after its
    handler resolves; `sessionLogReader(daemon)` reads a session's log entries in
    `[from, to?)` from the daemon's snapshot.
  - `nativeDream(…)` runs P6's `runDream` on this host; its shape and ports are under
    "Dream from the host" in the finalization's notes below.
  - `nativeLiveLearner({runtime, store, settings, preset?, intervalMs?, log?})` is P11's
    `LiveLearner` (the preset's settings, `readLog` from the daemon) fed by
    `pumpHookEvents` as plugin `procedural-learner` on `turn.ended`; `main.ts` starts it
    with the daemon, and the extension's `feedback` goes to `learner.feedback`.
  - `main.ts` takes `--procedural <dir>` with `--procedural-settings`,
    `--procedural-resolver` and `--procedural-policy` files. The step hook goes to
    `sessionAgent` for the model and ensemble workers (guided by the session's own model)
    and to `harnessWorker({ step })` for harness workers (guided by the ensemble's chat
    model, or the gateway model). With the cognitive core, `procedural.*` is served under the
    policy.
- `harness-procedural <history|export|import|revert|dream> <graph>` runs the extension's
  operations on the store in `--procedural <dir>` (default `~/.cache/harness/procedural`);
  `export` takes `--format`, `--revision`, `--no-overlay` and `--out`, `import` an optional
  file, `revert` `--to`, and `dream` `--model` (a gateway id) or else `--model-cache`,
  `--llama-server` and `--no-hosted` (the ensemble's reasoning model), and `--state`. A
  result a caller handles (a dream that did not finish included) exits 1, bad usage 2.
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
    is `busy`. `snapshotSessions(snapshot)` reads the session logs
    of a daemon snapshot (the daemon's, or its state file's). `terminalApprover(input, output)`
    asks `[y/N]` on a terminal. With the cognitive core, `main.ts` serves `procedural.dream`
    with the ensemble's `reasoning` generator over the daemon's logs; the live learner gets
    `modelReflector` on the same generator (the gateway `--model` without the core). `harness-procedural dream <graph>`
    runs it from the CLI on `--model <gateway id>`, or else on the ensemble's `reasoning`
    model (`--model-cache`, `--llama-server`, `--no-hosted`; it loads only when the refiner
    is asked), over the session logs of the daemon state file `--state` names, with the
    terminal approver when stdin is a terminal; a dream that is `busy`, `no-head` or
    `lease-lost` exits 1. The daemon has no approver: the
    permission flow is per session, and dream runs outside any session.
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

## Open issues

The finalization resolved the cross-phase wiring the phases recorded here (composition in
dream, live reflection, dream from the host, the stride as settings data, the tokenizer,
the evaluator contract and scripted environment, rejection records). Still open:

- P6 × P12: dream on the daemon has no approver (the permission flow, MX3, is per
  session and dream runs outside any session), no configured `Evaluator`, and no session
  tool catalog (`tools`, `sideEffectFree`), so `enforceToolCatalog` and
  `approval-for-side-effects` see no real tools there; the gates do what the preset says
  for their absence. The CLI approves on a terminal.
- P12: content-id keying means two graphs holding the same document share one record (its
  `graph` is whichever wrote last), and a revert replaces its target's record;
  `revertGraph` keeps what it replaced in `evidence.replaces`. Keying records by
  `(graph, id)` in the store would remove both.
- P12: `sessionLogReader` and `snapshotSessions` (dream's session logs) read logs from
  `Daemon.snapshot()`, which copies every session's log per read. A host-side
  `Daemon.readLog(sessionId, from, to)` in core would avoid the copy.
- P12: `harness-procedural` opens the store file itself, so it must not run while a
  daemon holds the same `--procedural` directory (one owner per store file). Routing the
  CLI through a running daemon's `_harness/cognitive/invoke` would lift that.
- P12: `procedural.feedback` answers `recorded` once the learner has the score, even when
  the learner skips it (for example, a turn it cannot find in the log).
