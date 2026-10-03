import { describe, expect, it } from "vitest";
import { ABSTAIN, actThreshold, bayesAction, binaryLossMatrix, binaryThreshold, expectedLoss } from "../src/loss.ts";
import type { LossMatrix } from "../src/loss.ts";
import { booleanDistribution, distributionFromWeights } from "../src/distribution.ts";
import { cost } from "../src/types.ts";

const loss = (rows: Record<string, Record<string, number>>): LossMatrix => Object.fromEntries(Object.entries(rows).map(([action, row]) => [action, Object.fromEntries(Object.entries(row).map(([truth, c]) => [truth, cost(c)]))]));
const dist = (weights: Record<string, number>) => distributionFromWeights(weights);
const matrix = loss({ act: { true: 0, false: 5 }, skip: { true: 10, false: 0 } });

describe("expected loss", () => {
  it("LOS1.1 the expected loss of an action is the sum over truths of probability times loss", () => {
    const d = booleanDistribution(0.3);
    expect(expectedLoss("act", d, matrix)).toBeCloseTo(0.7 * 5, 12);
    expect(expectedLoss("skip", d, matrix)).toBeCloseTo(0.3 * 10, 12);
    expect(expectedLoss("act", dist({ a: 1, b: 1, c: 2 }), loss({ act: { a: 4, b: 8, c: 0 } }))).toBeCloseTo(3, 12);
  });

  it("LOS1.2 an action or a truth the matrix does not give is refused, naming it", () => {
    const d = booleanDistribution(0.3);
    expect(() => expectedLoss("nap", d, matrix)).toThrow(RangeError);
    expect(() => expectedLoss("nap", d, matrix)).toThrow(/no action "nap"/);
    expect(() => expectedLoss("constructor", d, matrix)).toThrow(/no action "constructor"/);
    expect(() => expectedLoss("act", dist({ true: 1, false: 1, maybe: 1 }), matrix)).toThrow(/action "act" is not given for the truth "maybe"/);
    expect(() => expectedLoss("act", dist({ true: 1, false: 1, toString: 1 }), matrix)).toThrow(/truth "toString"/);
  });
});

describe("bayesAction", () => {
  it("LOS1.3 the action with the lowest expected loss is chosen, with its expected loss", () => {
    expect(bayesAction(booleanDistribution(0.3), matrix)).toEqual({ action: "skip", expectedLoss: expect.closeTo(3, 12) });
    expect(bayesAction(booleanDistribution(0.4), matrix)).toEqual({ action: "act", expectedLoss: expect.closeTo(3, 12) });
    expect(bayesAction(booleanDistribution(0.4), matrix).action).toBe("act");
  });

  it("LOS1.4 among equal expected losses the first action in key order is chosen", () => {
    const tied = loss({ first: { true: 1, false: 1 }, second: { true: 1, false: 1 } });
    expect(bayesAction(booleanDistribution(0.5), tied).action).toBe("first");
    expect(bayesAction(booleanDistribution(0.5), loss({ z: { true: 1, false: 1 }, a: { true: 1, false: 1 } })).action).toBe("z");
  });

  it("LOS1.5 abstaining is an extra action at a fixed cost, taken only when strictly cheaper than every action", () => {
    const d = booleanDistribution(0.3);
    expect(bayesAction(d, matrix, { abstain: cost(3.2) }).action).toBe("skip");
    expect(bayesAction(d, matrix, { abstain: cost(3) }).action).toBe("skip");
    expect(bayesAction(d, matrix, { abstain: cost(2.5) })).toEqual({ action: ABSTAIN, expectedLoss: 2.5 });
    expect(bayesAction(d, matrix).action).toBe("skip");
    expect(ABSTAIN).toBe("abstain");
  });

  it("LOS1.6 abstaining alone is possible, and an action called abstain is refused when abstaining is on offer", () => {
    expect(bayesAction(booleanDistribution(0.5), {}, { abstain: cost(1) })).toEqual({ action: "abstain", expectedLoss: 1 });
    expect(() => bayesAction(booleanDistribution(0.5), {})).toThrow(/at least one action/);
    const clash = loss({ abstain: { true: 0, false: 0 }, act: { true: 0, false: 1 } });
    expect(() => bayesAction(booleanDistribution(0.5), clash, { abstain: cost(1) })).toThrow(/already has an action called "abstain"/);
    expect(bayesAction(booleanDistribution(0.5), clash).action).toBe("abstain");
  });
});

describe("thresholds", () => {
  it("LOS1.7 the probability above which acting beats not acting is the false-positive cost over both costs", () => {
    expect(binaryThreshold({ costFalsePositive: cost(1), costFalseNegative: cost(4) })).toBeCloseTo(0.2, 12);
    expect(binaryThreshold({ costFalsePositive: cost(3), costFalseNegative: cost(3) })).toBe(0.5);
    expect(binaryThreshold({ costFalsePositive: cost(0), costFalseNegative: cost(3) })).toBe(0);
    expect(binaryThreshold({ costFalsePositive: cost(3), costFalseNegative: cost(0) })).toBe(1);
    expect(() => binaryThreshold({ costFalsePositive: cost(0), costFalseNegative: cost(0) })).toThrow(/both costs are zero/);
  });

  it("LOS1.8 acting on a benefit against a harm needs the harm's share of the two to be beaten", () => {
    expect(actThreshold({ benefit: cost(9), harm: cost(1) })).toBeCloseTo(0.1, 12);
    expect(actThreshold({ benefit: cost(1), harm: cost(1) })).toBe(0.5);
    expect(() => actThreshold({ benefit: cost(0), harm: cost(0) })).toThrow(/both costs are zero/);
  });

  it("LOS1.9 the binary loss matrix agrees with the threshold: acting only strictly above it", () => {
    const m = binaryLossMatrix({ costFalsePositive: cost(1), costFalseNegative: cost(4) });
    expect(Object.keys(m)).toEqual(["skip", "act"]);
    expect(m).toEqual({ skip: { true: 4, false: 0 }, act: { true: 0, false: 1 } });
    expect(bayesAction(booleanDistribution(0.19), m).action).toBe("skip");
    expect(bayesAction(booleanDistribution(0.21), m).action).toBe("act");
    expect(bayesAction(booleanDistribution(0.2), m).action).toBe("skip");
  });
});
