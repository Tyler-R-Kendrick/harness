/**
 * The dynamic layer's vocabulary (plan §4.4): entries it can hold, events it folds and
 * the effective graph guidance reads. The overlay only adds and annotates: an entry is
 * an edge the core lacks, a node such an edge needs, a note on an edge or a caution on
 * one. No entry carries a binding (I5), so the overlay can never reach a tool.
 */
import { z } from "zod";
import { EntryIdSchema, NodeNameSchema, NodeTypeNameSchema, RelationNameSchema, revisionId, RevisionIdSchema, ScoreSchema } from "./graph.ts";
import type { EntryId, GraphEdge, GraphNode, ProceduralGraph, RevisionId } from "./graph.ts";

const anchor = z.strictObject({ from: NodeNameSchema, to: NodeNameSchema });
const text = z.string().min(1);

export const OverlayEntrySchema = z.discriminatedUnion("kind", [
  /** A transition the core lacks. */
  z.strictObject({
    kind: z.literal("edge"),
    from: NodeNameSchema,
    relation: RelationNameSchema,
    to: NodeNameSchema,
    condition: z.string().nullable(),
    guidance: z.string(),
    pitfalls: z.string(),
  }),
  /** A node an edge entry needs. */
  z.strictObject({ kind: z.literal("node"), id: NodeNameSchema, type: NodeTypeNameSchema, description: z.string() }),
  /** Advice appended to a core or overlay edge. */
  z.strictObject({ kind: z.literal("note"), on: anchor, text }),
  /** "This edge preceded failures": shown, never deleted (I2). */
  z.strictObject({ kind: z.literal("caution"), on: anchor, text }),
]);
export type OverlayEntry = z.output<typeof OverlayEntrySchema>;

export const EntryStatusSchema = z.enum(["probation", "active", "retired"]);
export type EntryStatus = z.output<typeof EntryStatusSchema>;

/** `"<sessionId>/<turnId>"`: the fold ignores a turn it has seen (I4). */
const TurnKeySchema = z.string().regex(/^[^/]+\/.+$/, "a turn key <sessionId>/<turnId>");

const count = z.int().min(0);

export const OverlayEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("observed"),
    turnKey: TurnKeySchema,
    /** Matched nodes, in order. */
    path: z.array(NodeNameSchema),
    /** Actions that matched no node. */
    unmatched: z.array(z.string()),
    score: ScoreSchema.nullable(),
    /** Probationary entries this turn was shown (plan §6.3). */
    exposure: z.array(EntryIdSchema),
    /**
     * Present on a re-observation that changes a folded turn's score (feedback): the fold
     * moves the turn's score from `previous` to `score` without a new traversal. `seq`
     * numbers the turn's re-observations, so a redelivered one is ignored; `observedAt` is
     * the version the turn first folded at, so only entries that counted it change.
     * Consumers counting turns skip these.
     */
    rescore: z.strictObject({ seq: z.int().min(1), previous: ScoreSchema.nullable(), observedAt: z.int().min(1) }).exactOptional(),
  }),
  z.strictObject({
    kind: z.literal("proposed"),
    entry: OverlayEntrySchema,
    source: z.strictObject({ sessions: z.array(z.string().min(1)), by: z.enum(["stats", "reflection"]) }),
  }),
  z.strictObject({ kind: z.literal("status"), entry: EntryIdSchema, to: z.enum(["active", "retired"]), reason: z.string() }),
  z.strictObject({
    kind: z.literal("rebased"),
    core: RevisionIdSchema,
    absorbed: z.array(EntryIdSchema),
    dropped: z.array(EntryIdSchema),
    /** The overlay version that sessions still pinned to the old core keep. */
    frozenAt: count,
  }),
]);
export type OverlayEvent = z.output<typeof OverlayEventSchema>;

/** Traversals of an edge; `lastSeen` is an overlay version. */
export interface EdgeStats {
  traversals: number;
  scored: number;
  scoreSum: number;
  lastSeen: number;
}

/** A transition the graph lacks: its distinct sessions (at most 64) and scores. */
export interface TransitionStats {
  sessions: string[];
  scored: number;
  scoreSum: number;
}

export interface Arm {
  n: number;
  scored: number;
  scoreSum: number;
}

/** Outcomes of sessions shown an entry and of those not shown it, and who supports it. */
export interface EntryEvidence {
  exposed: Arm;
  unexposed: Arm;
  support: string[];
  firstSeen: number;
  lastSeen: number;
}

export interface OverlayState {
  base: RevisionId;
  /** The number of events folded. */
  version: number;
  entries: Record<EntryId, { entry: OverlayEntry; status: EntryStatus; evidence: EntryEvidence }>;
  /** Keyed "from→to". */
  stats: Record<string, EdgeStats>;
  /** Keyed "from→to". */
  transitions: Record<string, TransitionStats>;
  /** Turn keys seen; the oldest are dropped after 10,000. */
  turns: string[];
}

export type EffectiveNode = GraphNode & { origin: "core" | "overlay"; status?: EntryStatus };
export type EffectiveEdge = GraphEdge & {
  origin: "core" | "overlay";
  status?: EntryStatus;
  notes: { text: string; status: EntryStatus }[];
  cautions: { text: string; status: EntryStatus }[];
};

/** `core ⊕ overlay`: what guidance reads. It always contains the whole core (I2). */
export interface EffectiveGraph {
  core: RevisionId;
  /** The overlay version, or null for the core alone. */
  overlay: number | null;
  nodes: EffectiveNode[];
  edges: EffectiveEdge[];
}

/** The core alone, as an effective graph (the paper preset's view). */
export const coreView = (g: ProceduralGraph): EffectiveGraph => ({
  core: revisionId(g),
  overlay: null,
  nodes: g.nodes.map((n) => ({ ...n, origin: "core" })),
  edges: g.edges.map((e) => ({ ...e, origin: "core", notes: [], cautions: [] })),
});
