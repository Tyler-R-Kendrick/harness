import { describe, expect, it } from "vitest";
import { MAX_FEEDBACK, measure, pool, score, tokens } from "@harness/evolution";
import { runs } from "./helpers.ts";

describe("measure(): validation, order, feedback", () => {
  it("RS23.20 an invalid trial is refused with every issue named by its field, separated by semicolons", () => {
    const bad = [{ task: "a", trials: [{ reward: score(1) }, { reward: 2, tokens: -1 } as never] }];
    expect(() => measure(bad, ["a"], 2)).toThrow(/^trial 1 of a is invalid: reward: [^;]+; tokens: [^;]+$/);
  });

  it("RS23.21 the tasks of a measurement come back sorted by id, whatever order they were asked for", () => {
    const m = measure(runs({ b: [1], a: [0], c: [1] }), ["c", "b", "a"], 1);
    expect(m.tasks.map((t) => t.task)).toEqual(["a", "b", "c"]);
  });

  it("RS23.22 of trials tied for the lowest reward, the feedback kept is the first one's", () => {
    const m = measure([{ task: "a", trials: [{ reward: score(1), feedback: "fine" }, { reward: score(0.5), feedback: "first" }, { reward: score(0.5), feedback: "second" }] }], ["a"], 3);
    expect(m.tasks[0]!.feedback).toBe("first");
  });

  it("RS23.23 feedback is cut at MAX_FEEDBACK characters, and a surrogate pair that starts earlier in the text is left alone", () => {
    const text = `\u{1F600}${"a".repeat(MAX_FEEDBACK + 500)}`;
    const m = measure([{ task: "a", trials: [{ reward: score(0), feedback: text }] }], ["a"], 1);
    expect(m.tasks[0]!.feedback).toBe(text.slice(0, MAX_FEEDBACK));
    expect(m.tasks[0]!.feedback).toHaveLength(MAX_FEEDBACK);
  });

  it("RS23.24 feedback cut inside a surrogate pair drops the orphaned half", () => {
    const text = `${"a".repeat(MAX_FEEDBACK - 1)}\u{1F600}b`;
    const m = measure([{ task: "a", trials: [{ reward: score(0), feedback: text }] }], ["a"], 1);
    expect(m.tasks[0]!.feedback).toBe("a".repeat(MAX_FEEDBACK - 1));
  });
});

describe("pool()", () => {
  it("RS23.25 pooling measurements pools each task's tokens, missing trials and mean reward", () => {
    const withTokens = (rewards: number[], spent: number[]) => ({ task: "a", trials: rewards.map((r, j) => ({ reward: score(r), tokens: tokens(spent[j]!) })) });
    const first = measure([withTokens([1, 0], [10, 20])], ["a"], 2);
    const second = measure([withTokens([1], [30])], ["a"], 2);
    const task = pool([first, second]).tasks[0]!;
    expect(task.rewards).toEqual([1, 0, 1, 0]);
    expect(task.tokens).toEqual([10, 20, 30]);
    expect(task.missing).toBe(1);
    expect(task.mean).toBe(0.5);
  });

  it("RS23.26 one measurement of different tasks among several is enough to refuse pooling", () => {
    const a = measure(runs({ a: [1] }), ["a"], 1);
    const other = measure(runs({ b: [1] }), ["b"], 1);
    expect(() => pool([a, a, other])).toThrow("measurements of different tasks do not pool");
    expect(() => pool([a, other, a])).toThrow("measurements of different tasks do not pool");
  });
});
