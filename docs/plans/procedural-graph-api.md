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

## P11: live learner (`learner.ts`, `projection.ts`)

- `projectTurn(entries: readonly LogEntryLike[], context): ScoredTrajectory | undefined`.
  It maps ACP updates (`tool_call`, `tool_call_update`, agent text, and
  `_meta.harness.procedural.step` notices) into steps, the path of matched nodes, and
  exposure.
- `class LiveLearner({ store, settings, clock, readLog: (sessionId, from, to) => Promise<LogEntryLike[]>, score?: (trajectory) => Promise<{score, source} | null> })`:
  - `onHookEvent(event)` handles `turn.ended`: project, append `observed`, then append
    `proposals` and `statusChanges`. It is idempotent by `turnKey`.
  - `feedback(session, turn, score)`.

## P12: extension and CLI

- `proceduralExtension({ store, settings, resolver, policy, … })` is a
  `CognitiveExtension` with id `procedural`. Its ops are `graph`, `history`, `feedback`,
  `dream`, `revert`, `import`, `export`.
- `exportMermaid(g: EffectiveGraph): string`.
- Native host: `--procedural <dir>`, and a `harness-procedural` CLI with `dream`,
  `export`, `import`, `revert` and `history`.

## P13: composition (`compose.ts`)

- `pathCandidates(core, overlayStats, settings)`.
- `compilePath(path, recordedCalls, toolSpecs): Workflow`, a `@harness/workflows`
  `Workflow`.
- `StagingLibrary`, a `WorkflowLibrary` that is never the shared one.
- `revisionTools({ base, pinnedCore, staging })` returns the base tools plus exactly the
  workflows the pinned core binds.
