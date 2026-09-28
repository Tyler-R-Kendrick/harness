import { describe, expect, it } from "vitest";
import { compare, editBudget, measure, noiseBand, testLevel } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { Uniform } from "../src/random.ts";
import { measured, runs } from "./helpers.ts";

const opts = (seed = 1, alpha = 0.01, resamples = 2000) => ({ alpha, resamples, entropy: new SeededEntropy(seed) });

describe("paired comparison by an inverted randomization test", () => {
  it("RS2.1 the gain is the paired score difference on the same tasks; different task sets do not compare", () => {
    const inc = measured(10, 2, (i) => (i < 5 ? 1 : 0));
    const cand = measured(10, 2, (i) => (i < 7 ? 1 : 0));
    const c = compare(cand, inc, opts());
    expect(c.gain).toBeCloseTo(0.2, 12);
    expect(c.tasks).toBe(10);
    expect(c.groups).toBe(10);
    expect(c.alpha).toBe(0.01);
    expect(() => compare(measured(9, 2, () => 1), inc, opts())).toThrow(/same tasks/);
  });

  it("RS2.2 the same point gain spread over many tasks is supported, concentrated on two tasks it is not: the evidence is tasks, not trials", () => {
    // 100 tasks, no trial noise. Broad: +0.1 on 20 tasks. Concentrated: +1 on 2 tasks. Both gain 0.02.
    const inc = measured(100, 2, () => 0);
    const broad = compare(
      measured(100, 2, (i) => (i < 20 ? 0.1 : 0)),
      inc,
      opts(),
    );
    const narrow = compare(
      measured(100, 2, (i) => (i < 2 ? 1 : 0)),
      inc,
      opts(),
    );
    expect(broad.gain).toBeCloseTo(0.02, 12);
    expect(narrow.gain).toBeCloseTo(0.02, 12);
    expect(broad.lower).toBeGreaterThan(0);
    expect(narrow.lower).toBeLessThanOrEqual(0);
    expect(narrow.upper).toBeGreaterThan(broad.upper);
  });

  it("RS2.3 tasks in a group flip together: a gain in one practice area is evidence about one area, not ten tasks", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `t${String(i).padStart(3, "0")}`);
    const groups = Object.fromEntries(ids.map((id, i) => [id, `g${Math.floor(i / 10)}`]));
    const inc = measure(runs(Object.fromEntries(ids.map((id) => [id, [0, 0]])), undefined, groups), ids, 2);
    const cand = measure(runs(Object.fromEntries(ids.map((id, i) => [id, i < 10 ? [0.2, 0.2] : [0, 0]])), undefined, groups), ids, 2);
    const flat = measure(runs(Object.fromEntries(ids.map((id, i) => [id, i < 10 ? [0.2, 0.2] : [0, 0]]))), ids, 2);
    const flatInc = measure(runs(Object.fromEntries(ids.map((id) => [id, [0, 0]]))), ids, 2);
    const grouped = compare(cand, inc, opts());
    const ungrouped = compare(flat, flatInc, opts());
    expect(grouped.groups).toBe(10);
    expect(ungrouped.lower).toBeGreaterThan(0);
    expect(grouped.lower).toBeLessThanOrEqual(0);
  });

  it("RS2.4 trial noise is in each task's observed difference: two evaluations of one harness bracket zero, and the same measurement against itself is exactly zero", () => {
    // Two evaluations of one harness whose every trial succeeds with probability 1/2.
    const u = new Uniform(new SeededEntropy(8));
    const a = measured(40, 4, () => (u.next() < 0.5 ? 1 : 0));
    const b = measured(40, 4, () => (u.next() < 0.5 ? 1 : 0));
    const c = compare(b, a, opts(5, 0.05, 1000));
    expect(c.lower).toBeLessThan(0);
    expect(c.upper).toBeGreaterThan(0);
    expect(c.se).toBeGreaterThan(0);
    expect(compare(a, a, opts(5, 0.05, 1000))).toMatchObject({ gain: 0, lower: 0, upper: 0, se: 0 });
  });

  it("RS2.5 the relative cost change is (C' - C) / C, undefined when either side reports no tokens", () => {
    expect(compare(measured(4, 1, () => 1, 150), measured(4, 1, () => 1, 100), opts()).costChange).toBeCloseTo(0.5, 12);
    expect(compare(measured(4, 1, () => 1), measured(4, 1, () => 1, 100), opts()).costChange).toBeUndefined();
    expect(compare(measured(4, 1, () => 1, 100), measured(4, 1, () => 1), opts()).costChange).toBeUndefined();
  });

  it("RS2.6 a comparison is reproducible from its seed, and refuses levels its resamples cannot resolve", () => {
    const inc = measured(30, 2, (i, j) => (i * j) % 2);
    const cand = measured(30, 2, (i, j) => (i + j) % 2);
    expect(compare(cand, inc, opts(9))).toEqual(compare(cand, inc, opts(9)));
    expect(() => compare(cand, inc, opts(1, 0.001, 500))).toThrow(/at least 1000 resamples/);
    expect(() => compare(cand, inc, opts(1, 0.6))).toThrow(/alpha/);
    expect(() => compare(cand, inc, opts(1, 0))).toThrow(/alpha/);
  });

  it("RS2.7 a group of tasks is one unit of evidence: it is the same evidence as one task with their total weight and mean difference; with too few groups nothing is concluded", () => {
    const ids = ["a1", "a2", "b", "c", "d", "e", "f", "g"];
    const grouped = { a1: "a", a2: "a" } as Record<string, string>;
    const diffs: Record<string, number> = { a1: 1, a2: 0, b: 0.5, c: 0, d: 1, e: 0, f: 0.5, g: 1 };
    const both = (rewards: (id: string) => number, groups: Record<string, string>, only: readonly string[], weight: (id: string) => number = () => 1) =>
      measure(
        only.map((id) => ({ task: id, weight: weight(id), ...(groups[id] ? { group: groups[id] } : {}), trials: runs({ [id]: [rewards(id)] })[0]!.trials })),
        only,
        1,
      );
    const cand = both((id) => diffs[id]!, grouped, ids);
    const inc = both(() => 0, grouped, ids);
    // "a" as one task of weight 2 and mean difference 0.5 (the group's).
    const merged = ["a", ...ids.slice(2)];
    const one = both((id) => (id === "a" ? 0.5 : diffs[id]!), {}, merged, (id) => (id === "a" ? 2 : 1));
    const oneInc = both(() => 0, {}, merged, (id) => (id === "a" ? 2 : 1));
    const x = compare(cand, inc, opts(3, 0.05, 1000));
    const y = compare(one, oneInc, opts(3, 0.05, 1000));
    expect({ ...x, tasks: 0 }).toEqual({ ...y, tasks: 0 });
    expect(x.groups).toBe(7);
    // Two tasks cannot reject anything at 5%: a random sign vector flips none of them a quarter of the time.
    const two = compare(measured(2, 1, () => 1), measured(2, 1, () => 0), opts(4, 0.05, 1000));
    expect(two).toMatchObject({ gain: 1, lower: -1, upper: 1 });
  });
});

describe("the paper's noise band delta", () => {
  it("RS2.8 with repeated evaluations of the base harness, delta is z sqrt(2) times the sd of their scores", () => {
    const a = measured(10, 1, (i) => (i < 5 ? 1 : 0));
    const b = measured(10, 1, (i) => (i < 7 ? 1 : 0));
    const band = noiseBand([a, b], { z: 2, resamples: 200, entropy: new SeededEntropy(1) });
    expect(band.method).toBe("repeated");
    expect(band.delta).toBeCloseTo(2 * Math.SQRT2 * Math.SQRT1_2 * 0.2, 12);
  });

  it("RS2.9 with one evaluation (or identical ones), delta is bootstrapped over trials within tasks: task sampling is not in it", () => {
    const one = measured(40, 2, (i, j) => (i + j) % 2);
    const band = noiseBand([one], { z: 2, resamples: 2000, entropy: new SeededEntropy(1) });
    expect(band.method).toBe("bootstrap");
    // Each task's mean has sd 0.5/sqrt(2); the score's sd is that over sqrt(40).
    expect(band.delta).toBeCloseTo(2 * Math.SQRT2 * (0.5 / Math.SQRT2 / Math.sqrt(40)), 2);
    expect(noiseBand([one, one], { z: 2, resamples: 200, entropy: new SeededEntropy(1) }).method).toBe("bootstrap");
    // Tasks that always pass or always fail carry no trial noise, however different they are.
    expect(noiseBand([measured(40, 2, (i) => i % 2)], { z: 2, resamples: 200, entropy: new SeededEntropy(1) }).delta).toBe(0);
    expect(() => noiseBand([], { z: 2, resamples: 10, entropy: new SeededEntropy(1) })).toThrow(/no evaluations/);
  });
});

describe("schedules", () => {
  it("RS3.1 the edit budget anneals from b_max to b_min on a half cosine over the run's rounds (Eq. 4, with the deviation of RS19.47: it reaches b_min in the last round)", () => {
    const table = Array.from({ length: 20 }, (_, t) => editBudget(t, 20, 1, 4));
    for (let t = 0; t < 20; t++) expect(table[t]).toBe(Math.round(1 + 3 * 0.5 * (1 + Math.cos((Math.PI * t) / 19))));
    expect(table[0]).toBe(4);
    expect(table[19]).toBe(1);
    expect(table).toEqual([...table].sort((a, b) => b - a));
    expect(editBudget(20, 20, 1, 4)).toBe(1);
    expect(editBudget(25, 20, 1, 4)).toBe(1);
    expect(editBudget(-3, 20, 1, 4)).toBe(4);
    expect(editBudget(3, 0, 1, 4)).toBe(4);
  });

  it("RS3.2 every acceptance test of a run gets an equal share of the run's error rate (Bonferroni over T rounds of tests)", () => {
    expect(testLevel(0.1, 20, 3)).toBeCloseTo(0.1 / 60, 15);
    expect(() => testLevel(0.1, 0, 3)).toThrow(/rounds/);
    expect(() => testLevel(0.1, 20, 0)).toThrow(/tests/);
  });
});
