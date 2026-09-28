/**
 * What the live learner appends after folding a turn (plan §6.2, §6.3): proposals from
 * statistics, and status changes from the evidence of randomized exposure. Pure, with
 * no model: the text of a proposal is templated from its evidence.
 *
 * The statistic. Scores are in [0, 1] (a judge's probability, a metric or an outcome),
 * not only 0 or 1, so the bound is Hoeffding's inequality for the difference of two
 * independent means of bounded variables: with probability at least `confidence`,
 *
 *     mean(a) − mean(b) − t ≤ E[a] − E[b] ≤ mean(a) − mean(b) + t,   each side one-sided,
 *     t = sqrt(ln(1 / (1 − confidence)) · (1/n_a + 1/n_b) / 2).
 *
 * It holds at every sample size, with no normal approximation and no prior; the price is
 * that it is conservative, so an entry with little scored exposure stays on probation
 * until dream reviews it, which is what plan §6.3 asks.
 *
 * - Promotion is a non-inferiority test: exposed sessions are non-inferior when the
 *   lower bound of `exposed − unexposed` is above `−margin`.
 * - Retirement for inferiority: the upper bound is below `−margin`.
 * - A caution: an edge's upper bound against the rest of the graph is below 0.
 */
import { EntryIdSchema } from "./graph.ts";
import type { ProceduralGraph } from "./graph.ts";
import { edgeKey } from "./overlay.ts";
import { OverlayEntrySchema } from "./overlay-types.ts";
import type { Arm, EntryEvidence, OverlayEvent, OverlayState } from "./overlay-types.ts";
import type { LiveSettings } from "./settings.ts";

/** The relation a templated edge takes when the core's vocabulary has it (the paper's first relation). */
const PROPOSED_RELATION = "LEADS_TO";
/** An entry is stale once less than half a session of decayed support remains. */
const STALE_BELOW = 0.5;

const mean = (a: Pick<Arm, "scored" | "scoreSum">): number => a.scoreSum / a.scored;
const fixed = (x: number, digits = 2): string => x.toFixed(digits);

/**
 * The one-sided Hoeffding bounds on `E[a] − E[b]` for scores in [0, 1], each holding
 * with probability at least `confidence`. Both arms need at least one scored turn.
 */
export function differenceBounds(a: Arm, b: Arm, confidence: number): { difference: number; lower: number; upper: number } {
  const difference = mean(a) - mean(b);
  const t = Math.sqrt((Math.log(1 / (1 - confidence)) * (1 / a.scored + 1 / b.scored)) / 2);
  return { difference, lower: difference - t, upper: difference + t };
}

/** Support halves every `halfLife` overlay versions without new evidence for the entry. */
export const decayedSupport = (evidence: EntryEvidence, version: number, halfLife: number): number =>
  evidence.support.length * 2 ** (-(version - evidence.lastSeen) / halfLife);

/** The nodes a proposal may anchor to, and the edges it may annotate: the core's and live overlay ones. */
export function structure(state: OverlayState, core: ProceduralGraph): { nodes: Set<string>; edges: { from: string; to: string }[] } {
  const live = Object.values(state.entries).filter((r) => r.status !== "retired").map((r) => r.entry);
  const nodes = new Set<string>(core.nodes.map((n) => n.id));
  // Stryker disable next-line ConditionalExpression: equivalent; other kinds have no id, and the undefined it would add equals no name
  for (const e of live) if (e.kind === "node") nodes.add(e.id);
  const edges: { from: string; to: string }[] = [...core.edges];
  for (const e of live) if (e.kind === "edge" && nodes.has(e.from) && nodes.has(e.to)) edges.push(e);
  return { nodes, edges };
}

/**
 * Proposals the statistics support, as `proposed` events (by `stats`):
 *
 * - a transition the effective structure lacks, seen in at least `minSupport` distinct
 *   sessions between existing nodes, becomes an edge entry, unless any overlay edge
 *   (in any status) already joins the pair;
 * - an edge (core or live overlay) whose scored traversals fall confidently below those
 *   of the rest of the graph, each side with at least `minSupport` scored traversals,
 *   gets a caution, unless it already has one in any status.
 *
 * An entry in any status blocks its re-proposal, so a retired entry is not proposed again
 * with new counts in its text.
 */
export function proposals(state: OverlayState, core: ProceduralGraph, live: LiveSettings): OverlayEvent[] {
  const { nodes, edges } = structure(state, core);
  // Pairs that already have an overlay edge, or a caution, in any status.
  const proposedEdges = new Set<string>();
  const cautioned = new Set<string>();
  for (const { entry: e } of Object.values(state.entries)) {
    if (e.kind === "edge") proposedEdges.add(edgeKey(e.from, e.to));
    if (e.kind === "caution") cautioned.add(edgeKey(e.on.from, e.on.to));
  }
  const joined = new Set(edges.map((e) => edgeKey(e.from, e.to)));
  const relation = core.relations.includes(PROPOSED_RELATION) ? PROPOSED_RELATION : (core.relations[0] ?? PROPOSED_RELATION);
  const out: OverlayEvent[] = [];
  const propose = (entry: unknown, sessions: readonly string[]): void => {
    out.push({ kind: "proposed", entry: OverlayEntrySchema.parse(entry), source: { sessions: [...sessions], by: "stats" } });
  };

  for (const [key, t] of Object.entries(state.transitions)) {
    const [from, to] = key.split("→") as [string, string];
    if (t.sessions.length < live.minSupport || joined.has(key) || proposedEdges.has(key) || !nodes.has(from) || !nodes.has(to)) continue;
    const scored = t.scored > 0 ? `, mean score ${fixed(mean(t))}` : "";
    propose({ kind: "edge", from, relation, to, condition: null, guidance: `Observed after ${from} in ${t.sessions.length} sessions${scored}.`, pitfalls: "" }, t.sessions);
  }

  const total = Object.values(state.stats).reduce((sum, s) => ({ scored: sum.scored + s.scored, scoreSum: sum.scoreSum + s.scoreSum }), { scored: 0, scoreSum: 0 });
  const seen = new Set<string>();
  for (const { from, to } of edges) {
    const key = edgeKey(from, to);
    const stats = state.stats[key];
    if (seen.has(key) || stats === undefined || cautioned.has(key)) continue;
    seen.add(key);
    const rest = { n: 0, scored: total.scored - stats.scored, scoreSum: total.scoreSum - stats.scoreSum };
    if (stats.scored < live.minSupport || rest.scored < live.minSupport) continue;
    if (differenceBounds({ n: stats.traversals, scored: stats.scored, scoreSum: stats.scoreSum }, rest, live.promote.confidence).upper >= 0) continue;
    const text = `Preceded lower scores: mean ${fixed(mean(stats))} over ${stats.scored} scored traversals, against ${fixed(mean(rest))} elsewhere in the graph.`;
    propose({ kind: "caution", on: { from, to }, text }, state.transitions[key]?.sessions ?? []);
  }
  return out;
}

type Live = { id: string; status: "probation" | "active"; evidence: EntryEvidence };

/**
 * Status changes the evidence supports, as `status` events, for entries not yet retired.
 * With both arms at `minSupport` scored turns or more:
 *
 * - retire when exposed sessions are confidently inferior (upper bound below −margin);
 * - promote a probationary entry when they are non-inferior (lower bound above −margin),
 *   both at `promote.confidence`.
 *
 * An entry whose decayed support (half-life `halfLifeDays`, counted in overlay versions,
 * since the fold has no clock) falls below half a session retires as stale, before any
 * promotion. Then, beyond `maxEntries` live entries, the weakest are displaced: probation
 * before active, then by decayed support, most recent evidence and id.
 *
 * `margin` (default 0) is the loss in mean score an entry may cost and still be
 * non-inferior. At 0 promotion needs exposed sessions to do confidently better.
 */
export function statusChanges(state: OverlayState, live: LiveSettings, options: { margin?: number } = {}): OverlayEvent[] {
  const margin = options.margin ?? 0;
  const { confidence } = live.promote;
  const out: OverlayEvent[] = [];
  const change = (id: string, to: "active" | "retired", reason: string): void => {
    out.push({ kind: "status", entry: EntryIdSchema.parse(id), to, reason });
  };
  const survivors: Live[] = [];
  for (const [id, { status, evidence }] of Object.entries(state.entries)) {
    if (status === "retired") continue;
    const { exposed, unexposed } = evidence;
    const bounds = exposed.scored >= live.minSupport && unexposed.scored >= live.minSupport ? differenceBounds(exposed, unexposed, confidence) : undefined;
    const weight = decayedSupport(evidence, state.version, live.halfLifeDays);
    if (bounds !== undefined && bounds.upper < -margin) {
      change(id, "retired", `inferior: exposed − unexposed ≤ ${fixed(bounds.upper, 3)} at ${confidence} (margin ${margin})`);
    } else if (weight < STALE_BELOW) {
      change(id, "retired", `stale: decayed support ${fixed(weight)} below ${STALE_BELOW}`);
    } else if (status === "probation" && bounds !== undefined && bounds.lower > -margin) {
      change(id, "active", `non-inferior: exposed − unexposed ≥ ${fixed(bounds.lower, 3)} at ${confidence} (margin ${margin})`);
      survivors.push({ id, status: "active", evidence });
    } else {
      survivors.push({ id, status, evidence });
    }
  }
  const rank = (r: Live): [number, number, number] => [r.status === "active" ? 0 : 1, -decayedSupport(r.evidence, state.version, live.halfLifeDays), -r.evidence.lastSeen];
  const ordered = survivors.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    // Stryker disable next-line EqualityOperator: equivalent; ids are distinct record keys, so they are never equal
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || (a.id < b.id ? -1 : 1);
  });
  for (const r of ordered.slice(live.maxEntries)) change(r.id, "retired", `displaced: more than ${live.maxEntries} live entries`);
  return out;
}
