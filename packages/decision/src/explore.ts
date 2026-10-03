import { probability } from "@harness/cognitive";
import type { Probability } from "@harness/cognitive";
import type { Entropy } from "@harness/core";

/**
 * Uniform draws in [0, 1) from an entropy port: 53 bits from seven bytes (the low five
 * bits of the first, all of the rest), so every double in the grid is equally likely and
 * a draw is never 1.
 */
export function uniform(entropy: Entropy): () => number {
  return () => {
    const b = entropy.bytes(7);
    if (b.length < 7) throw new RangeError(`a uniform draw needs 7 bytes of entropy, got ${b.length}`);
    const high = ((b[0]! & 0x1f) << 16) | (b[1]! << 8) | b[2]!;
    const low = ((b[3]! << 24) | (b[4]! << 16) | (b[5]! << 8) | b[6]!) >>> 0;
    return (high * 2 ** 32 + low) / 2 ** 53;
  };
}

// ---- exploration ---------------------------------------------------------------------------

export interface EpsilonGreedyInput<T> {
  /** Every option the decision could take, greedy one included. */
  readonly options: readonly T[];
  /** The option the policy would take without exploring. */
  readonly greedy: T;
  /** The share of decisions taken uniformly at random among the options. */
  readonly epsilon: number;
  /** Uniform draws in [0, 1): one to decide whether to explore, one more to pick when it does. */
  readonly rng: () => number;
  /** How options are matched with the greedy one; identity by default (use it for objects that are values). */
  readonly same?: (a: T, b: T) => boolean;
}

export interface Exploration<T> {
  readonly choice: T;
  /**
   * The exact probability that this choice was taken: 1 - epsilon + epsilon/K for the
   * greedy option and epsilon/K for any other (K options), whichever branch produced it.
   */
  readonly propensity: Probability;
  /**
   * Whether the random branch fired, and so chose anything: it may have chosen the
   * greedy option, which is still an exploration draw (its propensity says how likely).
   */
  readonly explored: boolean;
}

/**
 * Epsilon-greedy choice with the propensity recorded, for off-policy evaluation. The
 * shape is the type `ExplorerFn`, so a runner can be handed another exploration policy.
 */
export function epsilonGreedy<T>({ options, greedy, epsilon, rng, same = Object.is }: EpsilonGreedyInput<T>): Exploration<T> {
  const k = options.length;
  if (k < 1) throw new RangeError("exploring needs at least one option");
  if (!(epsilon >= 0 && epsilon <= 1)) throw new RangeError(`epsilon must be a probability, got ${epsilon}`);
  const greedyAt = options.findIndex((option) => same(option, greedy));
  if (greedyAt < 0) throw new RangeError(`the greedy option ${JSON.stringify(greedy)} is not among the options`);
  if (options.some((option, i) => options.findIndex((other) => same(other, option)) !== i)) throw new RangeError("an option is listed more than once");
  const explored = rng() < epsilon;
  const at = explored ? Math.min(k - 1, Math.floor(rng() * k)) : greedyAt;
  const share = epsilon / k;
  return { choice: options[at]!, propensity: probability(Math.min(1, Math.max(0, at === greedyAt ? 1 - epsilon + share : share))), explored };
}

/** The exploration policy a runner is given: `epsilonGreedy` is one. */
export type ExplorerFn = typeof epsilonGreedy;

// ---- off-policy estimators -------------------------------------------------------------------

/** One logged decision, for estimating what another policy would have earned. */
export interface OffPolicySample {
  /** What came of the logged action, 0 to 1. */
  readonly reward: number;
  /** The probability with which the logging policy took the logged action: above 0, at most 1. */
  readonly propensity: number;
  /** The probability with which the policy being evaluated takes the logged action. */
  readonly targetProbability: number;
  /** A reward model's prediction for the logged action (or for any action, if it does not tell them apart). */
  readonly modelReward?: number;
  /** The model's expected reward under the target policy in this context; `modelReward` when absent. */
  readonly modelValue?: number;
}

export interface OffPolicyOptions {
  /** Weights above this are cut to it: less variance, some bias. No clipping when absent. */
  readonly clip?: number;
}

export interface OffPolicyEstimate {
  /** The estimated value (mean reward) of the target policy. */
  readonly estimate: number;
  /** The standard error of the estimate under the normal approximation; infinite when it cannot be told. */
  readonly standardError: number;
  readonly n: number;
  /** Kish's effective sample size of the weights: (Σw)² / Σw²; n for on-policy data, 0 with no support. */
  readonly effectiveSampleSize: number;
}

function inRange(name: string, index: number, value: number | undefined, low: number, high: number): void {
  if (value !== undefined && !(value >= low && value <= high)) throw new RangeError(`sample ${index}: ${name} ${value} must be between ${low} and ${high}`);
}

/** Weights of the samples (target over logging probability, clipped), after checking every sample. */
function weigh(samples: readonly OffPolicySample[], options: OffPolicyOptions): number[] {
  if (samples.length < 1) throw new RangeError("an estimate needs at least one sample");
  const { clip } = options;
  if (clip !== undefined && !(clip > 0)) throw new RangeError(`clip must be above zero, got ${clip}`);
  return samples.map((s, i) => {
    if (!(s.propensity > 0 && s.propensity <= 1)) throw new RangeError(`sample ${i}: propensity ${s.propensity} must be above 0 and at most 1 (a logged action had no chance of being taken)`);
    inRange("targetProbability", i, s.targetProbability, 0, 1);
    inRange("reward", i, s.reward, 0, 1);
    inRange("modelReward", i, s.modelReward, 0, 1);
    inRange("modelValue", i, s.modelValue, 0, 1);
    if (s.modelValue !== undefined && s.modelReward === undefined) throw new RangeError(`sample ${i}: a modelValue without a modelReward`);
    const w = s.targetProbability / s.propensity;
    return clip === undefined ? w : Math.min(w, clip);
  });
}

const sum = (xs: readonly number[]): number => xs.reduce((total, x) => total + x, 0);

function effectiveSampleSize(weights: readonly number[]): number {
  const squares = sum(weights.map((w) => w * w));
  return squares === 0 ? 0 : sum(weights) ** 2 / squares;
}

/** The mean of per-sample terms and its normal-approximation standard error. */
function meanOfTerms(terms: readonly number[], weights: readonly number[]): OffPolicyEstimate {
  const n = terms.length;
  const estimate = sum(terms) / n;
  const standardError = n < 2 ? Number.POSITIVE_INFINITY : Math.sqrt(sum(terms.map((t) => (t - estimate) ** 2)) / (n - 1) / n);
  return { estimate, standardError, n, effectiveSampleSize: effectiveSampleSize(weights) };
}

/** Inverse propensity scoring: the mean of weight × reward. Unbiased when weights are not clipped. */
export function ips(samples: readonly OffPolicySample[], options: OffPolicyOptions = {}): OffPolicyEstimate {
  const weights = weigh(samples, options);
  return meanOfTerms(samples.map((s, i) => weights[i]! * s.reward), weights);
}

/**
 * Self-normalized IPS: Σ w·r / Σ w, always a weighted mean of rewards (so within 0 to 1),
 * consistent though slightly biased. The standard error is the delta-method one. With no
 * weight at all (the target never takes a logged action) there is no evidence.
 */
export function snips(samples: readonly OffPolicySample[], options: OffPolicyOptions = {}): OffPolicyEstimate {
  const weights = weigh(samples, options);
  const n = samples.length;
  const total = sum(weights);
  if (total === 0) return { estimate: 0, standardError: Number.POSITIVE_INFINITY, n, effectiveSampleSize: 0 };
  const estimate = sum(samples.map((s, i) => weights[i]! * s.reward)) / total;
  const residuals = sum(samples.map((s, i) => (weights[i]! * (s.reward - estimate)) ** 2));
  const standardError = n < 2 ? Number.POSITIVE_INFINITY : Math.sqrt((n / (n - 1)) * residuals) / total;
  return { estimate, standardError, n, effectiveSampleSize: effectiveSampleSize(weights) };
}

/**
 * Doubly robust: the model's value of the target plus the weighted residual on the logged
 * action, so it is unbiased if either the weights or the model are right. A sample
 * without a model contributes as in IPS (the model is taken to predict 0).
 */
export function doublyRobust(samples: readonly OffPolicySample[], options: OffPolicyOptions = {}): OffPolicyEstimate {
  const weights = weigh(samples, options);
  return meanOfTerms(
    samples.map((s, i) => {
      const predicted = s.modelReward ?? 0;
      return (s.modelValue ?? predicted) + weights[i]! * (s.reward - predicted);
    }),
    weights,
  );
}
