import { describe, expect } from "vitest";
import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { attemptsForTarget, coverage, majorityCorrect, wilsonInterval } from "@harness/cognitive";

const prob = fc.double({ min: 0, max: 1, noNaN: true });
const openProb = fc.double({ min: 0.001, max: 0.999, noNaN: true });

describe("amplification properties", () => {
  test.prop([prob, fc.nat(200), fc.nat(200)])("AM5.1 coverage is a probability and never decreases with more attempts", (p, a, b) => {
    const [n, m] = a <= b ? [a, b] : [b, a];
    expect(coverage(p, n)).toBeGreaterThanOrEqual(0);
    expect(coverage(p, m)).toBeLessThanOrEqual(1);
    expect(coverage(p, m)).toBeGreaterThanOrEqual(coverage(p, n) - 1e-15);
  });

  test.prop([openProb, fc.double({ min: 0.001, max: 0.999, noNaN: true })])("AM5.2 attemptsForTarget returns the minimal sufficient count", (p, q) => {
    const n = attemptsForTarget(p, q);
    expect(coverage(p, n)).toBeGreaterThanOrEqual(q);
    if (n > 0) expect(coverage(p, n - 1)).toBeLessThan(q);
  });

  test.prop([prob, fc.integer({ min: 1, max: 60 })])("AM5.3 majority accuracy is a probability", (p, n) => {
    const v = majorityCorrect(p, n);
    expect(v).toBeGreaterThanOrEqual(-1e-12);
    expect(v).toBeLessThanOrEqual(1 + 1e-12);
  });

  test.prop([fc.nat(500), fc.nat(500)])("AM5.4 the Wilson interval contains the observed rate", (a, b) => {
    const [k, n] = a <= b ? [a, b] : [b, a];
    fc.pre(n > 0);
    const [lo, hi] = wilsonInterval(k, n);
    expect(lo).toBeLessThanOrEqual(k / n + 1e-12);
    expect(hi).toBeGreaterThanOrEqual(k / n - 1e-12);
  });
});
