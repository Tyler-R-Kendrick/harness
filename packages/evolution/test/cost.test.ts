import { describe, expect, it } from "vitest";
import { advance, calibratedDecision, compare, measure, score, tokens } from "@harness/evolution";
import type { CalibratedRule, Measured, Measurement } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";

const opts = (seed = 1, alpha = 0.05, resamples = 2000) => ({ alpha, resamples, entropy: new SeededEntropy(seed) });

/** `n` tasks, one trial each (or `k`), with rewards and tokens from functions (tokens undefined: not reported). */
function withTokens(n: number, spent: (i: number, j: number) => number | undefined, k = 1, reward: (i: number) => number = () => 1, group?: (i: number) => string): Measurement {
  const ids = Array.from({ length: n }, (_, i) => `t${String(i).padStart(3, "0")}`);
  return measure(
    ids.map((id, i) => ({
      task: id,
      ...(group ? { group: group(i) } : {}),
      trials: Array.from({ length: k }, (_, j) => {
        const t = spent(i, j);
        return { reward: score(reward(i)), ...(t === undefined ? {} : { tokens: tokens(t) }) };
      }),
    })),
    ids,
    k,
  );
}

describe("bounds on the relative cost change, from the same paired randomization test", () => {
  it("RS19.1 when every task's tokens change by the same amount, the point change and both bounds are that share", () => {
    const inc = withTokens(20, () => 100);
    const cand = withTokens(20, () => 60);
    const c = compare(cand, inc, opts());
    expect(c.costChange).toBeCloseTo(-0.4, 12);
    expect(c.costLower).toBeCloseTo(-0.4, 12);
    expect(c.costUpper).toBeCloseTo(-0.4, 12);
  });

  it("RS19.2 when the tasks' token changes differ, the bounds bracket the point change and are wider for noisier tasks", () => {
    // Task i's tokens differ by +-(i mod 5) * 4 around 100: the mean change is 0.
    const inc = withTokens(60, () => 100);
    const noisy = withTokens(60, (i) => 100 + ((i % 5) - 2) * 20 + (i % 2 ? 3 : -3));
    const calm = withTokens(60, (i) => 100 + ((i % 5) - 2) * 2 + (i % 2 ? 3 : -3));
    const a = compare(noisy, inc, opts());
    const b = compare(calm, inc, opts());
    expect(a.costLower!).toBeLessThan(a.costChange!);
    expect(a.costUpper!).toBeGreaterThan(a.costChange!);
    expect(a.costUpper! - a.costLower!).toBeGreaterThan(2 * (b.costUpper! - b.costLower!));
    // Relative to the incumbent's 100 tokens a task.
    expect(a.costUpper!).toBeLessThan(0.5);
    expect(a.costLower!).toBeGreaterThan(-0.5);
  });

  it("RS19.3 a task's tokens are the mean of the trials that reported them, and a task with none on either side is left out", () => {
    // Task 0 reports one of two trials; task 1 reports nothing for the candidate; task 2 nothing for the incumbent.
    const inc = withTokens(8, (i, j) => (i === 2 ? undefined : i === 0 && j === 1 ? undefined : 100), 2);
    const cand = withTokens(8, (i, j) => (i === 1 ? undefined : i === 0 ? (j === 0 ? 50 : undefined) : 100), 2);
    const c = compare(cand, inc, opts());
    // Only task 0 differs (50 against 100), among the 6 tasks that report on both sides: 6 groups, exact test at 5%.
    // Of the 63 nonempty sets of flipped tasks the 3rd smallest mean is -25 (task 0 with one other), and the largest are 0.
    expect(c.costLower).toBeCloseTo(-0.25, 12);
    expect(c.costUpper).toBeCloseTo(0, 12);
    // Leaving the unpaired tasks out is not the same as counting them as 0: the same data with them made equal gives the same bounds.
    const same = compare(
      withTokens(6, (i, j) => (i === 0 ? (j === 0 ? 50 : undefined) : 100), 2),
      withTokens(6, (i, j) => (i === 0 && j === 1 ? undefined : 100), 2),
      opts(),
    );
    expect(c.costLower).toBeCloseTo(same.costLower!, 12);
    expect(c.costUpper).toBeCloseTo(same.costUpper!, 12);
  });

  it("RS19.4 with too few tasks left to reject anything the cost bounds are the widest possible: no fall of at least 100%, no rise bounded", () => {
    const c = compare(withTokens(3, () => 10), withTokens(3, () => 100), opts());
    expect(c.costChange).toBeCloseTo(-0.9, 12);
    expect(c.costLower).toBe(-1);
    expect(c.costUpper).toBe(Number.POSITIVE_INFINITY);
    // Plenty of tasks, but none reports tokens on both sides.
    const disjoint = compare(
      withTokens(20, (i) => (i < 10 ? 100 : undefined)),
      withTokens(20, (i) => (i < 10 ? undefined : 100)),
      opts(),
    );
    expect(disjoint.costChange).toBeCloseTo(0, 12);
    expect(disjoint.costLower).toBe(-1);
    expect(disjoint.costUpper).toBe(Number.POSITIVE_INFINITY);
  });

  it("RS19.5 there are no cost bounds when a side reports no tokens at all", () => {
    const none = withTokens(20, () => undefined);
    const some = withTokens(20, () => 100);
    for (const c of [compare(some, none, opts()), compare(none, some, opts()), compare(none, none, opts())]) {
      expect(c.costChange).toBeUndefined();
      expect(c.costLower).toBeUndefined();
      expect(c.costUpper).toBeUndefined();
    }
  });

  it("RS19.6 tasks of a group flip together in the cost test too: a saving on two groups of ten is evidence about two groups", () => {
    const inc = withTokens(100, () => 100);
    const cand = (group?: (i: number) => string) => withTokens(100, (i) => (i < 20 ? 20 : 100), 1, () => 1, group);
    const flat = compare(cand(), inc, opts(1, 0.01));
    const grouped = compare(
      cand((i) => `g${Math.floor(i / 10)}`),
      withTokens(100, () => 100, 1, () => 1, (i) => `g${Math.floor(i / 10)}`),
      opts(1, 0.01),
    );
    expect(flat.costUpper!).toBeLessThan(0);
    expect(grouped.costUpper!).toBeGreaterThanOrEqual(0);
  });
});

const RULE: CalibratedRule = { rule: "calibrated", alpha: 0.1, resamples: 1000, margin: 0.01, saving: 0.05, beta0: 0.1, beta1: 40 };
const CTX = { drift: 0, certified: 0, anchor: { cost: 1000 } };

/** A candidate as selection sees it, with cost bounds given separately from the point change. */
const cand = (kind: Measured["kind"], gain: number, lower: number, cost: { change?: number; lower?: number; upper?: number }, extra: Partial<Measured> = {}): Measured => ({
  label: "X",
  kind,
  score: 0.5 + gain,
  gain,
  lower,
  upper: lower + 0.02,
  ...(cost.change === undefined ? {} : { costChange: cost.change }),
  ...(cost.lower === undefined ? {} : { costLower: cost.lower }),
  ...(cost.upper === undefined ? {} : { costUpper: cost.upper }),
  components: ["prompt"],
  guards: [],
  ...extra,
});

describe("a candidate is accepted on the intersection of its claims, each tested at the run's per-test level", () => {
  it("RS19.7 a gain is refused when its cost is clearly over budget (the lower cost bound above beta0 + beta1 lower), not when only the point estimate is", () => {
    // Budget 0.1 + 40 * 0.01 = 0.5.
    expect(calibratedDecision(cand("change", 0.03, 0.01, { change: 0.9, lower: 0.3, upper: 1.5 }), RULE, CTX)).toMatchObject({ admissible: true });
    expect(calibratedDecision(cand("change", 0.03, 0.01, { change: 0.6, lower: 0.51, upper: 0.7 }), RULE, CTX)).toMatchObject({ admissible: false, reason: "costs +60.0% tokens (at least +51.0% at the test's level); a gain of at least 0.0100 pays for +50.0%" });
    expect(calibratedDecision(cand("change", 0.03, 0.01, { change: 0.6, lower: 0.5, upper: 0.7 }), RULE, CTX).admissible).toBe(true);
    // No cost bounds: no cost claim to refuse.
    expect(calibratedDecision(cand("change", 0.03, 0.01, {}), RULE, CTX).admissible).toBe(true);
    expect(calibratedDecision(cand("change", 0.03, 0.01, { change: 0.6 }), RULE, CTX).admissible).toBe(true);
  });

  it("RS19.8 a saving needs its upper cost bound at or below -saving: a point saving that noise could explain is not one", () => {
    expect(calibratedDecision(cand("change", 0, -0.002, { change: -0.4, lower: -0.5, upper: -0.05 }), RULE, CTX)).toMatchObject({ admissible: true, reason: expect.stringMatching(/saves 40\.0% tokens, at least 5\.0% at the test's level/) });
    expect(calibratedDecision(cand("change", 0, -0.002, { change: -0.4, lower: -0.7, upper: -0.051 }), RULE, CTX).admissible).toBe(true);
    expect(calibratedDecision(cand("change", 0, -0.002, { change: -0.4, lower: -0.7, upper: -0.04 }), RULE, CTX)).toMatchObject({ admissible: false, reason: expect.stringMatching(/no supported gain .* and saves no more than 5\.0% tokens with confidence \(change -40\.0%, at most -4\.0%\)/) });
    expect(calibratedDecision(cand("change", 0, -0.002, { change: -0.4, lower: -1, upper: Number.POSITIVE_INFINITY }), RULE, CTX)).toMatchObject({ admissible: false, reason: expect.stringMatching(/at most unbounded\)/) });
    // A point change without bounds certifies nothing.
    expect(calibratedDecision(cand("change", 0, -0.002, { change: -0.4 }), RULE, CTX).admissible).toBe(false);
    expect(calibratedDecision(cand("change", 0, -0.002, {}), RULE, CTX).admissible).toBe(false);
  });

  it("RS19.9 a removal needs its upper cost bound at or below beta0: it may not be clearly costlier", () => {
    expect(calibratedDecision(cand("prune", -0.002, -0.005, { change: 0.05, lower: -0.2, upper: 0.1 }), RULE, CTX).admissible).toBe(true);
    expect(calibratedDecision(cand("prune", -0.002, -0.005, { change: 0.05, lower: -0.2, upper: 0.11 }), RULE, CTX)).toMatchObject({ admissible: false, reason: expect.stringMatching(/removing it costs \+5\.0% tokens \(up to \+11\.0% at the test's level\), more than \+10\.0%/) });
    // Unmeasured cost: nothing to refuse.
    expect(calibratedDecision(cand("prune", -0.002, -0.005, {}), RULE, CTX).admissible).toBe(true);
    // A point change without bounds: the cost is unknown, and a removal is not certified cheap.
    expect(calibratedDecision(cand("prune", -0.002, -0.005, { change: 0.05 }), RULE, CTX).admissible).toBe(false);
  });

  it("RS19.10 the cap against the base harness holds the upper bound of the cost, not the point estimate", () => {
    // The incumbent costs 1000 x 1.5; the candidate's point cost is 1650 (+10% on it), its upper bound +30% on the incumbent.
    const c = cand("change", 0.03, 0.05, { change: 0.1, lower: 0, upper: 0.3 }, { cost: 1650 });
    // Certified 0.01 + 0.05 pays for 0.1 + 40 * 0.06 = 2.5: fine either way. With nothing certified: allowed 0.1 + 40 * 0.05 = 2.1: still fine.
    expect(calibratedDecision(c, RULE, { ...CTX, certified: 0 }).admissible).toBe(true);
    // A tighter rule: allowed 0.1 + 4 * 0.05 = 0.3 against a total of at most 1.5 * 1.3 - 1 = +95%.
    const tight = { ...RULE, beta1: 4 };
    expect(calibratedDecision(c, tight, CTX)).toMatchObject({ admissible: false, reason: expect.stringMatching(/the harness would spend up to \+95\.0% tokens over the base harness, more than the \+30\.0% its certified gain pays for/) });
    // The point estimate alone (+65%) would have said the same here; with a saving's point it would not.
    const noisy = cand("change", 0.03, 0.05, { change: 0.02, lower: -0.1, upper: 0.3 }, { cost: 1530 });
    expect(calibratedDecision(noisy, { ...RULE, beta1: 10 }, CTX)).toMatchObject({ admissible: false, reason: expect.stringMatching(/up to \+/) });
  });

  it("RS19.19 a change of -100% in the cost has no ratio to bound the cap with: the cap uses the point cost, and does not say `up to`", () => {
    const free = cand("change", 0.03, 0.05, { change: -1, lower: -1, upper: -1 }, { cost: 0 });
    expect(calibratedDecision(free, RULE, CTX).admissible).toBe(true);
    // The base harness costs 1000; 4100 is +310% against the 0.1 + 40 * 0.05 = 2.1 the gain pays for.
    const over = cand("change", 0.03, 0.05, { change: -1, lower: -1, upper: -1 }, { cost: 4100 });
    expect(calibratedDecision(over, RULE, CTX)).toMatchObject({ admissible: false, reason: "the harness would spend +310.0% tokens over the base harness, more than the +210.0% its certified gain pays for" });
  });

  it("RS19.11 advance() moves the loss counter and the certified total by an accepted step's lower bound", () => {
    const near = (a: { drift: number; certified: number }, drift: number, certified: number) => {
      expect(a.drift).toBeCloseTo(drift, 12);
      expect(a.certified).toBeCloseTo(certified, 12);
    };
    near(advance({ drift: 0.004, certified: 0.02 }, -0.003), 0.007, 0.017);
    near(advance({ drift: 0.004, certified: 0.02 }, 0.003), 0.001, 0.023);
    near(advance({ drift: 0.004, certified: 0.02 }, 0.5), 0, 0.52);
  });
});
