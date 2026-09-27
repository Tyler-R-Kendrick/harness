/**
 * Applying a refiner's edit set, and the paper's `PrepareCandidate` (arXiv:2609.09153
 * App. B.6; plan §7.3 step 3). Edits apply to a copy, deletions first; under the
 * `forbidden` cycle policy the edges that close a cycle are removed (repair) before the
 * structural checks; the tool catalog and the edit filter run only when asked for (the
 * paper preset asks for neither). Every problem is a diagnostic, so a failed candidate
 * can go to the rejection memory with its reasons.
 */
import { editFilter } from "./filter.ts";
import type { FilterOptions } from "./filter.ts";
import { checkGraph, EditSetSchema, ProceduralGraphSchema, revisionId, START } from "./graph.ts";
import type { CandidateDocument, CyclePolicy, Diagnostic, EditSet, GraphEdge, NodeName, ProceduralGraph, RelationName, RevisionId } from "./graph.ts";

/**
 * The document after the edits, on a copy. Deletions first: `delete_edges` removes every
 * relation between its endpoints (in that direction), and deleting a node removes every
 * edge into or out of it. Then nodes are added, then edges. An added node has no binding.
 */
export function applyEdits(base: CandidateDocument, edits: EditSet): CandidateDocument {
  const gone = new Set<string>(edits.delete_nodes);
  const cut = new Set(edits.delete_edges.map((e) => `${e.source}\u0000${e.target}`));
  const kept = base.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to) && !cut.has(`${e.from}\u0000${e.to}`));
  return {
    ...base,
    nodes: [...base.nodes.filter((n) => !gone.has(n.id)), ...edits.add_nodes.map(({ id, type, description }) => ({ id, type, description }))],
    edges: [...kept, ...edits.add_edges.map(({ source, target, relation, condition, guidance, pitfalls }) => ({ from: source, relation, to: target, condition, guidance, pitfalls }))],
  };
}

/** An edge the cycle repair removed. */
export interface RepairedEdge {
  from: NodeName;
  relation: RelationName;
  to: NodeName;
}

export interface PrepareOptions {
  cycles: CyclePolicy;
  /** When given, every `ACTION` node must name one of these tools, by its binding's name or its id. */
  tools?: readonly string[];
  /** When given, the edit filter runs over the text the edits add. */
  filter?: { observations: readonly string[]; options?: FilterOptions };
}

export interface PreparedCandidate {
  /** The edited (and repaired) document; the base itself when the edit set is malformed. */
  document: CandidateDocument;
  id: RevisionId;
  /** Present exactly when there are no diagnostics. */
  graph?: ProceduralGraph;
  diagnostics: Diagnostic[];
  repaired: RepairedEdge[];
}

/**
 * The edges whose removal leaves no cycle: the back edges of a depth-first walk from
 * `Start`, then from each other node in document order, following edges in document
 * order. Edges with a missing endpoint are left for the checks to report.
 */
function cycleClosing(doc: CandidateDocument): Set<GraphEdge> {
  const ids = new Set<string>(doc.nodes.map((n) => n.id));
  const out = new Map([...ids].map((id): [string, GraphEdge[]] => [id, []]));
  for (const e of doc.edges) if (ids.has(e.from) && ids.has(e.to)) out.get(e.from)!.push(e);
  /** True while a node is on the walk's path, false once it is done. */
  const open = new Map<string, boolean>();
  const closing = new Set<GraphEdge>();
  const visit = (node: string): void => {
    open.set(node, true);
    for (const e of out.get(node)!) {
      const seen = open.get(e.to);
      if (seen === true) closing.add(e);
      else if (seen === undefined) visit(e.to);
    }
    open.set(node, false);
  };
  for (const root of [START, ...ids]) if (ids.has(root) && !open.has(root)) visit(root);
  return closing;
}

type Path = readonly PropertyKey[];
const where = (path: Path): string => path.reduce<string>((at, key) => (typeof key === "number" ? `${at}[${key}]` : `${at}.${String(key)}`), "edits");

/** Why an edit set is malformed, at its place in the set. A binding gets its own code (plan §4.2). */
function malformed(input: unknown): { edits: EditSet } | { diagnostics: Diagnostic[] } {
  const parsed = EditSetSchema.safeParse(input);
  if (parsed.success) return { edits: parsed.data };
  return {
    diagnostics: parsed.error.issues.map((issue): Diagnostic =>
      issue.code === "unrecognized_keys" && issue.keys.includes("binding")
        ? { code: "binding-not-allowed", message: "an edit cannot set a binding; only dream's composition step writes one", at: where(issue.path) }
        : { code: "malformed", message: issue.message, at: where(issue.path) },
    ),
  };
}

/** Deletions must name nodes the base has; deleting edges between existing nodes that have none is a no-op. */
function staleDeletions(base: CandidateDocument, edits: EditSet): Diagnostic[] {
  const ids = new Set<string>(base.nodes.map((n) => n.id));
  const missing = (field: string, name: string, at: string): Diagnostic[] => (ids.has(name) ? [] : [{ code: "missing-endpoint", message: `${field} names ${name}, which is not a node`, at }]);
  return [
    ...edits.delete_nodes.flatMap((id, i) => missing("delete_nodes", id, `edits.delete_nodes[${i}]`)),
    ...edits.delete_edges.flatMap((e, i) => [...missing("delete_edges", e.source, `edits.delete_edges[${i}].source`), ...missing("delete_edges", e.target, `edits.delete_edges[${i}].target`)]),
  ];
}

/** Action nodes that name no tool in the catalog, by binding name or by id. */
function outsideCatalog(doc: CandidateDocument, tools: readonly string[]): Diagnostic[] {
  const catalog = new Set(tools);
  return doc.nodes.flatMap((n, i): Diagnostic[] =>
    n.type !== "ACTION" || catalog.has(n.id) || (n.binding !== undefined && catalog.has(n.binding.name)) ? [] : [{ code: "tool-not-in-catalog", message: `action node ${n.id} names no tool in the catalog`, at: `nodes[${i}]` }],
  );
}

/** The text the edits add, each at its place in the edit set. A null condition is no text. */
function addedText(edits: EditSet): [string, string | null][] {
  return [
    ...edits.add_nodes.flatMap((n, i): [string, string][] => [
      [`edits.add_nodes[${i}].id`, n.id],
      [`edits.add_nodes[${i}].description`, n.description],
    ]),
    ...edits.add_edges.flatMap((e, i): [string, string | null][] => [
      [`edits.add_edges[${i}].condition`, e.condition],
      [`edits.add_edges[${i}].guidance`, e.guidance],
      [`edits.add_edges[${i}].pitfalls`, e.pitfalls],
    ]),
  ];
}

function filtered(edits: EditSet, filter: NonNullable<PrepareOptions["filter"]>): Diagnostic[] {
  return addedText(edits).flatMap(([at, text]) =>
    text === null ? [] : editFilter([text], filter.observations, filter.options).map((f): Diagnostic => ({ code: "filtered", message: `${f.code}: ${f.detail}`, at })),
  );
}

/**
 * The paper's `PrepareCandidate`: apply the edits to a copy of the retained graph, repair
 * cycles when they are forbidden, then check the structure (App. B.6), the tool catalog
 * (when given) and the edit filter (when given). Diagnostics come in that order, after any
 * about the edit set itself. The graph is present exactly when there are none.
 */
export function prepareCandidate(base: ProceduralGraph, edits: EditSet, options: PrepareOptions): PreparedCandidate {
  const parsed = malformed(edits);
  if ("diagnostics" in parsed) return { document: base, id: revisionId(base), diagnostics: parsed.diagnostics, repaired: [] };
  const applied = applyEdits(base, parsed.edits);
  const closing = options.cycles === "forbidden" ? cycleClosing(applied) : new Set<GraphEdge>();
  const document: CandidateDocument = { ...applied, edges: applied.edges.filter((e) => !closing.has(e)) };
  const repaired = applied.edges.filter((e) => closing.has(e)).map(({ from, relation, to }) => ({ from, relation, to }));
  const diagnostics = [
    ...staleDeletions(base, parsed.edits),
    ...checkGraph(document, options.cycles),
    ...(options.tools === undefined ? [] : outsideCatalog(document, options.tools)),
    ...(options.filter === undefined ? [] : filtered(parsed.edits, options.filter)),
  ];
  const id = revisionId(document);
  if (diagnostics.length > 0) return { document, id, diagnostics, repaired };
  return { document, id, graph: ProceduralGraphSchema.parse(document), diagnostics, repaired };
}
