import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { SeededEntropy } from "@harness/testkit";
import { doublyRobust, epsilonGreedy, ips, snips, uniform } from "../src/explore.ts";
import type { OffPolicySample } from "../src/explore.ts";

const MEANS: readonly number[] = [0.2, 0.5, 0.8];
const OPTIONS: readonly number[] = [0, 1, 2];

/** Logs decisions of an epsilon-greedy policy (greedy: action 0) in a world where action a pays 1 with probability MEANS[a]. */
function log(n: number, seed: number, target: (action: number) => number, model?: (action: number) => number): OffPolicySample[] {
  const rng = uniform(new SeededEntropy(seed));
  return Array.from({ length: n }, () => {
    const { choice, propensity } = epsilonGreedy({ options: OPTIONS, greedy: 0, epsilon: 0.6, rng });
    const reward = rng() < MEANS[choice]! ? 1 : 0;
    const modelReward = model?.(choice);
    return { reward, propensity, targetProbability: target(choice), ...(modelReward === undefined ? {} : { modelReward, modelValue: OPTIONS.reduce((v, a) => v + target(a) * model!(a), 0) }) };
  });
}
const always = (action: number) => (a: number) => (a === action ? 1 : 0);
const within = (out: { estimate: number; standardError: number }, truth: number) => Math.abs(out.estimate - truth) <= 4 * out.standardError;

const counts = fc.integer({ min: 1, max: 9 });

describe("exploration properties", () => {
  test.prop([fc.uint8Array({ minLength: 7, maxLength: 7 })])("EXP2.1 a uniform draw is in [0, 1) whatever the bytes", (bytes) => {
    const u = uniform({ bytes: () => bytes })();
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(1);
  });

  it("EXP2.2 seeded uniform draws are evenly spread", () => {
    const rng = uniform(new SeededEntropy(7));
    const buckets = new Array<number>(10).fill(0);
    const n = 20000;
    for (let i = 0; i < n; i++) buckets[Math.floor(rng() * 10)]!++;
    for (const b of buckets) expect(Math.abs(b / n - 0.1)).toBeLessThan(5 * Math.sqrt((0.1 * 0.9) / n));
  });

  test.prop([counts, fc.double({ min: 1e-6, max: 1, noNaN: true }), fc.nat()])("EXP2.3 the propensities of the options sum to one", (k, epsilon, greedyAt) => {
    const options = Array.from({ length: k }, (_, i) => `o${i}`);
    const greedy = options[greedyAt % k]!;
    let total = 0;
    for (let j = 0; j < k; j++) {
      const out = epsilonGreedy({ options, greedy, epsilon, rng: (() => { const draws = [0, (j + 0.5) / k]; let i = 0; return () => draws[i++] ?? 0; })() });
      expect(out.choice).toBe(options[j]);
      total += out.propensity;
    }
    expect(total).toBeCloseTo(1, 9);
  });

  it("EXP2.4 the frequency of each choice matches its recorded propensity in a seeded simulation", () => {
    const rng = uniform(new SeededEntropy(11));
    const options = ["a", "b", "c", "d"];
    const seen = new Map<string, { n: number; propensity: number }>();
    const n = 40000;
    for (let i = 0; i < n; i++) {
      const out = epsilonGreedy({ options, greedy: "b", epsilon: 0.4, rng });
      const entry = seen.get(out.choice) ?? { n: 0, propensity: out.propensity };
      entry.n++;
      expect(out.propensity).toBe(entry.propensity);
      seen.set(out.choice, entry);
    }
    expect([...seen.keys()].sort()).toEqual(options);
    for (const { n: count, propensity } of seen.values()) expect(Math.abs(count / n - propensity)).toBeLessThan(5 * Math.sqrt((propensity * (1 - propensity)) / n));
  });

  it("EXP2.5 the share explored is epsilon in a seeded simulation", () => {
    const rng = uniform(new SeededEntropy(3));
    const n = 40000;
    let explored = 0;
    for (let i = 0; i < n; i++) if (epsilonGreedy({ options: ["a", "b"], greedy: "a", epsilon: 0.25, rng }).explored) explored++;
    expect(Math.abs(explored / n - 0.25)).toBeLessThan(5 * Math.sqrt((0.25 * 0.75) / n));
  });
});

describe("off-policy properties", () => {
  it("EXP2.6 IPS is unbiased in a large seeded simulation, for a target that explores and for one that does not", () => {
    for (const seed of [1, 2, 3]) {
      expect(within(ips(log(30000, seed, always(2))), 0.8)).toBe(true);
      expect(within(ips(log(30000, seed, always(1))), 0.5)).toBe(true);
      expect(within(ips(log(30000, seed, () => 1 / 3)), (0.2 + 0.5 + 0.8) / 3)).toBe(true);
    }
  });

  it("EXP2.7 self-normalized IPS and doubly robust agree with the truth in a large seeded simulation, even with a wrong model", () => {
    const wrong = () => 0.3;
    expect(within(snips(log(30000, 5, always(2))), 0.8)).toBe(true);
    expect(within(doublyRobust(log(30000, 5, always(2), wrong)), 0.8)).toBe(true);
    expect(within(doublyRobust(log(30000, 6, always(1), (a) => MEANS[a]!)), 0.5)).toBe(true);
  });

  it("EXP2.8 a right model shrinks the standard error below IPS", () => {
    const samples = log(30000, 9, always(2), (a) => MEANS[a]!);
    expect(doublyRobust(samples).standardError).toBeLessThan(ips(samples).standardError);
  });

  it("EXP2.9 the standard error shrinks as evidence grows", () => {
    expect(ips(log(20000, 4, always(2))).standardError).toBeLessThan(ips(log(500, 4, always(2))).standardError);
  });

  const samples = fc.array(
    fc.record({ reward: fc.double({ min: 0, max: 1, noNaN: true }), propensity: fc.double({ min: 0.01, max: 1, noNaN: true }), targetProbability: fc.double({ min: 0, max: 1, noNaN: true }) }),
    { minLength: 2, maxLength: 30 },
  );

  test.prop([samples])("EXP2.10 self-normalized IPS stays within the rewards it averages", (ss) => {
    const out = snips(ss);
    if (out.effectiveSampleSize === 0) return;
    const rewards = ss.map((s) => s.reward);
    expect(out.estimate).toBeGreaterThanOrEqual(Math.min(...rewards) - 1e-9);
    expect(out.estimate).toBeLessThanOrEqual(Math.max(...rewards) + 1e-9);
  });

  test.prop([samples])("EXP2.11 the effective sample size is between 0 and n, and a clip above every weight changes nothing", (ss) => {
    const out = ips(ss);
    expect(out.effectiveSampleSize).toBeGreaterThanOrEqual(0);
    expect(out.effectiveSampleSize).toBeLessThanOrEqual(ss.length + 1e-9);
    expect(ips(ss, { clip: 1e9 })).toEqual(out);
  });

  test.prop([samples, fc.double({ min: 0.1, max: 5, noNaN: true })])("EXP2.12 clipping never raises a weight, so it never raises IPS for non-negative rewards", (ss, clip) => {
    expect(ips(ss, { clip }).estimate).toBeLessThanOrEqual(ips(ss).estimate + 1e-9);
  });
});
