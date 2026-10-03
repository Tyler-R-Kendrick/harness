import { describe, expect, it } from "vitest";
import { probability } from "@harness/cognitive";
import { askThreshold, shouldAsk, valueOfAsking } from "../src/voi.ts";
import { cost } from "../src/types.ts";

const c = (pRight: number, costWrong: number, costAsk: number, humanError?: number) => ({
  pRight: probability(pRight),
  costWrong: cost(costWrong),
  costAsk: cost(costAsk),
  ...(humanError === undefined ? {} : { humanError: probability(humanError) }),
});

describe("value of asking", () => {
  it("VOI1.1 the value is the expected loss of acting now minus the expected loss of asking", () => {
    expect(valueOfAsking(c(0.6, 10, 1))).toBeCloseTo(0.4 * 10 - 1);
  });

  it("VOI1.2 a person who errs makes asking worth less by the share of the wrong cost they add", () => {
    expect(valueOfAsking(c(0.6, 10, 1, 0.1))).toBeCloseTo(0.4 * 10 - (1 + 0.1 * 10));
  });

  it("VOI1.3 the human's error defaults to none", () => {
    expect(valueOfAsking(c(0.6, 10, 1))).toBe(valueOfAsking(c(0.6, 10, 1, 0)));
  });

  it("VOI1.4 asking is worth it only when the value is above zero", () => {
    expect(shouldAsk(c(0.5, 10, 1))).toBe(true);
    expect(shouldAsk(c(0.95, 10, 1))).toBe(false);
    expect(shouldAsk(c(0.75, 8, 2))).toBe(false); // value is exactly 0: no gain, so do not interrupt
  });

  it("VOI1.5 the threshold is the probability below which asking pays", () => {
    expect(askThreshold({ costWrong: cost(10), costAsk: cost(1) })).toBeCloseTo(0.9);
    expect(askThreshold({ costWrong: cost(10), costAsk: cost(1), humanError: probability(0.05) })).toBeCloseTo(0.85);
  });

  it("VOI1.6 the threshold is 0 when asking can never pay: a wrong answer costs nothing, or the ask costs more than being wrong", () => {
    expect(askThreshold({ costWrong: cost(0), costAsk: cost(1) })).toBe(0);
    expect(askThreshold({ costWrong: cost(0), costAsk: cost(0) })).toBe(0);
    expect(askThreshold({ costWrong: cost(1), costAsk: cost(5) })).toBe(0);
    expect(askThreshold({ costWrong: cost(10), costAsk: cost(1), humanError: probability(0.95) })).toBe(0);
  });

  it("VOI1.7 a free question to an infallible person is asked unless the action is certainly right", () => {
    expect(askThreshold({ costWrong: cost(10), costAsk: cost(0) })).toBe(1);
    expect(shouldAsk(c(0.999, 10, 0))).toBe(true);
    expect(shouldAsk(c(1, 10, 0))).toBe(false);
  });

  it("VOI1.8 the threshold agrees with shouldAsk away from the boundary", () => {
    const args = { costWrong: cost(8), costAsk: cost(2), humanError: probability(0.1) };
    const t = askThreshold(args);
    expect(shouldAsk({ ...args, pRight: probability(t - 0.01) })).toBe(true);
    expect(shouldAsk({ ...args, pRight: probability(t + 0.01) })).toBe(false);
  });
});
