/**
 * Arithmetic for candidate strategies (best-of-N, cascades, voting, verification).
 * Every function states its model. These are independence-model calculations for a
 * fixed task with per-attempt success probability p: useful for budgeting, never a
 * live guarantee. Real tasks are heterogeneous and attempts are correlated; use
 * measured per-task-family curves when they exist.
 */

function probability(v: number, name = "probability"): void {
  if (!(v >= 0 && v <= 1)) throw new Error(`${name} must be a probability in [0, 1], got ${v}`);
}

function count(n: number, min = 0): void {
  if (!Number.isInteger(n) || n < min) throw new Error(`count must be an integer >= ${min}, got ${n}`);
}

/** P(at least one of n independent attempts succeeds) = 1-(1-p)^n, computed stably. */
export function coverage(p: number, n: number): number {
  probability(p);
  count(n);
  if (n === 0 || p === 0) return 0;
  if (p === 1) return 1;
  return -Math.expm1(n * Math.log1p(-p));
}

/**
 * Smallest n with coverage(p, n) >= q: ceil(log(1-q)/log(1-p)). Returns Infinity when
 * the target is unreachable (p = 0, or q = 1 with p < 1) or exceeds `cap`.
 */
export function attemptsForTarget(p: number, q: number, cap = Number.POSITIVE_INFINITY): number {
  probability(p);
  probability(q, "target");
  if (q === 0) return 0;
  if (p === 1) return 1;
  if (p === 0 || q === 1) return Number.POSITIVE_INFINITY;
  let n = Math.max(1, Math.ceil(Math.log1p(-q) / Math.log1p(-p)));
  // Correct floating-point error at the boundary.
  while (n > 1 && coverage(p, n - 1) >= q) n--;
  while (coverage(p, n) < q) n++;
  return n <= cap ? n : Number.POSITIVE_INFINITY;
}

/** Final success when a selector picks a correct candidate with conditional accuracy `selection`. */
export function deliveredSuccess(p: number, n: number, selection: number): number {
  probability(selection, "selection accuracy");
  return coverage(p, n) * selection;
}

/**
 * Probability that a strict majority of n independent binary attempts is correct.
 * Below p = .5, voting makes things worse: at p = .3 thirteen votes are right ~6% of the time.
 */
export function majorityCorrect(p: number, n: number): number {
  probability(p);
  count(n, 1);
  if (p === 0) return 0;
  if (p === 1) return 1;
  const need = Math.floor(n / 2) + 1;
  const logP = Math.log(p);
  const logQ = Math.log1p(-p);
  let logChoose = 0; // log C(n, k), built up from k = 0
  let total = 0;
  for (let k = 0; k <= n; k++) {
    if (k > 0) logChoose += Math.log((n - k + 1) / k);
    if (k >= need) total += Math.exp(logChoose + k * logP + (n - k) * logQ);
  }
  return Math.min(1, total);
}

/**
 * Precision of accepted answers for a verifier with sensitivity t and false-positive
 * rate f on a population where a fraction p of candidates is correct:
 * p*t / (p*t + (1-p)*f). Undefined when nothing would ever be accepted.
 */
export function acceptedPrecision(p: number, sensitivity: number, falsePositiveRate: number): number | undefined {
  probability(p);
  probability(sensitivity, "sensitivity");
  probability(falsePositiveRate, "false positive rate");
  const accepted = p * sensitivity + (1 - p) * falsePositiveRate;
  return accepted === 0 ? undefined : (p * sensitivity) / accepted;
}

/**
 * Coverage over a mixture of task classes with different per-attempt success rates.
 * Shows why an average rate cannot be plugged into the independence formula.
 */
export function mixtureCoverage(classes: readonly { weight: number; p: number }[], n: number): number {
  let sum = 0;
  for (const c of classes) {
    if (!(c.weight >= 0)) throw new Error(`weight must be non-negative, got ${c.weight}`);
    sum += c.weight;
  }
  if (Math.abs(sum - 1) > 1e-9) throw new Error(`weights must sum to 1, got ${sum}`);
  return classes.reduce((acc, c) => acc + c.weight * coverage(c.p, n), 0);
}

/** Wilson score interval for a binomial proportion (default 95%). */
export function wilsonInterval(successes: number, trials: number, z = 1.959963984540054): [number, number] {
  count(trials);
  count(successes);
  if (successes > trials) throw new Error(`count of successes ${successes} exceeds trials ${trials}`);
  if (trials === 0) return [0, 1];
  const phat = successes / trials;
  const z2n = (z * z) / trials;
  const center = (phat + z2n / 2) / (1 + z2n);
  const margin = (z * Math.sqrt((phat * (1 - phat)) / trials + (z * z) / (4 * trials * trials))) / (1 + z2n);
  return [successes === 0 ? 0 : Math.max(0, center - margin), successes === trials ? 1 : Math.min(1, center + margin)];
}
