import type { Entropy } from "@harness/core";
import { z } from "zod";
import { Uniform } from "./random.ts";

/**
 * Futility early stopping of a candidate's evaluation (calibrated rule only): evaluate it
 * first on a prefix of a random permutation of the evolve tasks, and stop when it is
 * clearly worse than the incumbent measured on the same tasks.
 *
 * Validity, by construction. The acceptance decision is untouched: a candidate is
 * accepted only through the same full-sample test, at the same level (the round's share
 * of alpha, see `roundLevel`), on the same full measurement it would have had without
 * staging. Staging decides only whether that measurement is completed. So
 *   accepted = (not stopped) and (the full-sample test admits it)
 * is a subset of the unstaged acceptance event, and P(false acceptance) can only fall:
 * futility stopping removes acceptances, never adds them. That holds whatever the
 * prefix, the stopping level or the dependence between the stages, so the run-wide
 * bound alpha needs no adjustment and `futility.alpha` is a tuning knob for power, not an
 * error budget.
 *
 * What it costs is power, and how much is bounded. A candidate whose true gain is at
 * least -margin is stopped only if the prefix's one-sided upper confidence bound (at
 * level `futility.alpha`) falls below -margin, which for a bound of that coverage
 * happens with probability at most about `futility.alpha`; a gain, a saving or a removal
 * within the non-inferiority margin therefore survives staging with probability at least
 * about 1 - `futility.alpha` (for the prefix's own estimand; see the Monte Carlo of
 * RS14.60-RS14.62 for what was measured). A candidate that is clearly worse than the
 * margin can be neither a supported gain nor a non-inferior saving or removal, so
 * stopping it forgoes nothing but a measurement nobody needed.
 *
 * Ablations (a mechanism's removal) are not staged, and the paper's rule ignores this
 * setting.
 */
export const FutilitySchema = z.strictObject({
  /** The share of the evolve tasks in the first stage, in (0, 1): ceil(fraction n) tasks, at least one. */
  fraction: z.number().gt(0).lt(1),
  /** The one-sided level of the prefix's upper bound, in (0, 0.5): the smaller, the fewer candidates are stopped. */
  alpha: z.number().gt(0).lt(0.5),
});
export type Futility = z.output<typeof FutilitySchema>;

/**
 * The size of the first stage over `n` tasks: ceil(fraction n), between 1 and n. The
 * product is rounded to nine places first so that 0.28 * 25, which floating point makes
 * 7.000000000000001, is 7 tasks and not 8.
 */
export function prefixSize(fraction: number, n: number): number {
  if (!(n >= 1)) throw new RangeError(`a stage needs tasks, not ${n}`);
  return Math.min(n, Math.max(1, Math.ceil(Math.round(fraction * n * 1e9) / 1e9)));
}

/** A uniformly random permutation of `items` (Fisher-Yates), from the entropy port: reproducible from a seed. The input is left alone. */
export function permute<T>(items: readonly T[], entropy: Entropy): T[] {
  const u = new Uniform(entropy);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = u.index(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Stop when the prefix's upper confidence bound on the gain is strictly below -margin:
 * the candidate is clearly worse than the non-inferiority margin allows. A bound exactly
 * at -margin does not stop it; the widest possible bound (too few groups to say anything,
 * +1) never does.
 */
export const isFutile = (upper: number, margin: number): boolean => upper < -margin;
