import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "@ai-sdk/provider";
import type { Experimental_EvaluationModelV4 as EvaluationModelV4, Experimental_EvaluationModelV4Answer as ModelAnswer, Experimental_EvaluationModelV4CallOptions as CallOptions, Experimental_EvaluationModelV4Question as Question, Experimental_EvaluationModelV4Result as ModelResult } from "@ai-sdk/provider";
import { bytes, Ensemble, MODEL_HEADER } from "@harness/cognitive";
import type { ModelDescriptor } from "@harness/cognitive";
import { scriptedJudge } from "@harness/testkit";
import {
  choiceConfidence,
  ensembleSystemOneModels,
  handleModels,
  handleSystemOne,
  scoreConfidence,
  systemOneSchemas,
  systemOneError,
  systemOneInvalidJson,
  systemOneModels,
} from "../src/index.ts";
import type { SystemOneModels } from "../src/index.ts";

// ---- helpers ------------------------------------------------------------------------------

type Scripted = EvaluationModelV4 & { readonly calls: CallOptions[] };

/** A scripted evaluation model: `answer` gives each question's answer, `extra` adds result fields. */
function scripted(answer: (q: Question, options: CallOptions) => ModelAnswer | Promise<ModelAnswer>, extra: Partial<Omit<ModelResult, "answers">> | ((options: CallOptions) => Partial<Omit<ModelResult, "answers">>) = {}, types: EvaluationModelV4["supportedQuestionTypes"] = ["boolean", "choice", "score"]): Scripted {
  const calls: CallOptions[] = [];
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: "scripted",
    supportedQuestionTypes: types,
    calls,
    async doEvaluate(options) {
      calls.push(options);
      const entries = await Promise.all(Object.entries(options.questions).map(async ([id, q]) => [id, await answer(q, options)] as const));
      return { answers: Object.fromEntries(entries), warnings: [], ...(typeof extra === "function" ? extra(options) : extra) };
    },
  };
}

/** Even probabilities over a question's options, or `weights` when given. */
function distribution(q: Question, weights?: readonly number[]): ModelAnswer {
  if (q.type === "boolean") return { type: "boolean", probability: weights?.[0] ?? 0.5 };
  const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
  const w = weights ?? keys.map(() => 1 / keys.length);
  const probabilities = Object.fromEntries(keys.map((k, i) => [k, w[i] ?? 0]));
  if (q.type === "choice") return { type: "choice", choice: keys[w.indexOf(Math.max(...w))]!, probabilities };
  return { type: "score", score: w.reduce((s, p, i) => s + p * i, 0), probabilities };
}

const served = (model: EvaluationModelV4): SystemOneModels => systemOneModels([{ id: "test-1", model }]);

interface Body {
  model: string;
  answers: Record<string, Record<string, unknown>>;
  usage: { input_tokens: number; output_tokens: number };
}
async function post(body: unknown, model: EvaluationModelV4 = scripted((q) => distribution(q))) {
  return handleSystemOne({ body, models: served(model) });
}
const ok = async (body: unknown, model?: EvaluationModelV4) => {
  const reply = await post(body, model);
  expect(reply.status).toBe(200);
  return reply.body as Body;
};

const noulQuestion = () => ({ type: "noul", instructions: "Urgent?" });
const team = { type: "choice", instructions: "Which team?", criteria: { billing: "Charges", sales: null, support: "Help" } };
const anger = { type: "score", instructions: "How angry?", criteria: ["Calm", "Frustrated", "Very angry"] };
const urgent = { type: "noul", instructions: "Urgent?" };
const request = (questions: Record<string, unknown> = { team, anger, urgent }, more: Record<string, unknown> = {}) => ({ model: "jev-latest", state: "I was charged twice", questions, ...more });

// ---- confidence ---------------------------------------------------------------------------

describe("System One confidence, derived from the probabilities (docs.typesafe.ai/confidence; jevcompat 4.5)", () => {
  it("S1W1.1 a choice's confidence generalises the documented three-option formula (3 * largest - 1) / 2", () => {
    expect(choiceConfidence([0.85, 0, 0.15])).toBeCloseTo(0.775, 12);
    expect(choiceConfidence([0.57, 0.43, 0])).toBeCloseTo(0.355, 12);
  });

  it("S1W1.2 all the probability on one option gives 1 and an even spread gives 0", () => {
    expect(choiceConfidence([0, 1, 0, 0])).toBe(1);
    expect(choiceConfidence([0.25, 0.25, 0.25, 0.25])).toBe(0);
  });

  it("S1W1.3 with n options and largest m the confidence is (n * m - 1) / (n - 1)", () => {
    expect(choiceConfidence([0.75, 0.25])).toBeCloseTo(0.5, 12);
    expect(choiceConfidence([0.4, 0.3, 0.2, 0.1])).toBeCloseTo((4 * 0.4 - 1) / 3, 12);
  });

  it("S1W1.4 one option is fully confident", () => {
    expect(choiceConfidence([1])).toBe(1);
    expect(scoreConfidence([1])).toBe(1);
  });

  it("S1W1.5 float error never leaves the range", () => {
    expect(choiceConfidence([1 / 3, 1 / 3, 1 / 3])).toBe(0);
    expect(choiceConfidence(Array.from({ length: 255 }, () => 1 / 255))).toBe(0);
  });

  it("S1W1.6 a score's confidence falls with the distance of the mass from the most likely level", () => {
    expect(scoreConfidence([0, 0.57, 0.43])).toBeCloseTo(0.355, 12);
    expect(scoreConfidence([0, 1, 0])).toBe(1);
    expect(scoreConfidence([0.5, 0.5, 0])).toBeCloseTo(1 - 0.5 / (2 / 3), 12);
    expect(scoreConfidence([0.5, 0, 0.5])).toBe(0);
  });

  it("S1W1.7 mass on adjacent levels is more confident than the same mass on far levels", () => {
    expect(scoreConfidence([0.5, 0.5, 0, 0, 0])).toBeGreaterThan(scoreConfidence([0.5, 0, 0, 0, 0.5]));
  });

  it("S1W1.8 a uniform score is not confident and the level at a tie is the first", () => {
    expect(scoreConfidence([0.25, 0.25, 0.25, 0.25])).toBe(0);
    expect(scoreConfidence([0.5, 0.5])).toBe(0);
  });
});

// ---- the answer to a request ---------------------------------------------------------------

describe("handleSystemOne answers", () => {
  it("S1W2.1 a noul answer is the probability of yes", async () => {
    const body = await ok(request({ urgent }), scripted(() => ({ type: "boolean", probability: 0.95 })));
    expect(body.answers).toEqual({ urgent: { type: "noul", noul: 0.95 } });
    expect(body.answers["urgent"]).not.toHaveProperty("confidence");
  });

  it("S1W2.2 the envelope has the served model, an answer per question, and integer usage", async () => {
    const body = await ok(request(), scripted((q) => distribution(q), { usage: { inputTokens: 10, outputTokens: 2 } }));
    expect(Object.keys(body).sort()).toEqual(["answers", "model", "usage"]);
    expect(Object.keys(body.answers)).toEqual(["team", "anger", "urgent"]);
    expect(body.usage).toEqual({ input_tokens: 30, output_tokens: 6 });
    expect(systemOneSchemas().response.safeParse(body).success).toBe(true);
  });

  it("S1W2.3 a choice has its most probable option, the probabilities keyed by the options, and a derived confidence", async () => {
    const body = await ok(request({ team }), scripted((q) => distribution(q, [0.15, 0.85, 0])));
    expect(body.answers["team"]).toEqual({ type: "choice", choice: "sales", probabilities: { billing: 0.15, sales: 0.85, support: 0 }, confidence: expect.closeTo(0.775, 12) });
  });

  it("S1W2.4 the confidence comes from the probabilities and never from the model", async () => {
    const model = scripted((q) => distribution(q, [0.5, 0.5, 0]), { providerMetadata: { typesafe: { confidence: { q: 0.999 } } } });
    const body = await ok(request({ team, anger }), model);
    expect(body.answers["team"]!["confidence"]).toBeCloseTo(0.25, 12);
    expect(body.answers["anger"]!["confidence"]).toBeCloseTo(0.25, 12);
  });

  it("S1W2.5 a score is the sum of level times probability, with a legend that echoes the levels", async () => {
    const body = await ok(request({ anger }), scripted((q) => distribution(q, [0, 0.57, 0.43])));
    expect(body.answers["anger"]).toEqual({
      type: "score",
      score: expect.closeTo(1.43, 12),
      legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      probabilities: { "0": 0, "1": 0.57, "2": 0.43 },
      confidence: expect.closeTo(0.355, 12),
    });
  });

  it("S1W2.6 probabilities a rounding model reports are renormalised to sum to 1 (and the choice is the first of equals)", async () => {
    const model = scripted((q) => ({ ...distribution(q, [0.34, 0.34, 0.33]) }), { rounding: { probabilityDecimals: 2 } });
    const answer = (await ok(request({ team }), model)).answers["team"] as { choice: string; probabilities: Record<string, number> };
    const total = Object.values(answer.probabilities).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 12);
    expect(answer.probabilities["billing"]).toBeCloseTo(0.34 / 1.01, 12);
    expect(answer.choice).toBe("billing");
  });

  it("S1W2.33 a distribution that already sums to 1 is passed through exactly, float error and all", async () => {
    const answer = (await ok(request({ team }), scripted(() => ({ type: "choice", choice: "billing", probabilities: { billing: 0.7, sales: 0.2, support: 0.1 } })))).answers["team"] as { probabilities: Record<string, number> };
    expect(answer.probabilities).toEqual({ billing: 0.7, sales: 0.2, support: 0.1 });
    const nearly = (await ok(request({ team }), scripted(() => ({ type: "choice", choice: "billing", probabilities: { billing: 0.5, sales: 0.3, support: 0.2 + 2e-9 } }), { rounding: { probabilityDecimals: 15 } }))).answers["team"] as { probabilities: Record<string, number> };
    expect(Object.values(nearly.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(nearly.probabilities["billing"]).not.toBe(0.5);
  });

  it("S1W2.34 the pass-through limit is 2 to the minus 30: a sum that far from 1 is left alone, one further is renormalised", async () => {
    const two = { c: { type: "choice", instructions: "?", criteria: { a: null, b: null } } };
    const within = 0.5 + 2 ** -30;
    const kept = (await ok(request(two), scripted(() => ({ type: "choice", choice: "b", probabilities: { a: 0.5, b: within } }), { rounding: { probabilityDecimals: 15 } }))).answers["c"] as { probabilities: Record<string, number> };
    expect(kept.probabilities).toEqual({ a: 0.5, b: within });
    const beyond = 0.5 + 2 ** -29;
    const scaled = (await ok(request(two), scripted(() => ({ type: "choice", choice: "b", probabilities: { a: 0.5, b: beyond } }), { rounding: { probabilityDecimals: 15 } }))).answers["c"] as { probabilities: Record<string, number> };
    expect(scaled.probabilities["b"]).toBeCloseTo(beyond / (1 + 2 ** -29), 15);
    expect(scaled.probabilities["b"]).not.toBe(beyond);
  });

  it("S1W2.7 the score is recomputed from the renormalised probabilities, not taken from the model", async () => {
    const model = scripted(() => ({ type: "score", score: 1.51, probabilities: { "0": 0, "1": 0.51, "2": 0.5 } }), { rounding: { probabilityDecimals: 2, scoreDecimals: 2 } });
    const answer = (await ok(request({ anger }), model)).answers["anger"]!;
    expect(answer["score"]).toBeCloseTo(1.51 / 1.01, 12);
  });

  it("S1W2.8 a model that gives only a choice yields a certain distribution on it", async () => {
    const answer = (await ok(request({ team }), scripted(() => ({ type: "choice", choice: "support" })))).answers["team"];
    expect(answer).toEqual({ type: "choice", choice: "support", probabilities: { billing: 0, sales: 0, support: 1 }, confidence: 1 });
  });

  it("S1W2.9 a model that gives only a score yields the two neighbouring levels weighted to match it", async () => {
    const answer = (await ok(request({ anger }), scripted(() => ({ type: "score", score: 1.25 })))).answers["anger"] as { score: number; probabilities: Record<string, number> };
    expect(answer.probabilities).toEqual({ "0": 0, "1": 0.75, "2": 0.25 });
    expect(answer.score).toBeCloseTo(1.25, 12);
    const whole = (await ok(request({ anger }), scripted(() => ({ type: "score", score: 2 })))).answers["anger"] as { probabilities: Record<string, number> };
    expect(whole.probabilities).toEqual({ "0": 0, "1": 0, "2": 1 });
  });

  it("S1W2.10 a model that reports no probability at all is an upstream failure, never a NaN", async () => {
    const model = scripted(() => ({ type: "choice", choice: "billing", probabilities: { billing: 0, sales: 0, support: 0 } }), { rounding: { probabilityDecimals: 0 } });
    const reply = await post(request({ team }), model);
    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ detail: { error_type: "upstream_error", message: expect.stringContaining("no probability") } });
  });

  it("S1W2.11 the model alias jev-latest resolves to a concrete served id, which the response reports", async () => {
    const body = await ok(request({ urgent }, { model: "jev-latest" }));
    expect(body.model).toBe("test-1");
    expect((await ok(request({ urgent }, { model: "test-1" }))).model).toBe("test-1");
    expect((await ok(request({ urgent }, { model: "latest" }))).model).toBe("test-1");
  });

  it("S1W2.12 a request without a model uses the default one", async () => {
    const { model: _model, ...without } = request({ urgent });
    expect((await ok(without)).model).toBe("test-1");
  });

  it("S1W2.13 an unknown model is a 404 that names it", async () => {
    const reply = await post(request({ urgent }, { model: "nope-1" }));
    expect(reply.status).toBe(404);
    expect(reply.body).toEqual({ detail: { error_type: "model_not_found", message: expect.stringContaining("nope-1") } });
  });

  it("S1W2.14 a failing model is a 502 with error_type upstream_error and the message, tried once", async () => {
    const model = scripted(() => {
      throw new Error("weights offline");
    });
    const reply = await post(request({ urgent }), model);
    expect(reply).toEqual({ status: 502, body: { detail: { error_type: "upstream_error", message: "weights offline" } } });
    expect(model.calls).toHaveLength(1);
  });

  it("S1W2.15 a failure that is not an Error still gives a message", async () => {
    const model = scripted(() => {
      throw "boom";
    });
    expect((await post(request({ urgent }), model)).body).toEqual({ detail: { error_type: "upstream_error", message: "boom" } });
  });

  it("S1W2.32 a model that refuses the request itself is a 422, not an upstream failure", async () => {
    const model = scripted(() => {
      throw new InvalidArgumentError({ argument: "criteria", message: "at most 3 options" });
    });
    expect(await post(request({ team }), model)).toEqual({ status: 422, body: { detail: { error_type: "invalid_request", message: expect.stringContaining("at most 3 options") } } });
  });

  it("S1W2.16 an answer the model should not have given (an unknown option) is an upstream failure", async () => {
    const reply = await post(request({ team }), scripted(() => ({ type: "choice", choice: "legal" })));
    expect(reply.status).toBe(502);
    expect((reply.body as { detail: { message: string } }).detail.message).toMatch(/unknown option/);
  });

  it("S1W2.17 usage counts are integers: fractions round, and missing, negative and non-finite counts are 0", async () => {
    const usage = async (inputTokens: number | undefined, outputTokens: number | undefined) => (await ok(request({ urgent }), scripted((q) => distribution(q), { usage: { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) } }))).usage;
    expect(await usage(12.6, 3.4)).toEqual({ input_tokens: 13, output_tokens: 3 });
    expect(await usage(-5, Number.NaN)).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(await usage(Number.POSITIVE_INFINITY, undefined)).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect((await ok(request({ urgent }), scripted((q) => distribution(q)))).usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("S1W2.18 usage adds up over the questions", async () => {
    const model = scripted((q) => distribution(q), { usage: { inputTokens: 7, outputTokens: 1 } });
    expect((await ok(request(), model)).usage).toEqual({ input_tokens: 21, output_tokens: 3 });
  });

  it("S1W2.19 the model never sees the client's question ids, and gets one question per call", async () => {
    const model = scripted((q) => distribution(q));
    await ok(request({ "billing-team": team, anger }), model);
    expect(model.calls).toHaveLength(2);
    expect(model.calls.map((c) => Object.keys(c.questions))).toEqual([["q"], ["q"]]);
  });

  it("S1W2.20 the state is passed to the model unchanged: a string, an object or an array", async () => {
    for (const state of ["plain text", { message: "hi", n: [1, 2] }, ["a", { b: null }]]) {
      const model = scripted((q) => distribution(q));
      await ok(request({ urgent }, { state }), model);
      expect(model.calls[0]!.state).toEqual(state);
    }
  });

  it("S1W2.21 instructions and criteria may be structured, and reach the model as sent", async () => {
    const model = scripted((q) => distribution(q));
    const structured = { type: "choice", instructions: { ask: ["which", "team"] }, criteria: { a: { includes: ["x"] }, b: ["y", "z"], c: null } };
    await ok(request({ s: structured }), model);
    expect(model.calls[0]!.questions["q"]).toEqual(structured);
  });

  it("S1W2.22 a noul question reaches the model as a boolean, with the criteria it was given", async () => {
    const model = scripted((q) => distribution(q));
    await ok(request({ a: { type: "noul", instructions: "?", criteria: { true: "yes" } }, b: { type: "noul", instructions: "?", criteria: null }, c: { type: "noul" } }), model);
    expect(model.calls.map((c) => c.questions["q"])).toEqual([{ type: "boolean", instructions: "?", criteria: { true: "yes" } }, { type: "boolean", instructions: "?" }, { type: "boolean", instructions: "" }]);
  });

  it("S1W2.23 non-ASCII ids, option names, text and legends come back byte for byte", async () => {
    const questions = {
      "팀 - 1.a b": { type: "choice", instructions: "어느 팀? 🙂", criteria: { 청구: "요금", "판매 🙂": null } },
      "점수": { type: "score", instructions: "화남?", criteria: ["침착", "🙂 화남"] },
    };
    const body = await ok(request(questions, { state: "요금이 두 번 청구되었습니다 🙂" }));
    expect(Object.keys(body.answers)).toEqual(["팀 - 1.a b", "점수"]);
    expect(Object.keys(body.answers["팀 - 1.a b"]!["probabilities"] as object)).toEqual(["청구", "판매 🙂"]);
    expect(body.answers["점수"]!["legend"]).toEqual({ "0": "침착", "1": "🙂 화남" });
  });

  it("S1W2.24 a legend keeps structured levels as sent and names a level that has no description by its index", async () => {
    const q = { type: "score", instructions: "?", criteria: [{ text: "calm" }, ["a", "b"], null, "loud"] };
    const legend = (await ok(request({ q }))).answers["q"]!["legend"];
    expect(legend).toEqual({ "0": { text: "calm" }, "1": ["a", "b"], "2": "2", "3": "loud" });
  });

  it("S1W2.25 renaming, reordering or adding questions changes nothing about the others' answers", async () => {
    // A model whose answer depends on everything it is shown: the state, the question, and how many questions came with it.
    const model = scripted((q, o) => {
      const n = Object.keys(o.questions).length;
      const seed = (JSON.stringify([o.state, q]).length + n * 7) % 10;
      const weights = [seed + 1, 3, 2];
      const total = weights.reduce((a, b) => a + b, 0);
      return distribution(q, q.type === "boolean" ? [seed / 10] : q.type === "choice" ? weights.map((x) => x / total) : undefined);
    });
    const base = (await ok(request({ team, urgent }), model)).answers;
    const renamed = (await ok(request({ renamed: team, other: urgent }), model)).answers;
    const reordered = (await ok(request({ urgent, team }), model)).answers;
    const added = (await ok(request({ urgent, extra: anger, team }), model)).answers;
    expect(renamed["renamed"]).toEqual(base["team"]);
    expect(reordered["team"]).toEqual(base["team"]);
    expect(added["team"]).toEqual(base["team"]);
    expect(added["urgent"]).toEqual(base["urgent"]);
  });

  it("S1W2.26 answers come back in the order the questions were sent, with at most four questions in flight", async () => {
    let flight = 0;
    let most = 0;
    const model = scripted(async (q) => {
      flight++;
      most = Math.max(most, flight);
      await new Promise((r) => setTimeout(r, 5));
      flight--;
      return distribution(q);
    });
    const ids = Array.from({ length: 11 }, (_, i) => `q${10 - i}x`);
    const body = await ok(request(Object.fromEntries(ids.map((id) => [id, urgent]))), model);
    expect(Object.keys(body.answers)).toEqual(ids);
    expect(most).toBe(4);
  });

  it("S1W2.27 the concurrency and the question limit are options", async () => {
    let flight = 0;
    let most = 0;
    const model = scripted(async (q) => {
      flight++;
      most = Math.max(most, flight);
      await new Promise((r) => setTimeout(r, 5));
      flight--;
      return distribution(q);
    });
    const questions = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`q${i}`, urgent]));
    const reply = await handleSystemOne({ body: request(questions), models: served(model), concurrency: 2 });
    expect(reply.status).toBe(200);
    expect(most).toBe(2);
    const over = await handleSystemOne({ body: request(questions), models: served(model), maxQuestions: 5 });
    expect(over.status).toBe(422);
    expect(JSON.stringify(over.body)).toContain("at most 5 questions");
    expect((await handleSystemOne({ body: request(questions), models: served(model), maxQuestions: 6 })).status).toBe(200);
  });

  it("S1W2.28 a model that cannot answer a kind of question makes the request a 422 that names the kind", async () => {
    const model = scripted((q) => distribution(q), {}, ["choice", "score"]);
    const reply = await post(request({ urgent }), model);
    expect(reply.status).toBe(422);
    expect(reply.body).toEqual({ detail: { error_type: "unsupported_question_type", message: expect.stringContaining("noul") } });
    expect(model.calls).toHaveLength(0);
    expect((await post(request({ team, anger }), model)).status).toBe(200);
    const boolOnly = scripted((q) => distribution(q), {}, ["boolean"]);
    expect(((await post(request({ team }), boolOnly)).body as { detail: { message: string } }).detail.message).toContain("choice");
  });

  it("S1W2.29 a model that names who answered is reported; several distinct answerers are all named, sorted", async () => {
    let turn = 0;
    const model = scripted((q) => distribution(q), () => ({ response: { modelId: "x", headers: { "x-who": turn++ % 2 === 0 ? "member-b" : "member-a" } } }));
    const models = systemOneModels([{ id: "test-1", model, answeredBy: (r) => r.headers?.["x-who"] }]);
    const both = await handleSystemOne({ body: request({ a: urgent, b: urgent }), models });
    expect((both.body as Body).model).toBe("member-a+member-b");
    turn = 0;
    const one = await handleSystemOne({ body: request({ a: urgent }), models });
    expect((one.body as Body).model).toBe("member-b");
    const silent = systemOneModels([{ id: "test-1", model: scripted((q) => distribution(q)), answeredBy: () => undefined }]);
    expect(((await handleSystemOne({ body: request({ a: urgent }), models: silent })).body as Body).model).toBe("test-1");
  });

  it("S1W2.30 a model set that throws while resolving is an upstream failure, not a crash", async () => {
    const models: SystemOneModels = {
      list: () => [],
      resolve: () => {
        throw new Error("registry down");
      },
    };
    expect(await handleSystemOne({ body: request({ urgent }), models })).toEqual({ status: 502, body: { detail: { error_type: "upstream_error", message: "registry down" } } });
  });

  it("S1W2.31 a request body that is not an object is a 422", async () => {
    for (const body of [null, [], "text", 3, true]) expect((await post(body)).status).toBe(422);
  });
});

// ---- validation ----------------------------------------------------------------------------

const detail = (reply: { body: unknown }) => (reply.body as { detail: { loc: (string | number)[]; msg: string; type: string }[] }).detail;

describe("handleSystemOne validation (jevcompat 3, 6)", () => {
  it("S1W3.1 a body that is not an object is a 422 with detail located at body", async () => {
    const reply = await post([1]);
    expect(reply.status).toBe(422);
    expect(detail(reply)).toEqual([{ loc: ["body"], msg: expect.any(String), type: expect.any(String) }]);
  });

  it("S1W3.2 missing state and missing questions are located at their fields", async () => {
    expect(detail(await post({ model: "jev-latest", questions: { u: urgent } })).map((d) => d.loc)).toEqual([["body", "state"]]);
    expect(detail(await post({ model: "jev-latest", state: "s" })).map((d) => d.loc)).toEqual([["body", "questions"]]);
  });

  it("S1W3.3 no questions is a 422", async () => {
    const reply = await post(request({}));
    expect(reply.status).toBe(422);
    expect(detail(reply)[0]!.loc).toEqual(["body", "questions"]);
    expect(detail(reply)[0]!.msg).toMatch(/at least one question/);
  });

  it("S1W3.4 a question without a type, or with an unknown type such as boolean, is a 422 located at its type", async () => {
    for (const q of [{ instructions: "?" }, { type: "boolean", instructions: "?" }, { type: "yesno" }, { type: 4 }]) {
      const reply = await post(request({ q }));
      expect(reply.status).toBe(422);
      expect(detail(reply)[0]!.loc).toEqual(["body", "questions", "q", "type"]);
    }
  });

  it("S1W3.5 a choice takes 1 to 255 options and no more or fewer", async () => {
    const options = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, null]));
    for (const n of [1, 2, 100, 255]) expect((await post(request({ c: { type: "choice", instructions: "?", criteria: options(n) } }))).status).toBe(200);
    for (const n of [0, 256, 1000]) {
      const reply = await post(request({ c: { type: "choice", instructions: "?", criteria: options(n) } }));
      expect(reply.status).toBe(422);
      expect(detail(reply)[0]!.loc).toEqual(["body", "questions", "c", "criteria"]);
    }
  });

  it("S1W3.6 a score takes 2 to 10 levels, given as an array", async () => {
    const levels = (n: number) => Array.from({ length: n }, (_, i) => `level ${i}`);
    for (const n of [2, 3, 10]) expect((await post(request({ s: { type: "score", instructions: "?", criteria: levels(n) } }))).status).toBe(200);
    for (const n of [0, 1, 11]) expect((await post(request({ s: { type: "score", instructions: "?", criteria: levels(n) } }))).status).toBe(422);
    const map = await post(request({ s: { type: "score", instructions: "?", criteria: { "0": "a", "1": "b" } } }));
    expect(map.status).toBe(422);
    expect(detail(map)[0]!.loc).toEqual(["body", "questions", "s", "criteria"]);
  });

  it("S1W3.7 a bad level is located by its index", async () => {
    const reply = await post(request({ s: { type: "score", instructions: "?", criteria: ["ok", 5] } }));
    expect(reply.status).toBe(422);
    expect(detail(reply)[0]!.loc.slice(0, 5)).toEqual(["body", "questions", "s", "criteria", 1]);
  });

  it("S1W3.8 noul criteria may be omitted, null, both sides or one side, and nothing else", async () => {
    for (const criteria of [undefined, null, { true: "yes", false: "no" }, { true: "yes" }, { false: "no" }, {}, { true: null }, { true: { x: 1 }, false: ["a"] }]) {
      expect((await post(request({ n: { type: "noul", instructions: "?", ...(criteria === undefined ? {} : { criteria }) } }))).status).toBe(200);
    }
    for (const criteria of [{ maybe: "x" }, ["a"], "text"]) expect((await post(request({ n: { type: "noul", instructions: "?", criteria } }))).status).toBe(422);
  });

  it("S1W3.9 a noul question without instructions is accepted", async () => {
    expect((await post(request({ n: { type: "noul" } }))).status).toBe(200);
  });

  it("S1W3.10 instructions must be text, an object or an array", async () => {
    expect((await post(request({ n: { type: "noul", instructions: 5 } }))).status).toBe(422);
    expect((await post(request({ n: { type: "noul", instructions: null } }))).status).toBe(422);
  });

  it("S1W3.11 question ids: any non-empty string, but not an empty one", async () => {
    for (const id of ["a-b", "a.b", "a b", "  ", "팀", "🙂", "constructor", "toString"]) expect((await post(request({ [id]: urgent }))).status).toBe(200);
    const reply = await post(request({ "": urgent }));
    expect(reply.status).toBe(422);
  });

  it("S1W3.12 unknown fields at the top level and in questions are ignored", async () => {
    const body = await ok({ ...request({ u: { ...urgent, x_extra: 1 } }), x_nonce: "abc", extra_body: { a: 1 } });
    expect(Object.keys(body.answers)).toEqual(["u"]);
    expect(Object.keys(body.answers["u"]!)).toEqual(["type", "noul"]);
  });

  it("S1W3.13 the model must be a non-empty string when present", async () => {
    for (const model of [5, null, ""]) expect((await post({ ...request({ u: urgent }), model })).status).toBe(422);
  });

  it("S1W3.14 state may not be null or a number", async () => {
    for (const state of [null, 5, true]) expect((await post({ ...request({ u: urgent }), state })).status).toBe(422);
  });

  it("S1W3.15 values that JSON cannot carry are a 422 that says where and what, not a crash", async () => {
    const bad: [unknown, RegExp][] = [
      [{ n: Number.POSITIVE_INFINITY }, /^value\.n is not a finite number$/],
      [{ n: Number.NaN }, /^value\.n is not a finite number$/],
      [{ n: 10n }, /^value\.n is not JSON \(bigint\)$/],
      [{ n: () => 1 }, /^value\.n is not JSON \(function\)$/],
      [{ n: undefined }, /^value\.n is not JSON \(undefined\)$/],
      [{ n: Symbol("s") }, /^value\.n is not JSON \(symbol\)$/],
      [["ok", 10n], /^value\[1\] is not JSON \(bigint\)$/],
      [{ a: 1, b: 10n }, /^value\.b is not JSON \(bigint\)$/],
      [["fine", { a: "x", b: [1, 2, 3n] }], /^value\[1\]\.b\[2\] is not JSON \(bigint\)$/],
    ];
    for (const [state, message] of bad) {
      const reply = await post({ ...request({ u: urgent }), state });
      expect(reply.status).toBe(422);
      expect(detail(reply)).toEqual([{ loc: ["body", "state"], msg: expect.stringMatching(message), type: "custom" }]);
    }
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const reply = await post({ ...request({ u: urgent }), state: circular });
    expect(reply.status).toBe(422);
    expect(detail(reply)[0]!.msg).toMatch(/nested more than 64 levels/);
  });

  it("S1W3.25 a state that is neither text, an object nor an array says so", async () => {
    for (const state of [5, true, null, new Date(0), new Map(), new (class Box {})()]) {
      const reply = await post({ ...request({ u: urgent }), state });
      expect(detail(reply), String(state)).toEqual([{ loc: ["body", "state"], msg: "expected text, an object or an array", type: "custom" }]);
    }
    const missing = await post({ model: "jev-latest", questions: { u: urgent } });
    expect(detail(missing)).toEqual([{ loc: ["body", "state"], msg: "expected text, an object or an array", type: "custom" }]);
  });

  it("S1W3.26 numbers, booleans and null are JSON values wherever a value may go", async () => {
    const state = { count: 3, ratio: 0.5, on: true, off: false, none: null, list: [1, true, null, "x", { deep: false }] };
    const model = scripted((q) => distribution(q));
    await ok({ ...request({ u: urgent }), state }, model);
    expect(model.calls[0]!.state).toEqual(state);
  });

  it("S1W3.27 every problem in a map of questions is reported at its own place", async () => {
    const reply = await post(request({ a: { type: "nope" }, b: urgent, c: { type: "choice", criteria: [1] }, d: { type: "score", criteria: ["only"] } }));
    expect(reply.status).toBe(422);
    expect(detail(reply).map((d) => d.loc.slice(0, 4))).toEqual([
      ["body", "questions", "a", "type"],
      ["body", "questions", "c", "criteria"],
      ["body", "questions", "d", "criteria"],
    ]);
    expect(detail(reply)[1]!.msg).toBe("expected an object");
    expect(detail(reply)[2]).toMatchObject({ type: "too_small", msg: expect.stringContaining(">=2 items") });
  });

  it("S1W3.28 questions that is not an object says so", async () => {
    const reply = await post({ ...request(), questions: [noulQuestion()] });
    expect(detail(reply)).toEqual([{ loc: ["body", "questions"], msg: "expected an object", type: "custom" }]);
  });

  it("S1W3.29 a choice's option limit is reported in words", async () => {
    const options = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null]));
    const reply = await post(request({ c: { type: "choice", instructions: "?", criteria: options } }));
    expect(detail(reply)).toEqual([{ loc: ["body", "questions", "c", "criteria"], msg: "a choice has 1 to 255 options", type: "custom" }]);
  });

  it("S1W3.22 nesting is limited to 64 levels, however it is spelled, and the limit applies to every input", async () => {
    const nested = (levels: number) => {
      let value: unknown = "leaf";
      for (let i = 0; i < levels; i++) value = [value];
      return value;
    };
    expect((await post({ ...request({ u: urgent }), state: nested(64) })).status).toBe(200);
    for (const bad of [nested(65), nested(100_000)]) {
      expect((await post({ ...request({ u: urgent }), state: bad })).status).toBe(422);
      expect((await post(request({ u: { type: "noul", instructions: bad } }))).status).toBe(422);
      expect((await post(request({ u: { type: "noul", criteria: { true: bad } } }))).status).toBe(422);
      expect((await post(request({ u: { type: "choice", criteria: { a: bad } } }))).status).toBe(422);
      expect((await post(request({ u: { type: "score", criteria: ["a", bad] } }))).status).toBe(422);
    }
  });

  it("S1W3.23 objects that are not plain JSON (dates, maps, class instances) are a 422", async () => {
    for (const [state, message] of [[new Date(0), "expected text, an object or an array"], [new Map(), "expected text, an object or an array"], [new (class Box {})(), "expected text, an object or an array"], [[new Date(0)], "value[0] is not JSON (object)"], [{ at: new Date(0) }, "value.at is not JSON (object)"]] as const) {
      const reply = await post({ ...request({ u: urgent }), state });
      expect(reply.status).toBe(422);
      expect(detail(reply)[0]!.msg).toBe(message);
    }
    expect((await post({ ...request({ u: urgent }), state: Object.assign(Object.create(null) as object, { a: 1 }) })).status).toBe(200);
  });

  it("S1W3.24 a key named __proto__ inside a state reaches the model", async () => {
    const model = scripted((q) => distribution(q));
    const state = JSON.parse('{"__proto__":{"x":1},"a":[{"__proto__":2}]}') as unknown;
    await ok({ ...request({ u: urgent }), state }, model);
    expect(Object.keys(model.calls[0]!.state as object)).toEqual(["__proto__", "a"]);
  });

  it("S1W3.16 the keys __proto__ and constructor are ordinary ids and options", async () => {
    const body = JSON.parse('{"model":"jev-latest","state":"s","questions":{"__proto__":{"type":"choice","instructions":"?","criteria":{"__proto__":null,"constructor":"x"}},"u":{"type":"noul"}}}') as unknown;
    const reply = await post(body);
    expect(reply.status).toBe(200);
    const answers = (reply.body as Body).answers;
    expect(Object.keys(answers)).toEqual(["__proto__", "u"]);
    expect(Object.keys((Object.getOwnPropertyDescriptor(answers, "__proto__")!.value as { probabilities: object }).probabilities)).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(answers)).toBe(Object.prototype);
  });

  it("S1W3.17 the number of questions is limited (128 by default) and the limit is reported at questions", async () => {
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i}`, urgent]));
    expect((await post(request(many(128)))).status).toBe(200);
    const reply = await post(request(many(129)));
    expect(reply.status).toBe(422);
    expect(detail(reply)).toEqual([{ loc: ["body", "questions"], msg: "at most 128 questions in a request", type: "too_big" }]);
  });

  it("S1W3.18 no more than 100 problems are reported", async () => {
    const questions = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`q${i}`, { type: "nope" }]));
    const reply = await handleSystemOne({ body: request(questions), models: served(scripted((q) => distribution(q))), maxQuestions: 500 });
    expect(reply.status).toBe(422);
    expect(detail(reply)).toHaveLength(100);
  });

  it("S1W3.21 the limits the host sets must be positive whole numbers", async () => {
    const models = served(scripted((q) => distribution(q)));
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(handleSystemOne({ body: request(), models, maxQuestions: bad })).rejects.toThrow(/maxQuestions must be a positive whole number/);
      await expect(handleSystemOne({ body: request(), models, concurrency: bad })).rejects.toThrow(/concurrency must be a positive whole number/);
    }
  });

  it("S1W3.30 one question at a time, and one question in a request, are valid limits", async () => {
    const models = served(scripted((q) => distribution(q)));
    expect((await handleSystemOne({ body: request({ u: urgent }), models, maxQuestions: 1, concurrency: 1 })).status).toBe(200);
    expect((await handleSystemOne({ body: request({ a: urgent, b: urgent, c: urgent }), models, concurrency: 1 })).status).toBe(200);
  });

  it("S1W3.31 a request whose signal is already aborted is not asked of the model", async () => {
    const model = scripted((q) => distribution(q));
    const controller = new AbortController();
    controller.abort();
    const reply = await handleSystemOne({ body: request({ a: urgent, b: urgent }), models: served(model), signal: controller.signal });
    expect(reply).toEqual(systemOneError(499, "client_closed_request", "the client closed the request before it was answered"));
    expect(model.calls).toHaveLength(0);
  });

  it("S1W3.32 a signal aborted while the first batch runs stops the batches after it", async () => {
    const controller = new AbortController();
    const model = scripted((q) => {
      controller.abort();
      return distribution(q);
    });
    const reply = await handleSystemOne({ body: request({ a: urgent, b: urgent, c: urgent, d: urgent }), models: served(model), concurrency: 1, signal: controller.signal });
    expect(reply.status).toBe(499);
    expect(model.calls).toHaveLength(1);
  });

  it("S1W3.33 the signal reaches the model call, so a call in flight can be cut short", async () => {
    const model = scripted((q) => distribution(q));
    const controller = new AbortController();
    expect((await handleSystemOne({ body: request({ a: urgent }), models: served(model), signal: controller.signal })).status).toBe(200);
    expect(model.calls[0]!.abortSignal).toBe(controller.signal);
  });

  it("S1W3.34 a model that fails after the signal aborted is the client's departure, not an upstream failure", async () => {
    const controller = new AbortController();
    const model = scripted(() => {
      controller.abort();
      throw new Error("aborted by the caller");
    });
    expect((await handleSystemOne({ body: request({ a: urgent }), models: served(model), signal: controller.signal })).status).toBe(499);
  });

  it("S1W3.19 the request schema is exported and rejects the same requests", () => {
    expect(systemOneSchemas().request.safeParse(request()).success).toBe(true);
    expect(systemOneSchemas().request.safeParse({}).success).toBe(false);
    expect(systemOneSchemas().response.safeParse({ model: "m", answers: { u: { type: "noul", noul: 2 } }, usage: { input_tokens: 1, output_tokens: 1 } }).success).toBe(false);
    expect(systemOneSchemas().answer.safeParse({ type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 1 }).success).toBe(true);
    expect(systemOneSchemas().answer.safeParse({ type: "score", score: 0, legend: { "0": "a" }, probabilities: { "0": 1 }, confidence: 1 }).success).toBe(true);
    expect(systemOneSchemas().question.safeParse({ type: "noul" }).success).toBe(true);
  });

  it("S1W3.20 error bodies have the documented shapes", () => {
    expect(systemOneError(401, "authentication_error", "no key")).toEqual({ status: 401, body: { detail: { error_type: "authentication_error", message: "no key" } } });
    expect(systemOneInvalidJson("Unexpected token")).toEqual({ status: 422, body: { detail: [{ loc: ["body"], msg: "Unexpected token", type: "json_invalid" }] } });
  });
});

// ---- models --------------------------------------------------------------------------------

describe("System One models", () => {
  const model = scripted((q) => distribution(q));

  it("S1W4.1 GET /v1/models lists name, description and release date", () => {
    const models = systemOneModels([
      { id: "a-1", model, description: "first", releaseDate: "2026-05-04" },
      { id: "b-2", model },
    ]);
    expect(handleModels(models)).toEqual({
      status: 200,
      body: { models: [{ name: "a-1", description: "first", release_date: "2026-05-04" }, { name: "b-2", description: "b-2", release_date: "1970-01-01" }] },
    });
  });

  it("S1W4.2 a requested id resolves exactly, or by a latest alias to the first model", () => {
    const models = systemOneModels([{ id: "a-1", model }, { id: "b-2", model }]);
    expect(models.resolve("b-2")?.id).toBe("b-2");
    for (const alias of ["latest", "jev-latest", "any-thing-latest", "harness-LATEST"]) expect(models.resolve(alias)?.id).toBe("a-1");
    for (const other of ["c-3", "latest-x", "notlatest", ""]) expect(models.resolve(other)).toBeUndefined();
  });

  it("S1W4.3 an id that ends in -latest and is served resolves to itself", () => {
    const models = systemOneModels([{ id: "a-1", model }, { id: "b-latest", model }]);
    expect(models.resolve("b-latest")?.id).toBe("b-latest");
  });

  it("S1W4.4 a model set needs models, unique ids and dates that are dates", () => {
    expect(() => systemOneModels([])).toThrow(/at least one model/);
    expect(() => systemOneModels([{ id: "a", model }, { id: "a", model }])).toThrow(/duplicate model id a/);
    expect(() => systemOneModels([{ id: "", model }])).toThrow(/model id/);
    for (const releaseDate of ["x2026-05-04", "2026-5-4", "2026-13-01", "2026-00-10", "2026-00-01", "2026-13-01", "2026-13-10", "2026-02-30", "2100-02-29", "2026-02-29", "2026-04-31", "2026-01-00", "tomorrow", "2026-05-04T00:00"]) expect(() => systemOneModels([{ id: "a", model, releaseDate }])).toThrow(/release date/);
    for (const releaseDate of ["2024-02-29", "2000-02-29", "2026-12-31", "2026-01-01"]) expect(() => systemOneModels([{ id: "a", model, releaseDate }])).not.toThrow();
  });

  it("S1W4.5 the served model is the one registered", () => {
    expect(systemOneModels([{ id: "a", model }]).resolve("a")?.model).toBe(model);
  });
});

// ---- the harness's ensemble --------------------------------------------------------------------

function member(id: string, ports: ModelDescriptor["ports"] = ["judge"]): ModelDescriptor {
  return { id, name: id, publisher: "t", tasks: ["judgment"], ports, locality: "local", runtime: "transformers.js", run: { dtype: "q4" }, platforms: ["native"], license: "MIT", downloadBytes: bytes(1), benchmarks: [] };
}

describe("ensembleSystemOneModels", () => {
  it("S1W5.1 the ensemble is served under a stable id, and the member that answered is the reported model", async () => {
    const ensemble = new Ensemble({ platform: "native" });
    ensemble.register(member("judge-a"), async () => ({ judge: scriptedJudge((_, q) => (q.type === "boolean" ? { type: "boolean", probability: 0.9 } : undefined)) }));
    const models = ensembleSystemOneModels(ensemble);
    expect(handleModels(models).body).toEqual({ models: [{ name: "harness-ensemble", description: expect.stringContaining("judgment ensemble"), release_date: "1970-01-01" }] });
    const reply = await handleSystemOne({ body: request({ urgent }, { model: "harness-ensemble" }), models });
    expect(reply.status).toBe(200);
    expect((reply.body as Body).model).toBe("judge-a");
    expect((reply.body as Body).answers["urgent"]).toEqual({ type: "noul", noul: 0.9 });
    expect(((await handleSystemOne({ body: request({ urgent }), models })).body as Body).model).toBe("judge-a");
  });

  it("S1W5.2 the id, the description and the release date can be chosen", () => {
    const models = ensembleSystemOneModels(new Ensemble({ platform: "native" }), "decide-1", { description: "the decision ensemble", releaseDate: "2026-09-28" });
    expect(handleModels(models).body).toEqual({ models: [{ name: "decide-1", description: "the decision ensemble", release_date: "2026-09-28" }] });
    expect(models.resolve("decide-1")?.id).toBe("decide-1");
  });

  it("S1W5.3 a task other than judgment can be served", async () => {
    const ensemble = new Ensemble({ platform: "native" });
    ensemble.register({ ...member("router-x", ["judge"]), tasks: ["tool-calling"] }, async () => ({ judge: scriptedJudge() }));
    const reply = await handleSystemOne({ body: request({ urgent }), models: ensembleSystemOneModels(ensemble, "tools", { task: "tool-calling" }) });
    expect((reply.body as Body).model).toBe("router-x");
  });

  it("S1W5.4 an ensemble with no judge in service is an upstream failure", async () => {
    const reply = await handleSystemOne({ body: request({ urgent }), models: ensembleSystemOneModels(new Ensemble({ platform: "native" })) });
    expect(reply.status).toBe(502);
    expect((reply.body as { detail: { error_type: string } }).detail.error_type).toBe("upstream_error");
  });

  it("S1W5.5 the header names the member even when the model did not set a response id", () => {
    expect(MODEL_HEADER).toBe("x-harness-model");
    const served1 = ensembleSystemOneModels(new Ensemble({ platform: "native" })).resolve("latest")!;
    expect(served1.answeredBy?.({ modelId: "judgment", headers: { [MODEL_HEADER]: "m1" } })).toBe("m1");
    expect(served1.answeredBy?.({ modelId: "judgment", headers: undefined })).toBeUndefined();
  });
});
