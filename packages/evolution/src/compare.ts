import type { Entropy } from "@harness/core";
import { pool } from "./measure.ts";
import type { Measurement } from "./measure.ts";
import { Uniform } from "./random.ts";

/** A candidate against the incumbent on the same tasks. */
export interface Comparison {
  /** The paired score difference S' - S. */
  readonly gain: number;
  /** One-sided confidence bounds on the gain, each at error level `alpha`. */
  readonly lower: number;
  readonly upper: number;
  readonly alpha: number;
  /** The standard deviation of the random half-sample means: about the standard error of the gain. */
  readonly se: number;
  /** (C' - C) / C, when both sides report tokens: the point estimate, for display. */
  readonly costChange?: number;
  /**
   * One-sided confidence bounds, each at error level `alpha`, on the relative change of the
   * tokens a task takes, (C' - C) / C with C the incumbent's mean tokens a task, by the same
   * randomization test applied to the tasks' mean-token differences (a task's tokens are the
   * mean of its trials that report any; a task that does not report on both sides is left
   * out). Present with `costChange`; the widest possible (-1 and +Infinity) when too few
   * tasks are left for the test to reject anything.
   */
  readonly costLower?: number;
  readonly costUpper?: number;
  readonly tasks: number;
  readonly groups: number;
}

export interface ComparisonOptions {
  /** One-sided error level of each bound, in (0, 0.5). */
  readonly alpha: number;
  readonly resamples: number;
  readonly entropy: Entropy;
}

function checkLevel(alpha: number, resamples: number): void {
  if (!(alpha > 0 && alpha < 0.5)) throw new RangeError(`alpha must be in (0, 0.5), not ${alpha}`);
  const needed = Math.ceil(1 / alpha);
  if (resamples < needed) throw new RangeError(`a bound at alpha ${alpha} needs at least ${needed} resamples, not ${resamples}`);
}

/** The mean of k rewards drawn with replacement from `rewards` (no draws when they are all equal): the paper's within-task bootstrap. */
function resampledMean(u: Uniform, rewards: readonly number[]): number {
  const first = rewards[0]!;
  if (rewards.every((r) => r === first)) return first;
  let sum = 0;
  // Stryker disable next-line AssignmentOperator: equivalent; the only caller takes the standard deviation of the resampled scores, which does not change when the varying tasks' means are all negated (the constant tasks return before this loop and only shift every score alike; the standard deviation is unchanged except possibly in the last bit of rounding)
  for (let j = 0; j < rewards.length; j++) sum += rewards[u.index(rewards.length)]!;
  return sum / rewards.length;
}

const sd = (xs: readonly number[]): number => {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
};

/** Task indexes by group, in the order groups first appear. */
function clusters(groups: readonly string[]): number[][] {
  const byGroup = new Map<string, number[]>();
  groups.forEach((g, i) => byGroup.set(g, [...(byGroup.get(g) ?? []), i]));
  return [...byGroup.values()];
}

/** With at most this many groups the randomization test is enumerated over all 2^G sign vectors: exact, and it draws nothing. */
export const EXACT_GROUPS = 14;

interface Bounds {
  readonly lower: number;
  readonly upper: number;
  readonly se: number;
}

/**
 * Both one-sided bounds of the sign-flip test on groups with weighted difference sums
 * `sums` and weights `weights` (a group flips whole), at level `alpha`. See compare().
 *
 * With G <= EXACT_GROUPS groups all 2^G sign vectors are enumerated, so the p-values are
 * exact: rejecting "the gain is at most theta" happens for the vectors whose flipped set F
 * has mean at most theta, plus the empty set (the observed data itself), and the test
 * rejects when that share of the 2^G vectors is below alpha. Otherwise `resamples` random
 * vectors are drawn and the Monte Carlo p-value (1 + at least as extreme) / (R + 1) is
 * used. In both, a widest possible bound results when even the most extreme outcome is not
 * below alpha.
 */
function signFlipBounds(sums: readonly number[], weights: readonly number[], alpha: number, resamples: number, u: Uniform): Bounds {
  const G = sums.length;
  const means: number[] = [];
  let rank: number;
  if (G <= EXACT_GROUPS) {
    for (let mask = 1; mask < 2 ** G; mask++) {
      let num = 0;
      let den = 0;
      // `!==` rather than `<`: the one mutant it leaves (`===`, no pass at all) is killable, while `<=` would be equivalent (mask < 2 ** G has no bit G) and `>=` would not be
      for (let g = 0; g !== G; g++)
        if (mask & (1 << g)) {
          num += sums[g]!;
          den += weights[g]!;
        }
      means.push(num / den);
    }
    // p = (1 + #{F: mean_F <= theta}) / 2^G is not below alpha from the m-th smallest mean on, m = ceil(alpha 2^G) - 1.
    rank = Math.ceil(alpha * 2 ** G) - 1;
  } else {
    let flippedNothing = 0;
    for (let r = 0; r < resamples; r++) {
      let num = 0;
      let den = 0;
      for (let g = 0; g < G; g++)
        // A draw is strictly inside (0, 1) and never exactly one half, so doubling it and flooring is 0 exactly when it is below one half; written this way, no comparison remains whose `<=` variant would be equivalent.
        if (Math.floor(u.next() * 2) === 0) {
          num += sums[g]!;
          den += weights[g]!;
        }
      if (den === 0) flippedNothing++;
      else means.push(num / den);
    }
    // The Monte Carlo p-value (1 + at least as extreme) / (R + 1) must exceed alpha; a draw that flips nothing counts against rejection.
    rank = Math.floor(alpha * (resamples + 1)) - flippedNothing;
  }
  means.sort((a, b) => a - b);
  return {
    // Too few groups to reject anything at this level: the bounds are the widest possible.
    lower: rank >= 1 ? means[rank - 1]! : Number.NEGATIVE_INFINITY,
    upper: rank >= 1 ? means[means.length - rank]! : Number.POSITIVE_INFINITY,
    se: means.length > 1 ? sd(means) : 0,
  };
}

/** A task's tokens: the mean of the trials that report any (see `summarize` in measure.ts), or undefined. */
function taskTokens(tokens: readonly number[]): number | undefined {
  const reported = tokens.filter((x) => x > 0);
  return reported.length ? reported.reduce((s, x) => s + x, 0) / reported.length : undefined;
}

/**
 * Compare a candidate with the incumbent measured on the same tasks, with the same number
 * of trials, in the same window. The bounds invert a paired randomization test: under the
 * null that the two are the same harness, which of them produced which measurement of a
 * task is exchangeable, so each group of tasks (a task is its own group unless it names
 * one) may flip the sign of its difference, and the test is exact whatever the reward
 * distribution, the number of informative tasks or the ties (all 2^G sign vectors are
 * enumerated when there are at most 14 groups; above that the test is Monte Carlo). Under a
 * shift model the test inverts in closed form: rejecting "the gain is at most theta"
 * happens exactly when theta is below the weighted mean difference of the groups a random
 * sign vector flipped, so the lower bound at level alpha is a low quantile of those random
 * half-sample means (and the upper bound a high one); a draw that flips nothing counts
 * against rejection.
 *
 * The same machinery, applied to the tasks' mean-token differences (unweighted; a task is
 * left out when it reports no tokens on either side), bounds the RELATIVE change of the
 * cost: `costLower` and `costUpper`. Each is valid at level `alpha` on its own. Acceptance
 * (select.ts) requires every claim it makes to pass its bound at the same level, and needs
 * no extra error budget for that: P(accepting a candidate for which SOME claim is false)
 * is at most the level of that one claim's test, since accepting requires that claim to
 * pass too.
 *
 * What this does and does not guarantee. Tasks are the unit, so the interval holds the
 * noise that decides whether a gain generalizes to new tasks of the same kind: which tasks
 * were sampled, and how their trials happened to go (each task's difference was measured
 * with its trial noise). The paper's noise band has only the trial noise, the task set
 * held fixed (RS2.9), so a gain on two tasks and the same gain spread over twenty look
 * alike to it (RS2.2). The guarantee is that of a sharp-null test: the candidate and the
 * incumbent are the same harness, and the measurements are fresh noise on the same tasks.
 * It covers "this candidate is no better than the incumbent on these tasks, up to noise". It
 * does NOT cover transfer to new tasks: the proposer reads the failures of the evolve
 * tasks, so a candidate can be fitted to them, and a gain certified on the evolve set is
 * evidence about the evolve set. Only data the search never saw (the holdout, see
 * holdout.ts) speaks to transfer, and only within its own budget.
 */
export function compare(candidate: Measurement, incumbent: Measurement, options: ComparisonOptions): Comparison {
  const { alpha, resamples } = options;
  checkLevel(alpha, resamples);
  const n = candidate.tasks.length;
  if (incumbent.tasks.length !== n || candidate.tasks.some((t, i) => t.task !== incumbent.tasks[i]!.task)) throw new RangeError("a comparison needs both harnesses measured on the same tasks");
  const groups = clusters(candidate.tasks.map((t) => t.group));
  // Each group's weighted sum of differences, and its weight: a group flips whole.
  const sums = groups.map((g) => g.reduce((s, i) => s + candidate.tasks[i]!.weight * (candidate.tasks[i]!.mean - incumbent.tasks[i]!.mean), 0));
  const weights = groups.map((g) => g.reduce((s, i) => s + candidate.tasks[i]!.weight, 0));
  const u = new Uniform(options.entropy);
  const score = signFlipBounds(sums, weights, alpha, resamples, u);
  const costChange = candidate.cost !== undefined && incumbent.cost ? (candidate.cost - incumbent.cost) / incumbent.cost : undefined;
  let cost: { costLower: number; costUpper: number } | undefined;
  if (costChange !== undefined) {
    // Tasks that report tokens on both sides, each by its mean tokens; groups flip whole, tasks weigh alike.
    const paired = candidate.tasks.flatMap((t, i) => {
      const a = taskTokens(t.tokens);
      const b = taskTokens(incumbent.tasks[i]!.tokens);
      return a === undefined || b === undefined ? [] : [{ group: t.group, diff: a - b, base: b }];
    });
    const spread = clusters(paired.map((p) => p.group));
    const bounds = signFlipBounds(
      spread.map((g) => g.reduce((s, i) => s + paired[i]!.diff, 0)),
      spread.map((g) => g.length),
      alpha,
      resamples,
      u,
    );
    const base = paired.reduce((s, p) => s + p.base, 0) / paired.length;
    // No task reports on both sides: nothing is known (and there is no base to be relative to).
    cost = paired.length ? { costLower: Math.max(-1, bounds.lower / base), costUpper: bounds.upper / base } : { costLower: -1, costUpper: Number.POSITIVE_INFINITY };
  }
  return {
    gain: candidate.score - incumbent.score,
    lower: Math.max(-1, score.lower),
    upper: Math.min(1, score.upper),
    alpha,
    se: score.se,
    ...(costChange === undefined ? {} : { costChange, ...cost }),
    tasks: n,
    groups: groups.length,
  };
}

/** The paper's empirical noise band: what separates two evaluations of the same harness. */
export interface NoiseBand {
  readonly delta: number;
  readonly method: "repeated" | "bootstrap";
  /** The standard deviation of the null score difference. */
  readonly sd: number;
}

/**
 * The noise band delta of the paper (its `calibrate.py`), kept to run its rule as
 * published: delta = z * sd(null Delta S). With two or more evaluations of the base
 * harness that sd is sqrt(2) times the sd of their scores; with one (or identical ones)
 * it is sqrt(2) times the standard error of the score bootstrapped over trials within
 * each task. Either way the task set is held fixed: delta measures how differently the
 * same tasks come out when run again, not how differently new tasks would.
 */
export function noiseBand(evaluations: readonly Measurement[], options: { readonly z: number; readonly resamples: number; readonly entropy: Entropy }): NoiseBand {
  const [first] = evaluations;
  if (!first) throw new RangeError("no evaluations of the base harness");
  // With one evaluation sd() is 0 / 0 = NaN, and NaN > 0 is false, so the bootstrap below runs without any length check here.
  const repeated = sd(evaluations.map((e) => e.score)) * Math.SQRT2;
  if (repeated > 0) return { delta: options.z * repeated, method: "repeated", sd: repeated };
  const pooled = pool(evaluations);
  const u = new Uniform(options.entropy);
  // Stryker disable next-line ArithmeticOperator: equivalent; a negative denominator negates every resampled score exactly, and the standard deviation does not change under negation
  const den = pooled.tasks.reduce((s, t) => s + t.weight, 0);
  const weightedSum = (): number =>
    pooled.tasks.reduce((s, t) => {
      const term = t.weight * resampledMean(u, t.rewards);
      // Stryker disable next-line ArithmeticOperator: equivalent for s + term becoming s - term; the weighted sum is negated exactly, so every resampled score is, and the standard deviation does not change under negation
      return s + term;
    }, 0);
  const scores = Array.from({ length: options.resamples }, () => weightedSum() / den);
  const spread = Math.SQRT2 * sd(scores) * Math.sqrt(pooled.k / first.k);
  return { delta: options.z * spread, method: "bootstrap", sd: spread };
}
