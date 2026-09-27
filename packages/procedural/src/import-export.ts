import { parseGraph, revisionId, RevisionRecordSchema, seedGraph } from "./graph.ts";
import type { CyclePolicy, Decision, Diagnostic, EditSet, GraphId, ProceduralGraph, RevisionId, RevisionRecord } from "./graph.ts";
import { exportMermaid } from "./mermaid.ts";
import { effectiveGraph, foldAll, rebaseOverlay } from "./overlay.ts";
import { coreView } from "./overlay-types.ts";
import type { EffectiveGraph, OverlayEvent } from "./overlay-types.ts";
import type { ProceduralStore } from "./store.ts";

/** Milliseconds, from the host's Clock port. */
export interface ClockLike {
  now(): number;
}

/**
 * The graph operations that are not dream: importing a seed or expert graph, reading and
 * exporting a revision (JSON, or Mermaid of the effective graph), the revision history,
 * and reverting the head. The extension and the `harness-procedural` CLI both run these
 * over a ProceduralStore; errors a caller handles are result values.
 */

export type ImportResult =
  | { status: "head"; revision: RevisionId }
  | { status: "proposed"; revision: RevisionId; head: RevisionId }
  | { status: "known"; revision: RevisionId; decision: Decision }
  | { status: "invalid"; diagnostics: Diagnostic[] };

const record = (fields: Omit<RevisionRecord, "id" | "edits"> & { edits?: EditSet | null }): RevisionRecord =>
  RevisionRecordSchema.parse({ ...fields, id: revisionId(fields.document), edits: fields.edits ?? null });

/**
 * Import a seed or expert graph (the scratch skeleton when no document is given) as an
 * `import` revision. It becomes head only when the graph has none; otherwise it is proposed
 * to dream as a `pending-approval` revision on the head, which stays. A document the graph
 * already recorded (the head included) is `known` and nothing is written.
 */
export async function importGraph(input: { store: ProceduralStore; graph: GraphId; document?: unknown; clock: ClockLike; cycles?: CyclePolicy }): Promise<ImportResult> {
  const { store, graph, clock } = input;
  const parsed = input.document === undefined ? { ok: true as const, graph: seedGraph() } : parseGraph(input.document, input.cycles);
  if (!parsed.ok) return { status: "invalid", diagnostics: parsed.diagnostics };
  const document = parsed.graph;
  const id = revisionId(document);
  const at = clock.now();
  const propose = async (head: RevisionId): Promise<ImportResult> => {
    if (head === id) return { status: "known", revision: id, decision: { kind: "head" } };
    await store.revisions.put(record({ graph, parents: [head], document, origin: "import", evidence: {}, decision: { kind: "pending-approval" }, at }));
    return { status: "proposed", revision: id, head };
  };
  const head = await store.heads.get(graph);
  if (head) {
    const existing = await store.revisions.get(id);
    return existing?.graph === graph ? { status: "known", revision: id, decision: existing.decision } : propose(head.revision);
  }
  // The record goes in before the head points at it; if another writer set a head first, this is a proposal on theirs.
  await store.revisions.put(record({ graph, parents: [], document, origin: "import", evidence: {}, decision: { kind: "head" }, at }));
  if (await store.heads.set(graph, undefined, id)) return { status: "head", revision: id };
  return propose((await store.heads.get(graph))!.revision);
}

export type GraphView =
  | { status: "ok"; head: RevisionId; revision: RevisionId; record: RevisionRecord; graph: ProceduralGraph; effective: EffectiveGraph }
  | { status: "missing"; reason: string };

async function overlayEvents(store: ProceduralStore, graph: GraphId): Promise<OverlayEvent[]> {
  return (await store.overlay(graph).read(0)).map((e) => e.event);
}

/**
 * A revision of a graph (the head by default) as the extension shows it. On the head, with
 * `overlay` (the default), the effective graph folds the overlay log in and shows every
 * entry that is not retired, probation included; anywhere else, or when the overlay is on
 * another base, it is the core alone.
 */
export async function readGraph(input: { store: ProceduralStore; graph: GraphId; revision?: RevisionId; overlay?: boolean }): Promise<GraphView> {
  const { store, graph } = input;
  const head = await store.heads.get(graph);
  if (!head) return { status: "missing", reason: `graph ${graph} has no head` };
  const revision = input.revision ?? head.revision;
  const found = await store.revisions.get(revision);
  if (found?.graph !== graph) return { status: "missing", reason: `graph ${graph} has no revision ${revision}` };
  const parsed = parseGraph(found.document);
  if (!parsed.ok) return { status: "missing", reason: `revision ${revision} does not parse (it may be redacted)` };
  const core = parsed.graph;
  const state = revision === head.revision && input.overlay !== false ? foldAll(revision, await overlayEvents(store, graph)) : undefined;
  // A probation share of 1 exposes every probationary entry: this is the operator's view, not a session's.
  const effective = state?.base === revision ? effectiveGraph(core, state, { salt: "", probationShare: 1 }) : coreView(core);
  return { status: "ok", head: head.revision, revision, record: found, graph: core, effective };
}

export type ExportResult = { status: "ok"; revision: RevisionId; text: string } | { status: "missing"; reason: string };

/** A revision as text: `json` is the stored core document; `mermaid` is the effective graph (see `readGraph`). */
export async function exportGraph(input: { store: ProceduralStore; graph: GraphId; revision?: RevisionId; format: "json" | "mermaid"; overlay?: boolean }): Promise<ExportResult> {
  const view = await readGraph(input);
  if (view.status !== "ok") return view;
  const text = input.format === "json" ? JSON.stringify(view.record.document, null, 2) : exportMermaid(view.effective);
  return { status: "ok", revision: view.revision, text: `${text}\n` };
}

export interface RevisionSummary {
  id: RevisionId;
  origin: RevisionRecord["origin"];
  parents: RevisionId[];
  decision: Decision;
  at: number;
  dream?: string;
  edits?: EditSet;
  redacted?: true;
}

export interface GraphHistory {
  head?: RevisionId;
  /** The head, then earlier heads, most recent first. */
  heads: RevisionId[];
  /** Every revision recorded for the graph (rejections included), oldest first, without documents. */
  revisions: RevisionSummary[];
}

export async function graphHistory(input: { store: ProceduralStore; graph: GraphId }): Promise<GraphHistory> {
  const { store, graph } = input;
  const head = await store.heads.get(graph);
  const revisions = [...(await store.revisions.list(graph))]
    .sort((a, b) => a.at - b.at)
    .map(
      (r): RevisionSummary => ({
        id: r.id,
        origin: r.origin,
        parents: [...r.parents],
        decision: r.decision,
        at: r.at,
        ...(r.dream === undefined ? {} : { dream: r.dream }),
        ...(r.edits === null ? {} : { edits: r.edits }),
        ...(r.redacted ? { redacted: r.redacted } : {}),
      }),
    );
  return { ...(head ? { head: head.revision } : {}), heads: head ? [head.revision, ...head.history] : [], revisions };
}

export type RevertResult = { status: "reverted"; from: RevisionId; to: RevisionId } | { status: "refused"; reason: string };

/**
 * Move the head back to an earlier head (the previous one by default), as a `revert`
 * revision whose parent is the head it leaves. A revision's id is its content, so the
 * revert record takes the target's id and replaces its record; the evidence keeps what it
 * replaced. The overlay is rebased onto the target, dropping entries it cannot anchor, so
 * no session pairs a core with an overlay built on another; pinned sessions re-pin at
 * their next turn (P9).
 */
export async function revertGraph(input: { store: ProceduralStore; graph: GraphId; to?: RevisionId; clock: ClockLike }): Promise<RevertResult> {
  const { store, graph, clock } = input;
  const head = await store.heads.get(graph);
  if (!head) return { status: "refused", reason: `graph ${graph} has no head` };
  const to = input.to ?? head.history[0];
  if (to === undefined) return { status: "refused", reason: `graph ${graph} has no earlier head` };
  if (to === head.revision) return { status: "refused", reason: `${to} is already the head of graph ${graph}` };
  if (!head.history.includes(to)) return { status: "refused", reason: `${to} is not an earlier head of graph ${graph}` };
  const target = await store.revisions.get(to);
  if (!target) return { status: "refused", reason: `revision ${to} is not recorded` };
  const parsed = parseGraph(target.document);
  if (target.redacted || !parsed.ok) return { status: "refused", reason: `revision ${to} is redacted` };
  const { id: _, document: __, graph: ___, ...replaced } = target;
  const from = head.revision;
  await store.revisions.put(record({ graph, parents: [from], document: target.document, origin: "revert", evidence: { reverted: from, replaces: replaced }, decision: { kind: "head" }, at: clock.now() }));
  if (!(await store.heads.set(graph, from, to))) {
    await store.revisions.put(target);
    return { status: "refused", reason: `the head of graph ${graph} moved; try again` };
  }
  const log = store.overlay(graph);
  const { event } = rebaseOverlay(foldAll(from, await overlayEvents(store, graph)), parsed.graph, []);
  await log.append([event]);
  return { status: "reverted", from, to };
}
