/**
 * The approvals inbox (plan §7.4's approval gate, outside the dream). Candidates that need
 * approval wait in the store with decision `pending-approval`: a dream's proposals (when
 * there was no approver to ask) and import proposals. An operator lists them, and approves
 * or declines each; the extension and the `harness-procedural` CLI both run these.
 *
 * Approving re-runs the gates that do not need an evaluator against the current head,
 * because the head may have moved and the live evidence changed since the proposal:
 *
 * - **structure.** A dream's candidate is its edits applied to the current head (the
 *   paper's `PrepareCandidate` under the preset's cycle policy; a composition's workflow
 *   binding is carried over), so a candidate proposed on an earlier head is rebased onto
 *   this one. An import is a whole document, checked as it is.
 * - **evidence.** When the preset lists it, a dream's candidate must still be backed by the
 *   overlay on the current head. An import is an operator's document, with no live
 *   evidence to show; approving it is the decision.
 *
 * Then the revision is committed by compare-and-set and the overlay rebased onto it, as a
 * dream commit is. Anything that stops it is a result that says why, and the candidate
 * keeps waiting. Declining records the approval gate's rejection, so a dream with
 * deduplication does not propose the same candidate again.
 */
import { z } from "zod";
import { canonicalJson } from "./canonical.ts";
import { absorbedEntries } from "./dream.ts";
import type { ApprovalInbox } from "./dream-runner.ts";
import { prepareCandidate } from "./edits.ts";
import { approvalGate, evidenceGate, structureGate } from "./gates.ts";
import type { GateResult } from "./gates.ts";
import { parseGraph, revisionId, RevisionRecordSchema } from "./graph.ts";
import type { CandidateDocument, CyclePolicy, DreamId, EditSet, GraphId, ParsedGraph, ProceduralGraph, RevisionId, RevisionRecord } from "./graph.ts";
import type { ClockLike } from "./import-export.ts";
import { foldAll, rebaseOverlay } from "./overlay.ts";
import type { Preset } from "./settings.ts";
import type { Head, ProceduralStore } from "./store.ts";

/** What a dream's proposal records about the gate that asked for approval. */
const ApprovalAskSchema = z.object({ gate: z.string().min(1), tools: z.array(z.string()) });
/** What a composition candidate records about its path's support. */
const CompositionEvidenceSchema = z.object({ node: z.string(), support: z.int().min(0) });

/** A candidate waiting for approval, as the inbox lists it (without its document). */
export interface ApprovalSummary {
  candidate: RevisionId;
  graph: GraphId;
  origin: RevisionRecord["origin"];
  /** The head it was proposed on. */
  parent: RevisionId | null;
  /** Whether that is still the head; otherwise approving re-applies its edits to the head. */
  onHead: boolean;
  dream?: DreamId;
  at: number;
  edits: EditSet | null;
  /** The approval gate that asked (a dream's proposal). */
  gate?: string;
  /** The side-effecting tools its new edges route into. */
  tools: string[];
}

export interface ApprovalList {
  graph: GraphId;
  head?: RevisionId;
  /** Oldest first. */
  approvals: ApprovalSummary[];
}

export type ApprovalResult =
  | { status: "committed"; graph: GraphId; candidate: RevisionId; revision: RevisionId; previous: RevisionId }
  | { status: "unchanged"; graph: GraphId; candidate: RevisionId; head: RevisionId }
  | { status: "declined"; graph: GraphId; candidate: RevisionId }
  | { status: "refused"; graph: GraphId; candidate: RevisionId; gate?: "structure" | "evidence" | "head"; reason: string };

/** Hook-bus notices about the inbox; the host publishes them (under its own source). */
export type ApprovalNotice =
  | {
      type: "procedural.approval.requested";
      payload: { graph: GraphId; candidate: RevisionId; origin: RevisionRecord["origin"]; parent: RevisionId | null; dream?: DreamId; gate?: string; tools: string[] };
    }
  | { type: "procedural.approval.decided"; payload: { graph: GraphId; candidate: RevisionId; decision: "approved" | "declined"; revision?: RevisionId } };

const isWaiting = (r: RevisionRecord): boolean => r.decision.kind === "pending-approval";

function asked(record: RevisionRecord): { gate?: string; tools: string[] } {
  const parsed = ApprovalAskSchema.safeParse(record.evidence["approval"]);
  return parsed.success ? parsed.data : { tools: [] };
}

function summary(record: RevisionRecord, head: RevisionId | undefined): ApprovalSummary {
  const parent = record.parents[0] ?? null;
  return {
    candidate: record.id,
    graph: record.graph,
    origin: record.origin,
    parent,
    onHead: parent !== null && parent === head,
    ...(record.dream === undefined ? {} : { dream: record.dream }),
    at: record.at,
    edits: record.edits,
    ...asked(record),
  };
}

/** The candidates of a graph waiting for approval, oldest first. */
export async function listApprovals(input: { store: ProceduralStore; graph: GraphId }): Promise<ApprovalList> {
  const { store, graph } = input;
  const head = (await store.heads.get(graph))?.revision;
  const waiting = (await store.revisions.list(graph)).filter(isWaiting).sort((a, b) => a.at - b.at);
  return { graph, ...(head === undefined ? {} : { head }), approvals: waiting.map((r) => summary(r, head)) };
}

/** The notice that a candidate waits for approval. */
export function requestedNotice(record: RevisionRecord): ApprovalNotice {
  const { candidate, graph, origin, parent, dream, gate, tools } = summary(record, undefined);
  return { type: "procedural.approval.requested", payload: { graph, candidate, origin, parent, ...(dream === undefined ? {} : { dream }), ...(gate === undefined ? {} : { gate }), tools } };
}

/** The notice that a candidate was decided, for a result that decided one; none otherwise. */
export function decidedNotice(result: ApprovalResult): ApprovalNotice | undefined {
  const { graph, candidate } = result;
  switch (result.status) {
    case "committed":
      return { type: "procedural.approval.decided", payload: { graph, candidate, decision: "approved", revision: result.revision } };
    case "unchanged":
      return { type: "procedural.approval.decided", payload: { graph, candidate, decision: "approved", revision: result.head } };
    case "declined":
      return { type: "procedural.approval.decided", payload: { graph, candidate, decision: "declined" } };
    case "refused":
      return undefined;
  }
}

/** Dream's inbox port over a notifier: each stored proposal becomes a `requested` notice. */
export const approvalInbox = (notify: (notice: ApprovalNotice) => void | Promise<void>): ApprovalInbox => ({
  pending: async ({ candidate }) => {
    await notify(requestedNotice(candidate));
  },
});

/** The overlay log starts on the graph's first head, the oldest in its history. */
const firstHead = (head: Head): RevisionId => head.history.at(-1) ?? head.revision;

/** The edits without the additions the head already has (the same node, or the same edge that the deletions leave), so a rebase adds nothing twice. */
function onto(head: ProceduralGraph, edits: EditSet): EditSet {
  const gone = new Set<string>(edits.delete_nodes);
  const cut = new Set(edits.delete_edges.map((e) => canonicalJson([e.source, e.target])));
  const nodes = new Set(head.nodes.filter((n) => !gone.has(n.id)).map((n) => canonicalJson([n.id, n.type, n.description])));
  const kept = head.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to) && !cut.has(canonicalJson([e.from, e.to])));
  const edges = new Set(kept.map((e) => canonicalJson([e.from, e.relation, e.to, e.condition, e.guidance, e.pitfalls])));
  return {
    ...edits,
    add_nodes: edits.add_nodes.filter((n) => !nodes.has(canonicalJson([n.id, n.type, n.description]))),
    add_edges: edits.add_edges.filter((e) => !edges.has(canonicalJson([e.source, e.relation, e.target, e.condition, e.guidance, e.pitfalls]))),
  };
}

/**
 * The candidate against the current head: on the head it was proposed on (and for an
 * import) its document as it is; on a later head, its edits applied there (additions the
 * head already has are left out), with the workflow bindings it gave the nodes it adds.
 */
function againstHead(record: RevisionRecord, head: ProceduralGraph, cycles: CyclePolicy): ParsedGraph {
  if (record.edits === null || record.parents[0] === revisionId(head)) return parseGraph(record.document, cycles);
  const prepared = prepareCandidate(head, onto(head, record.edits), { cycles });
  if (prepared.diagnostics.length > 0) return { ok: false, diagnostics: prepared.diagnostics };
  const added = new Set<string>(record.edits.add_nodes.map((n) => n.id));
  const bound = new Map(record.document.nodes.flatMap((n) => (n.binding !== undefined && added.has(n.id) ? [[n.id, n.binding] as const] : [])));
  const document: CandidateDocument = { ...prepared.document, nodes: prepared.document.nodes.map((n) => (bound.has(n.id) ? { ...n, binding: bound.get(n.id)! } : n)) };
  return parseGraph(document, cycles);
}

/** The evidence gate against the overlay on the current head, when the preset lists it; a pass otherwise. */
async function evidenceNow(store: ProceduralStore, record: RevisionRecord, head: Head, base: ProceduralGraph, candidate: ProceduralGraph, preset: Preset): Promise<GateResult | undefined> {
  const { dream } = preset;
  // Stryker disable next-line Regex: equivalent; parsed settings allow `?` only at the end of a gate name
  const listed = dream.mode === "incremental" && dream.gate.some((g) => g.replace(/\?$/, "") === "evidence");
  if (!listed || record.edits === null) return undefined;
  if (!preset.overlay || preset.live === undefined) return { pass: false, reason: "no live evidence: the preset has no overlay" };
  const overlay = foldAll(firstHead(head), (await store.overlay(record.graph).read(0)).map((e) => e.event));
  if (overlay.base !== head.revision) return { pass: false, reason: `no live evidence yet: the overlay is not rebased onto the head ${head.revision}` };
  const composition = CompositionEvidenceSchema.safeParse(record.evidence["composition"]);
  return evidenceGate({ base, candidate, overlay, minSupport: preset.live.minSupport, confidence: preset.live.promote.confidence, ...(composition.success && { composition: composition.data }) });
}

/**
 * Approve a candidate waiting for approval: the structure and evidence gates run against
 * the current head, then the revision is committed by compare-and-set and the overlay
 * rebased onto it. A candidate proposed on an earlier head commits as its edits on this
 * one, and its own record is marked `approved` as that revision.
 */
export async function approveCandidate(input: { store: ProceduralStore; record: RevisionRecord; preset: Preset; clock: ClockLike }): Promise<ApprovalResult> {
  const { store, record, preset, clock } = input;
  const { graph, id: candidate } = record;
  const refused = (reason: string, gate?: "structure" | "evidence" | "head"): ApprovalResult => ({ status: "refused", graph, candidate, ...(gate === undefined ? {} : { gate }), reason });
  if (!isWaiting(record)) return refused(`candidate ${candidate} is not waiting for approval (its decision is ${record.decision.kind})`);
  if (record.redacted === true) return refused(`candidate ${candidate} is redacted`);
  const head = await store.heads.get(graph);
  if (head === undefined) return refused(`graph ${graph} has no head`);
  const current = parseGraph((await store.revisions.get(head.revision))?.document);
  if (!current.ok) return refused(`the head ${head.revision} of graph ${graph} is missing or does not parse (it may be redacted)`);
  const structure = againstHead(record, current.graph, preset.dream.cycles);
  if (!structure.ok) return refused(structureGate(structure).reason, "structure");
  const graphNow = structure.graph;
  const gates: (GateResult & { gate: string })[] = [{ gate: "structure", ...structureGate({ diagnostics: [] }) }];
  const evidence = await evidenceNow(store, record, head, current.graph, graphNow, preset);
  if (evidence !== undefined) {
    if (!evidence.pass) return refused(evidence.reason, "evidence");
    gates.push({ gate: "evidence", ...evidence });
  }
  const id = revisionId(graphNow);
  const approved = { ...record, decision: { kind: "approved" as const, revision: id } };
  if (id === head.revision) {
    await store.revisions.put(approved);
    return { status: "unchanged", graph, candidate, head: id };
  }
  const earlier = await store.revisions.get(id);
  const committed = RevisionRecordSchema.parse({
    ...approved,
    id,
    parents: [head.revision],
    document: graphNow,
    evidence: { ...record.evidence, approved: { candidate, on: head.revision, gates } },
    decision: { kind: "head" },
    at: clock.now(),
  });
  await store.revisions.put(committed);
  if (!(await store.heads.set(graph, head.revision, id))) {
    // An id is its content: put back what it held, or remember the lost race as the dream does.
    await store.revisions.put(earlier ?? { ...committed, decision: { kind: "rejected-gate", gate: "head", reason: "the head moved during the approval" } });
    return refused(`the head of graph ${graph} moved; try again`, "head");
  }
  if (id !== candidate) await store.revisions.put(approved);
  const log = store.overlay(graph);
  const overlay = foldAll(firstHead(head), (await log.read(0)).map((e) => e.event));
  await log.append([rebaseOverlay(overlay, graphNow, absorbedEntries(overlay, current.graph, graphNow)).event]);
  return { status: "committed", graph, candidate, revision: id, previous: head.revision };
}

/** Decline a candidate waiting for approval: it is rejected by the gate that asked (`approval` for an import) and remembered as a rejection. */
export async function declineCandidate(input: { store: ProceduralStore; record: RevisionRecord }): Promise<ApprovalResult> {
  const { store, record } = input;
  const { graph, id: candidate } = record;
  if (!isWaiting(record)) return { status: "refused", graph, candidate, reason: `candidate ${candidate} is not waiting for approval (its decision is ${record.decision.kind})` };
  const gate = asked(record).gate ?? "approval";
  await store.revisions.put({ ...record, decision: { kind: "rejected-gate", gate, reason: approvalGate({ required: true, approved: false }).reason } });
  return { status: "declined", graph, candidate };
}
