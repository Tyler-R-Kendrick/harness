import { z } from "zod";

/**
 * A budgeted holdout: tasks the proposer never sees, used only to CONFIRM a winner before
 * it becomes the incumbent. The design is the description-length argument of Dwork,
 * Feldman, Hardt, Pitassi, Reingold and Roth ("The reusable holdout", Science 2015; and
 * "Generalization in adaptive data analysis and holdout reuse", NIPS 2015), used in its
 * plainest form instead of Thresholdout's noise (which needs a holdout large against the
 * noise it adds and, at the sizes a harness run has, drowns in it: the noise scale was below
 * one task's influence, the evolve-side value it compared against was the selected
 * winner's own biased gain, and a pure-overfit candidate passed 55 to 60% of the time).
 *
 * A query is one confirmation test: the winner and the incumbent are measured afresh on
 * the holdout in the same window and compared by the same paired randomization test as on
 * the evolve set (compare.ts), at level beta. What the analyst (the proposer, and the
 * operator's own choices) learns from a query is one bit: confirmed or not (records keep
 * the holdout's numbers for the operator, but the proposer's history carries only the
 * outcome). So after B queries the whole transcript takes at most 2^B values, and the
 * hypotheses the analyst could have asked, being a function of the earlier answers (and of
 * what never touches the holdout: the evolve data, the analyst's own randomness), lie in
 * a binary tree of depth B with 1 + 2 + ... + 2^(B-1) = 2^B - 1 nodes. Testing each at
 * level beta = alpha / (2^B - 1) and taking the union bound gives
 *
 *   P(any queried hypothesis that is false is confirmed) <= alpha,
 *
 * whichever hypotheses the analyst chooses and however adaptively. That is the whole
 * guarantee, and it is why the holdout has a budget: the (B+1)-th query would lie outside
 * the tree, so a spent holdout confirms nothing. Every query counts, whether it confirms
 * or not (a rejection is also a bit).
 *
 * What a confirmation is worth is bounded by the holdout's own size: at level beta a
 * holdout needs at least `minimumGroups(beta)` groups of tasks for anything to be
 * confirmable at all (checked when the run starts), and the power of a query is that of an
 * ordinary test at that level.
 */
export const HoldoutSettingsSchema = z.strictObject({
  /** The probability, over the whole run, of confirming any change the holdout's test says is not a gain (or not non-inferior). */
  alpha: z.number().gt(0).lt(1),
  /** Queries the holdout answers before it is spent: one per winner put to it, confirmed or not. */
  budget: z.int().positive(),
});
export type HoldoutSettings = z.output<typeof HoldoutSettingsSchema>;

export const HoldoutStateSchema = z.strictObject({
  /** Queries made so far. */
  queries: z.int().min(0),
});
export type HoldoutState = z.output<typeof HoldoutStateSchema>;

/** The error level of each query: alpha / (2^budget - 1), the union over the queries an adaptive analyst can reach (see above). */
export function holdoutLevel(settings: HoldoutSettings): number {
  return settings.alpha / (2 ** settings.budget - 1);
}

/** Queries left. */
export function holdoutRemaining(state: HoldoutState, settings: HoldoutSettings): number {
  return Math.max(0, settings.budget - state.queries);
}
