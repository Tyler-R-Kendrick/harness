import type { Entropy } from "@harness/core";
import { pool } from "./measure.ts";
import type { Measurement, TaskMeasure } from "./measure.ts";
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
  /** (C' - C) / C, when both sides report tokens. */
  readonly costChange?: number;
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
  for (let j = 0; j < rewards.length; j++) sum += rewards[u.index(rewards.length)]!;
  return sum / rewards.length;
}

const sd = (xs: readonly number[]): number => {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
};

/** Task indexes by group, in the order groups first appear. */
function clusters(tasks: readonly TaskMeasure[]): number[][] {
  const byGroup = new Map<string, number[]>();
  tasks.forEach((t, i) => byGroup.set(t.group, [...(byGroup.get(t.group) ?? []), i]));
  return [...byGroup.values()];
}

/**
 * Compare a candidate with the incumbent measured on the same tasks, with the same number
 * of trials, in the same window. The bounds invert a paired randomization test: under the
 * null that the two are the same harness, which of them produced which measurement of a
 * task is exchangeable, so each group of tasks (a task is its own group unless it names
 * one) may flip the sign of its difference, and the test is exact whatever the reward
 * distribution, the number of informative tasks or the ties. Under a shift model the
 * test inverts in closed form: rejecting "the gain is at most theta" happens exactly when
 * theta is below the weighted mean difference of the groups a random sign vector flipped,
 * so the lower bound at level alpha is a low quantile of those random half-sample means
 * (and the upper bound a high one); a draw that flips nothing counts against rejection.
 *
 * Tasks are the unit, so the interval holds the noise that decides whether a gain
 * generalizes to new tasks of the same kind: which tasks were sampled, and how their
 * trials happened to go (each task's difference was measured with its trial noise). The
 * paper's noise band has only the trial noise, the task set held fixed (RS2.9), so a gain
 * on two tasks and the same gain spread over twenty look alike to it (RS2.2).
 */
export function compare(candidate: Measurement, incumbent: Measurement, options: ComparisonOptions): Comparison {
  const { alpha, resamples } = options;
  checkLevel(alpha, resamples);
  const n = candidate.tasks.length;
  if (incumbent.tasks.length !== n || candidate.tasks.some((t, i) => t.task !== incumbent.tasks[i]!.task)) throw new RangeError("a comparison needs both harnesses measured on the same tasks");
  const groups = clusters(candidate.tasks);
  // Each group's weighted sum of differences, and its weight: a group flips whole.
  const sums = groups.map((g) => g.reduce((s, i) => s + candidate.tasks[i]!.weight * (candidate.tasks[i]!.mean - incumbent.tasks[i]!.mean), 0));
  const weights = groups.map((g) => g.reduce((s, i) => s + candidate.tasks[i]!.weight, 0));
  const u = new Uniform(options.entropy);
  const means: number[] = [];
  let flippedNothing = 0;
  for (let r = 0; r < resamples; r++) {
    let num = 0;
    let den = 0;
    for (let g = 0; g < groups.length; g++)
      if (u.next() < 0.5) {
        num += sums[g]!;
        den += weights[g]!;
      }
    if (den === 0) flippedNothing++;
    else means.push(num / den);
  }
  means.sort((a, b) => a - b);
  // The rank of the bound: the Monte Carlo p-value (1 + at least as extreme) / (R + 1) must exceed alpha.
  const rank = Math.floor(alpha * (resamples + 1)) - flippedNothing;
  const costChange = candidate.cost !== undefined && incumbent.cost ? (candidate.cost - incumbent.cost) / incumbent.cost : undefined;
  return {
    gain: candidate.score - incumbent.score,
    // Too few groups to reject anything at this level: the bounds are the widest possible.
    lower: rank >= 1 ? means[rank - 1]! : -1,
    upper: rank >= 1 ? means[means.length - rank]! : 1,
    alpha,
    se: means.length > 1 ? sd(means) : 0,
    ...(costChange === undefined ? {} : { costChange }),
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
  if (evaluations.length >= 2) {
    const spread = sd(evaluations.map((e) => e.score)) * Math.SQRT2;
    if (spread > 0) return { delta: options.z * spread, method: "repeated", sd: spread };
  }
  const pooled = pool(evaluations);
  const u = new Uniform(options.entropy);
  const den = pooled.tasks.reduce((s, t) => s + t.weight, 0);
  const scores = Array.from({ length: options.resamples }, () => pooled.tasks.reduce((s, t) => s + t.weight * resampledMean(u, t.rewards), 0) / den);
  const spread = Math.SQRT2 * sd(scores) * Math.sqrt(pooled.k / first.k);
  return { delta: options.z * spread, method: "bootstrap", sd: spread };
}
