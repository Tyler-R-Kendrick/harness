import { ClimbRoundSchema, measureSplit } from "@harness/ir";
import type { ClimbRound, Spec, Split, SplitRates, Trial } from "@harness/ir";

export function freezeSplit(ids: readonly string[], train: readonly string[]): Split {
  const seen = new Set<string>();
  for (const id of train) {
    if (!ids.includes(id)) throw new Error(`unknown split id ${id}`);
    if (seen.has(id)) throw new Error(`duplicate split id ${id}`);
    seen.add(id);
  }
  return { train: [...train], test: ids.filter((id) => !seen.has(id)) };
}

const blocked: SplitRates = { pass: false, impermissible: 0, overrefusal: 0, passAtK: 0 };

/**
 * Accept only when the frozen train split and the frozen test split both pass
 * and nothing over-refused. Over-refusal is its own gate: a capability spec
 * has rate 0, so that gate is vacuous there.
 */
export function climbRound(input: { spec: Spec; patchId: string; frozen: Split; trials: readonly Trial[] }): ClimbRound {
  if (input.patchId.length === 0) throw new Error("patchId is empty");
  const train = new Set(input.frozen.train);
  const test = new Set(input.frozen.test);
  let reason: string | undefined;
  for (const trial of input.trials) {
    if (!train.has(trial.caseId) && !test.has(trial.caseId)) {
      reason = "trial case outside the frozen split";
      break;
    }
  }
  if (reason === undefined) {
    for (const trial of input.trials) {
      const expected = train.has(trial.caseId) ? "train" : "test";
      if (trial.split !== expected) {
        reason = "trial split does not match the frozen split";
        break;
      }
    }
  }
  if (reason === undefined) {
    for (const id of [...input.frozen.train, ...input.frozen.test]) {
      if (!input.trials.some((trial) => trial.caseId === id)) {
        reason = "frozen case has no trial";
        break;
      }
    }
  }
  const trainRates = reason === undefined ? measureSplit(input.spec, input.trials, "train", input.frozen) : blocked;
  const testRates = reason === undefined ? measureSplit(input.spec, input.trials, "test", input.frozen) : blocked;
  if (reason === undefined && !trainRates.pass) reason = "train failed";
  if (reason === undefined && !testRates.pass) reason = "test failed";
  if (reason === undefined && (trainRates.overrefusal > 0 || testRates.overrefusal > 0)) reason = "over-refusal";
  const round = {
    specId: input.spec.id,
    patchId: input.patchId,
    frozen: input.frozen,
    accepted: reason === undefined,
    train: trainRates,
    test: testRates,
    ...(reason === undefined ? {} : { reason }),
  };
  return ClimbRoundSchema.parse(round);
}
