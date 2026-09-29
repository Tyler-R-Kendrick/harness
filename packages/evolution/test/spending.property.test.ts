import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isFutile, permute, prefixSize, roundLevel, testLevel } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";

const alpha = fc.double({ min: 0.001, max: 0.5, noNaN: true, maxExcluded: true });
const rounds = fc.integer({ min: 1, max: 80 });
const tests = fc.integer({ min: 1, max: 30 });
const ratio = fc.double({ min: 0.02, max: 0.98, noNaN: true });

describe("alpha-spending schedules (properties)", () => {
  it("RS14.20 the levels of all rounds, times the tests a round makes, sum to alpha whatever the schedule", () => {
    fc.assert(
      fc.property(alpha, rounds, tests, ratio, fc.boolean(), (a, T, m, r, geometric) => {
        const spending = geometric ? ({ kind: "geometric", ratio: r } as const) : ({ kind: "uniform" } as const);
        let total = 0;
        for (let t = 0; t < T; t++) total += m * roundLevel(a, t, T, m, spending);
        expect(Math.abs(total - a)).toBeLessThanOrEqual(1e-12 * Math.max(1, T));
      }),
      { numRuns: 300 },
    );
  });

  it("RS14.21 every level is positive and at most alpha; geometric levels fall by exactly the ratio from round to round; uniform levels are the same and equal testLevel", () => {
    fc.assert(
      fc.property(alpha, rounds, tests, ratio, (a, T, m, r) => {
        for (let t = 0; t < T; t++) {
          const g = roundLevel(a, t, T, m, { kind: "geometric", ratio: r });
          expect(g).toBeGreaterThan(0);
          expect(g).toBeLessThanOrEqual(a);
          expect(roundLevel(a, t, T, m, { kind: "uniform" })).toBe(testLevel(a, T, m));
          if (t > 0) {
            const before = roundLevel(a, t - 1, T, m, { kind: "geometric", ratio: r });
            expect(g).toBeLessThan(before);
            expect(g / before).toBeCloseTo(r, 9);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("RS14.22 the schedule depends on (round, rounds, tests) alone: the same arguments give the same level, so no data can move it", () => {
    fc.assert(
      fc.property(alpha, rounds, tests, ratio, fc.nat(), (a, T, m, r, at) => {
        const t = at % T;
        const spending = { kind: "geometric", ratio: r } as const;
        expect(roundLevel(a, t, T, m, spending)).toBe(roundLevel(a, t, T, m, { ...spending }));
      }),
      { numRuns: 100 },
    );
  });
});

describe("futility staging (properties)", () => {
  it("RS14.23 the prefix has at least one task, never more than there are, and is the smallest count covering the fraction", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.001, max: 0.999, noNaN: true }), fc.integer({ min: 1, max: 500 }), (f, n) => {
        const size = prefixSize(f, n);
        expect(size).toBeGreaterThanOrEqual(1);
        expect(size).toBeLessThanOrEqual(n);
        expect(size).toBeGreaterThanOrEqual(Math.min(n, f * n - 1e-6));
        expect(size - 1).toBeLessThan(f * n + 1e-6);
      }),
      { numRuns: 400 },
    );
  });

  it("RS14.24 a permutation keeps every task exactly once, is reproducible from its seed, and leaves its input alone", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 60 }), fc.integer({ min: 1, max: 1_000_000 }), (items, seed) => {
        const copy = [...items];
        const a = permute(items, new SeededEntropy(seed));
        expect(items).toEqual(copy);
        expect([...a].sort()).toEqual([...items].sort());
        expect(permute(items, new SeededEntropy(seed))).toEqual(a);
      }),
      { numRuns: 200 },
    );
  });

  it("RS14.25 futility is a strict threshold on the upper bound: a bound at or above -margin never stops, one below it always does", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 0.5, noNaN: true }), fc.double({ min: 1e-9, max: 1, noNaN: true }), (margin, d) => {
        expect(isFutile(-margin, margin)).toBe(false);
        expect(isFutile(-margin + d, margin)).toBe(false);
        expect(isFutile(-margin - d, margin)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
