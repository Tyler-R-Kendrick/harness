import { z } from "zod";

/**
 * The edit history L_t (the paper's Eq. 10), one record per candidate a round drew. The
 * paper records a point Delta S per edit and tells the proposer that a rejected mechanism
 * is "negative evidence": but a gain inside the noise is absence of evidence, not
 * evidence of absence, and an underpowered rejection taught as a falsification steers
 * the search away from mechanisms nobody measured well enough. Here every measured
 * candidate carries a three-valued verdict with its interval, and the proposer is told
 * which is which.
 */

export const VERDICTS = ["supported", "refuted", "inconclusive"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Supported when the whole interval is above zero, refuted when it is below, else inconclusive. */
export const verdictOf = (c: { readonly lower: number; readonly upper: number }): Verdict => (c.lower > 0 ? "supported" : c.upper < 0 ? "refuted" : "inconclusive");

const text = z.string().min(1);

export const RecordSchema = z.strictObject({
  round: z.int().min(0),
  candidate: text,
  /** A change the proposer drafted, or the removal of an accepted mechanism (an ablation). */
  kind: z.enum(["change", "prune"]),
  edits: z.array(z.strictObject({ id: text, hypothesis: text, targets: text, components: z.array(text).readonly(), footprint: z.int().min(0), predicted: z.array(text).readonly() })).readonly(),
  /** Accepted as the next incumbent; admissible but not chosen; measured and refused; or refused before measurement. */
  outcome: z.enum(["accepted", "admissible", "rejected", "screened"]),
  reason: z.string(),
  measured: z
    .strictObject({
      score: z.number().min(0).max(1),
      cost: z.number().min(0).exactOptional(),
      gain: z.number(),
      lower: z.number(),
      upper: z.number(),
      alpha: z.number().positive(),
      costChange: z.number().exactOptional(),
      /** Confidence bounds on the relative cost change, at the same level (an absent upper bound with a cost change present is unbounded). */
      costLower: z.number().exactOptional(),
      costUpper: z.number().exactOptional(),
      verdict: z.enum(VERDICTS),
      /** Predicted tasks that improved, and predicted tasks that did not. */
      hits: z.array(text).readonly(),
      misses: z.array(text).readonly(),
      /**
       * The holdout's confirmation of the winner, when it was put to it: the comparison with
       * the incumbent on the holdout tasks (gain, bounds at `level`; absent when the holdout
       * was already spent), whether it confirmed, and the queries left. The proposer never
       * reads these numbers (see `render`): only whether the change was accepted.
       */
      holdout: z
        .strictObject({
          gain: z.number().exactOptional(),
          lower: z.number().exactOptional(),
          upper: z.number().exactOptional(),
          level: z.number().positive().exactOptional(),
          confirmed: z.boolean(),
          exhausted: z.boolean(),
          remaining: z.int().min(0),
        })
        .exactOptional(),
    })
    .exactOptional(),
});
export type LedgerRecord = z.output<typeof RecordSchema>;

export function parseRecord(input: unknown): LedgerRecord {
  const result = RecordSchema.safeParse(input);
  if (!result.success) throw new Error(`invalid ledger record\n${z.prettifyError(result.error)}`);
  return result.data;
}

const measuredChanges = (records: readonly LedgerRecord[]) => records.filter((r) => r.kind === "change" && r.measured !== undefined);

/** T_t: components with at least one measured change. */
export function tried(records: readonly LedgerRecord[]): Set<string> {
  return new Set(measuredChanges(records).flatMap((r) => r.edits.flatMap((e) => e.components)));
}

/** Stalled: at least `window` rounds in, and no supported change accepted in the last `window` rounds. */
export function stalled(records: readonly LedgerRecord[], round: number, window: number): boolean {
  if (round < window) return false;
  return !records.some((r) => r.kind === "change" && r.outcome === "accepted" && r.measured?.verdict === "supported" && r.round >= round - window && r.round < round);
}

/** The paper's sigma_t = 1[S_t - S_{t-w} <= delta] over the trajectory of incumbent scores; false until w rounds exist. */
export function paperStall(trajectory: readonly number[], t: number, w: number, delta: number): boolean {
  // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: equivalent; an index below 0 or at or past the length reads undefined, the difference below is NaN, and NaN <= delta is false, so each guard that is dropped or loosened still returns false
  if (t < w || t >= trajectory.length) return false;
  return trajectory[t]! - trajectory[t - w]! <= delta;
}

/**
 * The paper's recent yield g_t(l) = max{Delta S_i : l_i = l, t - t_i <= n_prune} for every
 * tried component (Eq. 11), and so its prune set B_t = {l : g_t(l) <= 0}. Kept to run the
 * paper's rule as published; note what it measures: whether NEW edits of a kind have
 * lately paid off, which says nothing about the accepted machinery of that kind that
 * B_t then proposes to delete (pruning here is by ablation of that machinery instead).
 */
export function componentYield(records: readonly LedgerRecord[], round: number, window: number): Record<string, number> {
  const g: Record<string, number> = Object.fromEntries([...tried(records)].map((c) => [c, Number.NEGATIVE_INFINITY]));
  for (const r of measuredChanges(records))
    if (round - r.round <= window) for (const c of new Set(r.edits.flatMap((e) => e.components))) g[c] = Math.max(g[c]!, r.measured!.gain);
  return g;
}

export interface Row {
  readonly round: number;
  readonly candidate: string;
  readonly kind: LedgerRecord["kind"];
  readonly outcome: LedgerRecord["outcome"];
  readonly reason: string;
  readonly edits: readonly { readonly hypothesis: string; readonly components: readonly string[] }[];
  readonly verdict?: Verdict;
  readonly gain?: number;
  readonly interval?: readonly [number, number];
  readonly costChange?: number;
  readonly predicted?: { readonly hit: readonly string[]; readonly missed: readonly string[] };
}

/**
 * The last `n` records as the proposer reads them. Measured records dominate: of the
 * candidates refused before measurement only the last four are kept, since a wall of
 * refusals is a feedback loop, not evidence.
 */
export function render(records: readonly LedgerRecord[], n: number): Row[] {
  const kept: LedgerRecord[] = [];
  let unmeasured = 0;
  for (const r of [...records].reverse()) {
    if (kept.length >= n) break;
    if (r.measured === undefined && ++unmeasured > 4) continue;
    kept.push(r);
  }
  return kept.reverse().map((r): Row => {
    const m = r.measured;
    return {
      round: r.round,
      candidate: r.candidate,
      kind: r.kind,
      outcome: r.outcome,
      reason: r.reason,
      edits: r.edits.map((e) => ({ hypothesis: e.hypothesis, components: e.components })),
      ...(m === undefined
        ? {}
        : {
            verdict: m.verdict,
            gain: m.gain,
            interval: [m.lower, m.upper] as const,
            ...(m.costChange === undefined ? {} : { costChange: m.costChange }),
            ...(m.hits.length || m.misses.length ? { predicted: { hit: m.hits, missed: m.misses } } : {}),
          }),
    };
  });
}
