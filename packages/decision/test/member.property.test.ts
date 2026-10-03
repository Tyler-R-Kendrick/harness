import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { probability } from "@harness/cognitive";
import type { JudgeQuestion } from "@harness/cognitive";
import { answerOf, averageAnswers, fromJudgeAnswer, rotateQuestion, rotations, toJudgeAnswer } from "../src/member.ts";

const keys = fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/), { minLength: 2, maxLength: 6 });
const weights = (n: number) => fc.array(fc.double({ min: 0.01, max: 1, noNaN: true }), { minLength: n, maxLength: n });

/** Whether the top probability leads the runner-up by more than rounding: renormalising may flip which of two ulp-close probabilities is "first". */
const clearLeader = (w: readonly number[]): boolean => {
  const sorted = [...w].sort((a, b) => b - a);
  return sorted[0]! - sorted[1]! > 1e-9 * sorted.reduce((sum, x) => sum + x, 0);
};

const choiceQuestion = keys.map((ks): JudgeQuestion => ({ type: "choice", instructions: "which", criteria: Object.fromEntries(ks.map((k) => [k, `about ${k}`])) }));

describe("member properties", () => {
  test.prop([choiceQuestion, fc.integer({ min: -20, max: 20 })])("MBR7.1 a rotation is a permutation of the options that keeps every description, and k and k + n are the same rotation", (q, k) => {
    if (q.type !== "choice") throw new Error("unreachable");
    const n = Object.keys(q.criteria).length;
    const r = rotateQuestion(q, k);
    if (r.type !== "choice") throw new Error("unreachable");
    expect(Object.keys(r.criteria).sort()).toEqual(Object.keys(q.criteria).sort());
    expect(r.criteria).toEqual(q.criteria);
    expect(Object.keys(rotateQuestion(q, k + n).type === "choice" ? (rotateQuestion(q, k + n) as typeof r).criteria : {})).toEqual(Object.keys(r.criteria));
  });

  test.prop([choiceQuestion, fc.integer({ min: 1, max: 10 })])("MBR7.2 rotations are distinct, start with the original and number min(count, options)", (q, count) => {
    if (q.type !== "choice") throw new Error("unreachable");
    const list = rotations(q, count);
    expect(list).toHaveLength(Math.min(count, Object.keys(q.criteria).length));
    expect(list[0]).toEqual(q);
    expect(new Set(list.map((r) => JSON.stringify(r.type === "choice" ? Object.keys(r.criteria) : []))).size).toBe(list.length);
  });

  test.prop([keys.chain((ks) => weights(ks.length).map((w) => [ks, w] as const))])("MBR7.3 a choice answer survives conversion to the AI SDK's and back", ([ks, w]) => {
    fc.pre(clearLeader(w));
    const q: JudgeQuestion = { type: "choice", instructions: "", criteria: Object.fromEntries(ks.map((k) => [k, null])) };
    const answer = answerOf("choice", Object.fromEntries(ks.map((k, i) => [k, w[i]!])));
    const back = fromJudgeAnswer(q, toJudgeAnswer(q, answer));
    expect(back.top).toBe(answer.top);
    for (const k of ks) expect(back.distribution[k]).toBeCloseTo(answer.distribution[k]!, 9);
  });

  test.prop([fc.integer({ min: 2, max: 8 }).chain((n) => weights(n))])("MBR7.4 a score answer survives conversion too, expected level included", (w) => {
    fc.pre(clearLeader(w));
    const q: JudgeQuestion = { type: "score", instructions: "", criteria: w.map(() => null) };
    const answer = answerOf("score", Object.fromEntries(w.map((x, i) => [String(i), x])));
    const back = fromJudgeAnswer(q, toJudgeAnswer(q, answer));
    expect(back.score).toBeCloseTo(answer.score!, 9);
    expect(back.top).toBe(answer.top);
  });

  test.prop([fc.integer({ min: 2, max: 8 }), fc.double({ min: 0, max: 1, noNaN: true })])("MBR7.5 a score with no probabilities has the score as its expected level", (levels, fraction) => {
    const q: JudgeQuestion = { type: "score", instructions: "", criteria: Array.from({ length: levels }, () => null) };
    const score = fraction * (levels - 1);
    const a = fromJudgeAnswer(q, { type: "score", score });
    expect(a.score).toBeCloseTo(score, 9);
    expect(Object.values(a.distribution).filter((p) => p > 0).length).toBeLessThanOrEqual(2);
  });

  test.prop([fc.double({ min: 0, max: 1, noNaN: true })])("MBR7.6 a boolean answer survives conversion", (pTrue) => {
    const q: JudgeQuestion = { type: "boolean", instructions: "" };
    const back = toJudgeAnswer(q, fromJudgeAnswer(q, { type: "boolean", probability: probability(pTrue) }));
    expect(back.type === "boolean" && back.probability).toBeCloseTo(pTrue, 12);
  });

  test.prop([keys.chain((ks) => fc.array(weights(ks.length), { minLength: 1, maxLength: 5 }).map((rows) => [ks, rows] as const))])("MBR7.7 an average sums to one, stays between the answers it averages, and an average of one answer is that answer", ([ks, rows]) => {
    const answers = rows.map((w) => answerOf("choice", Object.fromEntries(ks.map((k, i) => [k, w[i]!]))));
    const mean = averageAnswers(answers);
    expect(Object.values(mean.distribution).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 9);
    for (const k of ks) {
      const values = answers.map((a) => a.distribution[k]!);
      expect(mean.distribution[k]!).toBeGreaterThanOrEqual(Math.min(...values) - 1e-12);
      expect(mean.distribution[k]!).toBeLessThanOrEqual(Math.max(...values) + 1e-12);
    }
    expect(averageAnswers([answers[0]!])).toEqual(answers[0]);
  });
});
