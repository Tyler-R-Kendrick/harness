import { probability } from "@harness/cognitive";
import { describe, expect, it } from "vitest";
import {
  answerOfDistribution,
  argmax,
  booleanDistribution,
  distributionFromWeights,
  entropy,
  expectedLevel,
  isDistribution,
  logit,
  margin,
  normalizedEntropy,
  PROBABILITY_FLOOR,
  scaleProbabilities,
  sigmoid,
  softmaxWithTemperature,
  temperatureTransform,
  topProbability,
} from "../src/distribution.ts";

const dist = (weights: Record<string, number>) => distributionFromWeights(weights);

describe("distribution", () => {
  it("DSN1.1 isDistribution accepts probabilities over two or more options that sum to one, and nothing else", () => {
    expect(isDistribution({ a: 0.5, b: 0.5 })).toBe(true);
    expect(isDistribution({ a: 0.25, b: 0.25, c: 0.5 })).toBe(true);
    expect(isDistribution({ a: 0.5, b: 0.6 })).toBe(false);
    expect(isDistribution({ a: 1 })).toBe(false);
    expect(isDistribution({ a: 1.5, b: -0.5 })).toBe(false);
    expect(isDistribution(null)).toBe(false);
    expect(isDistribution([0.5, 0.5])).toBe(false);
    expect(isDistribution("a")).toBe(false);
  });

  it("DSN1.2 entropy is in nats: ln K for a uniform distribution, zero for a certain one", () => {
    expect(entropy(dist({ a: 1, b: 1, c: 1, d: 1 }))).toBeCloseTo(Math.log(4), 12);
    expect(entropy(dist({ a: 1, b: 0 }))).toBe(0);
    expect(entropy(dist({ a: 2, b: 1, c: 1 }))).toBeCloseTo(1.5 * Math.log(2), 12);
  });

  it("DSN1.3 normalized entropy is entropy over ln K: one for a uniform distribution, zero for a certain one", () => {
    expect(normalizedEntropy(dist({ a: 1, b: 1, c: 1 }))).toBeCloseTo(1, 12);
    expect(normalizedEntropy(dist({ a: 1, b: 0, c: 0 }))).toBe(0);
    expect(normalizedEntropy(dist({ a: 1, b: 1 }))).toBeCloseTo(1, 12);
    expect(normalizedEntropy(dist({ a: 3, b: 1 }))).toBeCloseTo((-0.75 * Math.log(0.75) - 0.25 * Math.log(0.25)) / Math.log(2), 12);
    expect(normalizedEntropy(dist({ a: 2, b: 1, c: 1 }))).toBeCloseTo((1.5 * Math.log(2)) / Math.log(3), 12);
  });

  it("DSN1.4 margin is the top probability minus the second, and topProbability is the top", () => {
    const d = dist({ a: 0.5, b: 0.3, c: 0.2 });
    expect(margin(d)).toBeCloseTo(0.2, 12);
    expect(topProbability(d)).toBeCloseTo(0.5, 12);
    expect(margin(dist({ a: 1, b: 1 }))).toBe(0);
    expect(margin(dist({ a: 0.1, b: 0.6, c: 0.3 }))).toBeCloseTo(0.3, 12);
    expect(margin(dist({ a: 0.1, b: 0.3, c: 0.6 }))).toBeCloseTo(0.3, 12);
    expect(margin(dist({ a: 0.6, b: 0.1, c: 0.3 }))).toBeCloseTo(0.3, 12);
    expect(topProbability(dist({ a: 0.1, b: 0.9 }))).toBeCloseTo(0.9, 12);
  });

  it("DSN1.5 argmax is the most probable option, and the first of equals in key order", () => {
    expect(argmax(dist({ a: 0.2, b: 0.5, c: 0.3 }))).toBe("b");
    expect(argmax(dist({ x: 1, y: 1, z: 1 }))).toBe("x");
    expect(argmax(dist({ x: 1, y: 2, z: 2 }))).toBe("y");
    expect(argmax(dist({ x: 1, y: 3 }))).toBe("y");
  });

  it("DSN1.6 distributionFromWeights renormalizes non-negative weights, and refuses weights that cannot be", () => {
    expect(dist({ a: 3, b: 1 })).toEqual({ a: 0.75, b: 0.25 });
    expect(isDistribution(dist({ a: 0.1, b: 0.2, c: 0.3 }))).toBe(true);
    expect(() => dist({ a: 1 })).toThrow(/at least two options/);
    expect(() => dist({ a: -1, b: 2 })).toThrow(/weight of "a"/);
    expect(() => dist({ a: Number.NaN, b: 2 })).toThrow(/weight of "a"/);
    expect(() => dist({ a: Number.POSITIVE_INFINITY, b: 2 })).toThrow(/weight of "a"/);
    expect(() => dist({ a: 0, b: 0 })).toThrow(/sum to zero/);
  });

  it("DSN1.7 a temperature above one flattens, below one sharpens, and one leaves a distribution as it was", () => {
    const d = dist({ a: 0.64, b: 0.36 });
    const flat = temperatureTransform(d, 2);
    expect(flat["a"]).toBeCloseTo(0.8 / 1.4, 12);
    expect(flat["b"]).toBeCloseTo(0.6 / 1.4, 12);
    const sharp = temperatureTransform(d, 0.5);
    expect(sharp["a"]).toBeCloseTo(0.4096 / (0.4096 + 0.1296), 12);
    const same = temperatureTransform(d, 1);
    expect(same["a"]).toBeCloseTo(0.64, 12);
    expect(same["b"]).toBeCloseTo(0.36, 12);
  });

  it("DSN1.8 a temperature transform is stable at extreme temperatures and keeps impossible options impossible", () => {
    const d = dist({ a: 0.7, b: 0.2, c: 0.1, z: 0 });
    const cold = temperatureTransform(d, 1e-9);
    expect(cold).toEqual({ a: 1, b: 0, c: 0, z: 0 });
    const denormal = temperatureTransform(d, 1e-320);
    expect(denormal).toEqual({ a: 1, b: 0, c: 0, z: 0 });
    const hot = temperatureTransform(d, 1e12);
    expect(hot["a"]).toBeCloseTo(1 / 3, 9);
    expect(hot["z"]).toBe(0);
    expect(isDistribution(hot)).toBe(true);
    const tie = temperatureTransform(dist({ a: 1, b: 1 }), 1e-320);
    expect(tie).toEqual({ a: 0.5, b: 0.5 });
  });

  it("DSN1.9 a temperature that is not finite and positive is refused", () => {
    const d = dist({ a: 1, b: 1 });
    for (const t of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => temperatureTransform(d, t)).toThrow(/temperature/);
  });

  it("DSN1.10 softmax turns logits into a distribution, stably, and a temperature divides the logits", () => {
    expect(softmaxWithTemperature({ a: 0, b: 0 })).toEqual({ a: 0.5, b: 0.5 });
    const big = softmaxWithTemperature({ a: 1000, b: 0, c: 999 });
    expect(big["a"]).toBeCloseTo(1 / (1 + Math.exp(-1)), 9);
    expect(big["b"]).toBe(0);
    const t = softmaxWithTemperature({ a: 2, b: 0 }, 2);
    expect(t["a"]).toBeCloseTo(1 / (1 + Math.exp(-1)), 12);
    expect(softmaxWithTemperature({ a: 5, b: 1 }, 1)["a"]).toBeCloseTo(1 / (1 + Math.exp(-4)), 12);
    expect(() => softmaxWithTemperature({ a: 1 })).toThrow(/at least two options/);
    expect(() => softmaxWithTemperature({ a: 1, b: Number.NaN })).toThrow(/logit of "b"/);
    expect(() => softmaxWithTemperature({ a: 1, b: 2 }, 0)).toThrow(/temperature/);
    expect(softmaxWithTemperature({ a: Number.NEGATIVE_INFINITY, b: 0 })).toEqual({ a: 0, b: 1 });
    expect(() => softmaxWithTemperature({ a: Number.POSITIVE_INFINITY, b: 0 })).toThrow(/logit of "a"/);
  });

  it("DSN1.11 logit and sigmoid are inverses, and clamped so that neither is ever infinite", () => {
    expect(logit(0.5)).toBe(0);
    expect(logit(0.75)).toBeCloseTo(Math.log(3), 12);
    expect(sigmoid(0)).toBe(0.5);
    expect(sigmoid(logit(0.9))).toBeCloseTo(0.9, 12);
    expect(Number.isFinite(logit(0))).toBe(true);
    expect(Number.isFinite(logit(1))).toBe(true);
    expect(logit(0)).toBeLessThan(-27);
    expect(logit(1)).toBeGreaterThan(27);
    expect(logit(0)).toBeCloseTo(-logit(1), 3);
    expect(sigmoid(1000)).toBeCloseTo(1 - PROBABILITY_FLOOR, 13);
    expect(sigmoid(-1000)).toBeCloseTo(PROBABILITY_FLOOR, 13);
    expect(sigmoid(Number.POSITIVE_INFINITY)).toBeCloseTo(1 - PROBABILITY_FLOOR, 13);
    expect(sigmoid(2)).toBeCloseTo(1 / (1 + Math.exp(-2)), 12);
    expect(sigmoid(-2)).toBeCloseTo(1 / (1 + Math.exp(2)), 12);
    expect(() => logit(1.1)).toThrow(/probability/);
    expect(() => logit(-0.1)).toThrow(/probability/);
    expect(() => logit(Number.NaN)).toThrow(/probability/);
    expect(() => sigmoid(Number.NaN)).toThrow(/not a number/);
  });

  it("DSN1.12 expectedLevel is the sum of level times probability over numeric keys", () => {
    expect(expectedLevel(dist({ "0": 0.5, "1": 0.25, "2": 0.25 }))).toBeCloseTo(0.75, 12);
    expect(expectedLevel(dist({ "0": 0, "1": 0, "10": 1 }))).toBe(10);
    expect(() => expectedLevel(dist({ "0": 1, low: 1 }))).toThrow(/level "low"/);
    expect(() => expectedLevel(dist({ "0": 1, "-1": 1 }))).toThrow(/level "-1"/);
    expect(() => expectedLevel(dist({ "0": 1, "1.5": 1 }))).toThrow(/level "1.5"/);
    expect(() => expectedLevel(dist({ "0": 1, "01": 1 }))).toThrow(/level "01"/);
  });

  it("DSN1.13 booleanDistribution puts p on true and the rest on false", () => {
    expect(booleanDistribution(0.75)).toEqual({ true: 0.75, false: 0.25 });
    expect(Object.keys(booleanDistribution(0.3))).toEqual(["true", "false"]);
    expect(booleanDistribution(0)).toEqual({ true: 0, false: 1 });
    expect(booleanDistribution(1)).toEqual({ true: 1, false: 0 });
    expect(() => booleanDistribution(1.2)).toThrow(/probability/);
    expect(() => booleanDistribution(Number.NaN)).toThrow(/probability/);
  });

  it("DSN1.15 a distribution with fewer than two options, or with no probability at all, is refused where it cannot be measured", () => {
    const one = { a: probability(1) };
    const none = { a: probability(0), b: probability(0) };
    expect(() => normalizedEntropy(one)).toThrow(/at least two options, got 1/);
    expect(() => margin(one)).toThrow(/margin needs at least two options, got 1/);
    expect(() => margin({})).toThrow(/margin needs at least two options, got 0/);
    expect(() => argmax({})).toThrow(/at least two options, got none/);
    expect(() => topProbability({})).toThrow(/at least two options/);
    expect(() => temperatureTransform(none, 1)).toThrow(/no option has any probability/);
    expect(() => scaleProbabilities([0, 0], 1)).toThrow(/no option has any probability/);
    expect(() => softmaxWithTemperature({ a: Number.NEGATIVE_INFINITY, b: Number.NEGATIVE_INFINITY })).toThrow(/every logit is -Infinity/);
    expect(() => softmaxWithTemperature({ a: Number.NEGATIVE_INFINITY })).toThrow(/at least two options, got 1/);
  });

  it("DSN1.16 scaleProbabilities is the temperature transform on plain numbers", () => {
    const scaled = scaleProbabilities([0.64, 0.36, 0], 2);
    expect(scaled[0]).toBeCloseTo(0.8 / 1.4, 12);
    expect(scaled[1]).toBeCloseTo(0.6 / 1.4, 12);
    expect(scaled[2]).toBe(0);
    expect(() => scaleProbabilities([0.5, 0.5], 0)).toThrow(/temperature/);
  });

  it("DSN1.17 weights near the limits of a double do not overflow", () => {
    expect(dist({ a: 1e308, b: 1e308 })).toEqual({ a: 0.5, b: 0.5 });
    expect(dist({ a: 5e-324, b: 5e-324 })).toEqual({ a: 0.5, b: 0.5 });
  });

  it("DSN1.14 answerOfDistribution names the top option, and adds the expected level for scores only", () => {
    const d = dist({ "0": 0.1, "1": 0.2, "2": 0.7 });
    expect(answerOfDistribution("choice", d)).toEqual({ type: "choice", distribution: d, top: "2" });
    expect(Object.keys(answerOfDistribution("boolean", booleanDistribution(0.4)))).toEqual(["type", "distribution", "top"]);
    expect(answerOfDistribution("boolean", booleanDistribution(0.4)).top).toBe("false");
    const score = answerOfDistribution("score", d);
    expect(score.top).toBe("2");
    expect(score.score).toBeCloseTo(1.6, 12);
  });
});
