import { probability } from "@harness/cognitive";
import type { Probability } from "@harness/cognitive";
import { cost } from "./types.ts";
import type { Cost, Distribution } from "./types.ts";

/** What being wrong costs: the loss of taking each action, by the truth it turns out to be. */
export type LossMatrix = Readonly<Record<string, Readonly<Record<string, Cost>>>>;

/** The name of the extra action of declining to decide. */
export const ABSTAIN = "abstain";

/** The expected loss of an action: the sum over truths of probability times loss. */
export function expectedLoss(action: string, d: Distribution, loss: LossMatrix): number {
  if (!Object.hasOwn(loss, action)) throw new RangeError(`the loss matrix has no action "${action}"`);
  const row = loss[action]!;
  let total = 0;
  for (const [truth, p] of Object.entries(d)) {
    if (!Object.hasOwn(row, truth)) throw new RangeError(`the loss of action "${action}" is not given for the truth "${truth}"`);
    total += p * row[truth]!;
  }
  return total;
}

export interface BayesDecision {
  /** The chosen action, or `ABSTAIN`. */
  readonly action: string;
  readonly expectedLoss: number;
}

/**
 * The action that minimizes expected loss, with abstaining as one more action at a fixed
 * cost. Ties go to the first action in the matrix's key order, and abstaining only when it
 * is strictly cheaper than every action.
 */
export function bayesAction(d: Distribution, loss: LossMatrix, options: { readonly abstain?: Cost } = {}): BayesDecision {
  const { abstain } = options;
  if (abstain !== undefined && Object.hasOwn(loss, ABSTAIN)) throw new RangeError(`the loss matrix already has an action called "${ABSTAIN}"`);
  let best: BayesDecision | undefined;
  for (const action of Object.keys(loss)) {
    const candidate = expectedLoss(action, d, loss);
    if (best === undefined || candidate < best.expectedLoss) best = { action, expectedLoss: candidate };
  }
  if (abstain !== undefined && (best === undefined || abstain < best.expectedLoss)) best = { action: ABSTAIN, expectedLoss: abstain };
  if (best === undefined) throw new RangeError("deciding needs at least one action (or abstaining)");
  return best;
}

export interface BinaryCosts {
  /** Acting when the truth is no (a false alarm). */
  readonly costFalsePositive: Cost;
  /** Not acting when the truth is yes (a miss). */
  readonly costFalseNegative: Cost;
}

/**
 * The probability of yes above which acting has the lower expected loss than not acting:
 * costFalsePositive / (costFalsePositive + costFalseNegative). Acting is free of false
 * alarms at 0, and never worth it at 1.
 */
export function binaryThreshold({ costFalsePositive, costFalseNegative }: BinaryCosts): Probability {
  const total = costFalsePositive + costFalseNegative;
  if (total === 0) throw new RangeError("there is no threshold when both costs are zero");
  return probability(costFalsePositive / total);
}

/** The probability of being right above which to act, when acting right gains `benefit` and acting wrong costs `harm`. */
export const actThreshold = ({ benefit, harm }: { readonly benefit: Cost; readonly harm: Cost }): Probability => binaryThreshold({ costFalsePositive: harm, costFalseNegative: benefit });

/**
 * The loss matrix of a yes/no decision (truths `true` and `false`), with `skip` before `act`
 * so that a tie is not acted on: `bayesAction` then acts exactly above `binaryThreshold`.
 */
export const binaryLossMatrix = ({ costFalsePositive, costFalseNegative }: BinaryCosts): LossMatrix => ({
  skip: { true: costFalseNegative, false: cost(0) },
  act: { true: cost(0), false: costFalsePositive },
});
