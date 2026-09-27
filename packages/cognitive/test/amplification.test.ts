import { describe, expect, it } from "vitest";
import { acceptedPrecision, attemptsForTarget, coverage, deliveredSuccess, majorityCorrect, mixtureCoverage, wilsonInterval } from "@harness/cognitive";

const close = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 9);

describe("candidate amplification (independence model)", () => {
  it("AM1.1 coverage 1-(1-p)^n matches the mandate fixtures for p=.3", () => {
    close(coverage(0.3, 9), 0.959646393);
    close(coverage(0.3, 13), 0.990311099);
  });

  it("AM1.2 delivered success multiplies coverage by conditional selection accuracy", () => {
    close(deliveredSuccess(0.3, 13, 0.95), 0.940795544);
  });

  it("AM1.3 attempts needed for a target coverage", () => {
    expect(attemptsForTarget(0.3, 0.95)).toBe(9);
    expect(attemptsForTarget(0.3, 0.99)).toBe(13);
  });

  it("AM1.4 edge cases of p and q", () => {
    expect(coverage(0, 100)).toBe(0);
    expect(coverage(1, 1)).toBe(1);
    expect(coverage(1, 0)).toBe(0);
    expect(coverage(0.5, 0)).toBe(0);
    expect(attemptsForTarget(0.5, 0)).toBe(0);
    expect(attemptsForTarget(1, 0.9)).toBe(1);
    expect(attemptsForTarget(0, 0.5)).toBe(Number.POSITIVE_INFINITY);
    expect(attemptsForTarget(0.5, 1)).toBe(Number.POSITIVE_INFINITY);
    expect(attemptsForTarget(1, 1)).toBe(1);
  });

  it("AM1.5 attemptsForTarget respects a cap and reports it as unreachable", () => {
    expect(attemptsForTarget(0.3, 0.99, 10)).toBe(Number.POSITIVE_INFINITY);
    expect(attemptsForTarget(0.3, 0.99, 13)).toBe(13);
  });

  it("AM1.6 tiny probabilities stay numerically stable", () => {
    close(coverage(1e-12, 1e6), 1 - Math.exp(-1e-6));
    expect(attemptsForTarget(1e-9, 0.5)).toBe(693147181);
  });

  it("AM1.7 invalid probabilities and counts are rejected", () => {
    expect(() => coverage(-0.1, 1)).toThrow(/probability/);
    expect(() => coverage(1.1, 1)).toThrow(/probability/);
    expect(() => coverage(Number.NaN, 1)).toThrow(/probability/);
    expect(() => coverage(0.5, -1)).toThrow(/count/);
    expect(() => coverage(0.5, 1.5)).toThrow(/count/);
    expect(() => attemptsForTarget(0.5, 2)).toThrow(/probability/);
    expect(() => deliveredSuccess(0.5, 1, 1.5)).toThrow(/probability/);
  });
});

describe("voting and verification", () => {
  it("AM2.1 majority voting over 13 attempts at p=.3 is correct only ~6.2% of the time", () => {
    close(majorityCorrect(0.3, 13), 0.062375212);
  });

  it("AM2.2 majority voting helps only when p > .5", () => {
    expect(majorityCorrect(0.7, 13)).toBeGreaterThan(0.7);
    expect(majorityCorrect(0.5, 13)).toBeCloseTo(0.5, 12);
    close(majorityCorrect(0.3, 1), 0.3);
  });

  it("AM2.3 an even count needs a strict majority (ties are not wins)", () => {
    close(majorityCorrect(0.5, 2), 0.25);
    expect(majorityCorrect(1, 4)).toBe(1);
    expect(majorityCorrect(0, 4)).toBe(0);
    expect(() => majorityCorrect(0.5, 0)).toThrow(/count/);
  });

  it("AM2.4 accepted precision p*t/(p*t+(1-p)*f) matches the mandate fixture", () => {
    close(acceptedPrecision(0.3, 0.95, 0.05) as number, 0.890625);
  });

  it("AM2.5 accepted precision is undefined when nothing can be accepted", () => {
    expect(acceptedPrecision(0, 0.9, 0)).toBeUndefined();
    expect(acceptedPrecision(0.5, 0, 0)).toBeUndefined();
    expect(acceptedPrecision(1, 1, 0.5)).toBe(1);
  });
});

describe("heterogeneous tasks", () => {
  it("AM3.1 a .3 average made of always/never-solvable tasks does not approach .99 by repetition", () => {
    const tasks = [
      { weight: 0.3, p: 1 },
      { weight: 0.7, p: 0 },
    ];
    close(mixtureCoverage(tasks, 1), 0.3);
    close(mixtureCoverage(tasks, 1000), 0.3);
    close(coverage(0.3, 13), 0.990311099); // what the naive independence model would claim
  });

  it("AM3.2 weights must be non-negative and sum to one", () => {
    expect(() => mixtureCoverage([{ weight: 0.5, p: 0.5 }], 3)).toThrow(/sum/);
    expect(() => mixtureCoverage([{ weight: -0.5, p: 0.5 }, { weight: 1.5, p: 0.1 }], 3)).toThrow(/weight/);
  });
});

describe("uncertainty", () => {
  it("AM4.1 Wilson interval for 8/10 at 95%", () => {
    const [lo, hi] = wilsonInterval(8, 10);
    expect(lo).toBeCloseTo(0.4902, 3);
    expect(hi).toBeCloseTo(0.9433, 3);
  });

  it("AM4.2 zero observed failures is not zero risk", () => {
    const [lo, hi] = wilsonInterval(20, 20);
    expect(hi).toBe(1);
    expect(lo).toBeLessThan(0.9);
  });

  it("AM4.3 no trials gives the vacuous interval; invalid counts are rejected", () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
    expect(() => wilsonInterval(3, 2)).toThrow(/count/);
    expect(() => wilsonInterval(-1, 2)).toThrow(/count/);
  });
});
