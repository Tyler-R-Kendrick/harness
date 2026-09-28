import { describe, expect, it } from "vitest";
import { measure, pool, score, tokens } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { Uniform, laplace } from "../src/random.ts";
import { runs } from "./helpers.ts";

describe("scores, costs and measurements", () => {
  it("RS1.1 a score is a reward in [0, 1] and a cost is a finite number of tokens, made only by parsing", () => {
    expect(score(0.25)).toBe(0.25);
    expect(() => score(1.5)).toThrow(/not a score/);
    expect(() => score(-0.1)).toThrow(/not a score/);
    expect(tokens(12.5)).toBe(12.5);
    expect(() => tokens(-1)).toThrow(/not a number of tokens/);
    expect(() => tokens(Number.POSITIVE_INFINITY)).toThrow(/not a number of tokens/);
  });

  it("RS1.2 the score is the weighted mean reward over k trials of every task (Eq. 3)", () => {
    const m = measure(runs({ a: [1, 0], b: [1, 1] }), ["a", "b"], 2);
    expect(m.score).toBe(0.75);
    expect(m.expected).toBe(4);
    expect(m.missing).toBe(0);
    const weighted = measure(
      [
        { task: "a", weight: 10, trials: [{ reward: score(0.5) }, { reward: score(1) }] },
        { task: "b", weight: 90, trials: [{ reward: score(0) }, { reward: score(0) }] },
      ],
      ["a", "b"],
      2,
    );
    expect(weighted.score).toBeCloseTo(15 / 200, 12);
  });

  it("RS1.3 a missing trial counts 0 with the full denominator, so a harness cannot look better by losing the trials it finds hard", () => {
    const m = measure([{ task: "a", trials: [{ reward: score(1) }] }], ["a", "b"], 2);
    expect(m.score).toBe(0.25);
    expect(m.missing).toBe(3);
    expect(m.tasks.map((t) => t.rewards)).toEqual([[1, 0], [0, 0]]);
  });

  it("RS1.4 the cost is the mean policy tokens of the trials that report them, undefined when none do", () => {
    const m = measure([{ task: "a", trials: [{ reward: score(1), tokens: tokens(100) }, { reward: score(0), tokens: tokens(300) }] }, { task: "b", trials: [{ reward: score(0) }, { reward: score(0), tokens: tokens(0) }] }], ["a", "b"], 2);
    expect(m.cost).toBe(200);
    expect(measure(runs({ a: [1] }), ["a"], 1).cost).toBeUndefined();
  });

  it("RS1.5 runs that do not fit the tasks asked for are refused", () => {
    expect(() => measure(runs({ z: [1] }), ["a"], 1)).toThrow(/z was not asked for/);
    expect(() => measure(runs({ a: [1, 1, 1] }), ["a"], 2)).toThrow(/3 trials of a, more than k = 2/);
    expect(() => measure(runs({ a: [1] }), ["a"], 0)).toThrow(/k must be a positive integer/);
    expect(() => measure([{ task: "a", weight: 0, trials: [] }], ["a"], 1)).toThrow(/weight of a/);
    expect(() => measure([...runs({ a: [1] }), ...runs({ a: [0] })], ["a"], 2)).toThrow(/a twice/);
    expect(() => measure([], [], 1)).toThrow(/no tasks/);
  });

  it("RS1.6 a task keeps its group and the feedback of its worst trial", () => {
    const m = measure([{ task: "a", group: "g1", trials: [{ reward: score(1), feedback: "fine" }, { reward: score(0), feedback: "wrong file" }] }, { task: "b", trials: [{ reward: score(1) }] }], ["a", "b"], 2);
    expect(m.tasks[0]).toMatchObject({ task: "a", group: "g1", mean: 0.5, feedback: "wrong file" });
    expect(m.tasks[1]).toMatchObject({ task: "b", group: "b", mean: 0.5 });
    expect(m.tasks[1]!.feedback).toBeUndefined();
  });

  it("RS1.7 measurements of the same harness pool their trials; different task sets do not pool", () => {
    const a = measure(runs({ a: [1, 0], b: [1, 1] }), ["a", "b"], 2);
    const b = measure(runs({ a: [1, 1], b: [0, 0] }), ["a", "b"], 2);
    const p = pool([a, b]);
    expect(p.k).toBe(4);
    expect(p.score).toBe(5 / 8);
    expect(p.tasks[0]!.rewards).toEqual([1, 0, 1, 1]);
    expect(p.expected).toBe(8);
    expect(pool([a])).toBe(a);
    expect(() => pool([a, measure(runs({ a: [1] }), ["a"], 1)])).toThrow(/different tasks/);
    expect(() => pool([])).toThrow(/nothing to pool/);
  });
});

describe("randomness from the entropy port", () => {
  it("RS1.8 uniform draws are in [0, 1), reproducible from the seed, and indexes cover their range", () => {
    const u = new Uniform(new SeededEntropy(7));
    const draws = Array.from({ length: 5000 }, () => u.next());
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThan(1);
    expect(draws.reduce((s, x) => s + x, 0) / draws.length).toBeCloseTo(0.5, 1);
    const again = new Uniform(new SeededEntropy(7));
    expect(again.next()).toBe(draws[0]);
    const seen = new Set(Array.from({ length: 200 }, () => u.index(3)));
    expect([...seen].sort()).toEqual([0, 1, 2]);
  });

  it("RS1.9 Laplace noise is centered with mean absolute deviation equal to its scale", () => {
    const u = new Uniform(new SeededEntropy(3));
    const xs = Array.from({ length: 20000 }, () => laplace(u, 2));
    expect(xs.reduce((s, x) => s + x, 0) / xs.length).toBeCloseTo(0, 1);
    expect(xs.reduce((s, x) => s + Math.abs(x), 0) / xs.length).toBeCloseTo(2, 1);
    expect(laplace(u, 0)).toBe(0);
  });
});
