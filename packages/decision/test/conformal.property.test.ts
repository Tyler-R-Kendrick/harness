import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { SeededEntropy } from "@harness/testkit";
import { clopperPearsonUpper, empiricalCoverage, nonconformity, predictionSet, regularizedIncompleteBeta, riskCoverageCurve, selectiveThreshold, splitConformal } from "../src/conformal.ts";
import type { SelectiveSample } from "../src/conformal.ts";
import { softmaxWithTemperature, temperatureTransform } from "../src/distribution.ts";
import { uniform } from "../src/explore.ts";
import type { Distribution } from "../src/types.ts";

const label = (d: Distribution, u: number): string => {
  let cumulative = 0;
  for (const [option, p] of Object.entries(d)) {
    cumulative += p;
    if (u < cumulative) return option;
  }
  return Object.keys(d).at(-1)!;
};

describe("conformal properties", () => {
  it("CFM2.1 prediction sets cover at least 1 - alpha of fresh examples in a seeded simulation, for an overconfident model", () => {
    const rng = uniform(new SeededEntropy(101));
    const example = () => {
      const q = softmaxWithTemperature({ a: (rng() - 0.5) * 6, b: (rng() - 0.5) * 6, c: (rng() - 0.5) * 6, d: (rng() - 0.5) * 6 });
      return { d: temperatureTransform(q, 0.5), y: label(q, rng()) };
    };
    for (const alpha of [0.1, 0.2]) {
      let total = 0;
      const reps = 80;
      for (let r = 0; r < reps; r++) {
        const calibration = Array.from({ length: 100 }, example);
        const qhat = splitConformal(calibration.map(({ d, y }) => nonconformity(d, y)), alpha);
        const fresh = Array.from({ length: 100 }, example);
        total += empiricalCoverage(fresh.map(({ d }) => predictionSet(d, qhat)), fresh.map(({ y }) => y));
      }
      expect(total / reps).toBeGreaterThanOrEqual(1 - alpha - 0.012);
      expect(total / reps).toBeLessThanOrEqual(1 - alpha + 0.03);
    }
  });

  it("CFM2.2 coverage is exactly ceil((n+1)(1-alpha)) / (n+1) on average for exchangeable scores", () => {
    const rng = uniform(new SeededEntropy(102));
    let covered = 0;
    const reps = 8000;
    for (let r = 0; r < reps; r++) {
      const qhat = splitConformal(Array.from({ length: 19 }, rng), 0.1);
      if (rng() <= qhat) covered++;
    }
    expect(Math.abs(covered / reps - 18 / 20)).toBeLessThan(0.015);
  });

  test.prop([fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 60 }), fc.double({ min: 0.01, max: 0.99, noNaN: true })])("CFM2.3 the quantile is a score or infinity, and never falls as the level tightens", (scores, alpha) => {
    const q = splitConformal(scores, alpha);
    expect(q === Number.POSITIVE_INFINITY || scores.includes(q)).toBe(true);
    expect(splitConformal(scores, alpha / 2)).toBeGreaterThanOrEqual(q);
  });
});

/**
 * Confidence uniform on a grid of `grid` levels (j / grid); an answer is wrong with probability
 * 0.4 (1 - confidence). The true risk above the level j / grid is then the mean of that over levels j..grid-1.
 */
function dataset(n: number, grid: number, rng: () => number): SelectiveSample[] {
  return Array.from({ length: n }, () => {
    const confidence = Math.floor(rng() * grid) / grid;
    return { confidence, correct: rng() >= 0.4 * (1 - confidence) };
  });
}
const trueRisk = (threshold: number, grid: number) => {
  const first = Math.round(threshold * grid);
  let sum = 0;
  for (let j = first; j < grid; j++) sum += 0.4 * (1 - j / grid);
  return sum / (grid - first);
};

describe("selective guarantee", () => {
  const TARGET = 0.15;
  const DELTA = 0.1;

  for (const [bound, n, grid, runs] of [["hoeffding", 3000, 100, 300], ["clopper-pearson", 400, 40, 300]] as const) {
    it(`CFM2.4 with ${bound}, the true risk at the chosen threshold exceeds the target in at most delta of seeded datasets (and the threshold is found)`, () => {
      const rng = uniform(new SeededEntropy(103));
      let violated = 0;
      let found = 0;
      for (let r = 0; r < runs; r++) {
        const { threshold } = selectiveThreshold(dataset(n, grid, rng), { targetRisk: TARGET, delta: DELTA, bound });
        if (threshold === undefined) continue;
        found++;
        if (trueRisk(threshold, grid) > TARGET) violated++;
      }
      expect(found).toBeGreaterThan(runs * 0.6);
      expect(violated / runs).toBeLessThanOrEqual(DELTA + 0.03);
    });
  }

  it("CFM2.5 the same simulation catches a rule with no bound: the lowest threshold whose empirical risk is under the target breaks the guarantee", () => {
    const rng = uniform(new SeededEntropy(103));
    let violated = 0;
    const runs = 300;
    for (let r = 0; r < runs; r++) {
      const curve = riskCoverageCurve(dataset(400, 40, rng)).filter((row) => row.coverage >= 0.1);
      const lowest = curve.filter((row) => row.risk <= TARGET).at(-1);
      if (lowest !== undefined && trueRisk(lowest.threshold, 40) > TARGET) violated++;
    }
    expect(violated / runs).toBeGreaterThan(DELTA + 0.05);
  });

  const samples = fc.array(fc.record({ confidence: fc.integer({ min: 0, max: 30 }).map((x) => x / 30), correct: fc.boolean() }), { minLength: 0, maxLength: 400 });
  const setting = fc.record({ targetRisk: fc.double({ min: 0.05, max: 0.6, noNaN: true }), delta: fc.double({ min: 0.01, max: 0.4, noNaN: true }), bound: fc.constantFrom("hoeffding" as const, "clopper-pearson" as const) });

  test.prop([samples, setting])("CFM2.6 a chosen threshold accepts exactly the samples at or above it, with a bound within the target", (ss, options) => {
    const out = selectiveThreshold(ss, options);
    if (out.threshold === undefined) {
      expect(out).toEqual({ threshold: undefined, coverage: 0, risk: 0, upperBound: 1, n: 0 });
      return;
    }
    const accepted = ss.filter((x) => x.confidence >= out.threshold!);
    expect(out.n).toBe(accepted.length);
    expect(out.coverage).toBeCloseTo(accepted.length / ss.length, 12);
    expect(out.risk).toBeCloseTo(accepted.filter((x) => !x.correct).length / accepted.length, 12);
    expect(out.upperBound).toBeLessThanOrEqual(options.targetRisk);
    expect(out.upperBound).toBeGreaterThanOrEqual(out.risk);
  });

  test.prop([samples, setting, fc.double({ min: 0, max: 0.3, noNaN: true })])("CFM2.7 a looser target never raises the threshold and never lowers the coverage", (ss, options, extra) => {
    const strict = selectiveThreshold(ss, options);
    const loose = selectiveThreshold(ss, { ...options, targetRisk: Math.min(0.99, options.targetRisk + extra) });
    if (strict.threshold === undefined) return;
    expect(loose.threshold).toBeDefined();
    expect(loose.threshold!).toBeLessThanOrEqual(strict.threshold);
    expect(loose.coverage).toBeGreaterThanOrEqual(strict.coverage);
  });

  test.prop([samples])("CFM2.8 the risk-coverage curve widens as the threshold falls and ends at full coverage", (ss) => {
    const curve = riskCoverageCurve(ss);
    if (ss.length === 0) {
      expect(curve).toEqual([]);
      return;
    }
    curve.slice(1).forEach((row, i) => {
      expect(row.threshold).toBeLessThan(curve[i]!.threshold);
      expect(row.coverage).toBeGreaterThan(curve[i]!.coverage);
    });
    expect(curve.at(-1)!.coverage).toBe(1);
    for (const row of curve) {
      expect(row.risk).toBeGreaterThanOrEqual(0);
      expect(row.risk).toBeLessThanOrEqual(1);
    }
  });
});

describe("bound properties", () => {
  it("CFM2.9 the Clopper-Pearson bound holds the true risk with at least the stated probability in a seeded simulation", () => {
    const rng = uniform(new SeededEntropy(104));
    for (const [p, n] of [[0.02, 60], [0.1, 50], [0.3, 40]] as const) {
      let held = 0;
      const runs = 3000;
      for (let r = 0; r < runs; r++) {
        let errors = 0;
        for (let i = 0; i < n; i++) if (rng() < p) errors++;
        if (clopperPearsonUpper(errors, n, 0.05) >= p) held++;
      }
      expect(held / runs).toBeGreaterThanOrEqual(0.95 - 0.015);
    }
  });

  test.prop([fc.integer({ min: 1, max: 200 }), fc.nat(), fc.double({ min: 0.01, max: 0.5, noNaN: true })])("CFM2.10 the Clopper-Pearson bound is at least the observed risk, at most 1, and rises with the errors", (n, k0, delta) => {
    const k = k0 % (n + 1);
    const ub = clopperPearsonUpper(k, n, delta);
    expect(ub).toBeGreaterThanOrEqual(k / n - 1e-12);
    expect(ub).toBeLessThanOrEqual(1);
    if (k < n) expect(clopperPearsonUpper(k + 1, n, delta)).toBeGreaterThanOrEqual(ub);
    expect(clopperPearsonUpper(k, n, delta / 2)).toBeGreaterThanOrEqual(ub);
    expect(clopperPearsonUpper(k, n + 10, delta)).toBeLessThanOrEqual(ub + 1e-12);
  });

  test.prop([fc.double({ min: 0.001, max: 0.999, noNaN: true }), fc.double({ min: 0.1, max: 60, noNaN: true }), fc.double({ min: 0.1, max: 60, noNaN: true })])("CFM2.11 the incomplete beta is a CDF: I_x(a, b) + I_(1-x)(b, a) = 1 and it is within [0, 1]", (x, a, b) => {
    const left = regularizedIncompleteBeta(x, a, b);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThanOrEqual(1);
    expect(left + regularizedIncompleteBeta(1 - x, b, a)).toBeCloseTo(1, 9);
    expect(regularizedIncompleteBeta(Math.min(1, x + 0.0005), a, b)).toBeGreaterThanOrEqual(left - 1e-12);
  });
});
