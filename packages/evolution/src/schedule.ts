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
