/**
 * A procedural graph's core (arXiv:2609.09153 §3.1, App. B.4): a directed, attributed
 * multigraph whose nodes abstract tool calls, reasoning steps and task statuses, and
 * whose edges carry a condition, guidance and pitfalls. See docs/plans/procedural-graph.md
 * §4.1–4.3.
 *
 * A `CandidateDocument` is only well formed; a `ProceduralGraph` also passes the paper's
 * structural checks (App. B.6) and exists only as the output of parsing. Structural
 * problems are values (`Diagnostic[]`), so a failing candidate can be stored with them.
 */
import { z } from "zod";
import { ProbabilitySchema, Sha256Schema } from "@harness/cognitive";
import { canonicalJson, sha256Hex } from "./canonical.ts";

// ---- refined names and ids ---------------------------------------------------------

/** An opaque graph address; `team/web` or `repo/harness` if a deployment chooses (plan §8). */
export const GraphIdSchema = z.string().max(200).regex(/^[a-z0-9][a-z0-9._/-]*$/, "a graph id").brand<"GraphId">();
export type GraphId = z.output<typeof GraphIdSchema>;

export const NodeNameSchema = z.string().max(120).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/, "a node name").brand<"NodeName">();
export type NodeName = z.output<typeof NodeNameSchema>;

export const NodeTypeNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "an upper snake case node type");
export type NodeTypeName = z.output<typeof NodeTypeNameSchema>;

export const RelationNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "an upper snake case relation");
export type RelationName = z.output<typeof RelationNameSchema>;

const sha256Hex64 = z.string().regex(/^[0-9a-f]{64}$/, "a lowercase hex sha256");

/** A core revision: the sha256 of its canonical document. */
export const RevisionIdSchema = sha256Hex64.brand<"RevisionId">();
export type RevisionId = z.output<typeof RevisionIdSchema>;

/** An overlay entry: the sha256 of its canonical content. */
export const EntryIdSchema = sha256Hex64.brand<"EntryId">();
export type EntryId = z.output<typeof EntryIdSchema>;

export const TrajectoryIdSchema = z.string().min(1).max(200).brand<"TrajectoryId">();
export type TrajectoryId = z.output<typeof TrajectoryIdSchema>;

export const DreamIdSchema = z.string().min(1).max(200).brand<"DreamId">();
export type DreamId = z.output<typeof DreamIdSchema>;

/** A score is a probability: a judge's probability, a metric or an outcome in [0, 1]. */
export const ScoreSchema = ProbabilitySchema;
export type Score = z.output<typeof ScoreSchema>;

// ---- vocabulary ----------------------------------------------------------------------

export const FORMAT = "harness.procedural-graph/v1";
export const DEFAULT_NODE_TYPES: readonly NodeTypeName[] = ["ACTION", "REASONING", "STATUS"];
export const DEFAULT_RELATIONS: readonly RelationName[] = ["LEADS_TO", "TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO"];
/** Every graph begins here; the paper's a₀. */
export const START = "Start";
/** The scratch skeleton's terminal. Any node with no outgoing edges is a terminal. */
export const END = "End";

// ---- the document --------------------------------------------------------------------

const toolName = z.string().min(1).max(200);

/** What a node runs. A binding names a tool; it never grants one (plan §9). Only dream writes bindings (I5). */
export const BindingSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("tool"), name: toolName }).readonly(),
  z.strictObject({ kind: z.literal("workflow"), name: toolName, code: Sha256Schema }).readonly(),
  z.strictObject({ kind: z.literal("skill"), name: toolName, content: Sha256Schema }).readonly(),
]);
export type Binding = z.output<typeof BindingSchema>;

export const GraphNodeSchema = z
  .strictObject({ id: NodeNameSchema, type: NodeTypeNameSchema, description: z.string(), binding: BindingSchema.exactOptional() })
  .readonly();
export type GraphNode = z.output<typeof GraphNodeSchema>;

/** A transition with the paper's attributes Φ(e): when it applies (null: always), how to proceed, what to avoid. */
export const GraphEdgeSchema = z
  .strictObject({
    from: NodeNameSchema,
    relation: RelationNameSchema,
    to: NodeNameSchema,
    condition: z.string().nullable(),
    guidance: z.string(),
    pitfalls: z.string(),
  })
  .readonly();
export type GraphEdge = z.output<typeof GraphEdgeSchema>;

/** A graph document, well formed but unchecked. */
export const CandidateDocumentSchema = z
  .strictObject({
    /** The JSON Schema an editor checks the file against (data/graph.schema.json); never hashed. */
    $schema: z.string().exactOptional(),
    /** Hashed, so a format migration changes every id. */
    format: z.literal(FORMAT),
    nodeTypes: z.array(NodeTypeNameSchema).readonly(),
    relations: z.array(RelationNameSchema).readonly(),
    nodes: z.array(GraphNodeSchema).readonly(),
    edges: z.array(GraphEdgeSchema).readonly(),
  })
  .readonly();
export type CandidateDocument = z.output<typeof CandidateDocumentSchema>;

// ---- structural checks (App. B.6) -----------------------------------------------------

export type CyclePolicy = "allowed" | "forbidden";

export const DIAGNOSTIC_CODES = [
  "malformed",
  "duplicate-node",
  "unknown-type",
  "unknown-relation",
  "missing-endpoint",
  "missing-start",
  "no-terminal",
  "cycle",
  "tool-not-in-catalog",
  "binding-not-allowed",
  "filtered",
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export const DiagnosticSchema = z.strictObject({ code: z.enum(DIAGNOSTIC_CODES), message: z.string(), at: z.string().exactOptional() });
/** One problem with a candidate, and where it is (`nodes[2].id`). */
export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  at?: string;
}

type Path = readonly PropertyKey[];
interface Problem {
  code: DiagnosticCode;
  message: string;
  path: Path;
}

const formatPath = (path: Path): string =>
  path.map((key, i) => (typeof key === "number" ? `[${key}]` : i === 0 ? String(key) : `.${String(key)}`)).join("");

const toDiagnostic = ({ code, message, path }: Problem): Diagnostic => (path.length === 0 ? { code, message } : { code, message, at: formatPath(path) });

type Edges = readonly { from: string; to: string }[];

/** Each node's successors along edges whose endpoints both exist. */
function adjacency(ids: ReadonlySet<string>, edges: Edges): Map<string, string[]> {
  const next = new Map([...ids].map((id): [string, string[]] => [id, []]));
  for (const e of edges) next.get(e.from)!.push(e.to);
  return next;
}

/** Every node reachable from `start` (itself included). */
function reachable(next: ReadonlyMap<string, readonly string[]>, start: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...start];
  for (let n = queue.pop(); n !== undefined; n = queue.pop()) {
    if (seen.has(n)) continue;
    seen.add(n);
    queue.push(...next.get(n)!);
  }
  return seen;
}

function problems(doc: CandidateDocument, forbidCycles: boolean): Problem[] {
  const found: Problem[] = [];
  const ids = new Set<string>();
  doc.nodes.forEach((n, i) => {
    if (ids.has(n.id)) found.push({ code: "duplicate-node", message: `node ${n.id} is defined more than once`, path: ["nodes", i, "id"] });
    ids.add(n.id);
  });
  const types = new Set<string>(doc.nodeTypes);
  doc.nodes.forEach((n, i) => {
    if (!types.has(n.type)) found.push({ code: "unknown-type", message: `node ${n.id} has type ${n.type}, which is not in nodeTypes`, path: ["nodes", i, "type"] });
  });
  const relations = new Set<string>(doc.relations);
  doc.edges.forEach((e, i) => {
    if (!relations.has(e.relation)) found.push({ code: "unknown-relation", message: `edge ${e.from} → ${e.to} has relation ${e.relation}, which is not in relations`, path: ["edges", i, "relation"] });
  });
  doc.edges.forEach((e, i) => {
    if (!ids.has(e.from)) found.push({ code: "missing-endpoint", message: `edge ${i} starts at ${e.from}, which is not a node`, path: ["edges", i, "from"] });
    if (!ids.has(e.to)) found.push({ code: "missing-endpoint", message: `edge ${i} ends at ${e.to}, which is not a node`, path: ["edges", i, "to"] });
  });
  if (!ids.has(START)) found.push({ code: "missing-start", message: `there is no ${START} node`, path: ["nodes"] });

  // Structure is judged on the edges whose endpoints exist.
  const edges = doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const sources = new Set<string>(edges.map((e) => e.from));
  const terminating = reachable(adjacency(ids, edges.map((e) => ({ from: e.to, to: e.from }))), [...ids].filter((id) => !sources.has(id)));
  doc.nodes.forEach((n, i) => {
    if (!terminating.has(n.id)) found.push({ code: "no-terminal", message: `node ${n.id} has no path to a terminal node (one with no outgoing edges)`, path: ["nodes", i] });
  });
  if (forbidCycles) {
    // A node is on a cycle when it reaches itself in one or more steps; two such nodes share a cycle when each reaches the other.
    const next = adjacency(ids, edges);
    const reach = new Map([...ids].map((id) => [id, reachable(next, next.get(id)!)]));
    const reported = new Set<string>();
    doc.nodes.forEach((n, i) => {
      if (reported.has(n.id) || !reach.get(n.id)!.has(n.id)) return;
      const members = [...ids].filter((m) => reach.get(n.id)!.has(m) && reach.get(m)!.has(n.id));
      for (const m of members) reported.add(m);
      found.push({ code: "cycle", message: `cycle through ${members.join(", ")}`, path: ["nodes", i] });
    });
  }
  return found;
}

/**
 * The structural checks of App. B.6: unique ids, types and relations in their
 * vocabularies, existing endpoints, a `Start` node, every node reaching some node with
 * no outgoing edges (not necessarily `End`), and, when cycles are forbidden, no cycles.
 */
export const checkGraph = (doc: CandidateDocument, cycles: CyclePolicy): Diagnostic[] => problems(doc, cycles === "forbidden").map(toDiagnostic);

/** A checked graph: what guidance reads and a revision stores as head. */
export const ProceduralGraphSchema = CandidateDocumentSchema.superRefine((doc, ctx) => {
  for (const p of problems(doc, false)) ctx.addIssue({ code: "custom", message: `${p.code}: ${p.message}`, path: [...p.path] });
}).brand<"ProceduralGraph">();
export type ProceduralGraph = z.output<typeof ProceduralGraphSchema>;

export type ParsedGraph = { ok: true; graph: ProceduralGraph } | { ok: false; diagnostics: Diagnostic[] };

/** Parse untrusted input into a graph, or say every problem with it. Cycles are allowed unless forbidden. */
export function parseGraph(input: unknown, cycles?: CyclePolicy): ParsedGraph {
  const shape = CandidateDocumentSchema.safeParse(input);
  if (!shape.success) {
    return { ok: false, diagnostics: shape.error.issues.map((issue) => toDiagnostic({ code: "malformed", message: issue.message, path: issue.path })) };
  }
  const diagnostics = problems(shape.data, cycles === "forbidden").map(toDiagnostic);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, graph: ProceduralGraphSchema.parse(input) };
}

/** The JSON Schema for graph files, for editors (data/graph.schema.json). */
// The document has no defaults or transforms, so its input and output schemas are the same.
export const graphJsonSchema = (): object => z.toJSONSchema(CandidateDocumentSchema);

// ---- identity -------------------------------------------------------------------------

// Stryker disable next-line EqualityOperator: equivalent; equal keys come only from identical items, whose order cannot show
const byKey = (a: { key: string }, b: { key: string }): number => (a.key < b.key ? -1 : 1);

/**
 * Items in code-unit order of their keys. A key joins fields with NUL, which no name
 * contains and which sorts first, so the order is that of the fields in turn.
 */
const sortedBy = <T>(items: readonly T[], key: (item: T) => readonly string[]): T[] =>
  items
    .map((item) => ({ item, key: key(item).join("\u0000") }))
    .sort(byKey)
    .map(({ item }) => item);

/**
 * A revision's id: the sha256 of the canonical JSON of the document without `$schema`,
 * with nodes sorted by id, edges by (from, relation, to) and the vocabularies sorted.
 * Ties (only possible in a candidate that fails its checks) sort by content, so the id
 * never depends on array order.
 */
export function revisionId(doc: CandidateDocument): RevisionId {
  const content = {
    format: doc.format,
    nodeTypes: [...doc.nodeTypes].sort(),
    relations: [...doc.relations].sort(),
    nodes: sortedBy(doc.nodes, (n) => [n.id, canonicalJson(n)]),
    edges: sortedBy(doc.edges, (e) => [e.from, e.relation, e.to, canonicalJson(e)]),
  };
  return RevisionIdSchema.parse(sha256Hex(canonicalJson(content)));
}

/** The paper's scratch skeleton: `Start → End`, both statuses, one unconditional `LEADS_TO`. */
export const seedGraph = (): ProceduralGraph =>
  ProceduralGraphSchema.parse({
    format: FORMAT,
    nodeTypes: DEFAULT_NODE_TYPES,
    relations: DEFAULT_RELATIONS,
    nodes: [
      { id: START, type: "STATUS", description: "The task begins." },
      { id: END, type: "STATUS", description: "The task is complete." },
    ],
    edges: [{ from: START, relation: "LEADS_TO", to: END, condition: null, guidance: "", pitfalls: "" }],
  });

// ---- lookups (any graph-shaped value: a core, a candidate or an effective graph) --------

/** Edges leaving a node, in document order. */
export const outgoing = <E extends { readonly from: string }>(g: { readonly edges: readonly E[] }, node: string): E[] => g.edges.filter((e) => e.from === node);
/** Edges entering a node, in document order. */
export const incoming = <E extends { readonly to: string }>(g: { readonly edges: readonly E[] }, node: string): E[] => g.edges.filter((e) => e.to === node);
export const nodeById = <N extends { readonly id: string }>(g: { readonly nodes: readonly N[] }, id: string): N | undefined => g.nodes.find((n) => n.id === id);

// ---- the refiner's edit set (App. B.5, exactly) ---------------------------------------

/**
 * The refiner's output, exactly as the paper's prompt asks for it. `delete_edges`
 * removes every relation between its endpoints. There is no binding: only dream's
 * composition step writes one (plan §4.2).
 */
export const EditSetSchema = z.strictObject({
  add_nodes: z.array(z.strictObject({ id: NodeNameSchema, type: NodeTypeNameSchema, description: z.string() })).default([]),
  delete_nodes: z.array(NodeNameSchema).default([]),
  add_edges: z
    .array(
      z.strictObject({
        source: NodeNameSchema,
        target: NodeNameSchema,
        relation: RelationNameSchema,
        condition: z.string().nullable(),
        guidance: z.string(),
        pitfalls: z.string(),
      }),
    )
    .default([]),
  delete_edges: z.array(z.strictObject({ source: NodeNameSchema, target: NodeNameSchema })).default([]),
});
export type EditSet = z.output<typeof EditSetSchema>;

/** The constraint sent with every refiner request: all four lists, nothing else. */
// Output mode (the default): every list is required, as the paper's prompt asks.
export const editSetJsonSchema = (): object => z.toJSONSchema(EditSetSchema);

// ---- revision records (plan §4.3) -------------------------------------------------------

export const DecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("head") }),
  z.strictObject({ kind: z.literal("rejected-structure"), diagnostics: z.array(DiagnosticSchema) }),
  z.strictObject({ kind: z.literal("rejected-gate"), gate: z.string().min(1), reason: z.string() }),
  z.strictObject({ kind: z.literal("pending-approval") }),
  /** Approved from the approvals inbox and committed as another revision: its edits on a later head. */
  z.strictObject({ kind: z.literal("approved"), revision: RevisionIdSchema }),
]);
export type Decision = z.output<typeof DecisionSchema>;

/** One core revision, accepted or not. Rejected candidates are the rejection memory. */
export const RevisionRecordSchema = z.strictObject({
  id: RevisionIdSchema,
  graph: GraphIdSchema,
  /** Two parents make a merge (plan §8.2). */
  parents: z.array(RevisionIdSchema),
  document: CandidateDocumentSchema,
  edits: EditSetSchema.nullable(),
  origin: z.enum(["seed", "dream", "merge", "revert", "import"]),
  dream: DreamIdSchema.exactOptional(),
  evidence: z.record(z.string(), z.unknown()),
  decision: DecisionSchema,
  /** Milliseconds from the Clock port. */
  at: z.number().int().min(0),
  /** The text was tombstoned; the id stays but can no longer be verified. */
  redacted: z.literal(true).exactOptional(),
}).refine((r) => r.redacted === true || revisionId(r.document) === r.id, { message: "the id is not the revision id of the document", path: ["id"] });
export type RevisionRecord = z.output<typeof RevisionRecordSchema>;
