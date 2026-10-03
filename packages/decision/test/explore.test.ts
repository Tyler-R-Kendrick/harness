import { describe, expect, it } from "vitest";
import type { Entropy } from "@harness/core";
import { doublyRobust, epsilonGreedy, ips, snips, uniform } from "../src/explore.ts";
import type { ExplorerFn, OffPolicySample } from "../src/explore.ts";

const fixed = (...bytes: number[]): Entropy & { asked: number[] } => {
  const asked: number[] = [];
  return {
    asked,
    bytes(length: number) {
      asked.push(length);
      return Uint8Array.from({ length }, (_, i) => bytes[i] ?? 0);
    },
  };
};
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++] ?? 0;
};
const sample = (reward: number, propensity: number, targetProbability: number, extra: Partial<OffPolicySample> = {}): OffPolicySample => ({ reward, propensity, targetProbability, ...extra });

describe("uniform", () => {
  it("EXP1.1 a uniform draw takes seven bytes and uses 53 of their 56 bits", () => {
    const e = fixed(0x01, 0, 0, 0, 0, 0, 0);
    expect(uniform(e)()).toBe(2 ** 48 / 2 ** 53);
    expect(e.asked).toEqual([7]);
    expect(uniform(fixed(0, 0, 0, 0, 0, 0, 1))()).toBe(1 / 2 ** 53);
    expect(uniform(fixed(0, 0, 0, 0x80, 0, 0, 0))()).toBe(2 ** 31 / 2 ** 53);
    expect(uniform(fixed(0, 0, 1, 0, 0, 0, 0))()).toBe(2 ** 32 / 2 ** 53);
    expect(uniform(fixed(0, 1, 0, 0, 0, 0, 0))()).toBe(2 ** 40 / 2 ** 53);
    expect(uniform(fixed(0, 0, 0, 1, 0, 0, 0))()).toBe(2 ** 24 / 2 ** 53);
    expect(uniform(fixed(0, 0, 0, 0, 1, 0, 0))()).toBe(2 ** 16 / 2 ** 53);
    expect(uniform(fixed(0, 0, 0, 0, 0, 1, 0))()).toBe(2 ** 8 / 2 ** 53);
  });

  it("EXP1.2 a uniform draw is zero for zero bytes and never reaches one, whatever the bytes", () => {
    expect(uniform(fixed())()).toBe(0);
    expect(uniform(fixed(0xe0, 0, 0, 0, 0, 0, 0))()).toBe(0);
    const top = uniform(fixed(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff))();
    expect(top).toBe((2 ** 53 - 1) / 2 ** 53);
    expect(top).toBeLessThan(1);
  });

  it("EXP1.3 an entropy source that gives fewer bytes than asked is refused", () => {
    expect(() => uniform({ bytes: () => new Uint8Array(3) })()).toThrow(/7 bytes/);
  });
});

describe("epsilonGreedy", () => {
  const options = ["a", "b", "c"];

  it("EXP1.4 with no exploration the greedy option is chosen with certainty", () => {
    expect(epsilonGreedy({ options, greedy: "b", epsilon: 0, rng: sequence(0, 0) })).toEqual({ choice: "b", propensity: 1, explored: false });
  });

  it("EXP1.5 the random branch picks uniformly and records epsilon over K as the propensity of an option that is not the greedy one", () => {
    const out = epsilonGreedy({ options, greedy: "a", epsilon: 0.1, rng: sequence(0.05, 0.6) });
    expect(out.choice).toBe("b");
    expect(out.explored).toBe(true);
    expect(out.propensity).toBeCloseTo(0.1 / 3, 12);
  });

  it("EXP1.6 the random branch may pick the greedy option: it counts as explored and its propensity is one minus epsilon plus epsilon over K", () => {
    const out = epsilonGreedy({ options, greedy: "a", epsilon: 0.1, rng: sequence(0.05, 0.1) });
    expect(out.choice).toBe("a");
    expect(out.explored).toBe(true);
    expect(out.propensity).toBeCloseTo(0.9 + 0.1 / 3, 12);
  });

  it("EXP1.7 outside the random branch the greedy option is chosen with propensity one minus epsilon plus epsilon over K", () => {
    const out = epsilonGreedy({ options, greedy: "c", epsilon: 0.3, rng: sequence(0.9, 0.1) });
    expect(out.choice).toBe("c");
    expect(out.explored).toBe(false);
    expect(out.propensity).toBeCloseTo(0.7 + 0.1, 12);
  });

  it("EXP1.8 a draw equal to epsilon does not explore, and the random branch takes exactly one more draw", () => {
    expect(epsilonGreedy({ options, greedy: "a", epsilon: 0.5, rng: sequence(0.5, 0.99) }).explored).toBe(false);
    let draws = 0;
    epsilonGreedy({ options, greedy: "a", epsilon: 0.5, rng: () => (draws++, 0.1) });
    expect(draws).toBe(2);
    draws = 0;
    epsilonGreedy({ options, greedy: "a", epsilon: 0.5, rng: () => (draws++, 0.9) });
    expect(draws).toBe(1);
  });

  it("EXP1.9 with epsilon one every option is equally likely, and a single option is certain", () => {
    for (const [u, choice] of [[0, "a"], [0.34, "b"], [0.67, "c"], [0.999, "c"]] as const) {
      expect(epsilonGreedy({ options, greedy: "a", epsilon: 1, rng: sequence(0, u) })).toMatchObject({ choice, explored: true });
    }
    expect(epsilonGreedy({ options, greedy: "a", epsilon: 1, rng: sequence(0, 0.5) }).propensity).toBeCloseTo(1 / 3, 12);
    expect(epsilonGreedy({ options: ["only"], greedy: "only", epsilon: 1, rng: sequence(0, 0) })).toEqual({ choice: "only", propensity: 1, explored: true });
  });

  it("EXP1.10 a generator that breaks its contract and returns one still yields a real option", () => {
    expect(epsilonGreedy({ options, greedy: "a", epsilon: 1, rng: sequence(0, 1) }).choice).toBe("c");
  });

  it("EXP1.11 options that cannot be explored over, or an epsilon that is not a probability, are refused", () => {
    const rng = sequence();
    expect(() => epsilonGreedy({ options: [], greedy: "a", epsilon: 0.1, rng })).toThrow(/at least one option/);
    expect(() => epsilonGreedy({ options, greedy: "z", epsilon: 0.1, rng })).toThrow(/greedy option .*z.* is not among the options/);
    expect(() => epsilonGreedy({ options: ["a", "b", "a"], greedy: "a", epsilon: 0.1, rng })).toThrow(/more than once/);
    for (const epsilon of [-0.1, 1.1, Number.NaN]) expect(() => epsilonGreedy({ options, greedy: "a", epsilon, rng })).toThrow(/epsilon/);
  });

  it("EXP1.12 options are matched with the given comparison, so objects can be explored over", () => {
    const objects = [{ id: 1 }, { id: 2 }];
    const out = epsilonGreedy({ options: objects, greedy: { id: 2 }, epsilon: 0, rng: sequence(0), same: (x, y) => x.id === y.id });
    expect(out.choice).toBe(objects[1]);
    expect(() => epsilonGreedy({ options: objects, greedy: { id: 2 }, epsilon: 0, rng: sequence(0) })).toThrow(/not among the options/);
  });

  it("EXP1.13 the explorer type is the signature of epsilonGreedy, so a runner can inject another", () => {
    const explorer: ExplorerFn = epsilonGreedy;
    const fixedFirst: ExplorerFn = ({ options }) => ({ choice: options[0]!, propensity: epsilonGreedy({ options: ["x"], greedy: "x", epsilon: 0, rng: sequence(0) }).propensity, explored: true });
    expect(explorer({ options, greedy: "a", epsilon: 0, rng: sequence(0) }).choice).toBe("a");
    expect(fixedFirst({ options, greedy: "c", epsilon: 0, rng: sequence(0) }).choice).toBe("a");
  });
});

describe("off-policy estimators", () => {
  it("EXP1.14 IPS weights each reward by target over logging probability, and reports its standard error and effective sample size", () => {
    const out = ips([sample(1, 0.5, 1), sample(0, 0.5, 0)]);
    expect(out.estimate).toBe(1);
    expect(out.standardError).toBeCloseTo(1, 12);
    expect(out.n).toBe(2);
    expect(out.effectiveSampleSize).toBeCloseTo(1, 12);
  });

  it("EXP1.15 with the target equal to the logging policy IPS is the mean reward and every sample counts", () => {
    const out = ips([sample(1, 0.25, 0.25), sample(0, 0.5, 0.5), sample(1, 1, 1), sample(0, 0.1, 0.1)]);
    expect(out.estimate).toBeCloseTo(0.5, 12);
    expect(out.effectiveSampleSize).toBeCloseTo(4, 12);
    expect(out.standardError).toBeCloseTo(Math.sqrt((4 * 0.25) / 3 / 4), 12);
  });

  it("EXP1.16 clipping caps weights at the given bound and lowers the effective sample size only through the weights", () => {
    const samples = [sample(1, 0.1, 0.5), sample(1, 0.5, 0.5)];
    expect(ips(samples).estimate).toBeCloseTo(3, 12);
    expect(ips(samples, { clip: 2 }).estimate).toBeCloseTo(1.5, 12);
    expect(ips(samples, { clip: 2 }).effectiveSampleSize).toBeCloseTo(9 / 5, 12);
    expect(ips(samples, { clip: 10 }).estimate).toBeCloseTo(3, 12);
  });

  it("EXP1.17 a single sample has no standard error", () => {
    expect(ips([sample(1, 0.5, 0.5)]).standardError).toBe(Number.POSITIVE_INFINITY);
    expect(snips([sample(1, 0.5, 0.5)]).standardError).toBe(Number.POSITIVE_INFINITY);
    expect(doublyRobust([sample(1, 0.5, 0.5)]).standardError).toBe(Number.POSITIVE_INFINITY);
  });

  it("EXP1.18 self-normalized IPS divides by the sum of weights, so it stays a mean of rewards", () => {
    const out = snips([sample(0.5, 0.5, 0.5), sample(1, 0.25, 0.5)]);
    expect(out.estimate).toBeCloseTo(2.5 / 3, 12);
    expect(out.standardError).toBeCloseTo(Math.sqrt(2 * ((0.5 - 2.5 / 3) ** 2 + (2 * (1 - 2.5 / 3)) ** 2)) / 3, 12);
    expect(out.effectiveSampleSize).toBeCloseTo(9 / 5, 12);
    expect(out.n).toBe(2);
    expect(snips([sample(0.5, 0.5, 0.5), sample(1, 0.25, 0.5)], { clip: 1 }).estimate).toBeCloseTo(1.5 / 2, 12);
  });

  it("EXP1.24 the self-normalized standard error corrects for the estimate having used the same samples: n over n - 1", () => {
    const samples = [sample(0.2, 0.5, 0.5), sample(0.6, 0.5, 0.25), sample(1, 0.25, 0.5)];
    const weights = [1, 0.5, 2];
    const estimate = (0.2 * 1 + 0.6 * 0.5 + 1 * 2) / 3.5;
    const residuals = [0.2, 0.6, 1].reduce((sum, r, i) => sum + (weights[i]! * (r - estimate)) ** 2, 0);
    expect(snips(samples).estimate).toBeCloseTo(estimate, 12);
    expect(snips(samples).standardError).toBeCloseTo(Math.sqrt((3 / 2) * residuals) / 3.5, 12);
  });

  it("EXP1.19 when the target never takes a logged action there is no evidence: zero effective samples and an infinite standard error", () => {
    expect(snips([sample(1, 0.5, 0), sample(0, 0.5, 0)])).toEqual({ estimate: 0, standardError: Number.POSITIVE_INFINITY, n: 2, effectiveSampleSize: 0 });
    expect(ips([sample(1, 0.5, 0), sample(0, 0.5, 0)])).toMatchObject({ estimate: 0, standardError: 0, effectiveSampleSize: 0 });
  });

  it("EXP1.20 doubly robust without a model is IPS", () => {
    const samples = [sample(1, 0.5, 1), sample(0, 0.25, 0), sample(0.5, 0.5, 0.5)];
    expect(doublyRobust(samples)).toEqual(ips(samples));
  });

  it("EXP1.21 doubly robust corrects the model by the weighted residual, and uses the model's value of the target when it has one", () => {
    const out = doublyRobust([sample(1, 0.5, 1, { modelReward: 0.6 }), sample(0, 0.5, 0, { modelReward: 0.2 })]);
    // terms: 0.6 + 2 * (1 - 0.6) = 1.4 and 0.2 + 0 * (0 - 0.2) = 0.2
    expect(out.estimate).toBeCloseTo(0.8, 12);
    expect(out.standardError).toBeCloseTo(Math.sqrt(((0.6 ** 2 + 0.6 ** 2) / 1) / 2), 12);
    const withValue = doublyRobust([sample(1, 0.5, 1, { modelReward: 0.6, modelValue: 0.9 }), sample(0, 0.5, 0, { modelReward: 0.2, modelValue: 0.1 })]);
    // terms: 0.9 + 2 * (1 - 0.6) = 1.7 and 0.1
    expect(withValue.estimate).toBeCloseTo(0.9, 12);
    expect(withValue.effectiveSampleSize).toBeCloseTo(1, 12);
    expect(withValue.n).toBe(2);
  });

  it("EXP1.22 doubly robust is exact whatever the weights when the model is exact", () => {
    const out = doublyRobust([sample(1, 0.1, 0.9, { modelReward: 1 }), sample(0.5, 0.9, 0.05, { modelReward: 0.5 }), sample(0, 0.3, 0.3, { modelReward: 0 })]);
    expect(out.estimate).toBeCloseTo(0.5, 12);
  });

  it("EXP1.23 samples that cannot be weighted are refused, naming the sample", () => {
    expect(() => ips([sample(1, 0, 0.5)])).toThrow(/sample 0: propensity 0/);
    expect(() => ips([sample(1, 0.5, 0.5), sample(1, 1.5, 0.5)])).toThrow(/sample 1: propensity 1.5/);
    expect(() => ips([sample(1, Number.NaN, 0.5)])).toThrow(/propensity/);
    expect(() => ips([sample(1, 0.5, 1.5)])).toThrow(/sample 0: targetProbability 1.5/);
    expect(() => ips([sample(1, 0.5, -0.1)])).toThrow(/targetProbability/);
    expect(() => ips([sample(1.5, 0.5, 0.5)])).toThrow(/sample 0: reward 1.5/);
    expect(() => ips([sample(-0.5, 0.5, 0.5)])).toThrow(/reward/);
    expect(() => ips([sample(1, 0.5, 0.5, { modelReward: 2 })])).toThrow(/sample 0: modelReward 2/);
    expect(() => ips([sample(1, 0.5, 0.5, { modelValue: 0.5 })])).toThrow(/modelValue without a modelReward/);
    expect(() => ips([sample(1, 0.5, 0.5, { modelReward: 0.5, modelValue: -1 })])).toThrow(/sample 0: modelValue -1/);
    expect(() => ips([])).toThrow(/at least one sample/);
    for (const clip of [0, -1, Number.NaN]) expect(() => ips([sample(1, 0.5, 0.5)], { clip })).toThrow(/clip/);
    expect(() => snips([sample(1, 0, 0.5)])).toThrow(/propensity/);
    expect(() => doublyRobust([sample(1, 0, 0.5)])).toThrow(/propensity/);
  });
});
