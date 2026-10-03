import { describe, expect, it } from "vitest";
import type { Entropy } from "@harness/core";
import { compare, measure, noiseBand, score, tokens } from "@harness/evolution";
import type { Measurement, TaskRun } from "@harness/evolution";

/** An entropy port that serves a fixed stream (cycling it), and records the lengths it was asked for. */
function fixed(stream: readonly number[]): Entropy & { readonly asked: number[] } {
  let at = 0;
  const asked: number[] = [];
  return {
    asked,
    bytes(length: number): Uint8Array {
      asked.push(length);
      return Uint8Array.from({ length }, () => stream[at++ % stream.length]!);
    },
  };
}

const LOW = [0, 0, 0, 0]; // a draw just above 0: below one half
const HIGH = [255, 255, 255, 255]; // a draw just below 1: not below one half

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `t${String(i).padStart(2, "0")}`);

interface Spec {
  readonly rewards: readonly number[];
  readonly tokens?: readonly number[];
  readonly group?: string;
}

/** A measurement of tasks t00, t01, ... each with the given rewards (and tokens, per trial). */
function measurement(specs: readonly Spec[], k = specs[0]!.rewards.length): Measurement {
  const names = ids(specs.length);
  const runs = specs.map((s, i): TaskRun => ({
    task: names[i]!,
    ...(s.group === undefined ? {} : { group: s.group }),
    trials: s.rewards.map((r, j) => ({ reward: score(r), ...(s.tokens?.[j] === undefined ? {} : { tokens: tokens(s.tokens[j]!) }) })),
  }));
  return measure(runs, names, k);
}

const same = (n: number, reward: number, extra: Partial<Spec> = {}): Spec[] => Array.from({ length: n }, () => ({ rewards: [reward], ...extra }));
const base = { alpha: 0.25, resamples: 100 };
const entropy = (): Entropy => fixed([1, 2, 3, 4]);

describe("compare: the level, the tasks, and what is reported", () => {
  it("RS22.30 an alpha of zero, below zero or at one half is refused, naming it", () => {
    const m = measurement(same(3, 0));
    const run = (alpha: number) => () => compare(m, m, { alpha, resamples: 1000, entropy: entropy() });
    expect(run(0)).toThrow("alpha must be in (0, 0.5), not 0");
    expect(run(-0.1)).toThrow("alpha must be in (0, 0.5), not -0.1");
    expect(run(0.5)).toThrow("alpha must be in (0, 0.5), not 0.5");
    expect(run(0.25)).not.toThrow();
  });

  it("RS22.31 two harnesses measured on tasks with different names do not compare, even when only one name differs", () => {
    const a = measurement(same(4, 0));
    const b = measure(
      [{ task: "t00", trials: [{ reward: score(0) }] }, { task: "t01", trials: [{ reward: score(0) }] }, { task: "t02", trials: [{ reward: score(0) }] }, { task: "u03", trials: [{ reward: score(0) }] }],
      ["t00", "t01", "t02", "u03"],
      1,
    );
    expect(() => compare(a, b, { ...base, entropy: entropy() })).toThrow("a comparison needs both harnesses measured on the same tasks");
    expect(() => compare(b, a, { ...base, entropy: entropy() })).toThrow("a comparison needs both harnesses measured on the same tasks");
    expect(() => compare(a, a, { ...base, entropy: entropy() })).not.toThrow();
  });

  it("RS22.32 a comparison on a single group has no spread to report: its standard error is exactly 0, and its bounds are the widest", () => {
    const c = compare(measurement([{ rewards: [0.5] }]), measurement([{ rewards: [0] }]), { ...base, entropy: entropy() });
    expect(c.se).toBe(0);
    expect(c.lower).toBe(-1);
    expect(c.upper).toBe(1);
    expect(c.groups).toBe(1);
  });

  it("RS22.33 without tokens on either side, no cost fields are present at all", () => {
    const c = compare(measurement(same(3, 0.5)), measurement(same(3, 0)), { ...base, entropy: entropy() });
    expect(Object.keys(c).sort()).toEqual(["alpha", "gain", "groups", "lower", "se", "tasks", "upper"]);
  });

  it("RS22.34 a measurement without a cost asks the entropy for nothing for the cost test", () => {
    // 15 groups: the score test is Monte Carlo, 100 resamples of 15 draws is 1500 draws, two blocks of 1024.
    const tokenSpecs = (reward: number): Spec[] => Array.from({ length: 15 }, () => ({ rewards: [reward], tokens: [100] }));
    const inc = measurement(tokenSpecs(0));
    const { cost: _cost, ...candidate } = measurement(tokenSpecs(0.5));
    const port = fixed([1, 2, 3, 4]);
    const c = compare(candidate, inc, { ...base, entropy: port });
    expect(c.costChange).toBeUndefined();
    expect(port.asked).toEqual([4096, 4096]);
  });
});

describe("compare: the Monte Carlo test, exactly", () => {
  // 15 groups (more than 14): t_g gains (g + 1) / 20. Each resample is 15 draws, one per group: LOW flips (includes) it.
  const draws = (...patterns: number[][]): number[] =>
    patterns.flatMap((included) => Array.from({ length: 15 }, (_, g) => (included.includes(g) ? LOW : HIGH)).flat());
  const gains = Array.from({ length: 15 }, (_, g) => ({ rewards: [(g + 1) / 20] }));
  const cand = measurement(gains);
  const inc = measurement(same(15, 0));
  // Resample means: {0, 1}: (0.05 + 0.10) / 2 = 0.075; {14}: 0.75; {2, 3, 4, 5}: 0.225; {}: nothing flipped; {0}: 0.05.
  const stream = draws([0, 1], [14], [2, 3, 4, 5], [], [0]);

  it("RS22.35 four resamples use four draws of 15, and the bounds are the quantiles of what flipped", () => {
    // rank = floor(0.4 * (4 + 1)) - 1 draw that flipped nothing = 1: the lower bound is the smallest mean, the upper the largest.
    const c = compare(cand, inc, { alpha: 0.4, resamples: 4, entropy: fixed(stream) });
    expect(c.groups).toBe(15);
    expect(c.lower).toBeCloseTo(0.075, 12);
    expect(c.upper).toBeCloseTo(0.75, 12);
    // The sample standard deviation of 0.075, 0.225 and 0.75.
    expect(c.se).toBeCloseTo(Math.sqrt(0.25125 / 2), 12);
  });

  it("RS22.36 a draw below one half flips its group into the resample's mean", () => {
    // One resample would flip only group 14; with all groups kept out nothing flips and the widest bounds result.
    const none = compare(cand, inc, { alpha: 0.4, resamples: 4, entropy: fixed(draws([])) });
    expect(none.lower).toBe(-1);
    expect(none.upper).toBe(1);
    expect(none.se).toBe(0);
  });
});

describe("compare: costs", () => {
  it("RS22.40 a task's tokens are the mean of the trials that report any: a trial of 0 tokens reports nothing", () => {
    // Per task: the candidate's trials spend 0 and 200, the incumbent's 100 and 100: 200 against 100 reported, so +100%.
    const specs = (t: readonly number[]): Spec[] => Array.from({ length: 3 }, () => ({ rewards: [0, 0], tokens: t }));
    const c = compare(measurement(specs([0, 200])), measurement(specs([100, 100])), { alpha: 0.25, resamples: 100, entropy: entropy() });
    expect(c.costChange).toBeCloseTo(1, 12);
    expect(c.costLower).toBeCloseTo(1, 12);
    expect(c.costUpper).toBeCloseTo(1, 12);
  });

  it("RS22.41 a task whose trials all report 0 tokens is left out of the cost test", () => {
    // Three tasks; the candidate reports nothing on the third. Two tasks are left, too few to say anything at alpha 0.25.
    const cand = measurement([{ rewards: [0], tokens: [100] }, { rewards: [0], tokens: [100] }, { rewards: [0], tokens: [0] }]);
    const inc = measurement(same(3, 0, { tokens: [100] }));
    const c = compare(cand, inc, { alpha: 0.25, resamples: 100, entropy: entropy() });
    expect(c.costChange).toBeCloseTo(0, 12);
    expect(c.costLower).toBe(-1);
    expect(c.costUpper).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("noiseBand: the bootstrap, exactly", () => {
  // Two identical evaluations of two tasks: a constant task (0.5, 0.5) and one that went 0 then 1.
  const evaluation = measurement([{ rewards: [0.5, 0.5] }, { rewards: [0, 1] }]);
  // Pooled, the varying task has rewards 0, 1, 0, 1: four high draws pick an odd index (reward 1), four low draws index 0 (reward 0).
  const stream = [...HIGH, ...HIGH, ...HIGH, ...HIGH, ...LOW, ...LOW, ...LOW, ...LOW];

  it("RS22.50 a task whose rewards are all equal draws nothing, and the others draw once per reward", () => {
    // Two resamples: the second task's mean is 1 then 0, so the scores are (0.5 + 1) / 2 and (0.5 + 0) / 2.
    const band = noiseBand([evaluation, evaluation], { z: 2, resamples: 2, entropy: fixed(stream) });
    expect(band.method).toBe("bootstrap");
    // sd of 0.75 and 0.25 is sqrt(0.125); times sqrt(2); times sqrt(pooled k / first k) = sqrt(4 / 2).
    expect(band.sd).toBeCloseTo(Math.SQRT1_2 * 1, 12);
    expect(band.delta).toBeCloseTo(Math.SQRT2, 12);
  });

  it("RS22.51 the bootstrap's spread scales with the square root of how many more trials the pool has than one evaluation", () => {
    // One evaluation against two: the same draws in the same order, so only the factor differs.
    const one = noiseBand([evaluation], { z: 1, resamples: 2, entropy: fixed([...HIGH, ...HIGH, ...LOW, ...LOW]) });
    const two = noiseBand([evaluation, evaluation], { z: 1, resamples: 2, entropy: fixed(stream) });
    expect(one.sd).toBeCloseTo(Math.sqrt(0.125) * Math.SQRT2, 12);
    expect(two.sd / one.sd).toBeCloseTo(Math.SQRT2, 12);
  });
});
