/**
 * Dream's gates (plan §7.4): each is a pure function of its evidence to
 * `{pass, reason}`, so the reducer can compose the ones a preset lists and record why a
 * candidate was rejected.
 *
 * - `structureGate`: the candidate passed `prepareCandidate` (always on).
 * - `atLeastRetained`: the paper's gate (App. B.6 line 16), ties accepted.
 * - `anchoredNonInferiority`: the harness gate on paired per-task validation scores.
 *   Binary scores use a Newcombe-style paired interval (Wilson margins joined through the
 *   pairs' correlation, Newcombe 1998 method 10 without continuity correction);
 *   continuous scores use a paired bootstrap whose resampler is seeded (the dream draws
 *   the seed from the Entropy port and logs it, so a replay decides the same way).
 *   A candidate passes when it is superior to the retained head, or non-inferior within
 *   a power-sized margin δ *and* smaller; it must also stay within `totalLoss` of G₀, so
 *   losses cannot compound across rounds; when δ exceeds `totalLoss` only superiority
 *   passes.
 * - `evidenceGate`: every structural change is backed by live evidence (plan §7.4).
 * - `approvalGate`: an approver accepted, when approval is needed.
 */
import { wilsonInterval } from "@harness/cognitive";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import type { CandidateDocument, Diagnostic, GraphEdge } from "./graph.ts";
import { edgeKey } from "./overlay.ts";
import { differenceBounds } from "./overlay-policy.ts";
import type { OverlayState } from "./overlay-types.ts";

export interface GateResult {
  pass: boolean;
  reason: string;
}

/** One task's score from an evaluator, in [0, 1]. */
export interface TaskScore {
  task: string;
  score: number;
}

const f4 = (x: number): string => x.toFixed(4);

// ---- structure and the paper's gate ------------------------------------------------------

/** The candidate passed the structural checks, the tool catalog and the edit filter. */
export function structureGate(evidence: { diagnostics: readonly Diagnostic[] }): GateResult {
  if (evidence.diagnostics.length === 0) return { pass: true, reason: "the candidate passes the structural checks" };
  return { pass: false, reason: evidence.diagnostics.map((d) => `${d.code}${d.at === undefined ? "" : ` at ${d.at}`}: ${d.message}`).join("; ") };
}

/** The paper's gate: the candidate's mean validation score is at least the retained head's cached score (ties pass). */
export function atLeastRetained(evidence: { candidate: number; retained: number }): GateResult {
  const { candidate, retained } = evidence;
  return candidate >= retained ? { pass: true, reason: `validation ${f4(candidate)} ≥ retained ${f4(retained)}` } : { pass: false, reason: `validation ${f4(candidate)} < retained ${f4(retained)}` };
}

// ---- statistics --------------------------------------------------------------------------

// Stryker disable next-line ArithmeticOperator: equivalent; `acc * x - c` negates every polynomial, and each use is a ratio of two, so the sign cancels
const poly = (coefficients: readonly number[], x: number): number => coefficients.reduce((acc, c) => acc * x + c, 0);
// Acklam's rational approximation of the normal quantile (relative error below 1.2e-9).
const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1, 1];
const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416, 1];
const P_LOW = 0.02425;

/** The standard normal quantile Φ⁻¹(p), for p strictly between 0 and 1. */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`a normal quantile needs a probability strictly between 0 and 1, not ${p}`);
  const tail = (q: number): number => poly(C, q) / poly(D, q);
  // Stryker disable next-line EqualityOperator: equivalent; the branches meet at P_LOW to within the approximation's error
  if (p < P_LOW) return tail(Math.sqrt(-2 * Math.log(p)));
  // Stryker disable next-line EqualityOperator: equivalent; the branches meet at 1 − P_LOW to within the approximation's error
  if (p > 1 - P_LOW) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  return (poly(A, q * q) * q) / poly(B, q * q);
}

/**
 * The non-inferiority margin δ sized by power: with `n` paired tasks whose differences
 * have variance `discordance` (for binary scores, the share of discordant pairs), a
 * candidate equal to the retained head passes a lower bound at `confidence` against −δ
 * with probability `power`. δ = (z_confidence + z_power) · sqrt(discordance / n).
 */
export function powerMargin(n: number, discordance: number, confidence: number, power: number): number {
  if (!(n >= 1)) throw new RangeError(`a margin needs at least one paired task, not ${n}`);
  if (!(discordance >= 0)) throw new RangeError(`discordance is a variance, not ${discordance}`);
  return (normalQuantile(confidence) + normalQuantile(power)) * Math.sqrt(discordance / n);
}

export interface PairedDifference {
  /** Tasks scored in both arms. */
  n: number;
  /** Mean of `a − b` over the paired tasks. */
  difference: number;
  /** One-sided lower bound on the difference at the confidence; −∞ with no pairs. */
  lower: number;
  method: "newcombe" | "bootstrap";
}

/** A deterministic uniform stream in [0, 1) from a seed (splitmix32 over the seed's sha256). */
function resampler(seed: string): () => number {
  let state = Number.parseInt(sha256Hex(seed).slice(0, 8), 16);
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return ((z ^ (z >>> 16)) >>> 0) / 2 ** 32;
  };
}

function newcombe(pairs: readonly (readonly [number, number])[], confidence: number): number {
  const n = pairs.length;
  let [a, b, c, d] = [0, 0, 0, 0];
  for (const [x, y] of pairs) {
    if (x === 1 && y === 1) a += 1;
    else if (x === 1) b += 1;
    else if (y === 1) c += 1;
    else d += 1;
  }
  const z = normalQuantile(confidence);
  const [p1, p2] = [(a + b) / n, (a + c) / n];
  const [l1] = wilsonInterval(a + b, n, z);
  const [, u2] = wilsonInterval(a + c, n, z);
  const margins = (a + b) * (c + d) * (a + c) * (b + d);
  const phi = margins === 0 ? 0 : (a * d - b * c) / Math.sqrt(margins);
  const [x, y] = [p1 - l1, u2 - p2];
  return p1 - p2 - Math.sqrt(x * x - 2 * phi * x * y + y * y);
}

function bootstrap(diffs: readonly number[], confidence: number, seed: string, resamples: number): number {
  const n = diffs.length;
  const next = resampler(seed);
  const means = Array.from({ length: resamples }, () => {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += diffs[Math.floor(next() * n)]!;
    return sum / n;
  }).sort((p, q) => p - q);
  return means[Math.floor((1 - confidence) * resamples)]!;
}

/**
 * The paired difference `a − b` over tasks scored in both, with a one-sided lower bound
 * at `confidence`: a Newcombe-style interval when every paired score is 0 or 1, else a
 * paired bootstrap of `resamples` resamples seeded by `seed`.
 */
export function pairedDifference(a: readonly TaskScore[], b: readonly TaskScore[], confidence: number, seed: string, resamples = 2000): PairedDifference {
  const other = new Map(b.map((s) => [s.task, s.score]));
  const pairs = [...new Map(a.map((s) => [s.task, s.score]))].flatMap(([task, x]): [number, number][] => (other.has(task) ? [[x, other.get(task)!]] : []));
  if (pairs.length === 0) return { n: 0, difference: 0, lower: Number.NEGATIVE_INFINITY, method: "newcombe" };
  const diffs = pairs.map(([x, y]) => x - y);
  const difference = diffs.reduce((s, x) => s + x, 0) / diffs.length;
  const binary = pairs.every(([x, y]) => (x === 0 || x === 1) && (y === 0 || y === 1));
  if (binary) return { n: pairs.length, difference, lower: newcombe(pairs, confidence), method: "newcombe" };
  return { n: pairs.length, difference, lower: bootstrap(diffs, confidence, seed, resamples), method: "bootstrap" };
}

// ---- the anchored non-inferiority gate -------------------------------------------------

/** A graph's size for the "smaller" test: nodes plus edges, then the characters of every attribute. */
export interface GraphSize {
  items: number;
  chars: number;
}

const edgeChars = (e: Pick<GraphEdge, "condition" | "guidance" | "pitfalls">): number => (e.condition ?? "").length + e.guidance.length + e.pitfalls.length;

export function graphSize(doc: CandidateDocument): GraphSize {
  return {
    items: doc.nodes.length + doc.edges.length,
    chars: doc.nodes.reduce((s, n) => s + n.description.length, 0) + doc.edges.reduce((s, e) => s + edgeChars(e), 0),
  };
}

const smaller = (a: GraphSize, b: GraphSize): boolean => a.items < b.items || (a.items === b.items && a.chars < b.chars);

export interface NonInferiorityEvidence {
  /** Per-task validation scores of the candidate, the retained head and G₀. */
  candidate: readonly TaskScore[];
  retained: readonly TaskScore[];
  anchor: readonly TaskScore[];
  sizes: { candidate: GraphSize; retained: GraphSize };
  /** The total loss allowed against G₀. */
  totalLoss: number;
  /** One-sided confidence of every bound; above 0.5. */
  confidence: number;
  /** The chance that a candidate equal to the retained head passes as non-inferior. */
  power: number;
  /** Seeds the bootstrap for continuous scores. */
  seed: string;
  resamples?: number;
}

/**
 * The harness gate (plan §7.4). δ is sized by power from the variance the interval
 * shows: with lower half-width w = difference − lower, the implied variance of a paired
 * difference is n · (w / z_confidence)², so δ = w · (z_confidence + z_power) / z_confidence
 * and an equal candidate clears −δ with probability `power`.
 */
export function anchoredNonInferiority(evidence: NonInferiorityEvidence): GateResult {
  const { confidence, power, totalLoss, seed, resamples } = evidence;
  if (!(confidence > 0.5 && confidence < 1)) throw new RangeError(`the confidence must be above 0.5 and below 1, not ${confidence}`);
  const retained = pairedDifference(evidence.candidate, evidence.retained, confidence, `${seed}/retained`, resamples);
  const anchor = pairedDifference(evidence.candidate, evidence.anchor, confidence, `${seed}/anchor`, resamples);
  if (retained.n === 0 || anchor.n === 0) return { pass: false, reason: "no validation task was scored for both graphs" };
  const discordance = retained.n * ((retained.difference - retained.lower) / normalQuantile(confidence)) ** 2;
  const delta = powerMargin(retained.n, discordance, confidence, power);
  const summary = `candidate − retained ${f4(retained.difference)} (lower ${f4(retained.lower)}, δ ${f4(delta)}); candidate − G₀ ${f4(anchor.difference)} (lower ${f4(anchor.lower)}, total loss ${f4(totalLoss)})`;
  if (anchor.lower < -totalLoss) return { pass: false, reason: `beyond the total loss against G₀: ${summary}` };
  if (retained.lower > 0) return { pass: true, reason: `superior: ${summary}` };
  if (delta > totalLoss) return { pass: false, reason: `the margin δ ${f4(delta)} exceeds the total loss ${f4(totalLoss)}, so only superiority passes: ${summary}` };
  if (retained.lower >= -delta && smaller(evidence.sizes.candidate, evidence.sizes.retained)) return { pass: true, reason: `non-inferior and smaller: ${summary}` };
  return { pass: false, reason: `neither superior nor non-inferior and smaller: ${summary}` };
}

// ---- the evidence gate -------------------------------------------------------------------

/** How much live evidence counts: distinct sessions, and the confidence of statistical bounds. */
export interface EvidenceBar {
  minSupport: number;
  confidence: number;
}

/**
 * An edge whose scored traversals fall confidently below the rest of the graph's (a
 * one-sided Hoeffding bound, as for the overlay's cautions), each side with at least
 * `minSupport` scored traversals, seen in at least `minSupport` distinct sessions.
 */
export function poorStatistics(overlay: OverlayState, from: string, to: string, bar: EvidenceBar): boolean {
  const key = edgeKey(from, to);
  const stats = overlay.stats[key];
  // Stryker disable next-line ConditionalExpression,OptionalChaining: equivalent; the fold writes stats and transitions for the same pairs, so a pair without stats has no sessions either
  if (stats === undefined || (overlay.transitions[key]?.sessions.length ?? 0) < bar.minSupport) return false;
  const total = Object.values(overlay.stats).reduce((sum, s) => ({ scored: sum.scored + s.scored, scoreSum: sum.scoreSum + s.scoreSum }), { scored: 0, scoreSum: 0 });
  const rest = { n: 0, scored: total.scored - stats.scored, scoreSum: total.scoreSum - stats.scoreSum };
  if (stats.scored < bar.minSupport || rest.scored < bar.minSupport) return false;
  // Stryker disable next-line EqualityOperator: equivalent in practice; an upper bound of exactly 0 needs a difference equal to minus an irrational margin
  return differenceBounds({ n: stats.traversals, scored: stats.scored, scoreSum: stats.scoreSum }, rest, bar.confidence).upper < 0;
}

export interface EvidenceGateInput extends EvidenceBar {
  base: CandidateDocument;
  candidate: CandidateDocument;
  overlay: OverlayState;
  /** A composition candidate (plan §7.6): its workflow node, and the distinct sessions whose turns walked the path it compiles. */
  composition?: { node: string; support: number };
}

const triple = (e: Pick<GraphEdge, "from" | "relation" | "to">): string => `${e.from}\u0000${e.relation}\u0000${e.to}`;
const label = (e: Pick<GraphEdge, "from" | "relation" | "to">): string => `${e.from} → ${e.to} (${e.relation})`;

/**
 * Every change is backed by live evidence (plan §7.4):
 *
 * - a removed core edge has a caution (not retired) with `minSupport` sessions, or poor
 *   statistics;
 * - an added node has an active node entry, or a transition through it with `minSupport`
 *   sessions;
 * - an added edge has an active overlay edge between its endpoints, or `minSupport`
 *   sessions on the transition;
 * - a rewritten edge's text is shorter, or absorbs an active note on the edge;
 * - a rewritten node keeps its type and binding and has a shorter description;
 * - a composition's workflow node, and every edge into or out of it, are backed by the
 *   distinct sessions that walked the path it compiles, at least `minSupport` of them.
 */
export function evidenceGate(input: EvidenceGateInput): GateResult {
  const { base, candidate, overlay, minSupport } = input;
  const live = Object.values(overlay.entries).filter((r) => r.status !== "retired");
  const active = live.filter((r) => r.status === "active").map((r) => r.entry);
  const sessions = (from: string, to: string): number => overlay.transitions[edgeKey(from, to)]?.sessions.length ?? 0;
  const through = (node: string): boolean =>
    Object.entries(overlay.transitions).some(([key, t]) => t.sessions.length >= minSupport && key.split("→").includes(node));
  // Stryker disable next-line ConditionalExpression: equivalent; entries of other kinds have no id, and undefined names no node
  const activeNodes = new Set(active.flatMap((e) => (e.kind === "node" ? [e.id] : [])));
  // Stryker disable next-line ConditionalExpression: equivalent; entries of other kinds have no endpoints of their own, and "undefined→undefined" joins no nodes
  const activeEdges = new Set(active.flatMap((e) => (e.kind === "edge" ? [edgeKey(e.from, e.to)] : [])));
  /** The composed workflow node, when its path has the support: it and the edges into and out of it are justified. */
  const composed = (node: string): boolean => input.composition !== undefined && input.composition.node === node && input.composition.support >= minSupport;

  const unjustified: string[] = [];
  const baseEdges = new Map(base.edges.map((e) => [triple(e), e]));
  const candidateEdges = new Map(candidate.edges.map((e) => [triple(e), e]));
  for (const [key, e] of baseEdges) {
    if (candidateEdges.has(key)) continue;
    const cautioned = live.some((r) => r.entry.kind === "caution" && r.entry.on.from === e.from && r.entry.on.to === e.to && r.evidence.support.length >= minSupport);
    if (!cautioned && !poorStatistics(overlay, e.from, e.to, input)) unjustified.push(`removed edge ${label(e)}`);
  }
  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]));
  for (const n of candidate.nodes) {
    const old = baseNodes.get(n.id);
    if (old === undefined) {
      if (!activeNodes.has(n.id) && !through(n.id) && !composed(n.id)) unjustified.push(`added node ${n.id}`);
    } else if (canonicalJson(old) !== canonicalJson(n)) {
      const kept = old.type === n.type && canonicalJson(old.binding ?? null) === canonicalJson(n.binding ?? null);
      if (!kept || n.description.length >= old.description.length) unjustified.push(`rewritten node ${n.id}`);
    }
  }
  for (const [key, e] of candidateEdges) {
    const old = baseEdges.get(key);
    if (old === undefined) {
      if (!activeEdges.has(edgeKey(e.from, e.to)) && sessions(e.from, e.to) < minSupport && !composed(e.from) && !composed(e.to)) unjustified.push(`added edge ${label(e)}`);
    } else if (canonicalJson(old) !== canonicalJson(e)) {
      const text = [e.condition, e.guidance, e.pitfalls];
      const absorbs = active.some((a) => a.kind === "note" && a.on.from === e.from && a.on.to === e.to && text.some((t) => t !== null && t.includes(a.text)));
      if (!absorbs && edgeChars(e) >= edgeChars(old)) unjustified.push(`rewritten edge ${label(e)}`);
    }
  }
  if (unjustified.length > 0) return { pass: false, reason: `no evidence for: ${unjustified.join("; ")}` };
  const changes = [...baseEdges.keys()].filter((k) => !candidateEdges.has(k)).length + [...candidateEdges].filter(([k, e]) => canonicalJson(baseEdges.get(k) ?? null) !== canonicalJson(e)).length + candidate.nodes.filter((n) => canonicalJson(baseNodes.get(n.id) ?? null) !== canonicalJson(n)).length;
  return { pass: true, reason: `every change has evidence (${changes} changes)` };
}

// ---- approval ------------------------------------------------------------------------------

/**
 * The tools that edges the candidate adds (or re-adds with new text) route into, in
 * order: the target is an `ACTION` node, named by its binding or its id, and not declared
 * free of side effects. A tool without such a declaration counts as side-effecting.
 */
export function routesIntoSideEffects(base: CandidateDocument, candidate: CandidateDocument, sideEffectFree: readonly string[]): string[] {
  const existing = new Set(base.edges.map((e) => canonicalJson(e)));
  const free = new Set(sideEffectFree);
  const nodes = new Map(candidate.nodes.map((n) => [n.id, n]));
  const tools: string[] = [];
  for (const e of candidate.edges) {
    const target = nodes.get(e.to);
    // Stryker disable next-line OptionalChaining: equivalent; a candidate that passed its checks has every edge target as a node
    if (existing.has(canonicalJson(e)) || target?.type !== "ACTION") continue;
    const tool = target.binding?.name ?? target.id;
    if (!free.has(tool) && !tools.includes(tool)) tools.push(tool);
  }
  return tools;
}

/** Approval passes when it is not needed, or an approver accepted the candidate. */
export function approvalGate(evidence: { required: boolean; approved?: boolean }): GateResult {
  if (!evidence.required) return { pass: true, reason: "no approval needed" };
  if (evidence.approved === true) return { pass: true, reason: "approved" };
  if (evidence.approved === false) return { pass: false, reason: "declined by the approver" };
  return { pass: false, reason: "approval needed, and no approver is configured" };
}
