import type { Distribution } from "./types.ts";

// ---- split conformal ------------------------------------------------------------------------------

function assertLevel(name: string, value: number): void {
  if (!(value > 0 && value < 1)) throw new RangeError(`${name} must be between 0 and 1 (exclusive), got ${value}`);
}

/**
 * Slack for the product (n + 1)(1 - alpha), which can land a hair above a whole number in
 * floating point ((9 + 1)(1 - 0.7) is 3.0000000000000004) and would cost a rank.
 */
const RANK_SLACK = 1e-9;

/**
 * The finite-sample conformal quantile: the ceil((n+1)(1-alpha))-th smallest nonconformity
 * score, which covers the true label with probability at least 1 - alpha for an exchangeable
 * new example. Infinity when there are too few scores for the level (then every option is in
 * every set).
 */
export function splitConformal(scores: readonly number[], alpha: number): number {
  assertLevel("alpha", alpha);
  scores.forEach((score, i) => {
    if (Number.isNaN(score)) throw new RangeError(`score ${i} is not a number`);
  });
  const rank = Math.ceil((scores.length + 1) * (1 - alpha) - RANK_SLACK);
  if (rank > scores.length) return Number.POSITIVE_INFINITY;
  return [...scores].sort((a, b) => a - b)[rank - 1]!;
}

/** How unlikely the model made the right option: one minus its probability. */
export function nonconformity(d: Distribution, label: string): number {
  const p = d[label];
  if (p === undefined) throw new RangeError(`the label "${label}" is not among the options (${Object.keys(d).join(", ")})`);
  return 1 - p;
}

/** The options whose nonconformity is at most the quantile, most probable first (ties in the distribution's order). */
export function predictionSet(d: Distribution, qhat: number): string[] {
  return Object.entries(d)
    .filter(([, p]) => 1 - p <= qhat)
    .sort(([, a], [, b]) => b - a)
    .map(([option]) => option);
}

/** The share of prediction sets that hold their label. */
export function empiricalCoverage(sets: readonly (readonly string[])[], labels: readonly string[]): number {
  if (sets.length !== labels.length) throw new RangeError(`${sets.length} sets but ${labels.length} labels`);
  if (sets.length < 1) throw new RangeError("coverage needs at least one set");
  return sets.filter((set, i) => set.includes(labels[i]!)).length / sets.length;
}

/** The mean number of options in a prediction set. */
export function averageSetSize(sets: readonly (readonly string[])[]): number {
  if (sets.length < 1) throw new RangeError("a mean size needs at least one set");
  return sets.reduce((sum, set) => sum + set.length, 0) / sets.length;
}

// ---- upper confidence bounds on a risk ------------------------------------------------------------

function assertCounts(errors: number, n: number, delta: number): void {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`n must be a positive whole number, got ${n}`);
  if (!Number.isInteger(errors) || errors < 0 || errors > n) throw new RangeError(`errors must be a whole number from 0 to n (${n}), got ${errors}`);
  assertLevel("delta", delta);
}

/** With probability at least 1 - delta the true risk is at most `errors / n + sqrt(ln(1/delta) / 2n)` (Hoeffding), capped at 1. */
export function hoeffdingUpper(errors: number, n: number, delta: number): number {
  assertCounts(errors, n, delta);
  return Math.min(1, errors / n + Math.sqrt(Math.log(1 / delta) / (2 * n)));
}

/** ln Γ(x) for x > 0 (Lanczos approximation, g = 7: about 1e-15 relative for the x that arise here). */
function logGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  const y = x - 1;
  const t = y + 7.5;
  let sum = c[0]!;
  for (let i = 1; i < 9; i++) sum += c[i]! / (y + i);
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(sum);
}

const TINY = 1e-300;
/** Keeps a denominator of the continued fraction away from zero (Lentz's method needs this in theory; it does not arise for valid arguments). */
// Stryker disable next-line all: equivalent; the guard never fires for arguments the callers pass
const nonZero = (v: number): number => (Math.abs(v) < TINY ? TINY : v);

/** The continued fraction of the incomplete beta function (modified Lentz's method). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  let c = 1;
  let d = 1 / nonZero(1 - ((a + b) * x) / (a + 1));
  let h = d;
  // Stryker disable next-line EqualityOperator: equivalent; the cap only stops a fraction that does not converge, one more step past it changes nothing
  for (let m = 1; m <= 10000; m++) {
    const m2 = 2 * m;
    const even = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 / nonZero(1 + even * d);
    c = nonZero(1 + even / c);
    h *= d * c;
    const odd = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 / nonZero(1 + odd * d);
    c = nonZero(1 + odd / c);
    const change = d * c;
    h *= change;
    // Stryker disable next-line EqualityOperator: equivalent; a change of exactly 3e-16 is not reachable, and either side of it is converged
    if (Math.abs(change - 1) < 3e-16) break;
  }
  return h;
}

/** The regularized incomplete beta function I_x(a, b): the Beta(a, b) distribution's CDF at x. */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (!(x >= 0 && x <= 1)) throw new RangeError(`x must be between 0 and 1, got ${x}`);
  if (!(a > 0 && b > 0 && Number.isFinite(a) && Number.isFinite(b))) throw new RangeError(`a and b must be positive and finite, got ${a} and ${b}`);
  // At x = 0 and x = 1 the logarithms below are -Infinity, so `front` is 0 and the result is 0 or 1.
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  // The fraction converges quickly below the mean; above it, use the symmetry I_x(a, b) = 1 - I_(1-x)(b, a).
  // Stryker disable next-line all: equivalent; the fraction is valid for every x, the split only picks the faster side
  return x < (a + 1) / (a + b + 2) ? (front * betaContinuedFraction(x, a, b)) / a : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/**
 * The exact one-sided upper bound on a risk (Clopper-Pearson): the probability p at which
 * seeing at most `errors` errors in `n` trials has probability delta. Found by bisection on
 * P(X <= errors | n, p) = I_(1-p)(n - errors, errors + 1), which falls as p rises.
 */
export function clopperPearsonUpper(errors: number, n: number, delta: number): number {
  assertCounts(errors, n, delta);
  if (errors === n) return 1;
  if (errors === 0) return 1 - delta ** (1 / n);
  let lo = errors / n;
  let hi = 1;
  // Stryker disable next-line EqualityOperator: equivalent; a 61st halving of an interval already 1e-18 wide changes nothing
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    // Stryker disable next-line EqualityOperator: equivalent; the tail probability equals delta exactly at no double
    if (regularizedIncompleteBeta(1 - mid, n - errors, errors + 1) > delta) lo = mid;
    else hi = mid;
  }
  return hi;
}

// ---- selective prediction -----------------------------------------------------------------------------

export interface SelectiveSample {
  /** The (calibrated) confidence of the answer. */
  readonly confidence: number;
  /** Whether the answer was right. */
  readonly correct: boolean;
}

export interface SelectiveOptions {
  /** The share of wrong answers among those acted on that is to be bounded. */
  readonly targetRisk: number;
  /** The bound fails with probability at most this. */
  readonly delta: number;
  readonly bound: "hoeffding" | "clopper-pearson";
}

export interface SelectiveResult {
  /** Act when the confidence is at least this: the lowest threshold that passed. Undefined when none did. */
  readonly threshold: number | undefined;
  /** The share of samples at or above the threshold (0 when there is none). */
  readonly coverage: number;
  /** The share of those that were wrong. */
  readonly risk: number;
  /** The upper confidence bound on the risk at the threshold (1 when there is none). */
  readonly upperBound: number;
  /** How many samples are at or above the threshold. */
  readonly n: number;
}

export interface RiskCoverageRow {
  readonly threshold: number;
  readonly coverage: number;
  readonly risk: number;
}

interface Level {
  readonly threshold: number;
  /** Samples with confidence at or above the threshold, and how many of them were wrong. */
  readonly n: number;
  readonly errors: number;
}

/** Each distinct confidence from the highest, with the counts of everything at or above it. */
function levels(samples: readonly SelectiveSample[]): Level[] {
  samples.forEach((sample, i) => {
    if (!Number.isFinite(sample.confidence)) throw new RangeError(`sample ${i}: the confidence must be a finite number, got ${sample.confidence}`);
  });
  const sorted = [...samples].sort((a, b) => b.confidence - a.confidence);
  const out: Level[] = [];
  let errors = 0;
  sorted.forEach((sample, i) => {
    if (!sample.correct) errors++;
    if (i === sorted.length - 1 || sorted[i + 1]!.confidence !== sample.confidence) out.push({ threshold: sample.confidence, n: i + 1, errors });
  });
  return out;
}

/** The risk at every distinct confidence, from the highest: what accepting down to it would cover and get wrong. */
export function riskCoverageCurve(samples: readonly SelectiveSample[]): RiskCoverageRow[] {
  return levels(samples).map(({ threshold, n, errors }) => ({ threshold, coverage: n / samples.length, risk: errors / n }));
}

/**
 * The confidence threshold above which the share of wrong answers is bounded by `targetRisk`
 * with confidence 1 - delta, by fixed-sequence testing (Learn then Test): thresholds are the
 * distinct confidences from the highest down; each tests the null "the risk above this
 * threshold exceeds the target" by an upper confidence bound (Hoeffding, or the exact
 * Clopper-Pearson); testing goes on while the bound is at most the target and stops at the
 * first failure, so no multiple-testing correction is needed and the guarantee holds at the
 * chosen threshold (the lowest that passed).
 *
 * A threshold with so few samples above it that even no errors could not meet the target is
 * not tested: it cannot pass whatever the labels are, and it is decided by the confidences
 * alone, so passing it over does not spend any of the level. (Without this a continuous
 * confidence, whose highest threshold has one sample, would stop the sequence at once.)
 */
export function selectiveThreshold(samples: readonly SelectiveSample[], { targetRisk, delta, bound }: SelectiveOptions): SelectiveResult {
  assertLevel("targetRisk", targetRisk);
  assertLevel("delta", delta);
  if (bound !== "hoeffding" && bound !== "clopper-pearson") throw new RangeError(`bound must be "hoeffding" or "clopper-pearson", got ${JSON.stringify(bound)}`);
  const upper = bound === "hoeffding" ? hoeffdingUpper : clopperPearsonUpper;
  let result: SelectiveResult = { threshold: undefined, coverage: 0, risk: 0, upperBound: 1, n: 0 };
  for (const { threshold, n, errors } of levels(samples)) {
    if (upper(0, n, delta) > targetRisk) continue;
    const upperBound = upper(errors, n, delta);
    if (upperBound > targetRisk) break;
    result = { threshold, coverage: n / samples.length, risk: errors / n, upperBound, n };
  }
  return result;
}
