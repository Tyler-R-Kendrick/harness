import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { argmax, distributionFromWeights, entropy, isDistribution, logit, margin, normalizedEntropy, sigmoid, softmaxWithTemperature, temperatureTransform, topProbability } from "../src/distribution.ts";

const weights = fc.array(fc.double({ min: 0, max: 1000, noNaN: true }), { minLength: 2, maxLength: 8 }).filter((w) => w.some((x) => x > 0));
const dist = weights.map((w) => distributionFromWeights(Object.fromEntries(w.map((x, i) => [`o${i}`, x]))));
const temp = fc.double({ min: 0.05, max: 20, noNaN: true });

describe("distribution properties", () => {
  test.prop([dist])("DSN2.1 a distribution made from weights is a distribution", (d) => {
    expect(isDistribution(d)).toBe(true);
  });

  test.prop([dist])("DSN2.2 temperature 1 leaves a distribution as it was", (d) => {
    const same = temperatureTransform(d, 1);
    for (const option of Object.keys(d)) expect(same[option]).toBeCloseTo(d[option]!, 9);
  });

  test.prop([dist, temp])("DSN2.3 a temperature transform is a distribution that keeps the order of the options", (d, t) => {
    const out = temperatureTransform(d, t);
    expect(isDistribution(out)).toBe(true);
    const options = Object.keys(d);
    for (const a of options) for (const b of options) if (d[a]! > d[b]!) expect(out[a]!).toBeGreaterThanOrEqual(out[b]!);
    // Rounding may make two close options equal, and then "first of equals" can differ: the leader is still a maximum.
    expect(out[argmax(d)]!).toBe(Math.max(...Object.values(out)));
  });

  test.prop([dist, temp, temp])("DSN2.4 a higher temperature never lowers entropy", (d, t1, t2) => {
    const [lo, hi] = t1 <= t2 ? [t1, t2] : [t2, t1];
    expect(entropy(temperatureTransform(d, hi))).toBeGreaterThanOrEqual(entropy(temperatureTransform(d, lo)) - 1e-9);
  });

  test.prop([dist])("DSN2.5 entropy is between 0 and ln K, normalized entropy between 0 and 1", (d) => {
    const k = Object.keys(d).length;
    expect(entropy(d)).toBeGreaterThanOrEqual(0);
    expect(entropy(d)).toBeLessThanOrEqual(Math.log(k) + 1e-9);
    expect(normalizedEntropy(d)).toBeGreaterThanOrEqual(0);
    expect(normalizedEntropy(d)).toBeLessThanOrEqual(1);
  });

  test.prop([dist])("DSN2.6 the margin is between 0 and the top probability, and the top probability is that of the argmax", (d) => {
    expect(margin(d)).toBeGreaterThanOrEqual(0);
    expect(margin(d)).toBeLessThanOrEqual(topProbability(d));
    expect(topProbability(d)).toBe(d[argmax(d)]);
  });

  test.prop([fc.array(fc.double({ min: -50, max: 50, noNaN: true }), { minLength: 2, maxLength: 6 }), temp])("DSN2.7 softmax is a distribution ordered like its logits", (logits, t) => {
    const d = softmaxWithTemperature(Object.fromEntries(logits.map((x, i) => [`o${i}`, x])), t);
    expect(isDistribution(d)).toBe(true);
    logits.forEach((a, i) => logits.forEach((b, j) => a > b && expect(d[`o${i}`]!).toBeGreaterThanOrEqual(d[`o${j}`]!)));
  });

  test.prop([fc.double({ min: 1e-9, max: 1 - 1e-9, noNaN: true })])("DSN2.8 sigmoid inverts logit", (p) => {
    expect(sigmoid(logit(p))).toBeCloseTo(p, 8);
  });

  test.prop([fc.double({ min: -1e6, max: 1e6, noNaN: true })])("DSN2.9 a sigmoid is always a probability strictly inside the unit interval", (x) => {
    const s = sigmoid(x);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});
