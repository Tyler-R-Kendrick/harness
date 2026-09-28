import { z } from "zod";
import { laplace } from "./random.ts";
import type { Uniform } from "./random.ts";

export const HoldoutSettingsSchema = z.strictObject({
  /** How far the evolve set's answer may be from the holdout's before it is called overfitting. */
  threshold: z.number().positive(),
  /** Scale of the Laplace noise that keeps the holdout's answers from leaking it. */
  sigma: z.number().min(0),
  /** Overfitting detections the holdout can answer before it is spent. */
  budget: z.int().positive(),
});
export type HoldoutSettings = z.output<typeof HoldoutSettingsSchema>;

export const HoldoutStateSchema = z.strictObject({
  budget: z.int().min(0),
  /** The noisy threshold T + gamma in force. */
  threshold: z.number(),
  queries: z.int().min(0),
  overfits: z.int().min(0),
});
export type HoldoutState = z.output<typeof HoldoutStateSchema>;

export type HoldoutAnswer = { readonly kind: "answer"; readonly answer: number; readonly overfit: boolean; readonly state: HoldoutState } | { readonly kind: "exhausted"; readonly state: HoldoutState };

/** A fresh holdout: its full budget and a noisy threshold. */
export function startHoldout(settings: HoldoutSettings, u: Uniform): HoldoutState {
  return { budget: settings.budget, threshold: settings.threshold + laplace(u, 2 * settings.sigma), queries: 0, overfits: 0 };
}

/**
 * Thresholdout (Dwork, Feldman, Hardt, Pitassi, Reingold and Roth, "The reusable holdout",
 * Science 2015: the paper the RRSI paper cites for adaptivity and then does not use). A
 * query's value on the evolve set is answered as it is while the holdout agrees with it
 * to within a noisy threshold; when they disagree (the evolve set was overfit) the answer
 * is the holdout's value with Laplace noise, and one unit of budget is spent. The noise
 * is what lets one holdout answer many adaptively chosen queries without being learned;
 * once the budget is spent, nothing more is answered, because nothing more would be valid.
 */
export function thresholdout(state: HoldoutState, settings: HoldoutSettings, value: { readonly evolve: number; readonly holdout: number }, u: Uniform): HoldoutAnswer {
  if (state.budget < 1) return { kind: "exhausted", state };
  const queries = state.queries + 1;
  if (Math.abs(value.holdout - value.evolve) > state.threshold + laplace(u, 4 * settings.sigma)) {
    const answer = value.holdout + laplace(u, settings.sigma);
    return { kind: "answer", answer, overfit: true, state: { budget: state.budget - 1, threshold: settings.threshold + laplace(u, 2 * settings.sigma), queries, overfits: state.overfits + 1 } };
  }
  return { kind: "answer", answer: value.evolve, overfit: false, state: { ...state, queries } };
}
