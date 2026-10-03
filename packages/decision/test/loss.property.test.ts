import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { ABSTAIN, actThreshold, bayesAction, binaryLossMatrix, binaryThreshold, expectedLoss } from "../src/loss.ts";
import type { LossMatrix } from "../src/loss.ts";
import { booleanDistribution, distributionFromWeights } from "../src/distribution.ts";
import { cost } from "../src/types.ts";

const price = fc.double({ min: 0, max: 100, noNaN: true }).map((c) => cost(c));
const positive = fc.double({ min: 0.01, max: 100, noNaN: true }).map((c) => cost(c));

/** A loss matrix of 1 to 4 actions over the truths o0..o(k-1), and a distribution over them. */
const problem = fc.integer({ min: 2, max: 4 }).chain((k) =>
  fc.tuple(
    fc.array(fc.array(price, { minLength: k, maxLength: k }), { minLength: 1, maxLength: 4 }),
    fc.array(fc.double({ min: 0, max: 10, noNaN: true }), { minLength: k, maxLength: k }).filter((w) => w.some((x) => x > 0)),
  ),
).map(([rows, weights]) => ({
  loss: Object.fromEntries(rows.map((row, a) => [`a${a}`, Object.fromEntries(row.map((c, t) => [`o${t}`, c]))])) as LossMatrix,
  d: distributionFromWeights(Object.fromEntries(weights.map((w, t) => [`o${t}`, w]))),
}));

describe("loss properties", () => {
  test.prop([problem, fc.option(price, { nil: undefined })])("LOS2.1 bayesAction never picks an action with a strictly higher expected loss than another", ({ loss, d }, abstain) => {
    const out = bayesAction(d, loss, abstain === undefined ? {} : { abstain });
    const losses = [...Object.keys(loss).map((a) => expectedLoss(a, d, loss)), ...(abstain === undefined ? [] : [abstain])];
    expect(out.expectedLoss).toBe(Math.min(...losses));
    if (out.action === ABSTAIN) expect(out.expectedLoss).toBe(abstain);
    else expect(out.expectedLoss).toBe(expectedLoss(out.action, d, loss));
  });

  test.prop([problem])("LOS2.2 with several equally good actions the first in key order wins", ({ loss, d }) => {
    const out = bayesAction(d, loss);
    const first = Object.keys(loss).find((a) => expectedLoss(a, d, loss) === out.expectedLoss);
    expect(out.action).toBe(first);
  });

  test.prop([problem, fc.double({ min: 0.01, max: 50, noNaN: true })])("LOS2.3 scaling every cost by a positive factor does not change the decision", ({ loss, d }, k) => {
    const scaled = Object.fromEntries(Object.entries(loss).map(([a, row]) => [a, Object.fromEntries(Object.entries(row).map(([t, c]) => [t, cost(c * k)]))])) as LossMatrix;
    const gaps = Object.keys(loss).map((a) => expectedLoss(a, d, loss)).sort((x, y) => x - y);
    fc.pre(gaps.length < 2 || gaps[1]! - gaps[0]! > 1e-6 * (1 + gaps[1]!));
    expect(bayesAction(d, scaled).action).toBe(bayesAction(d, loss).action);
  });

  test.prop([problem, price])("LOS2.4 abstaining is taken exactly when it costs less than every action", ({ loss, d }, abstain) => {
    const best = bayesAction(d, loss).expectedLoss;
    const out = bayesAction(d, loss, { abstain });
    expect(out.action === ABSTAIN).toBe(abstain < best);
  });

  test.prop([positive, positive])("LOS2.5 the binary threshold is a probability that rises with the false-positive cost and falls with the false-negative cost", (fp, fn) => {
    const t = binaryThreshold({ costFalsePositive: fp, costFalseNegative: fn });
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThanOrEqual(1);
    expect(binaryThreshold({ costFalsePositive: cost(fp * 2), costFalseNegative: fn })).toBeGreaterThan(t);
    expect(binaryThreshold({ costFalsePositive: fp, costFalseNegative: cost(fn * 2) })).toBeLessThan(t);
    expect(actThreshold({ benefit: fn, harm: fp })).toBe(t);
  });

  test.prop([positive, positive, fc.double({ min: 0, max: 1, noNaN: true })])("LOS2.6 the Bayes action of the binary matrix acts exactly above the threshold", (fp, fn, p) => {
    const t = binaryThreshold({ costFalsePositive: fp, costFalseNegative: fn });
    fc.pre(Math.abs(p - t) > 1e-9);
    const action = bayesAction(booleanDistribution(p), binaryLossMatrix({ costFalsePositive: fp, costFalseNegative: fn })).action;
    expect(action).toBe(p > t ? "act" : "skip");
  });

  test.prop([positive, positive, positive])("LOS2.7 a higher false-negative cost never makes acting less likely: the set of probabilities that act only grows", (fp, fn, extra) => {
    const lower = binaryThreshold({ costFalsePositive: fp, costFalseNegative: cost(fn + extra) });
    const higher = binaryThreshold({ costFalsePositive: fp, costFalseNegative: fn });
    expect(lower).toBeLessThanOrEqual(higher);
  });
});
