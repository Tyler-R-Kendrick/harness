import { z } from "zod";
import { ProbabilitySchema } from "@harness/cognitive";
import { FutilitySchema } from "./futility.ts";
import { verdictOf } from "./ledger.ts";
import type { Verdict } from "./ledger.ts";
import { SpendingSchema } from "./schedule.ts";

/**
 * The selection side: which measured candidate, if any, becomes the next incumbent. Two
 * rules. `paper` is Algorithm 2 of the RRSI paper as published (its `selection.py`), kept
 * so a run can reproduce it and so its behavior can be shown (RS8.1-RS8.3). `calibrated`
 * is the rule this package uses by default: acceptance by confidence bounds that count
 * tasks (not only trials), a run-wide error rate, non-inferiority with a cumulative loss
 * budget in place of the floor and the within-band rule, cost claims (a saving, a removal's
 * price, a gain's price) tested by bounds like the score's, and capped against the base
 * harness by the certified gain, and no bonus for adding machinery.
 */

export const PaperRuleSchema = z.strictObject({
  rule: z.literal("paper"),
  /** The noise band; calibrated from the base harness when absent. */
  delta: z.number().min(0).exactOptional(),
  /** Standard deviations of the null difference that make delta, when calibrated. */
  z: z.number().positive().default(2),
  beta0: z.number().min(0),
  beta1: z.number().min(0),
  ws: z.number().min(0),
  wc: z.number().min(0),
  wn: z.number().min(0),
  /** The window of the recent-yield summary g_t and so of the prune set B_t. */
  prune: z.int().positive(),
});
export type PaperRule = z.input<typeof PaperRuleSchema>;

export const CalibratedRuleSchema = z.strictObject({
  rule: z.literal("calibrated"),
  /**
   * The probability, over the whole run, of accepting any change that is not what its test
   * says: under each test's sharp null (same harness, fresh noise on the same tasks). It is
   * not a probability that a certified gain transfers to new tasks (see compare()).
   */
  alpha: ProbabilitySchema,
  resamples: z.int().positive(),
  /** Non-inferiority margin: the certified score a run may lose in total, over any stretch of accepted steps (a CUSUM of their lower bounds; a step's own lower bound must be above -margin). */
  margin: z.number().min(0),
  /** The least relative token saving that admits a change without a supported gain. */
  saving: z.number().positive(),
  /** Relative cost increase tolerated for any gain, and per unit of the gain's lower bound. */
  beta0: z.number().min(0),
  beta1: z.number().min(0),
  /**
   * How alpha is spent across the rounds (default: the same share for every round). The
   * schedule is fixed by (round, rounds, tests a round) alone, so the run-wide bound holds.
   */
  spending: SpendingSchema.default({ kind: "uniform" }),
  /**
   * Futility early stopping: a candidate clearly worse on a random prefix of the evolve
   * tasks is not evaluated on the rest. It can only remove a candidate's own acceptance,
   * never add one, so it costs the run-wide error rate nothing; it can change which
   * candidate wins a round (a weaker admissible candidate can win when the best was
   * stopped), and its later-stage evaluations happen after the incumbent's window (see
   * futility.ts). Absent: every candidate is evaluated on every task.
   */
  futility: FutilitySchema.exactOptional(),
});
export type CalibratedRule = z.input<typeof CalibratedRuleSchema>;

export const RuleSchema = z.discriminatedUnion("rule", [CalibratedRuleSchema, PaperRuleSchema]);

/** A candidate as selection sees it: measured on the evolve set and compared with the incumbent. */
export interface Measured {
  readonly label: string;
  /** A drafted change, or the removal of an accepted mechanism. */
  readonly kind: "change" | "prune";
  /** S' and C'. */
  readonly score: number;
  readonly cost?: number;
  /** S' - S_t, and its confidence bounds. */
  readonly gain: number;
  readonly lower: number;
  readonly upper: number;
  /** (C' - C_t) / C_t, the point estimate, and the confidence bounds on it (compare.ts); a bound may be infinite. */
  readonly costChange?: number;
  readonly costLower?: number;
  readonly costUpper?: number;
  readonly components: readonly string[];
  /** Domain guards the candidate violates (non-compensatory criteria). */
  readonly guards: readonly string[];
}

export interface Decision {
  readonly admissible: boolean;
  readonly reason: string;
  readonly verdict?: Verdict;
  /** The paper's nu: new structural component types. */
  readonly novelty?: number;
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(1)}%`;
/** A bound on a relative cost change, which is infinite when nothing could be said. */
const bound = (x: number) => (x === Number.POSITIVE_INFINITY ? "unbounded" : pct(x));
const f = (x: number) => x.toFixed(4);

// ---- the paper ------------------------------------------------------------------------

export interface PaperContext {
  /** S*, the best incumbent score so far. */
  readonly best: number;
  /** Components with an accepted edit in the evolution so far (for novelty). */
  readonly accepted: ReadonlySet<string>;
  readonly structural: readonly string[];
}

/**
 * Algorithm 2 for one candidate: floor S' >= S* - delta; then if Delta S > delta the cost
 * rule Delta C <= beta0 + beta1 Delta S, else the within-band rule
 * w_s Delta S - w_c Delta C + w_n nu > 0; then the domain guards. A missing cost change
 * counts as 0, as in the reference implementation.
 */
export function paperDecision(c: Measured, rule: PaperRule & { readonly delta: number }, ctx: PaperContext): Decision {
  const novelty = new Set(c.components.filter((x) => ctx.structural.includes(x) && !ctx.accepted.has(x))).size;
  const reject = (reason: string): Decision => ({ admissible: false, reason, novelty });
  const floor = ctx.best - rule.delta;
  if (c.score < floor) return reject(`below the noise-adjusted floor: S' ${f(c.score)} < S* ${f(ctx.best)} - delta ${f(rule.delta)}`);
  const dC = c.costChange ?? 0;
  let why: string;
  if (c.gain > rule.delta) {
    const budget = rule.beta0 + rule.beta1 * c.gain;
    why = `gain ${f(c.gain)} > delta; cost ${pct(dC)} against a budget of ${pct(budget)}`;
    if (dC > budget) return reject(`cost rule failed: ${why}`);
  } else {
    const shaped = rule.ws * c.gain - rule.wc * dC + rule.wn * novelty;
    why = `gain ${f(c.gain)} within delta; shaped ${shaped.toFixed(4)} (nu = ${novelty})`;
    if (!(shaped > 0)) return reject(`cost rule failed: ${why}`);
  }
  if (c.guards.length) return reject(`domain guard violated: ${c.guards.join("; ")}`);
  return { admissible: true, reason: `admissible: ${why}`, novelty };
}

// ---- calibrated -----------------------------------------------------------------------

export interface CalibratedContext {
  /**
   * The running loss counter: a CUSUM of the lower bounds of every accepted step,
   * max(0, drift - lower) after each (see `advance`). Supported gains bring it down and
   * accepted steps that may have lost score push it up; it never exceeds the margin.
   */
  readonly drift: number;
  /** The sum of the accepted steps' lower bounds since H_0: a lower bound on the total change of score, by the union bound the run's alpha already pays. */
  readonly certified: number;
  /** The base harness H_0: the cost of the harness is capped against it. */
  readonly anchor: { readonly cost?: number };
}

/** The loss counter and the certified total after an accepted step with lower bound `lower`. */
export function advance(state: { readonly drift: number; readonly certified: number }, lower: number): { drift: number; certified: number } {
  return { drift: Math.max(0, state.drift - lower), certified: state.certified + lower };
}

/**
 * The calibrated rule for one candidate. Acceptance is the intersection of the claims a
 * candidate makes, each tested by its own bound at the run's per-test level; no extra error
 * budget is needed, because accepting requires every claim to pass, so the probability of
 * accepting a candidate for which some claim is false is at most that claim's level.
 *
 * - A gain: the lower confidence bound of its paired gain is above zero, and its cost is
 *   not clearly over budget: the lower bound of the relative cost change is at most
 *   beta0 + beta1 L (L the gain's lower bound).
 * - A saving (a change without a supported gain): non-inferior, its lower bound above
 *   -margin, and the upper bound of the relative cost change at most -saving.
 * - A removal of a mechanism: non-inferior, and the upper bound of the cost change at most
 *   beta0 (removing it may not be clearly costlier).
 *
 * Losses are bounded in total, not per step: every accepted step moves a CUSUM of lower
 * bounds, drift' = max(0, drift - lower), and a step that would take it above the margin
 * is refused (this also refuses any step whose own lower bound is below -margin). A
 * supported gain lowers the counter by its lower bound only, so a run cannot save
 * -0.0098 and reset the account with a gain of 0.0002 (the reset the point-loss account
 * used to allow). The sum of the accepted lower bounds, `certified`, is a lower bound on
 * the total change against H_0, and pays for the cost cap: the harness's cost against the
 * base harness's, using the upper cost bound when there is one, is at most
 * beta0 + beta1 max(0, certified) (allowances do not compound, and noisy point scores do
 * not pay for cost). A candidate with no cost bounds makes no cost claim, except that a
 * saving or a removal that reports a cost change without its bounds certifies nothing.
 */
export function calibratedDecision(c: Measured, rule: CalibratedRule, ctx: CalibratedContext): Decision {
  const verdict = verdictOf(c);
  const reject = (reason: string): Decision => ({ admissible: false, reason, verdict });
  if (c.guards.length) return reject(`domain guard violated: ${c.guards.join("; ")}`);
  const dC = c.costChange ?? 0;
  // An absent number is NaN and an absent lower bound is -Infinity, so every comparison below that uses one is false: no cost, no bound, no claim.
  const cost = c.cost ?? Number.NaN;
  if (ctx.anchor.cost) {
    const allowed = rule.beta0 + rule.beta1 * Math.max(0, ctx.certified + c.lower);
    // The candidate's cost against H_0: its point cost, or the upper bound of its change on the incumbent's cost when there is one.
    const change = c.costChange ?? Number.NaN;
    const bounded = c.costUpper !== undefined && 1 + change > 0;
    const total = bounded ? (cost * (1 + c.costUpper!)) / (1 + change) / ctx.anchor.cost - 1 : (cost - ctx.anchor.cost) / ctx.anchor.cost;
    if (total > allowed) return reject(`the harness would spend ${bounded ? "up to " : ""}${bound(total)} tokens over the base harness, more than the ${pct(allowed)} its certified gain pays for`);
  }
  if (c.kind === "change" && c.lower > 0) {
    const budget = rule.beta0 + rule.beta1 * c.lower;
    const costLower = c.costLower ?? Number.NEGATIVE_INFINITY;
    if (costLower > budget) return reject(`costs ${pct(dC)} tokens (at least ${pct(costLower)} at the test's level); a gain of at least ${f(c.lower)} pays for ${pct(budget)}`);
    return { admissible: true, reason: `supported gain: ${f(c.gain)}, at least ${f(c.lower)}; cost ${pct(dC)} within ${pct(budget)}`, verdict };
  }
  if (c.lower <= -rule.margin) return reject(`${c.kind === "change" ? `no supported gain (lower bound ${f(c.lower)} <= 0), and it ` : "it "}may be worse than the incumbent by the margin or more: lower bound ${f(c.lower)} <= -${f(rule.margin)}`);
  const { drift } = advance(ctx, c.lower);
  if (drift > rule.margin) return reject(`accumulated losses ${f(drift)} (a running total of the accepted steps' lower bounds) would exceed the margin ${f(rule.margin)}`);
  const nonInferior = `non-inferior (lower bound ${f(c.lower)} > -${f(rule.margin)})`;
  if (c.kind === "prune") {
    if (c.costUpper === undefined ? c.costChange !== undefined : c.costUpper > rule.beta0) return reject(`${nonInferior}, but removing it costs ${pct(dC)} tokens (up to ${c.costUpper === undefined ? "an unknown share" : bound(c.costUpper)} at the test's level), more than ${pct(rule.beta0)}`);
    return { admissible: true, reason: `${nonInferior}, and removes a mechanism`, verdict };
  }
  if (c.costUpper === undefined || c.costUpper > -rule.saving) return reject(`no supported gain (lower bound ${f(c.lower)} <= 0) and saves no more than ${(100 * rule.saving).toFixed(1)}% tokens with confidence (change ${pct(dC)}, at most ${c.costUpper === undefined ? "unknown" : bound(c.costUpper)})`);
  return { admissible: true, reason: `${nonInferior}, and saves ${(100 * -dC).toFixed(1)}% tokens, at least ${(100 * -c.costUpper).toFixed(1)}% at the test's level`, verdict };
}

/**
 * The winner among admissible candidates: by the highest score (the paper's argmax S'),
 * or by the highest lower bound, then the lowest cost change, then the label. Choosing by
 * the point estimate picks, among candidates of similar worth, the luckiest draw; choosing
 * by the lower bound picks the best-evidenced one.
 */
export function choose(decided: readonly { readonly candidate: Measured; readonly decision: Decision }[], by: "score" | "lower"): Measured | undefined {
  const admissible = decided.filter((d) => d.decision.admissible).map((d) => d.candidate);
  const key = (c: Measured) => (by === "score" ? c.score : c.lower);
  return admissible.sort((a, b) => key(b) - key(a) || (a.costChange ?? 0) - (b.costChange ?? 0) || a.label.localeCompare(b.label))[0];
}
