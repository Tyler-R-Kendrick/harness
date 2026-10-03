import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import type { Experimental_EvaluationModelV4 as EvaluationModelV4, Experimental_EvaluationModelV4Answer as ModelAnswer, Experimental_EvaluationModelV4Question as Question } from "@ai-sdk/provider";
import { choiceConfidence, handleSystemOne, scoreConfidence, systemOneModels } from "../src/index.ts";

/** A model that answers every question with the probabilities `weights` gives it, rounded to two decimals as a hosted model does. */
function weighted(weights: (q: Question) => number[]): EvaluationModelV4 {
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: "weighted",
    supportedQuestionTypes: ["boolean", "choice", "score"],
    async doEvaluate({ questions }) {
      const answers: Record<string, ModelAnswer> = {};
      for (const [id, q] of Object.entries(questions)) {
        const w = weights(q);
        const total = w.reduce((a, b) => a + b, 0);
        const p = w.map((x) => Math.round((x / total) * 100) / 100);
        if (q.type === "boolean") answers[id] = { type: "boolean", probability: p[0]! };
        else if (q.type === "choice") {
          const keys = Object.keys(q.criteria);
          answers[id] = { type: "choice", choice: keys[p.indexOf(Math.max(...p))]!, probabilities: Object.fromEntries(keys.map((k, i) => [k, p[i]!])) };
        } else answers[id] = { type: "score", score: p.reduce((s, x, i) => s + x * i, 0), probabilities: Object.fromEntries(p.map((x, i) => [String(i), x])) };
      }
      return { answers, warnings: [], rounding: { probabilityDecimals: 2, scoreDecimals: 15 } };
    },
  };
}

const post = (body: unknown, model: EvaluationModelV4) => handleSystemOne({ body, models: systemOneModels([{ id: "m", model }]) });
const weightsOf = (n: number) => fc.array(fc.integer({ min: 0, max: 20 }), { minLength: n, maxLength: n }).filter((w) => w.reduce((a, b) => a + b, 0) > 0 && Math.max(...w) / w.reduce((a, b) => a + b, 0) >= 0.06);
const optionCount = fc.integer({ min: 1, max: 14 });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("System One properties", () => {
  test.prop([optionCount.chain((n) => fc.tuple(fc.constant(n), weightsOf(n)))], { numRuns: 100 })("S1W6.1 a choice's probabilities are keyed by the options, sum to 1 and never NaN, and the choice is the argmax", async ([n, w]) => {
    const criteria = Object.fromEntries(Array.from({ length: n }, (_, i) => [`option ${i}`, i % 2 ? null : `d${i}`]));
    const reply = await post({ model: "jev-latest", state: "s", questions: { c: { type: "choice", instructions: "?", criteria } } }, weighted(() => w));
    expect(reply.status).toBe(200);
    const a = (reply.body as { answers: { c: { choice: string; probabilities: Record<string, number>; confidence: number } } }).answers.c;
    expect(Object.keys(a.probabilities)).toEqual(Object.keys(criteria));
    const p = Object.values(a.probabilities);
    expect(p.every((x) => Number.isFinite(x) && x >= 0 && x <= 1)).toBe(true);
    expect(Math.abs(sum(p) - 1)).toBeLessThan(1e-9);
    expect(a.probabilities[a.choice]).toBe(Math.max(...p));
    expect(a.confidence).toBeGreaterThanOrEqual(0);
    expect(a.confidence).toBeLessThanOrEqual(1);
  });

  test.prop([fc.integer({ min: 2, max: 10 }).chain((n) => fc.tuple(fc.constant(n), weightsOf(n)))], { numRuns: 100 })("S1W6.2 a score is the expectation of its level over the reported probabilities, and its legend has every level", async ([n, w]) => {
    const criteria = Array.from({ length: n }, (_, i) => `level ${i}`);
    const reply = await post({ model: "m", state: { any: ["json"] }, questions: { s: { type: "score", instructions: "?", criteria } } }, weighted(() => w));
    expect(reply.status).toBe(200);
    const a = (reply.body as { answers: { s: { score: number; probabilities: Record<string, number>; legend: Record<string, string>; confidence: number } } }).answers.s;
    expect(Object.keys(a.probabilities)).toEqual(criteria.map((_, i) => String(i)));
    expect(Object.values(a.legend)).toEqual(criteria);
    expect(Math.abs(sum(Object.values(a.probabilities)) - 1)).toBeLessThan(1e-9);
    expect(Math.abs(a.score - sum(Object.entries(a.probabilities).map(([i, p]) => Number(i) * p)))).toBeLessThan(1e-9);
    expect(a.score).toBeGreaterThanOrEqual(0);
    expect(a.score).toBeLessThanOrEqual(n - 1);
    expect(a.confidence).toBeGreaterThanOrEqual(0);
    expect(a.confidence).toBeLessThanOrEqual(1);
  });

  test.prop([fc.oneof(fc.jsonValue(), fc.anything(), fc.object({ key: fc.constantFrom("model", "state", "questions", "type", "criteria", "instructions", "u"), values: [fc.string(), fc.constant(null), fc.jsonValue(), fc.constantFrom("noul", "choice", "score", "jev-latest")], maxDepth: 4 }))], { numRuns: 300 })("S1W6.3 no body, however malformed, is answered with a 5xx or throws", async (body) => {
    const reply = await post(body, weighted((q) => (q.type === "boolean" ? [1] : q.type === "choice" ? Object.keys(q.criteria).map(() => 1) : q.criteria.map(() => 1))));
    expect(reply.status === 200 || (reply.status >= 400 && reply.status < 500)).toBe(true);
    expect(() => JSON.stringify(reply.body)).not.toThrow();
  });

  test.prop([fc.shuffledSubarray(["a", "b", "c", "d"], { minLength: 1 }), fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 3, maxLength: 3 })], { numRuns: 60 })("S1W6.4 any subset of the questions in any order gives the same answer to each", async (ids, w) => {
    const all: Record<string, unknown> = {
      a: { type: "choice", instructions: "which?", criteria: { x: null, y: "why", z: null } },
      b: { type: "noul", instructions: "yes?" },
      c: { type: "score", instructions: "how much?", criteria: ["low", "mid", "high"] },
      d: { type: "choice", instructions: "which other?", criteria: { p: null, q: null, r: null } },
    };
    const model = weighted((q) => (q.type === "boolean" ? [w[0]!, w[1]! + w[2]!] : q.type === "choice" && "x" in q.criteria ? w : q.type === "choice" ? [...w].reverse() : [w[1]!, w[2]!, w[0]!]));
    const request = (keys: string[]) => ({ model: "m", state: "s", questions: Object.fromEntries(keys.map((k) => [k, all[k]])) });
    const full = (await post(request(["a", "b", "c", "d"]), model)).body as { answers: Record<string, unknown> };
    const part = (await post(request(ids), model)).body as { answers: Record<string, unknown> };
    for (const id of ids) expect(part.answers[id]).toEqual(full.answers[id]);
  });

  test.prop([fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 255 }).filter((p) => sum(p) > 0)], { numRuns: 200 })("S1W6.5 confidence is in [0, 1] for any distribution, and 1 for a certain one", (weights) => {
    const total = sum(weights);
    const p = weights.map((x) => x / total);
    for (const c of [choiceConfidence(p), scoreConfidence(p)]) {
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    const certain = p.map((_, i) => (i === 0 ? 1 : 0));
    expect(choiceConfidence(certain)).toBe(1);
    expect(scoreConfidence(certain)).toBe(1);
  });

  test.prop([fc.integer({ min: 2, max: 10 }), fc.integer({ min: 0, max: 9 })], { numRuns: 60 })("S1W6.6 moving probability from a rival to the leading option never lowers a choice's confidence", (n, lead) => {
    const top = lead % n;
    const spread = Array.from({ length: n }, (_, i) => (i === top ? 1 / n + 0.01 : (1 - (1 / n + 0.01)) / (n - 1)));
    const moved = spread.map((x, i) => (i === top ? x + 0.005 : i === (top + 1) % n ? x - 0.005 : x));
    expect(choiceConfidence(moved)).toBeGreaterThanOrEqual(choiceConfidence(spread));
  });
});
