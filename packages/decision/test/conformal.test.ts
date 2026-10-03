import { describe, expect, it } from "vitest";
import {
  averageSetSize,
  clopperPearsonUpper,
  empiricalCoverage,
  hoeffdingUpper,
  nonconformity,
  predictionSet,
  regularizedIncompleteBeta,
  riskCoverageCurve,
  selectiveThreshold,
  splitConformal,
} from "../src/conformal.ts";
import type { SelectiveSample } from "../src/conformal.ts";
import { distributionFromWeights } from "../src/distribution.ts";

const dist = (weights: Record<string, number>) => distributionFromWeights(weights);
/** P(X <= k) for X ~ Binomial(n, p), by the pmf recursion (small n only). */
function binomialCdf(k: number, n: number, p: number): number {
  let pmf = (1 - p) ** n;
  let sum = pmf;
  for (let j = 0; j < k; j++) {
    pmf *= ((n - j) / (j + 1)) * (p / (1 - p));
    sum += pmf;
  }
  return sum;
}
/** I_x(a, b) for whole a and b, as a binomial tail: P(Bin(a + b - 1, x) >= a). */
const betaByBinomial = (x: number, a: number, b: number): number => 1 - binomialCdf(a - 1, a + b - 1, x);
const group = (count: number, confidence: number, wrong: number): SelectiveSample[] => Array.from({ length: count }, (_, i) => ({ confidence, correct: i >= wrong }));

describe("split conformal", () => {
  it("CFM1.1 the quantile is the ceil((n+1)(1-alpha))-th smallest score, whatever the input order", () => {
    expect(splitConformal([0.5, 0.1, 0.9, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6], 0.1)).toBe(0.9);
    expect(splitConformal([5, 3, 1, 4, 2, 9, 8, 7, 6, 10], 0.2)).toBe(9);
    expect(splitConformal([5, 3, 1, 4, 2, 9, 8, 7, 6, 10], 0.5)).toBe(6);
  });

  it("CFM1.2 the quantile is infinite when there are too few scores for the level", () => {
    const scores = Array.from({ length: 18 }, (_, i) => i / 20);
    expect(splitConformal(scores, 0.05)).toBe(Number.POSITIVE_INFINITY);
    expect(splitConformal([...scores, 0.9], 0.05)).toBe(0.9);
    expect(splitConformal([], 0.5)).toBe(Number.POSITIVE_INFINITY);
    expect(splitConformal([0.4], 0.5)).toBe(0.4);
  });

  it("CFM1.3 a product that lands a hair above a whole number in floating point does not cost a rank", () => {
    // (9 + 1) * (1 - 0.7) is 3.0000000000000004 in doubles
    expect(splitConformal([1, 2, 3, 4, 5, 6, 7, 8, 9], 0.7)).toBe(3);
    // (19 + 1) * (1 - 0.95) is 1.0000000000000009
    expect(splitConformal(Array.from({ length: 19 }, (_, i) => i + 1), 0.95)).toBe(1);
  });

  it("CFM1.4 a level outside (0, 1) or a score that is not a number is refused", () => {
    for (const alpha of [0, 1, -0.1, 1.5, Number.NaN]) expect(() => splitConformal([0.1], alpha)).toThrow(/alpha/);
    expect(() => splitConformal([0.1, Number.NaN], 0.1)).toThrow(/score 1/);
  });

  it("CFM1.5 nonconformity is one minus the probability of the label", () => {
    expect(nonconformity(dist({ a: 0.7, b: 0.3 }), "a")).toBeCloseTo(0.3, 12);
    expect(nonconformity(dist({ a: 0.7, b: 0.3 }), "b")).toBeCloseTo(0.7, 12);
    expect(() => nonconformity(dist({ a: 0.7, b: 0.3 }), "z")).toThrow(/label "z" is not among the options \(a, b\)/);
  });

  it("CFM1.6 a prediction set holds the options within the quantile, most probable first", () => {
    const d = dist({ a: 0.2, b: 0.5, c: 0.3 });
    expect(predictionSet(d, 0.8)).toEqual(["b", "c", "a"]);
    expect(predictionSet(d, 0.79)).toEqual(["b", "c"]);
    expect(predictionSet(d, 0.7)).toEqual(["b", "c"]);
    expect(predictionSet(d, 0.69)).toEqual(["b"]);
    expect(predictionSet(d, 0.5)).toEqual(["b"]);
    expect(predictionSet(d, 0.49)).toEqual([]);
    expect(predictionSet(d, Number.POSITIVE_INFINITY)).toEqual(["b", "c", "a"]);
    expect(predictionSet(dist({ x: 1, y: 1, z: 1 }), 0.7)).toEqual(["x", "y", "z"]);
  });

  it("CFM1.7 an option is in the set exactly when its nonconformity is at most the quantile", () => {
    const d = dist({ a: 0.2, b: 0.5, c: 0.3 });
    for (const q of [0.4, 0.5, 0.6, 0.7, 0.8]) for (const o of ["a", "b", "c"]) expect(predictionSet(d, q).includes(o)).toBe(nonconformity(d, o) <= q);
  });

  it("CFM1.8 empirical coverage is the share of sets that hold their label, and the average size is the mean set size", () => {
    expect(empiricalCoverage([["a"], ["a", "b"], ["b"], []], ["a", "b", "a", "a"])).toBe(0.5);
    expect(empiricalCoverage([["a"]], ["a"])).toBe(1);
    expect(averageSetSize([["a"], ["a", "b"], ["b"], []])).toBe(1);
    expect(averageSetSize([["a", "b"]])).toBe(2);
    expect(() => empiricalCoverage([["a"]], ["a", "b"])).toThrow(/1 sets but 2 labels/);
    expect(() => empiricalCoverage([], [])).toThrow(/at least one set/);
    expect(() => averageSetSize([])).toThrow(/at least one set/);
  });
});

describe("bounds", () => {
  it("CFM1.9 the Hoeffding bound adds sqrt(ln(1/delta) / 2n) to the risk, capped at one", () => {
    expect(hoeffdingUpper(5, 100, 0.05)).toBeCloseTo(0.05 + Math.sqrt(Math.log(20) / 200), 12);
    expect(hoeffdingUpper(0, 100, 0.05)).toBeCloseTo(Math.sqrt(Math.log(20) / 200), 12);
    expect(hoeffdingUpper(1, 2, 0.05)).toBe(1);
    expect(() => hoeffdingUpper(1, 0, 0.05)).toThrow(/n must be a positive whole number/);
    expect(() => hoeffdingUpper(3, 2, 0.05)).toThrow(/errors/);
    expect(() => hoeffdingUpper(1, 2, 0)).toThrow(/delta/);
    expect(() => hoeffdingUpper(1.5, 4, 0.1)).toThrow(/errors/);
  });

  it("CFM1.10 the regularized incomplete beta agrees with the binomial tail it equals for whole parameters", () => {
    for (const [a, b] of [[1, 1], [2, 2], [2, 5], [5, 2], [10, 3], [3, 30], [40, 40]] as const) {
      for (const x of [0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) {
        expect(regularizedIncompleteBeta(x, a, b)).toBeCloseTo(betaByBinomial(x, a, b), 10);
      }
    }
    expect(regularizedIncompleteBeta(0.3, 2, 5)).toBeCloseTo(0.579825, 9);
    expect(regularizedIncompleteBeta(0.5, 2, 2)).toBeCloseTo(0.5, 12);
    expect(regularizedIncompleteBeta(0.25, 1, 1)).toBeCloseTo(0.25, 12);
  });

  it("CFM1.11 the regularized incomplete beta is 0 at 0 and 1 at 1, is right for real parameters, and refuses what is not defined", () => {
    expect(regularizedIncompleteBeta(0, 2, 3)).toBe(0);
    expect(regularizedIncompleteBeta(1, 2, 3)).toBe(1);
    // I_x(1/2, 1/2) = (2 / pi) asin(sqrt(x))
    expect(regularizedIncompleteBeta(0.3, 0.5, 0.5)).toBeCloseTo((2 / Math.PI) * Math.asin(Math.sqrt(0.3)), 10);
    expect(regularizedIncompleteBeta(0.8, 0.5, 0.5)).toBeCloseTo((2 / Math.PI) * Math.asin(Math.sqrt(0.8)), 10);
    // I_x(a, 1) = x^a
    expect(regularizedIncompleteBeta(0.6, 2.5, 1)).toBeCloseTo(0.6 ** 2.5, 10);
    expect(regularizedIncompleteBeta(0.4, 1, 3.5)).toBeCloseTo(1 - 0.6 ** 3.5, 10);
    // small parameters: I_x(a, 1) = x^a, I_x(1, b) = 1 - (1 - x)^b
    for (const a of [0.01, 0.05, 0.1, 0.3, 0.45]) {
      expect(regularizedIncompleteBeta(0.4, a, 1)).toBeCloseTo(0.4 ** a, 10);
      expect(regularizedIncompleteBeta(0.7, 1, a)).toBeCloseTo(1 - 0.3 ** a, 10);
    }
    // I_x(a, b) + I_(1-x)(b, a) = 1 for small parameters too
    expect(regularizedIncompleteBeta(0.35, 0.2, 0.3) + regularizedIncompleteBeta(0.65, 0.3, 0.2)).toBeCloseTo(1, 10);
    expect(regularizedIncompleteBeta(0.5, 0.3, 0.3)).toBeCloseTo(0.5, 10);
    expect(() => regularizedIncompleteBeta(-0.1, 1, 1)).toThrow(/x must be between 0 and 1/);
    expect(() => regularizedIncompleteBeta(1.1, 1, 1)).toThrow(/x must be between 0 and 1/);
    expect(() => regularizedIncompleteBeta(0.5, 0, 1)).toThrow(/positive/);
    expect(() => regularizedIncompleteBeta(0.5, 1, -1)).toThrow(/positive/);
    expect(() => regularizedIncompleteBeta(0.5, 1, 0)).toThrow(/positive/);
    expect(() => regularizedIncompleteBeta(0.5, Number.POSITIVE_INFINITY, 1)).toThrow(/finite/);
    expect(() => regularizedIncompleteBeta(0.5, 1, Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => regularizedIncompleteBeta(Number.NaN, 1, 1)).toThrow(/x must be between 0 and 1/);
  });

  it("CFM1.12 the Clopper-Pearson bound matches published one-sided 95% limits", () => {
    expect(clopperPearsonUpper(0, 10, 0.05)).toBe(1 - 0.05 ** (1 / 10));
    expect(clopperPearsonUpper(0, 10, 0.05)).toBeCloseTo(0.2589, 4);
    // upper limits of the 90% two-sided exact intervals (R: binom.test(k, n, conf.level = 0.9)$conf.int), summed exactly from the binomial
    expect(clopperPearsonUpper(1, 10, 0.05)).toBeCloseTo(0.3941633, 6);
    expect(clopperPearsonUpper(5, 10, 0.05)).toBeCloseTo(0.7775589, 6);
    expect(clopperPearsonUpper(3, 20, 0.05)).toBeCloseTo(0.3436638, 6);
    expect(clopperPearsonUpper(2, 30, 0.05)).toBeCloseTo(0.195326, 6);
    expect(clopperPearsonUpper(90, 100, 0.05)).toBeCloseTo(0.9447368, 6);
    // the "rule of three": no errors in n trials, upper limit near 3 / n
    expect(clopperPearsonUpper(0, 300, 0.05)).toBeCloseTo(0.0099361, 6);
    expect(clopperPearsonUpper(10, 10, 0.05)).toBe(1);
  });

  it("CFM1.13 the Clopper-Pearson bound is the probability at which seeing at most that many errors has probability delta", () => {
    for (const [k, n] of [[1, 10], [5, 10], [2, 30], [7, 50], [30, 100], [90, 100]] as const) {
      for (const delta of [0.01, 0.05, 0.2, 0.5]) expect(binomialCdf(k, n, clopperPearsonUpper(k, n, delta))).toBeCloseTo(delta, 7);
    }
  });

  it("CFM1.14 the Clopper-Pearson bound refuses what is not a count of errors or a level", () => {
    expect(() => clopperPearsonUpper(1, 0, 0.05)).toThrow(/n must be a positive whole number/);
    expect(() => clopperPearsonUpper(11, 10, 0.05)).toThrow(/errors/);
    expect(() => clopperPearsonUpper(-1, 10, 0.05)).toThrow(/errors/);
    expect(() => clopperPearsonUpper(1, 10, 1)).toThrow(/delta/);
  });
});

describe("selective threshold", () => {
  const options = { targetRisk: 0.05, delta: 0.05, bound: "hoeffding" } as const;

  it("CFM1.15 the threshold is the lowest confidence at which the bound on the risk still holds, stopping at the first failure", () => {
    const samples = [...group(2000, 0.9, 20), ...group(1000, 0.8, 20), ...group(1000, 0.5, 300)];
    const out = selectiveThreshold(samples, options);
    expect(out.threshold).toBe(0.8);
    expect(out.n).toBe(3000);
    expect(out.coverage).toBeCloseTo(0.75, 12);
    expect(out.risk).toBeCloseTo(40 / 3000, 12);
    expect(out.upperBound).toBeCloseTo(40 / 3000 + Math.sqrt(Math.log(20) / 6000), 12);
    expect(selectiveThreshold(samples.slice(0, 2000), options).threshold).toBe(0.9);
  });

  it("CFM1.16 a lower confidence that would pass again after a failure is not reached", () => {
    const samples = [...group(2000, 0.9, 0), ...group(400, 0.7, 300), ...group(100000, 0.5, 0)];
    const out = selectiveThreshold(samples, options);
    expect(out.threshold).toBe(0.9);
    expect(out.n).toBe(2000);
  });

  it("CFM1.17 samples with equal confidence enter together", () => {
    const samples = [...group(1000, 0.9, 0), ...group(2000, 0.6, 0), ...group(500, 0.3, 500)];
    expect(selectiveThreshold(samples, options).threshold).toBe(0.6);
    expect(selectiveThreshold(samples, options).n).toBe(3000);
    const shuffled = [...samples].reverse();
    expect(selectiveThreshold(shuffled, options)).toEqual(selectiveThreshold(samples, options));
  });

  it("CFM1.18 thresholds at which even no errors could not meet the target are passed over rather than counted as failures", () => {
    const n = 3000;
    const samples = Array.from({ length: n }, (_, i) => ({ confidence: (i + 1) / n, correct: (i + 1) / n >= 0.5 || i % 2 === 0 }));
    const out = selectiveThreshold(samples, options);
    expect(out.threshold).toBeDefined();
    expect(out.n).toBeGreaterThan(1500);
    expect(out.upperBound).toBeLessThanOrEqual(0.05);
    // the oracle: every threshold, from the top, with the same rule written out plainly
    let best: number | undefined;
    for (let i = n - 1; i >= 0; i--) {
      const k = n - i;
      const errors = samples.slice(i).filter((x) => !x.correct).length;
      const ub = errors / k + Math.sqrt(Math.log(20) / (2 * k));
      const floor = Math.sqrt(Math.log(20) / (2 * k));
      if (floor > 0.05) continue;
      if (ub > 0.05) break;
      best = samples[i]!.confidence;
    }
    expect(out.threshold).toBe(best);
  });

  it("CFM1.19 with no threshold that passes, nothing is accepted", () => {
    const empty = { threshold: undefined, coverage: 0, risk: 0, upperBound: 1, n: 0 };
    expect(selectiveThreshold(group(3000, 0.9, 1500), options)).toEqual(empty);
    expect(selectiveThreshold(group(10, 0.9, 0), options)).toEqual(empty);
    expect(selectiveThreshold([], options)).toEqual(empty);
    expect(selectiveThreshold([...group(2000, 0.9, 200), ...group(2000, 0.8, 0)], options)).toEqual(empty);
  });

  it("CFM1.20 the Clopper-Pearson bound is exact, so it accepts with far fewer samples than Hoeffding", () => {
    const cp = { targetRisk: 0.05, delta: 0.05, bound: "clopper-pearson" } as const;
    const out = selectiveThreshold(group(100, 0.9, 0), cp);
    expect(out.threshold).toBe(0.9);
    expect(out.upperBound).toBeCloseTo(1 - 0.05 ** 0.01, 12);
    expect(selectiveThreshold(group(100, 0.9, 0), options).threshold).toBeUndefined();
    expect(selectiveThreshold(group(100, 0.9, 0), { ...cp, targetRisk: 0.02 }).threshold).toBeUndefined();
    const some = selectiveThreshold([...group(300, 0.9, 3), ...group(300, 0.7, 30)], cp);
    expect(some.threshold).toBe(0.9);
    expect(some.upperBound).toBeCloseTo(clopperPearsonUpper(3, 300, 0.05), 12);
    expect(some.risk).toBeCloseTo(0.01, 12);
  });

  it("CFM1.23 a bound that just meets the target passes: the comparisons are at most, not below", () => {
    // one sample, no errors: the exact bound is 1 - 0.5 = 0.5, exactly the target
    const out = selectiveThreshold([{ confidence: 0.9, correct: true }], { targetRisk: 0.5, delta: 0.5, bound: "clopper-pearson" });
    expect(out).toEqual({ threshold: 0.9, coverage: 1, risk: 0, upperBound: 0.5, n: 1 });
  });

  it("CFM1.21 a target, a level, a bound or a confidence that cannot be right is refused", () => {
    const one = [{ confidence: 0.5, correct: true }];
    for (const targetRisk of [0, 1, Number.NaN]) expect(() => selectiveThreshold(one, { ...options, targetRisk })).toThrow(/targetRisk/);
    for (const delta of [0, 1, Number.NaN]) expect(() => selectiveThreshold(one, { ...options, delta })).toThrow(/delta/);
    expect(() => selectiveThreshold(one, { ...options, bound: "wilson" as never })).toThrow(/bound/);
    expect(() => selectiveThreshold([{ confidence: Number.NaN, correct: true }], options)).toThrow(/sample 0/);
    expect(() => riskCoverageCurve([{ confidence: Number.POSITIVE_INFINITY, correct: true }])).toThrow(/sample 0/);
  });

  it("CFM1.22 the risk-coverage curve lists each distinct confidence from the highest, with the coverage and risk of accepting down to it", () => {
    const curve = riskCoverageCurve([
      { confidence: 0.9, correct: true },
      { confidence: 0.9, correct: false },
      { confidence: 0.7, correct: true },
      { confidence: 0.4, correct: false },
    ]);
    expect(curve).toEqual([
      { threshold: 0.9, coverage: 0.5, risk: 0.5 },
      { threshold: 0.7, coverage: 0.75, risk: 1 / 3 },
      { threshold: 0.4, coverage: 1, risk: 0.5 },
    ]);
    expect(riskCoverageCurve([])).toEqual([]);
  });
});
