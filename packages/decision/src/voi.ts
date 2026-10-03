/**
 * The value of asking a person: whether an answer is worth the interruption. Acting now
 * costs the chance of being wrong times what wrong costs; asking costs the interruption
 * plus whatever the person's own mistakes cost. Ask when asking is cheaper.
 */
import { probability } from "@harness/cognitive";
import type { Probability } from "@harness/cognitive";
import type { Cost } from "./types.ts";

export interface AskCase {
  /** The probability that the action taken without asking is right (calibrated). */
  readonly pRight: Probability;
  /** What a wrong action costs. */
  readonly costWrong: Cost;
  /** What the interruption costs (attention, latency), in the same unit. */
  readonly costAsk: Cost;
  /** The probability that the person's answer is wrong; 0 when omitted. */
  readonly humanError?: Probability;
}

export type AskThresholdCase = Omit<AskCase, "pRight">;

/** Expected loss of acting now minus expected loss of asking: positive when asking pays. */
export function valueOfAsking({ pRight, costWrong, costAsk, humanError = probability(0) }: AskCase): number {
  return (1 - pRight) * costWrong - (costAsk + humanError * costWrong);
}

/** Whether asking pays (the value is above zero; at zero the interruption buys nothing). */
export const shouldAsk = (c: AskCase): boolean => valueOfAsking(c) > 0;

/**
 * The probability of being right below which asking pays: 1 - humanError - costAsk / costWrong,
 * kept within 0 and 1. It is 0 when asking can never pay (a wrong action costs nothing, or
 * asking costs at least as much as being wrong always would).
 */
export function askThreshold({ costWrong, costAsk, humanError = probability(0) }: AskThresholdCase): Probability {
  if (costWrong === 0) return probability(0);
  return probability(Math.min(1, Math.max(0, 1 - humanError - costAsk / costWrong)));
}
