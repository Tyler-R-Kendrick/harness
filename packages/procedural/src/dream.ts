/**
 * Dream as a pure reducer (plan §7.3): Algorithm 1 of App. B.6, generalized. The runner
 * (`dream-runner.ts`) performs each command and feeds back one event per command; the
 * reducer holds everything else, so a dream is its input plus its event log and resumes
 * by replaying it (plan §7.1).
 *
 * The paper preset is Algorithm 1 exactly:
 *
 *     S₀ ← Evaluate(G₀, D_val);  H_rejected ← []
 *     for k = 1..K:
 *       E_k ← Rollout(G_{k−1}, B_k)                       B_k: the k-th stride, wrapping
 *       C_k ← Tail_{L_max}(Concat(E_k))
 *       ΔG_k ← Refiner(G_{k−1}, C_k, {S_i}, SerializeRejections(H_rejected))
 *       (G_cand, d_k) ← PrepareCandidate(G_{k−1}, ΔG_k, c)
 *       if d_k ≠ ∅: remember (ΔG_k, G_cand, E_k, d_k); continue       no evaluation
 *       S_cand ← Evaluate(G_cand, D_val)
 *       if S_cand ≥ S_{k−1}: G_k ← G_cand; S_k ← S_cand             ties accepted
 *       else: remember (ΔG_k, G_cand, E_k, S_cand)
 *
 * A rejected candidate never seeds the next round. Generalized: without an evaluator a
 * round selects recorded trajectories instead of rolling out; the harness context keeps
 * each trajectory's own tail, balanced between high and low scores; the refiner also
 * sees the overlay's entries, cautioned edges and rejection reasons (consolidation); the
 * gates are those the preset lists (§7.4); a commit is followed by a rebase of the
 * overlay onto the new core. `onetime` is one ungated round over every training task
 * (App. D.2); approval gates, a security control, still apply.
 */
import { z } from "zod";
import { canonicalJson } from "./canonical.ts";
import { prepareCandidate } from "./edits.ts";
import type { PreparedCandidate, PrepareOptions } from "./edits.ts";
import { anchoredNonInferiority, approvalGate, atLeastRetained, evidenceGate, graphSize, poorStatistics, routesIntoSideEffects, structureGate } from "./gates.ts";
import type { GateResult, TaskScore } from "./gates.ts";
import { BindingSchema, EditSetSchema, EntryIdSchema, NodeNameSchema, ProceduralGraphSchema, revisionId, seedGraph } from "./graph.ts";
import type { CandidateDocument, Decision, DreamId, EditSet, EntryId, GraphId, ProceduralGraph, RevisionId, RevisionRecord } from "./graph.ts";
import { edgeKey, foldOverlay } from "./overlay.ts";
import { OverlayEventSchema } from "./overlay-types.ts";
import type { Arm, OverlayEntry, OverlayState } from "./overlay-types.ts";
import type { RefineRequest } from "./refine.ts";
import { serializeWindow } from "./serialize.ts";
import type { DreamSettings, LiveSettings } from "./settings.ts";
import { ScoredTrajectorySchema } from "./trajectory.ts";
import type { ScoredTrajectory } from "./trajectory.ts";

type Step = ScoredTrajectory["steps"][number];

// ---- vocabulary ---------------------------------------------------------------------------

const TaskScoreSchema = z.strictObject({ task: z.string(), score: z.number().min(0).max(1) });

/** One training task rolled out under a graph: its score and, when the evaluator keeps it, its trace. */
export const RolloutResultSchema = z.strictObject({
  task: z.string(),
  score: z.number().min(0).max(1),
  query: z.string().exactOptional(),
  steps: ScoredTrajectorySchema.shape.steps.exactOptional(),
});
export type RolloutResult = z.output<typeof RolloutResultSchema>;

const stamp = { command: z.int().min(0), at: z.int().min(0) };

const [, WorkflowBindingSchema] = BindingSchema.options;

/**
 * A composition as the runner reports it: the path it compiles, the distinct sessions that
 * walked it, the workflow node and its binding, and the edits (`composeCandidate`'s) that
 * add the node beside the path. The reducer binds the node when it prepares the candidate.
 */
export const CompositionSchema = z.strictObject({
  path: z.array(NodeNameSchema).min(1),
  support: z.int().min(0),
  node: NodeNameSchema,
  binding: WorkflowBindingSchema,
  edits: EditSetSchema,
});
export type DreamComposition = z.output<typeof CompositionSchema>;

/** The result of one command, stamped with the command's id and the Clock's time. */
export const DreamEventSchema = z.discriminatedUnion("kind", [
  /** Per-task validation scores, and the seed any resampling uses (drawn from Entropy). */
  z.strictObject({ ...stamp, kind: z.literal("evaluated"), scores: z.array(TaskScoreSchema), seed: z.string() }),
  z.strictObject({ ...stamp, kind: z.literal("rolled-out"), results: z.array(RolloutResultSchema) }),
  z.strictObject({ ...stamp, kind: z.literal("selected"), trajectories: z.array(ScoredTrajectorySchema) }),
  z.strictObject({
    ...stamp,
    kind: z.literal("refined"),
    result: z.union([z.strictObject({ edits: EditSetSchema, raw: z.string() }), z.strictObject({ error: z.string(), raw: z.string() })]),
  }),
  z.strictObject({ ...stamp, kind: z.literal("approved"), approved: z.boolean() }),
  /** Whether the head's compare-and-set succeeded. */
  z.strictObject({ ...stamp, kind: z.literal("committed"), ok: z.boolean() }),
  /** A rejection record was stored. */
  z.strictObject({ ...stamp, kind: z.literal("recorded") }),
  /** The `rebased` overlay event the runner appended. */
  z.strictObject({ ...stamp, kind: z.literal("rebased"), event: OverlayEventSchema }),
  /** A path compiled, staged and composed into the retained graph (plan §7.6), or why there is none. */
  z.strictObject({ ...stamp, kind: z.literal("composed"), result: z.union([CompositionSchema, z.strictObject({ none: z.string() })]) }),
]);
export type DreamEvent = z.output<typeof DreamEventSchema>;

/** What the refiner port is asked: `refine`'s request without the model, the template and decoding. */
export type DreamRefineRequest = Pick<RefineRequest, "task" | "mode" | "tools" | "attempts" | "graphJson" | "rejected" | "consolidation">;

export type RoundOutcome =
  | { round: number; outcome: "committed"; revision: RevisionId; score: number | null }
  | { round: number; outcome: "rejected"; revision: RevisionId | null; gate: string; reason: string }
  | { round: number; outcome: "unchanged"; score: number | null }
  | { round: number; outcome: "known-rejection"; revision: RevisionId }
  | { round: number; outcome: "conflict"; revision: RevisionId }
  | { round: number; outcome: "no-composition"; reason: string };

/** What a finished dream reports. */
export interface DreamOutcome {
  dream: DreamId;
  graph: GraphId;
  /** G₀. */
  initial: RevisionId;
  /** The retained graph at the end. */
  head: RevisionId;
  /** Its cached validation score, when it has one. */
  score: number | null;
  rounds: RoundOutcome[];
}

export type DreamCommand =
  | { id: number; kind: "evaluate"; revision: RevisionId; graph: ProceduralGraph; tasks: "validation" }
  | { id: number; kind: "rollout"; revision: RevisionId; graph: ProceduralGraph; batch: string[] }
  | { id: number; kind: "select"; revision: RevisionId; limit: number }
  | { id: number; kind: "refine"; request: DreamRefineRequest }
  | { id: number; kind: "approve"; candidate: RevisionRecord; tools: string[] }
  | { id: number; kind: "commit"; record: RevisionRecord; expected: RevisionId }
  | { id: number; kind: "reject"; record: RevisionRecord }
  | { id: number; kind: "rebase"; core: ProceduralGraph; absorbed: EntryId[] }
  /** Compose a path of `graph` into a workflow node; `known` are rejected candidates not to propose again. */
  | { id: number; kind: "compose"; revision: RevisionId; graph: ProceduralGraph; known: RevisionId[] }
  | { id: number; kind: "done"; result: DreamOutcome };
type Draft = DreamCommand extends infer C ? (C extends DreamCommand ? Omit<C, "id"> : never) : never;

const EVENT_OF: Record<DreamCommand["kind"], DreamEvent["kind"] | undefined> = {
  evaluate: "evaluated",
  rollout: "rolled-out",
  select: "selected",
  refine: "refined",
  approve: "approved",
  commit: "committed",
  reject: "recorded",
  rebase: "rebased",
  compose: "composed",
  done: undefined,
};

type RejectedDecision = Extract<Decision, { kind: "rejected-structure" | "rejected-gate" }>;

/** One entry of the rejection memory. */
export interface Rejection {
  /** Null when the refiner's answer was not an edit set. */
  id: RevisionId | null;
  parent: RevisionId | null;
  /** The round of this dream, or null for a rejection from an earlier dream. */
  round: number | null;
  edits: EditSet | null;
  document: CandidateDocument | null;
  decision: RejectedDecision;
  /** The candidate's mean validation score, when it was evaluated. */
  score: number | null;
}

export interface DreamInput {
  dream: DreamId;
  graph: GraphId;
  /** G₀: the head when the dream started. */
  head: ProceduralGraph;
  settings: DreamSettings;
  /** Whether the graph has an evaluator: rounds roll out training tasks, and evaluator gates apply. */
  evaluator: boolean;
  approver: boolean;
  /** Training task ids, in order, for strides. */
  train: readonly string[];
  /** Tasks per round (the paper's S), or trajectories selected per round without an evaluator. */
  stride: number;
  /** `{task_description}`. */
  task: string;
  /** The tool catalog. */
  tools: readonly string[];
  /** Tools declared free of side effects; every other tool needs approval under `approval-for-side-effects`. */
  sideEffectFree: readonly string[];
  /** The overlay at the dream's snapshot, with the live settings its evidence is read by. */
  overlay?: { state: OverlayState; live: LiveSettings };
  /** Rejection records from earlier dreams (the harness remembers them; the paper starts empty). */
  rejections: readonly RevisionRecord[];
  /** After the rounds, one composition round (plan §7.6): the settings ask for it and the runner has a composer. */
  compose?: boolean;
  /** Counts `contextTokens` in the refiner's tokens; without one, whitespace-separated words. */
  tokenizer?: Tokenizer;
}

/** A tokenizer, for the paper's Tail_{L_max}: text to token ids and back. */
export interface Tokenizer {
  encode(text: string): readonly number[];
  decode(ids: readonly number[]): string;
}

interface Retained {
  graph: ProceduralGraph;
  revision: RevisionId;
  /** Per-task validation scores (S_k), when evaluated. */
  scores: readonly TaskScore[] | null;
  mean: number | null;
}

interface GateOutcome extends GateResult {
  gate: string;
}

interface Attempt {
  id: string;
  score: number | null;
  query: string;
  steps: readonly Step[];
}

interface Round {
  attempts: readonly { id: string; score: number | null }[];
  observations: readonly string[];
  edits?: EditSet;
  prepared?: PreparedCandidate;
  gates: readonly GateOutcome[];
  scores: readonly TaskScore[] | null;
  mean: number | null;
  /** The approval gate that asked, while an approval is pending. */
  approval?: string;
  /** The composition this round's candidate binds. */
  composition?: DreamComposition;
}

export interface DreamState {
  readonly input: DreamInput;
  /** The next command id. */
  readonly next: number;
  /** Commands issued and not yet answered; after a replay, exactly those to re-issue. */
  readonly pending: readonly DreamCommand[];
  /** The current round, from 1; 0 before the first. */
  readonly round: number;
  readonly retained: Retained;
  /** S₀ per task: G₀'s validation scores, the anchor of the non-inferiority gate. */
  readonly anchor: readonly TaskScore[] | null;
  /** The overlay as the dream sees it (rebased after each commit), with the live settings its evidence is read by. */
  readonly overlay: { state: OverlayState; live: LiveSettings } | undefined;
  readonly rejections: readonly Rejection[];
  readonly rounds: readonly RoundOutcome[];
  readonly work: Round;
  readonly committed: readonly RevisionId[];
}

export interface DreamStep {
  state: DreamState;
  commands: DreamCommand[];
}

// ---- rendering ----------------------------------------------------------------------------

/**
 * The last `limit` tokens of a text; a shorter text is unchanged (the paper's Tail_{L_max}).
 * Tokens are the tokenizer's when one is given, else whitespace-separated words.
 */
export function tailTokens(text: string, limit: number, tokenizer?: Tokenizer): string {
  if (tokenizer !== undefined) {
    const ids = tokenizer.encode(text);
    return ids.length <= limit ? text : tokenizer.decode(ids.slice(ids.length - limit));
  }
  // Stryker disable next-line ArrayDeclaration: equivalent; with no match the text is empty, and dropping tokens from an empty text leaves it empty
  const tokens = text.match(/\S+\s*/g) ?? [];
  if (tokens.length <= limit) return text;
  return tokens.slice(tokens.length - limit).join("");
}

const f2 = (x: number): string => x.toFixed(2);
const mean = (scores: readonly TaskScore[]): number => scores.reduce((s, x) => s + x.score, 0) / scores.length;

function header(a: Attempt): string {
  return `Trajectory ${a.id} (score: ${a.score === null ? "unscored" : f2(a.score)})`;
}

function body(a: Attempt): string {
  return [...(a.query === "" ? [] : [`Query: ${a.query}`]), serializeWindow(a.steps, a.steps.length)].filter((line) => line !== "").join("\n");
}

const joinLines = (...lines: string[]): string => lines.filter((line) => line !== "").join("\n");

/** High and low scores alternating from the extremes inward, then the unscored. */
function balanced(attempts: readonly Attempt[]): Attempt[] {
  const scored = attempts.filter((a) => a.score !== null).sort((a, b) => b.score! - a.score!);
  const out: Attempt[] = [];
  for (let i = 0, j = scored.length - 1; i <= j; i += 1, j -= 1) {
    out.push(scored[i]!);
    if (i < j) out.push(scored[j]!);
  }
  return [...out, ...attempts.filter((a) => a.score === null)];
}

function renderAttempts(attempts: readonly Attempt[], settings: DreamSettings, tokenizer: Tokenizer | undefined): string {
  if (settings.context === "tail-concatenated") return tailTokens(attempts.map((a) => joinLines(header(a), body(a))).join("\n\n"), settings.contextTokens, tokenizer);
  const ordered = balanced(attempts);
  const share = Math.floor(settings.contextTokens / Math.max(1, ordered.length));
  return ordered.map((a) => joinLines(header(a), tailTokens(body(a), share, tokenizer))).join("\n\n");
}

const graphJson = (g: ProceduralGraph): string => JSON.stringify({ format: g.format, nodeTypes: g.nodeTypes, relations: g.relations, nodes: g.nodes, edges: g.edges }, null, 2);

function reasonOf(r: Rejection): string {
  if (r.decision.kind === "rejected-structure") return `structural failure: ${structureGate(r.decision).reason}`;
  return `rejected by ${r.decision.gate}${r.score === null ? "" : `, validation score ${r.score.toFixed(4)}`}: ${r.decision.reason}`;
}

/** The rejections the refiner sees: all of them (the paper), or the most relevant `limit`. */
function shownRejections(state: DreamState): readonly Rejection[] {
  const { show, limit } = state.input.settings.rejections;
  if (show === "all") return state.rejections;
  const latest = new Map<string, number>();
  state.rejections.forEach((r, i) => latest.set(r.id ?? `answer:${i}`, i));
  const unique = [...latest.values()];
  const against = (i: number): number => Number(state.rejections[i]!.parent === state.retained.revision);
  return unique
    .sort((a, b) => against(b) - against(a) || b - a)
    .slice(0, limit)
    .map((i) => state.rejections[i]!);
}

function renderRejections(shown: readonly Rejection[]): string {
  if (shown.length === 0) return "None";
  return shown
    .map((r, i) =>
      joinLines(
        `Candidate ${i + 1}${r.round === null ? "" : ` (round ${r.round})`}: ${reasonOf(r)}`,
        `Edits: ${r.edits === null ? "none (the answer was not an edit set)" : JSON.stringify(r.edits)}`,
        r.document === null ? "" : `Graph: ${JSON.stringify(r.document)}`,
      ),
    )
    .join("\n\n");
}

const lines = (items: readonly string[]): string => (items.length === 0 ? "None" : items.join("\n"));
const armText = (arm: Arm): string => `${arm.n} turns, ${arm.scored === 0 ? "unscored" : `mean ${f2(arm.scoreSum / arm.scored)}`}`;

function consolidation(state: DreamState, { state: overlay, live }: { state: OverlayState; live: LiveSettings }, shown: readonly Rejection[]): NonNullable<DreamRefineRequest["consolidation"]> {
  const entries = Object.values(overlay.entries).filter((r) => r.status !== "retired");
  const bar = { minSupport: live.minSupport, confidence: live.promote.confidence };
  const seen = new Set<string>();
  const cautioned: string[] = [];
  for (const { from, to } of state.retained.graph.edges) {
    const key = edgeKey(from, to);
    const cautions = entries.flatMap((r) => (r.entry.kind === "caution" && r.entry.on.from === from && r.entry.on.to === to ? [r.entry.text] : []));
    if (seen.has(key) || (cautions.length === 0 && !poorStatistics(overlay, from, to, bar))) continue;
    seen.add(key);
    const stats = overlay.stats[key];
    const traversed = stats === undefined ? "no traversals" : `${stats.traversals} traversals, ${stats.scored} scored, ${stats.scored === 0 ? "unscored" : `mean ${f2(stats.scoreSum / stats.scored)}`}`;
    cautioned.push(`- ${from} → ${to}: ${traversed}, ${overlay.transitions[key]?.sessions.length ?? 0} sessions${cautions.map((c) => `; caution: ${c}`).join("")}`);
  }
  return {
    overlayEntries: lines(entries.map((r) => `- [${r.status}] ${canonicalJson(r.entry)} (support ${r.evidence.support.length} sessions; exposed ${armText(r.evidence.exposed)}; unexposed ${armText(r.evidence.unexposed)})`)),
    cautionedEdges: lines(cautioned),
    rejectionReasons: lines(shown.map((r) => `- ${r.id === null ? "unparsed answer" : r.id.slice(0, 12)}: ${reasonOf(r)}`)),
  };
}

// ---- absorbed entries ------------------------------------------------------------------------

/**
 * The live overlay entries a candidate absorbs, which the rebase retires: an edge or a
 * node the candidate has, a note whose text an edge between its endpoints now carries,
 * and a caution on an edge the candidate pruned.
 */
export function absorbedEntries(overlay: OverlayState, base: CandidateDocument, candidate: CandidateDocument): EntryId[] {
  const before = new Set(base.edges.map((e) => edgeKey(e.from, e.to)));
  const after = new Set(candidate.edges.map((e) => edgeKey(e.from, e.to)));
  const absorbs = (e: OverlayEntry): boolean => {
    switch (e.kind) {
      case "edge":
        return candidate.edges.some((c) => c.from === e.from && c.relation === e.relation && c.to === e.to);
      case "node":
        return candidate.nodes.some((n) => n.id === e.id);
      case "note":
        return candidate.edges.some((c) => c.from === e.on.from && c.to === e.on.to && [c.condition ?? "", c.guidance, c.pitfalls].some((t) => t.includes(e.text)));
      case "caution": {
        const key = edgeKey(e.on.from, e.on.to);
        return before.has(key) && !after.has(key);
      }
    }
  };
  return Object.entries(overlay.entries)
    .filter(([, r]) => r.status !== "retired" && absorbs(r.entry))
    .map(([id]) => EntryIdSchema.parse(id));
}

// ---- the reducer ------------------------------------------------------------------------------

const EVALUATOR_GATES = ["evaluator-at-least-retained", "evaluator-anchored-noninferiority"];
const APPROVAL_GATES = ["approval", "approval-for-side-effects"];

/** The gates a dream applies, by name, in the order listed; evaluator and evidence gates only when incremental. */
function gatesOf(input: DreamInput): { evaluator: string[]; evidence: boolean; approval: string[] } {
  // Stryker disable next-line Regex: equivalent; parsed settings allow `?` only at the end of a gate name
  const listed = input.settings.gate.map((g) => ({ name: g.replace(/\?$/, ""), optional: g.endsWith("?") }));
  const gated = input.settings.mode === "incremental";
  return {
    evaluator: gated ? listed.filter((g) => EVALUATOR_GATES.includes(g.name) && (!g.optional || input.evaluator)).map((g) => g.name) : [],
    evidence: gated && listed.some((g) => g.name === "evidence"),
    approval: listed.filter((g) => APPROVAL_GATES.includes(g.name)).map((g) => g.name),
  };
}

// Stryker disable next-line ArrayDeclaration: equivalent; a round's attempts and observations are set when it gathers, before anything reads them
const emptyRound = (): Round => ({ attempts: [], observations: [], gates: [], scores: null, mean: null });

function issue(state: DreamState, ...drafts: Draft[]): DreamStep {
  const commands = drafts.map((d, i) => ({ ...d, id: state.next + i }) as DreamCommand);
  return { state: { ...state, next: state.next + commands.length, pending: [...state.pending, ...commands] }, commands };
}

function fromRecord(r: RevisionRecord): Rejection[] {
  const { decision } = r;
  if (decision.kind !== "rejected-structure" && decision.kind !== "rejected-gate") return [];
  const score = r.evidence["score"];
  return [{ id: r.id, parent: r.parents[0] ?? null, round: null, edits: r.edits, document: r.document, decision, score: typeof score === "number" ? score : null }];
}

/** A dream's initial state; its `pending` holds the first command. */
export function dreamStart(input: DreamInput): DreamState {
  const revision = revisionId(input.head);
  const state: DreamState = {
    input,
    next: 0,
    pending: [],
    round: 0,
    retained: { graph: input.head, revision, scores: null, mean: null },
    anchor: null,
    overlay: input.overlay,
    rejections: input.rejections.flatMap(fromRecord),
    rounds: [],
    work: emptyRound(),
    // Stryker disable next-line ArrayDeclaration: equivalent; a placeholder string is never a revision id
    committed: [],
  };
  if (input.evaluator && gatesOf(input).evaluator.length > 0) return issue(state, { kind: "evaluate", revision, graph: input.head, tasks: "validation" }).state;
  return startRound(state, 1).state;
}

function batchOf(input: DreamInput, round: number): string[] {
  const n = input.train.length;
  // Stryker disable next-line EqualityOperator: equivalent; a stride of exactly n wraps to every task in order
  if (input.settings.mode === "onetime" || input.stride >= n) return [...input.train];
  return Array.from({ length: input.stride }, (_, j) => input.train[((round - 1) * input.stride + j) % n]!);
}

function startRound(state: DreamState, round: number): DreamStep {
  const s: DreamState = { ...state, round, work: emptyRound() };
  const { revision, graph } = s.retained;
  if (s.input.evaluator) return issue(s, { kind: "rollout", revision, graph, batch: batchOf(s.input, round) });
  return issue(s, { kind: "select", revision, limit: s.input.stride });
}

function outcome(state: DreamState): DreamOutcome {
  return { dream: state.input.dream, graph: state.input.graph, initial: revisionId(state.input.head), head: state.retained.revision, score: state.retained.mean, rounds: [...state.rounds] };
}

/** The next round, then (when composing) one composition round, then done. */
function nextRound(state: DreamState): DreamStep {
  const last = state.input.settings.mode === "onetime" ? 1 : state.input.settings.rounds;
  if (state.round < last) return startRound(state, state.round + 1);
  if (state.input.compose === true && state.round === last) {
    const { revision, graph } = state.retained;
    const known = [...new Set(state.rejections.flatMap((r) => (r.id === null ? [] : [r.id])))];
    return issue({ ...state, round: last + 1, work: emptyRound() }, { kind: "compose", revision, graph, known });
  }
  return issue(state, { kind: "done", result: outcome(state) });
}

const addRound = (state: DreamState, round: RoundOutcome): DreamState => ({ ...state, rounds: [...state.rounds, round] });

function gather(state: DreamState, attempts: readonly Attempt[]): DreamStep {
  const { input } = state;
  const shown = shownRejections(state);
  const request: DreamRefineRequest = {
    task: input.task,
    mode: `${revisionId(input.head) === revisionId(seedGraph()) ? "scratch" : "static"}_${input.settings.mode}`,
    tools: input.tools,
    attempts: renderAttempts(attempts, input.settings, input.tokenizer),
    graphJson: graphJson(state.retained.graph),
    rejected: renderRejections(shown),
    ...(state.overlay && { consolidation: consolidation(state, state.overlay, shown) }),
  };
  const work: Round = {
    ...emptyRound(),
    attempts: attempts.map((a) => ({ id: a.id, score: a.score })),
    observations: attempts.flatMap((a) => a.steps.filter((s) => s.role === "tool" || s.role === "observation").map((s) => s.content)),
  };
  return issue({ ...state, work }, { kind: "refine", request });
}

function record(state: DreamState, decision: Decision, at: number): RevisionRecord {
  const { work, retained, input } = state;
  const prepared = work.prepared!;
  return {
    id: prepared.id,
    graph: input.graph,
    parents: [retained.revision],
    document: prepared.document,
    edits: work.edits!,
    origin: "dream",
    dream: input.dream,
    evidence: {
      round: state.round,
      trajectories: work.attempts,
      score: work.mean,
      retained: retained.mean,
      ...(work.scores !== null && { validation: work.scores }),
      ...(work.composition && { composition: { path: work.composition.path, node: work.composition.node, support: work.composition.support } }),
      gates: work.gates,
      repaired: prepared.repaired,
    },
    decision,
    at,
  };
}

/** Never store a rejection over a revision this dream holds as a head (G₀, the retained graph, or a commit). */
function storable(state: DreamState, id: RevisionId): boolean {
  return id !== state.retained.revision && id !== revisionId(state.input.head) && !state.committed.includes(id);
}

function reject(state: DreamState, decision: RejectedDecision, at: number): DreamStep {
  const { work } = state;
  const prepared = work.prepared!;
  const [gate, reason] = decision.kind === "rejected-gate" ? [decision.gate, decision.reason] : ["structure", structureGate(decision).reason];
  const rejection: Rejection = { id: prepared.id, parent: state.retained.revision, round: state.round, edits: work.edits!, document: prepared.document, decision, score: work.mean };
  const s = addRound({ ...state, rejections: [...state.rejections, rejection] }, { round: state.round, outcome: "rejected", revision: prepared.id, gate, reason });
  if (!storable(s, prepared.id)) return nextRound(s);
  return issue(s, { kind: "reject", record: record(s, decision, at) });
}

const withGate = (state: DreamState, gate: string, result: GateResult): DreamState => ({ ...state, work: { ...state.work, gates: [...state.work.gates, { gate, ...result }] } });

function rejectGate(state: DreamState, gate: string, result: GateResult, at: number): DreamStep {
  return reject(withGate(state, gate, result), { kind: "rejected-gate", gate, reason: result.reason }, at);
}

function refined(state: DreamState, result: Extract<DreamEvent, { kind: "refined" }>["result"], at: number): DreamStep {
  const { retained } = state;
  if ("error" in result) {
    const decision: RejectedDecision = { kind: "rejected-structure", diagnostics: [{ code: "malformed", message: result.error }] };
    const rejection: Rejection = { id: null, parent: retained.revision, round: state.round, edits: null, document: null, decision, score: null };
    return nextRound(addRound({ ...state, rejections: [...state.rejections, rejection] }, { round: state.round, outcome: "rejected", revision: null, gate: "structure", reason: structureGate(decision).reason }));
  }
  const prepared = prepareCandidate(retained.graph, result.edits, prepareOptions(state));
  return candidate({ ...state, work: { ...state.work, edits: result.edits, prepared } }, at);
}

function prepareOptions(state: DreamState, extraTools: readonly string[] = []): PrepareOptions {
  const { input } = state;
  return {
    cycles: input.settings.cycles,
    ...(input.settings.enforceToolCatalog && { tools: [...input.tools, ...extraTools] }),
    ...(input.settings.editFilter && { filter: { observations: state.work.observations } }),
  };
}

/** The prepared candidate of a round: structure, then the rejection memory, then the gates. */
function candidate(s: DreamState, at: number): DreamStep {
  const { input, retained } = s;
  const prepared = s.work.prepared!;
  if (prepared.diagnostics.length > 0) return reject(s, { kind: "rejected-structure", diagnostics: prepared.diagnostics }, at);
  if (input.settings.rejections.dedupe) {
    if (s.rejections.some((r) => r.id === prepared.id)) return nextRound(addRound(s, { round: s.round, outcome: "known-rejection", revision: prepared.id }));
    if (prepared.id === retained.revision) return nextRound(addRound(s, { round: s.round, outcome: "unchanged", score: retained.mean }));
  }
  return afterStructure(s, at);
}

/**
 * The composition round's candidate (plan §7.6): the composition's edits prepared as any
 * refiner's (its workflow node counts as a tool the catalog has), then the node bound to
 * the staged workflow, which is the document the gates decide on.
 */
function composed(state: DreamState, result: Extract<DreamEvent, { kind: "composed" }>["result"], at: number): DreamStep {
  if ("none" in result) return nextRound(addRound(state, { round: state.round, outcome: "no-composition", reason: result.none }));
  const edited = prepareCandidate(state.retained.graph, result.edits, prepareOptions(state, [result.node]));
  const document: CandidateDocument = { ...edited.document, nodes: edited.document.nodes.map((n) => (n.id === result.node ? { ...n, binding: result.binding } : n)) };
  const prepared: PreparedCandidate = {
    ...edited,
    document,
    id: revisionId(document),
    ...(edited.diagnostics.length === 0 && { graph: ProceduralGraphSchema.parse(document) }),
  };
  return candidate({ ...state, work: { ...state.work, edits: result.edits, prepared, composition: result } }, at);
}

function afterStructure(state: DreamState, at: number): DreamStep {
  const { input, retained } = state;
  const gates = gatesOf(input);
  let s = state;
  if (gates.evidence) {
    const result = s.overlay
      ? evidenceGate({ base: retained.graph, candidate: s.work.prepared!.graph!, overlay: s.overlay.state, minSupport: s.overlay.live.minSupport, confidence: s.overlay.live.promote.confidence, ...(s.work.composition && { composition: { node: s.work.composition.node, support: s.work.composition.support } }) })
      : { pass: false, reason: "no live evidence: the preset has no overlay" };
    if (!result.pass) return rejectGate(s, "evidence", result, at);
    s = withGate(s, "evidence", result);
  }
  const [first] = gates.evaluator;
  if (first !== undefined) {
    if (!input.evaluator) return rejectGate(s, first, { pass: false, reason: "the gate needs an evaluator, and the graph has none" }, at);
    const prepared = s.work.prepared!;
    return issue(s, { kind: "evaluate", revision: prepared.id, graph: prepared.graph!, tasks: "validation" });
  }
  return approvalStage(s, at);
}

function evaluated(state: DreamState, event: Extract<DreamEvent, { kind: "evaluated" }>): DreamStep {
  const { scores, seed, at } = event;
  if (state.round === 0) return startRound({ ...state, anchor: scores, retained: { ...state.retained, scores, mean: mean(scores) } }, 1);
  const { input, retained } = state;
  const m = mean(scores);
  let s: DreamState = { ...state, work: { ...state.work, scores, mean: m } };
  const candidate = s.work.prepared!.graph!;
  for (const gate of gatesOf(input).evaluator) {
    const result =
      gate === "evaluator-at-least-retained"
        ? atLeastRetained({ candidate: m, retained: retained.mean! })
        : anchoredNonInferiority({ candidate: scores, retained: retained.scores!, anchor: s.anchor!, sizes: { candidate: graphSize(candidate), retained: graphSize(retained.graph) }, ...input.settings.noninferiority!, seed });
    if (!result.pass) return rejectGate(s, gate, result, at);
    s = withGate(s, gate, result);
  }
  return approvalStage(s, at);
}

function approvalStage(state: DreamState, at: number): DreamStep {
  const { input, retained, work } = state;
  const candidate = work.prepared!.graph!;
  const tools = routesIntoSideEffects(retained.graph, candidate, input.sideEffectFree);
  const gate = gatesOf(input).approval.find((g) => g === "approval" || tools.length > 0);
  if (gate === undefined) return accept(state, at);
  if (!input.approver) return rejectGate(state, gate, approvalGate({ required: true }), at);
  const s: DreamState = { ...state, work: { ...work, approval: gate } };
  return issue(s, { kind: "approve", candidate: record(s, { kind: "pending-approval" }, at), tools });
}

function accept(state: DreamState, at: number): DreamStep {
  const { work, retained } = state;
  if (work.prepared!.id === retained.revision) {
    // Stryker disable next-line ConditionalExpression: equivalent; the retained graph has a cached score only when evaluator gates apply, and then every candidate is evaluated
    const kept: Retained = work.scores === null ? retained : { ...retained, scores: work.scores, mean: work.mean };
    return nextRound(addRound({ ...state, retained: kept }, { round: state.round, outcome: "unchanged", score: kept.mean }));
  }
  return issue(state, { kind: "commit", record: record(state, { kind: "head" }, at), expected: retained.revision });
}

function committed(state: DreamState, ok: boolean): DreamStep {
  const { work, retained } = state;
  const prepared = work.prepared!;
  if (!ok) {
    const lost = addRound(state, { round: state.round, outcome: "conflict", revision: prepared.id });
    return issue(lost, { kind: "done", result: outcome(lost) });
  }
  const graph = prepared.graph!;
  const s = addRound({ ...state, retained: { graph, revision: prepared.id, scores: work.scores, mean: work.mean }, committed: [...state.committed, prepared.id] }, { round: state.round, outcome: "committed", revision: prepared.id, score: work.mean });
  if (s.overlay === undefined) return nextRound(s);
  return issue(s, { kind: "rebase", core: graph, absorbed: absorbedEntries(s.overlay.state, retained.graph, graph) });
}

/**
 * Feed one command's result to the reducer. An event for a command that is not pending
 * (a redelivery) changes nothing; an event of the wrong kind for its command is an error.
 */
export function dreamStep(state: DreamState, event: DreamEvent): DreamStep {
  const command = state.pending.find((c) => c.id === event.command);
  if (command === undefined) return { state, commands: [] };
  if (EVENT_OF[command.kind] !== event.kind) throw new RangeError(`command ${command.id} (${command.kind}) cannot finish with a ${event.kind} event`);
  // Stryker disable next-line ArrowFunction,ConditionalExpression: equivalent; the reducer never has more than one command pending
  const s: DreamState = { ...state, pending: state.pending.filter((c) => c !== command) };
  switch (event.kind) {
    case "evaluated":
      return evaluated(s, event);
    case "rolled-out":
      return gather(
        s,
        // Stryker disable next-line ArrayDeclaration: equivalent; a placeholder step has no role, so it renders nothing and is no observation
        event.results.map((r) => ({ id: r.task, score: r.score, query: r.query ?? "", steps: r.steps ?? [] })),
      );
    case "selected":
      return gather(
        s,
        event.trajectories.map((t) => ({ id: t.id, score: t.score, query: t.query, steps: t.steps })),
      );
    case "refined":
      return refined(s, event.result, event.at);
    case "approved": {
      const gate = s.work.approval!;
      const result = approvalGate({ required: true, approved: event.approved });
      if (!result.pass) return rejectGate(s, gate, result, event.at);
      return accept(withGate(s, gate, result), event.at);
    }
    case "committed":
      return committed(s, event.ok);
    case "recorded":
      return nextRound(s);
    case "rebased":
      return nextRound({ ...s, overlay: { ...s.overlay!, state: foldOverlay(s.overlay!.state, event.event) } });
    case "composed":
      return composed(s, event.result, event.at);
  }
}
