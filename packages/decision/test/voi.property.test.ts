import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { probability } from "@harness/cognitive";
import { askThreshold, shouldAsk, valueOfAsking } from "../src/voi.ts";
import { cost } from "../src/types.ts";

const p = fc.double({ min: 0, max: 1, noNaN: true });
const money = fc.double({ min: 0, max: 1000, noNaN: true });

describe("value of asking properties", () => {
  test.prop([p, p, money, money, p])("VOI2.1 the value never rises with the probability of being right", (a, b, w, k, h) => {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const at = (x: number) => valueOfAsking({ pRight: probability(x), costWrong: cost(w), costAsk: cost(k), humanError: probability(h) });
    expect(at(hi)).toBeLessThanOrEqual(at(lo) + 1e-9);
  });

  test.prop([p, money, money, money, p])("VOI2.2 the value never falls as being wrong costs more", (x, a, b, k, h) => {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    // asking's own cost grows with the wrong cost only through the human's error, which is smaller than the loss avoided when humanError < 1 - pRight
    const at = (w: number) => valueOfAsking({ pRight: probability(x), costWrong: cost(w), costAsk: cost(k), humanError: probability(Math.min(h, 1 - x)) });
    expect(at(hi)).toBeGreaterThanOrEqual(at(lo) - 1e-9);
  });

  test.prop([p, money, money, p])("VOI2.3 the value never rises with the cost of asking", (x, w, k, h) => {
    const at = (ask: number) => valueOfAsking({ pRight: probability(x), costWrong: cost(w), costAsk: cost(ask), humanError: probability(h) });
    expect(at(k + 1)).toBeLessThan(at(k));
  });

  test.prop([p, money, money, p])("VOI2.4 a probability below the threshold asks and one above it does not", (x, w, k, h) => {
    const t = askThreshold({ costWrong: cost(w), costAsk: cost(k), humanError: probability(h) });
    const args = { costWrong: cost(w), costAsk: cost(k), humanError: probability(h) };
    if (x < t - 1e-9) expect(shouldAsk({ ...args, pRight: probability(x) })).toBe(true);
    if (x > t + 1e-9) expect(shouldAsk({ ...args, pRight: probability(x) })).toBe(false);
  });

  test.prop([money, money, p])("VOI2.5 the threshold is a probability that falls as asking gets dearer", (w, k, h) => {
    const at = (ask: number) => askThreshold({ costWrong: cost(w), costAsk: cost(ask), humanError: probability(h) });
    expect(at(k)).toBeGreaterThanOrEqual(0);
    expect(at(k)).toBeLessThanOrEqual(1);
    expect(at(k + 1)).toBeLessThanOrEqual(at(k));
  });
});
