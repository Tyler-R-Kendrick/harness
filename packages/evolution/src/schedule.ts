import { z } from "zod";

/**
 * The annealed edit budget of Eq. (4): b_t = ceil(b_min + (b_max - b_min) (1 + cos(pi t / T)) / 2).
 * Early rounds may bundle several coordinated edits; late rounds make single attributable
 * ones. Rounds past T keep b_min; a run of no rounds keeps b_max.
 */
export function editBudget(t: number, T: number, bMin: number, bMax: number): number {
  if (T <= 0) return bMax;
  const at = Math.max(0, Math.min(t, T));
  const v = bMin + (bMax - bMin) * 0.5 * (1 + Math.cos((Math.PI * at) / T));
  // Rounded first, so 1.0000000002 at t = T does not become 2.
  return Math.ceil(Math.round(v * 1e9) / 1e9);
}

/**
 * The error level of one acceptance test when a run of `rounds` rounds makes `perRound`
 * tests a round and may accept a wrong change with probability at most `alpha` in all.
 * The union bound holds under any dependence between the tests, which an adaptive search
 * certainly has; the price is power, which is why a run that wants to accept small
 * gains needs more tasks, not a looser rule.
 */
export function testLevel(alpha: number, rounds: number, perRound: number): number {
  if (!(rounds >= 1)) throw new RangeError(`a run needs rounds, not ${rounds}`);
  if (!(perRound >= 1)) throw new RangeError(`a round makes tests, not ${perRound}`);
  return alpha / (rounds * perRound);
}

/**
 * How a run's error budget alpha is spent across its rounds. `uniform` gives every round
 * the same share; `geometric` gives round t the share ratio^t / sum_s ratio^s, so early
 * rounds (where the annealed edit budget lets the proposer make its large, coordinated
 * moves, and where a real gain found early keeps paying for every later round) are
 * tested at a looser level than late ones.
 */
export const SpendingSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("uniform") }), z.strictObject({ kind: z.literal("geometric"), ratio: z.number().gt(0).lt(1) })]);
export type Spending = z.output<typeof SpendingSchema>;

/**
 * The error level of each acceptance test of round `round` (0-based) in a run of `rounds`
 * rounds that makes `perRound` tests a round, when the run may accept a wrong change with
 * probability at most `alpha` in all. Round t is given the total level
 * alpha w_t / sum_s w_s (w_t = 1 for `uniform`, ratio^t for `geometric`), split equally
 * among its tests.
 *
 * Why this is valid: the schedule is a function of (round, rounds, perRound) alone, fixed
 * before the run and never touched by data, and the levels of all the run's tests add up
 * to alpha exactly. The union bound then gives P(any false acceptance) <= sum of the
 * levels = alpha under any dependence between tests, adaptive choice of candidates
 * included (each test is valid conditionally on what came before it, since its level was
 * fixed in advance).
 *
 * Why this is deliberately not alpha-investing (Foster and Stine 2008): alpha-investing
 * lets the level of a test depend on the outcomes of earlier ones, reinvesting wealth
 * after each rejection, which is what makes it powerful for streams of many hypotheses,
 * but what it controls is the marginal false discovery rate (mFDR), not the probability of
 * any false discovery. A run here that accepts one change wrongly has changed the
 * harness for good (every later round builds on it), so what is promised is the
 * family-wise rate, and the price of that promise is a level fixed in advance.
 */
export function roundLevel(alpha: number, round: number, rounds: number, perRound: number, spending: Spending = { kind: "uniform" }): number {
  if (!(rounds >= 1)) throw new RangeError(`a run needs rounds, not ${rounds}`);
  if (!(perRound >= 1)) throw new RangeError(`a round makes tests, not ${perRound}`);
  if (!Number.isInteger(round) || round < 0 || round >= rounds) throw new RangeError(`round ${round} is outside a run of ${rounds} rounds`);
  if (spending.kind === "uniform") return testLevel(alpha, rounds, perRound);
  let total = 0;
  for (let s = 0; s < rounds; s++) total += spending.ratio ** s;
  return (alpha * (spending.ratio ** round / total)) / perRound;
}

/**
 * The fewest groups of tasks an evolve set can have for a test at `level` to be able to
 * certify anything. The acceptance test flips the signs of whole groups' differences, so
 * with G groups its smallest possible p-value is 2^-G (every group flipped the way the
 * data lean): a level at or below that can never be met, however large the gain. This is
 * the least G with 2^-G < level.
 */
export function minimumGroups(level: number): number {
  if (!(level > 0 && level < 1)) throw new RangeError(`a level is in (0, 1), not ${level}`);
  return Math.floor(Math.log2(1 / level)) + 1;
}
