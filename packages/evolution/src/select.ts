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
 * tasks (not only trials), a run-wide error rate, non-inferiority with a loss budget in
 * place of the floor and the within-band rule, cost paid for by the gain's lower bound
 * and capped against the base harness, and no bonus for adding machinery.
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
  /** The probability, over the whole run, of accepting any change that is not what its test says. */
  alpha: ProbabilitySchema,
  resamples: z.int().positive(),
  /** Non-inferiority margin: how much worse (in score) a saving or a removal may be, in total, between supported gains. */
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
   * tasks is not evaluated on the rest. It can only remove acceptances, never add them
   * (see futility.ts). Absent: every candidate is evaluated on every task.
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
  /** (C' - C_t) / C_t. */
  readonly costChange?: number;
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
  /** Score lost to accepted savings and removals since the last supported gain. */
  readonly drift: number;
  /** The base harness H_0: the cost of the harness is capped against it. */
  readonly anchor: { readonly score: number; readonly cost?: number };
}

/**
 * The calibrated rule for one candidate. A change is a gain only when the lower
 * confidence bound of its paired gain is above zero (at the run's per-test level), and
 * then its added cost must be paid for by that lower bound: Delta C <= beta0 + beta1 L.
 * Anything else, a change that saves at least `saving` of the tokens or the removal of a
 * mechanism, must be non-inferior: its lower bound at least -margin, with the losses of
 * such steps since the last supported gain within the margin in total (what the paper's
 * floor was for, without a reference that ratchets up with lucky draws). Every
 * candidate's cost is also capped against the base harness, so allowances do not
 * compound: (C' - C_0) / C_0 <= beta0 + beta1 max(0, S' - S_0).
 */
export function calibratedDecision(c: Measured, rule: CalibratedRule, ctx: CalibratedContext): Decision {
  const verdict = verdictOf(c);
  const reject = (reason: string): Decision => ({ admissible: false, reason, verdict });
  if (c.guards.length) return reject(`domain guard violated: ${c.guards.join("; ")}`);
  if (c.cost !== undefined && ctx.anchor.cost) {
    const total = (c.cost - ctx.anchor.cost) / ctx.anchor.cost;
    const allowed = rule.beta0 + rule.beta1 * Math.max(0, c.score - ctx.anchor.score);
    if (total > allowed) return reject(`the harness would spend ${pct(total)} tokens over the base harness, more than the ${pct(allowed)} its total gain pays for`);
  }
  const dC = c.costChange ?? 0;
  if (c.kind === "change" && c.lower > 0) {
    const budget = rule.beta0 + rule.beta1 * c.lower;
    if (dC > budget) return reject(`costs ${pct(dC)} tokens; a gain of at least ${f(c.lower)} pays for ${pct(budget)}`);
    return { admissible: true, reason: `supported gain: ${f(c.gain)}, at least ${f(c.lower)}; cost ${pct(dC)} within ${pct(budget)}`, verdict };
  }
  if (c.lower < -rule.margin) return reject(`${c.kind === "change" ? `no supported gain (lower bound ${f(c.lower)} <= 0), and it ` : "it "}may be worse than the incumbent by more than the margin: lower bound ${f(c.lower)} < -${f(rule.margin)}`);
  const drift = ctx.drift + Math.max(0, -c.gain);
  if (drift > rule.margin) return reject(`accumulated losses ${f(drift)} would exceed the margin ${f(rule.margin)} since the last supported gain`);
  const nonInferior = `non-inferior (lower bound ${f(c.lower)} >= -${f(rule.margin)})`;
  if (c.kind === "prune") {
    if (dC > rule.beta0) return reject(`${nonInferior}, but removing it costs ${pct(dC)} tokens, more than ${pct(rule.beta0)}`);
    return { admissible: true, reason: `${nonInferior}, and removes a mechanism`, verdict };
  }
  if (c.costChange === undefined || dC > -rule.saving) return reject(`no supported gain (lower bound ${f(c.lower)} <= 0) and saves no more than ${(100 * rule.saving).toFixed(1)}% tokens`);
  return { admissible: true, reason: `${nonInferior}, and saves ${(100 * -dC).toFixed(1)}% tokens`, verdict };
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
