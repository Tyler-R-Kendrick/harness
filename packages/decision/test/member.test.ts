import { Experimental_EvaluationMockModelV4 as EvaluationMockModel } from "ai/test";
import { describe, expect, it } from "vitest";
import { probability } from "@harness/cognitive";
import type { JudgeAnswer, JudgeQuestion } from "@harness/cognitive";
import { answerOf, averageAnswers, evaluationMember, fromJudgeAnswer, rotateQuestion, rotations, toJudgeAnswer } from "../src/member.ts";
import { DecisionError } from "../src/types.ts";
import type { Answer } from "../src/types.ts";

const choice: JudgeQuestion = { type: "choice", instructions: "which?", criteria: { a: "the first", b: "the second", c: "the third" } };
const score: JudgeQuestion = { type: "score", instructions: "how good?", criteria: ["bad", "ok", "good", "great"] };
const bool: JudgeQuestion = { type: "boolean", instructions: "is it?" };
const p = probability;

/** Distributions equal option for option, to floating point. */
function expectClose(actual: Readonly<Record<string, number>>, expected: Readonly<Record<string, number>>): void {
  expect(Object.keys(actual)).toEqual(Object.keys(expected));
  for (const [key, value] of Object.entries(expected)) expect(actual[key]).toBeCloseTo(value, 12);
}

describe("answerOf", () => {
  it("MBR1.1 weights are normalized into a distribution whose top is the heaviest option", () => {
    const a = answerOf("choice", { a: 1, b: 3, c: 0 });
    expectClose(a.distribution, { a: 0.25, b: 0.75, c: 0 });
    expect(a.top).toBe("b");
    expect(a.type).toBe("choice");
    expect(a).not.toHaveProperty("score");
  });

  it("MBR1.2 a score answer carries the expected level", () => {
    const a = answerOf("score", { "0": 1, "1": 1, "2": 2 });
    expect(a.score).toBeCloseTo(0.25 * 1 + 0.5 * 2, 12);
    expect(a.top).toBe("2");
  });

  it("MBR1.3 equal weights make the first option the top", () => {
    expect(answerOf("choice", { x: 1, y: 1 }).top).toBe("x");
  });

  it("MBR1.4 weights that cannot be a distribution are refused", () => {
    expect(() => answerOf("choice", { a: -1, b: 2 })).toThrow(RangeError);
    expect(() => answerOf("choice", { a: 1 })).toThrow(/at least two options/);
    expect(() => answerOf("score", { low: 1, high: 1 })).toThrow(/whole number/);
  });
});

describe("fromJudgeAnswer", () => {
  it("MBR2.1 a boolean answer is a distribution over true and false", () => {
    const a = fromJudgeAnswer(bool, { type: "boolean", probability: p(0.8) });
    expect(a.distribution["true"]).toBeCloseTo(0.8, 12);
    expect(a.distribution["false"]).toBeCloseTo(0.2, 12);
    expect(Object.keys(a.distribution)).toEqual(["true", "false"]);
    expect(a.top).toBe("true");
    expect(a.type).toBe("boolean");
  });

  it("MBR2.2 a boolean at exactly one half has true on top", () => {
    expect(fromJudgeAnswer(bool, { type: "boolean", probability: p(0.5) }).top).toBe("true");
    expect(fromJudgeAnswer(bool, { type: "boolean", probability: p(0.2) }).top).toBe("false");
  });

  it("MBR2.3 a choice answer keeps its probabilities, in the question's option order", () => {
    const a = fromJudgeAnswer(choice, { type: "choice", choice: "b", probabilities: { c: p(0.1), b: p(0.6), a: p(0.3) } });
    expect(Object.keys(a.distribution)).toEqual(["a", "b", "c"]);
    expectClose(a.distribution, { a: 0.3, b: 0.6, c: 0.1 });
    expect(a.top).toBe("b");
  });

  it("MBR2.4 a choice answer without probabilities is one-hot on its choice", () => {
    const a = fromJudgeAnswer(choice, { type: "choice", choice: "c" });
    expectClose(a.distribution, { a: 0, b: 0, c: 1 });
    expect(a.top).toBe("c");
  });

  it("MBR2.5 probabilities that sum to one only within rounding are renormalized", () => {
    const a = fromJudgeAnswer(choice, { type: "choice", choice: "a", probabilities: { a: p(0.5), b: p(0.25), c: p(0.2500004) } });
    expect(Object.values(a.distribution).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
  });

  it("MBR2.6 a score answer with probabilities takes its expected level from them", () => {
    const a = fromJudgeAnswer(score, { type: "score", score: 1.5, probabilities: { "0": p(0.1), "1": p(0.4), "2": p(0.4), "3": p(0.1) } });
    expect(a.score).toBeCloseTo(1.5, 12);
    expect(a.top).toBe("1");
    expect(Object.keys(a.distribution)).toEqual(["0", "1", "2", "3"]);
  });

  it("MBR2.7 a score without probabilities spreads over the two neighboring levels with the score as its mean", () => {
    const a = fromJudgeAnswer(score, { type: "score", score: 1.25 });
    expectClose(a.distribution, { "0": 0, "1": 0.75, "2": 0.25, "3": 0 });
    expect(a.score).toBeCloseTo(1.25, 12);
    expect(a.top).toBe("1");
  });

  it("MBR2.8 a whole-number score without probabilities puts everything on its level, including the last", () => {
    expect(fromJudgeAnswer(score, { type: "score", score: 2 }).distribution).toEqual({ "0": 0, "1": 0, "2": 1, "3": 0 });
    const last = fromJudgeAnswer(score, { type: "score", score: 3 });
    expect(last.distribution).toEqual({ "0": 0, "1": 0, "2": 0, "3": 1 });
    expect(last.score).toBe(3);
    expect(fromJudgeAnswer(score, { type: "score", score: 0 }).distribution["0"]).toBe(1);
  });

  it("MBR2.9 an answer of another type than its question is refused, naming both", () => {
    expect(() => fromJudgeAnswer(bool, { type: "choice", choice: "a" })).toThrow(/choice answer.*boolean question/);
    expect(() => fromJudgeAnswer(choice, { type: "boolean", probability: p(1) })).toThrow(/boolean answer.*choice question/);
    expect(() => fromJudgeAnswer(score, { type: "choice", choice: "a" })).toThrow(/choice answer.*score question/);
    expect(() => fromJudgeAnswer(bool, { type: "score", score: 1 })).toThrow(/score answer.*boolean question/);
    expect(() => fromJudgeAnswer(choice, { type: "score", score: 1 })).toThrow(/score answer.*choice question/);
  });

  it("MBR2.10 a choice the question does not offer is refused", () => {
    expect(() => fromJudgeAnswer(choice, { type: "choice", choice: "z" })).toThrow(/"z"/);
  });

  it("MBR2.11 probabilities over other options than the question's are refused", () => {
    expect(() => fromJudgeAnswer(choice, { type: "choice", choice: "a", probabilities: { a: p(0.5), b: p(0.5) } })).toThrow("the answer is over options [a, b] but the question has [a, b, c]");
    expect(() => fromJudgeAnswer(choice, { type: "choice", choice: "a", probabilities: { a: p(0.5), b: p(0.25), z: p(0.25) } })).toThrow("the answer is over options [a, b, z] but the question has [a, b, c]");
    expect(() => fromJudgeAnswer(score, { type: "score", score: 1, probabilities: { "0": p(0.5), "1": p(0.5) } })).toThrow("the answer is over levels [0, 1] but the question has [0, 1, 2, 3]");
  });

  it("MBR2.12 a score outside the question's levels is refused", () => {
    expect(() => fromJudgeAnswer(score, { type: "score", score: 3.5 })).toThrow(/between 0 and 3/);
    expect(() => fromJudgeAnswer(score, { type: "score", score: -0.5 })).toThrow(/between 0 and 3/);
    expect(() => fromJudgeAnswer(score, { type: "score", score: Number.NaN })).toThrow(/between 0 and 3/);
  });

  it("MBR2.13 a question with one option cannot be a distribution", () => {
    expect(() => fromJudgeAnswer({ type: "choice", instructions: "", criteria: { only: "x" } }, { type: "choice", choice: "only" })).toThrow(/at least two options/);
  });
});

describe("toJudgeAnswer", () => {
  it("MBR3.1 a boolean answer becomes the probability of true", () => {
    const back = toJudgeAnswer(bool, fromJudgeAnswer(bool, { type: "boolean", probability: p(0.3) }));
    expect(back.type).toBe("boolean");
    expect(back.type === "boolean" && back.probability).toBeCloseTo(0.3, 12);
  });

  it("MBR3.2 a choice answer names its top with the distribution", () => {
    const back = toJudgeAnswer(choice, answerOf("choice", { a: 1, b: 6, c: 3 }));
    expect(back.type === "choice" && back.choice).toBe("b");
    expectClose(back.type === "choice" ? back.probabilities! : {}, { a: 0.1, b: 0.6, c: 0.3 });
  });

  it("MBR3.3 a score answer carries its expected level and the levels' probabilities", () => {
    const back = toJudgeAnswer(score, answerOf("score", { "0": 0, "1": 1, "2": 1, "3": 0 }));
    expect(back.type === "score" && back.score).toBeCloseTo(1.5, 12);
    expectClose(back.type === "score" ? back.probabilities! : {}, { "0": 0, "1": 0.5, "2": 0.5, "3": 0 });
  });

  it("MBR3.4 a score answer with no recorded level computes it from the distribution", () => {
    const answer = answerOf("score", { "0": 1, "1": 0, "2": 1, "3": 0 });
    const { score: _level, ...bare } = answer;
    const back = toJudgeAnswer(score, bare);
    expect(back.type === "score" && back.score).toBeCloseTo(1, 12);
  });

  it("MBR3.5 an answer over other options than the question's is refused, and so is one of another type", () => {
    expect(() => toJudgeAnswer(choice, answerOf("choice", { a: 1, b: 1 }))).toThrow(/options/);
    expect(() => toJudgeAnswer(bool, answerOf("boolean", { yes: 1, no: 1 }))).toThrow(/options/);
    expect(() => toJudgeAnswer(score, answerOf("score", { "0": 1, "1": 1 }))).toThrow(/levels/);
    expect(() => toJudgeAnswer(bool, answerOf("choice", { true: 1, false: 1 }))).toThrow(/choice answer.*boolean question/);
  });

  it("MBR3.6 the answers the AI SDK would validate come back as they went in", () => {
    const answers: [JudgeQuestion, JudgeAnswer][] = [
      [bool, { type: "boolean", probability: p(0.75) }],
      [choice, { type: "choice", choice: "c", probabilities: { a: p(0.125), b: p(0.25), c: p(0.625) } }],
      [score, { type: "score", score: 1.75, probabilities: { "0": p(0), "1": p(0.25), "2": p(0.75), "3": p(0) } }],
    ];
    for (const [q, a] of answers) {
      const back = toJudgeAnswer(q, fromJudgeAnswer(q, a));
      expect(back.type).toBe(a.type);
      if (back.type === "boolean" && a.type === "boolean") expect(back.probability).toBeCloseTo(a.probability, 12);
      if (back.type === "choice" && a.type === "choice") {
        expect(back.choice).toBe(a.choice);
        expectClose(back.probabilities!, a.probabilities!);
      }
      if (back.type === "score" && a.type === "score") {
        expect(back.score).toBeCloseTo(a.score, 12);
        expectClose(back.probabilities!, a.probabilities!);
      }
    }
  });
});

describe("rotateQuestion", () => {
  const order = (q: JudgeQuestion) => (q.type === "choice" ? Object.keys(q.criteria) : []);

  it("MBR4.1 the k-th rotation of a choice question moves its first k options to the end", () => {
    expect(order(rotateQuestion(choice, 0))).toEqual(["a", "b", "c"]);
    expect(order(rotateQuestion(choice, 1))).toEqual(["b", "c", "a"]);
    expect(order(rotateQuestion(choice, 2))).toEqual(["c", "a", "b"]);
  });

  it("MBR4.2 rotation wraps around, also for a negative k", () => {
    expect(order(rotateQuestion(choice, 4))).toEqual(["b", "c", "a"]);
    expect(order(rotateQuestion(choice, -1))).toEqual(["c", "a", "b"]);
  });

  it("MBR4.3 a rotation keeps every description with its option and the instructions", () => {
    const r = rotateQuestion(choice, 1);
    expect(r).toEqual(choice);
    expect(r.type === "choice" && r.criteria["a"]).toBe("the first");
    expect(r.instructions).toBe("which?");
  });

  it("MBR4.4 score and boolean questions are never rotated", () => {
    expect(rotateQuestion(score, 1)).toBe(score);
    expect(rotateQuestion(bool, 3)).toBe(bool);
  });

  it("MBR4.5 a rotation index that is not a whole number is refused", () => {
    expect(() => rotateQuestion(choice, 0.5)).toThrow("a rotation is a whole number, got 0.5");
    expect(() => rotateQuestion(choice, Number.NaN)).toThrow(RangeError);
  });

  it("MBR4.6 rotations lists distinct orders, the original first, at most as many as asked for", () => {
    expect(rotations(choice, 2).map(order)).toEqual([["a", "b", "c"], ["b", "c", "a"]]);
    expect(rotations(choice, 3).map(order)).toEqual([["a", "b", "c"], ["b", "c", "a"], ["c", "a", "b"]]);
    expect(rotations(choice, 10)).toHaveLength(3);
  });

  it("MBR4.7 a question that cannot be rotated has just itself", () => {
    expect(rotations(score, 4)).toEqual([score]);
    expect(rotations(bool, 4)).toEqual([bool]);
  });

  it("MBR4.8 options named by whole numbers cannot be reordered, so there is one rotation", () => {
    const numbered: JudgeQuestion = { type: "choice", instructions: "n", criteria: { "1": "one", "2": "two" } };
    expect(rotations(numbered, 2)).toHaveLength(1);
  });

  it("MBR4.9 a count below one is refused", () => {
    expect(() => rotations(choice, 0)).toThrow("the number of rotations is a whole number from 1, got 0");
    expect(() => rotations(choice, 1.5)).toThrow(RangeError);
  });
});

describe("averageAnswers", () => {
  it("MBR5.1 the mean of two distributions is their pointwise mean, in the first's option order", () => {
    const m = averageAnswers([answerOf("choice", { a: 1, b: 0, c: 0 }), answerOf("choice", { c: 1, b: 0, a: 0 })]);
    expectClose(m.distribution, { a: 0.5, b: 0, c: 0.5 });
    expect(Object.keys(m.distribution)).toEqual(["a", "b", "c"]);
    expect(m.top).toBe("a");
  });

  it("MBR5.2 a single answer averages to itself", () => {
    const a = answerOf("choice", { a: 1, b: 3 });
    expect(averageAnswers([a])).toEqual(a);
  });

  it("MBR5.3 the mean of score answers has the mean expected level", () => {
    const m = averageAnswers([answerOf("score", { "0": 1, "1": 0 }), answerOf("score", { "0": 0, "1": 1 })]);
    expect(m.score).toBeCloseTo(0.5, 12);
  });

  it("MBR5.4 nothing to average is refused", () => {
    expect(() => averageAnswers([])).toThrow("there are no answers to average");
  });

  it("MBR5.5 answers over different options are refused", () => {
    expect(() => averageAnswers([answerOf("choice", { a: 1, b: 1 }), answerOf("choice", { a: 1, c: 1 })])).toThrow(/same options/);
    expect(() => averageAnswers([answerOf("choice", { a: 1, b: 1 }), answerOf("choice", { a: 1, b: 1, c: 1 })])).toThrow(/same options/);
  });

  it("MBR5.6 answers of different types are refused", () => {
    const a: Answer = answerOf("choice", { "0": 1, "1": 1 });
    expect(() => averageAnswers([a, answerOf("score", { "0": 1, "1": 1 })])).toThrow(/types/);
  });
});

describe("evaluationMember", () => {
  const model = (answer: (id: string, q: JudgeQuestion) => unknown) => {
    const calls: { questions: Record<string, JudgeQuestion>; state: unknown; retriesSeen: number }[] = [];
    const mock = new EvaluationMockModel({
      modelId: "double",
      doEvaluate: async (options) => {
        calls.push({ questions: options.questions as Record<string, JudgeQuestion>, state: options.state, retriesSeen: calls.length });
        return { answers: Object.fromEntries(Object.entries(options.questions).map(([id, q]) => [id, answer(id, q as JudgeQuestion) as never])), warnings: [] };
      },
    });
    return { mock, calls };
  };

  it("MBR6.1 the member has the id and pinned version it was given", () => {
    const { mock } = model(() => ({ type: "boolean", probability: 1 }));
    const m = evaluationMember(mock, { id: "judge-a", version: "2026-01" });
    expect(m.id).toBe("judge-a");
    expect(m.version).toBe("2026-01");
  });

  it("MBR6.2 every question goes in one call and each answer comes back keyed like its question", async () => {
    const { mock, calls } = model((_id, q) =>
      q.type === "boolean" ? { type: "boolean", probability: 0.9 } : q.type === "choice" ? { type: "choice", choice: "b", probabilities: { a: 0.2, b: 0.5, c: 0.3 } } : { type: "score", score: 2 },
    );
    const member = evaluationMember(mock, { id: "j", version: "1" });
    const answers = await member.ask({ state: { x: 1 }, questions: { b: bool, c: choice, s: score } });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.questions)).toEqual(["b", "c", "s"]);
    expect(calls[0]!.state).toEqual({ x: 1 });
    expect(Object.keys(answers)).toEqual(["b", "c", "s"]);
    expect(answers["b"]!.distribution["true"]).toBeCloseTo(0.9, 12);
    expect(answers["c"]!.top).toBe("b");
    expect(answers["s"]!.score).toBeCloseTo(2, 12);
  });

  it("MBR6.3 a failing model is not retried and its error reaches the caller", async () => {
    let calls = 0;
    const mock = new EvaluationMockModel({
      doEvaluate: async () => {
        calls++;
        throw Object.assign(new Error("down"), { isRetryable: true });
      },
    });
    await expect(evaluationMember(mock, { id: "j", version: "1" }).ask({ state: "s", questions: { q: bool } })).rejects.toThrow("down");
    expect(calls).toBe(1);
  });

  it("MBR6.4 an answer the AI SDK refuses is a rejection", async () => {
    const { mock } = model(() => ({ type: "boolean", probability: 3 }));
    await expect(evaluationMember(mock, { id: "j", version: "1" }).ask({ state: "s", questions: { q: bool } })).rejects.toThrow();
  });

  it("MBR6.5 an answer that cannot be a distribution is a rejection naming the member and question", async () => {
    const one: JudgeQuestion = { type: "choice", instructions: "only one?", criteria: { only: "x" } };
    const { mock } = model(() => ({ type: "choice", choice: "only" }));
    const ask = evaluationMember(mock, { id: "judge-a", version: "1" }).ask({ state: "s", questions: { q: one } });
    await expect(ask).rejects.toBeInstanceOf(DecisionError);
    await expect(ask).rejects.toThrow(/judge-a.*"q"/);
    await expect(ask).rejects.toMatchObject({ code: "invalid" });
  });
});
