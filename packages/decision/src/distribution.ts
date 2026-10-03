import { probability } from "@harness/cognitive";
import type { Probability } from "@harness/cognitive";
import { DistributionSchema } from "./types.ts";
import type { Answer, Distribution } from "./types.ts";

/**
 * Probabilities are kept this far from 0 and 1 wherever a logarithm or a logit is taken,
 * so a member that says 0 or 1 costs a large finite loss rather than an infinite one.
 */
export const PROBABILITY_FLOOR = 1e-12;

/** A sigmoid never goes beyond this logit, so it stays about `PROBABILITY_FLOOR` from 0 and 1. */
const LOGIT_LIMIT = Math.log(1 / PROBABILITY_FLOOR);

const LEVEL = /^(?:0|[1-9]\d*)$/;

/** Whether a value is probabilities over two or more options that sum to one (within `SUM_TOLERANCE`). */
export const isDistribution = (value: unknown): value is Distribution => DistributionSchema.safeParse(value).success;

function assertOptions(count: number): void {
  if (count < 2) throw new RangeError(`a distribution has at least two options, got ${count}`);
}

/**
 * A distribution from non-negative weights, renormalized. Weights are scaled by the largest
 * first, so weights near the limits of a double cannot overflow the total.
 */
export function distributionFromWeights(weights: Readonly<Record<string, number>>): Distribution {
  const entries = Object.entries(weights);
  assertOptions(entries.length);
  for (const [option, weight] of entries) {
    if (!Number.isFinite(weight) || weight < 0) throw new RangeError(`the weight of "${option}" must be finite and not negative, got ${weight}`);
  }
  const largest = Math.max(...entries.map(([, weight]) => weight));
  if (largest === 0) throw new RangeError("the weights sum to zero, so no option is possible");
  const scaled = entries.map(([option, weight]) => [option, weight / largest] as const);
  const total = scaled.reduce((sum, [, weight]) => sum + weight, 0);
  return Object.fromEntries(scaled.map(([option, weight]) => [option, probability(weight / total)]));
}

/** A boolean question's distribution: `pTrue` on `true` and the rest on `false`, in that order. */
export const booleanDistribution = (pTrue: number): Distribution => ({ true: probability(pTrue), false: probability(1 - pTrue) });

/** Shannon entropy in nats: 0 for a certain answer, ln K for K equally likely options. */
export function entropy(d: Distribution): number {
  let h = 0;
  for (const p of Object.values(d)) h -= p * Math.log(Math.max(p, PROBABILITY_FLOOR));
  return Math.max(0, h);
}

/** Entropy over its maximum, ln K: 0 for a certain answer, 1 for a uniform one. */
export function normalizedEntropy(d: Distribution): number {
  const options = Object.keys(d).length;
  if (options < 2) throw new RangeError(`entropy is normalized over at least two options, got ${options}`);
  return Math.min(1, entropy(d) / Math.log(options));
}

/** The most probable option: the first of equals, in the distribution's key order (whole-number keys first, ascending). */
export function argmax(d: Distribution): string {
  let best: string | undefined;
  let bestP = -1;
  for (const [option, p] of Object.entries(d)) {
    if (p > bestP) {
      best = option;
      bestP = p;
    }
  }
  if (best === undefined) throw new RangeError("a distribution has at least two options, got none");
  return best;
}

/** The highest probability. */
export const topProbability = (d: Distribution): Probability => d[argmax(d)]!;

/** How far the top option leads the second: 0 when they tie, 1 when the answer is certain. */
export function margin(d: Distribution): number {
  const [top, second] = Object.values(d).sort((a, b) => b - a);
  if (second === undefined) throw new RangeError(`a margin needs at least two options, got ${Object.keys(d).length}`);
  return top! - second;
}

function assertTemperature(t: number): void {
  if (!(t > 0 && Number.isFinite(t))) throw new RangeError(`not a temperature: ${t} (finite and above zero)`);
}

/**
 * pᵢ^(1/T), scaled so the largest is 1. Worked in logs against the largest, so neither
 * a very small nor a very large T over- or underflows; an impossible option stays impossible
 * (ln 0 is -Infinity, and e to that is 0).
 */
function temperatureWeights(probs: readonly number[], t: number): number[] {
  assertTemperature(t);
  const top = Math.max(...probs);
  if (!(top > 0)) throw new RangeError("no option has any probability");
  const lnTop = Math.log(top);
  return probs.map((p) => Math.exp((Math.log(p) - lnTop) / t));
}

/** The probabilities as numbers, pᵢ^(1/T) renormalized (the hot path of fitting, with no branded values). */
export function scaleProbabilities(probs: readonly number[], t: number): number[] {
  const weights = temperatureWeights(probs, t);
  const total = weights.reduce((sum, w) => sum + w, 0);
  return weights.map((w) => w / total);
}

/**
 * Temperature scaling of a distribution: pᵢ ∝ pᵢ^(1/T). Above 1 flattens, below 1 sharpens,
 * 1 leaves it as it was; the order of options never changes.
 */
export function temperatureTransform(d: Distribution, t: number): Distribution {
  const options = Object.keys(d);
  const weights = temperatureWeights(Object.values(d), t);
  return distributionFromWeights(Object.fromEntries(options.map((option, i) => [option, weights[i]!])));
}

/** Logits to a distribution, stably (the largest logit is subtracted first); `-Infinity` is an impossible option. */
export function softmaxWithTemperature(logits: Readonly<Record<string, number>>, t = 1): Distribution {
  assertTemperature(t);
  const entries = Object.entries(logits);
  assertOptions(entries.length);
  for (const [option, value] of entries) {
    if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY) throw new RangeError(`the logit of "${option}" must be a number or -Infinity, got ${value}`);
  }
  const largest = Math.max(...entries.map(([, value]) => value));
  if (largest === Number.NEGATIVE_INFINITY) throw new RangeError("every logit is -Infinity, so no option is possible");
  return distributionFromWeights(Object.fromEntries(entries.map(([option, value]) => [option, Math.exp((value - largest) / t)])));
}

/** ln(p / (1 - p)), with p kept `PROBABILITY_FLOOR` away from 0 and 1 so it is always finite. */
export function logit(p: number): number {
  if (!(p >= 0 && p <= 1)) throw new RangeError(`not a probability: ${p}`);
  const c = Math.min(1 - PROBABILITY_FLOOR, Math.max(PROBABILITY_FLOOR, p));
  return Math.log(c / (1 - c));
}

/** 1 / (1 + e⁻ˣ), with x kept where the result is `PROBABILITY_FLOOR` from 0 or 1, so it never saturates. */
export function sigmoid(x: number): number {
  if (Number.isNaN(x)) throw new RangeError("not a number: NaN");
  return 1 / (1 + Math.exp(-Math.min(LOGIT_LIMIT, Math.max(-LOGIT_LIMIT, x))));
}

/** A score's expected level: the sum of level × probability over options named by their whole-number level. */
export function expectedLevel(d: Distribution): number {
  let level = 0;
  for (const [option, p] of Object.entries(d)) {
    if (!LEVEL.test(option)) throw new RangeError(`a score's level "${option}" must be a whole number without a sign or leading zeros`);
    level += Number(option) * p;
  }
  return level;
}

/** An answer of a question type from its distribution: the top option, and a score's expected level. */
export function answerOfDistribution(type: Answer["type"], distribution: Distribution): Answer {
  const top = argmax(distribution);
  return type === "score" ? { type, distribution, top, score: expectedLevel(distribution) } : { type, distribution, top };
}
