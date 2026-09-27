import { describe, expect, it } from "vitest";
import { experimental_evaluate } from "ai";
import { Experimental_EvaluationMockModelV4 } from "ai/test";
import type { Experimental_EvaluationModelV4CallOptions } from "@ai-sdk/provider";
import { gatewayEvaluationModel, generatorJudge, serviceAvailable, typesafeApiEvaluationModel } from "@harness/models";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { constraintOf, logprobsOf } from "@harness/cognitive";
import { JudgeAnswerSchema } from "@harness/cognitive";
import { judgeContract } from "@harness/testkit";

/** A scripted evaluation model that records what it was asked. */
function scripted(answers: Record<string, unknown>) {
  const calls: Experimental_EvaluationModelV4CallOptions[] = [];
  const model = new Experimental_EvaluationMockModelV4({
    provider: "fake",
    modelId: "fake-judge",
    doEvaluate: async (options) => {
      calls.push(options);
      return { answers: answers as never, warnings: [], usage: { inputTokens: 10, outputTokens: 0 } };
    },
  });
  return { model, calls };
}

describe("evaluation judges", () => {
  it("EV1.3 a model's answers are parsed where they enter: a probability outside [0, 1] is an error, not an answer", async () => {
    const { model } = scripted({ correct: { type: "boolean", probability: 1.2 } });
    await expect(experimental_evaluate({ model, maxRetries: 0, state: "s", questions: { correct: { type: "boolean", instructions: "?" } } })).rejects.toThrow();
    // answers that reach us as JSON are parsed by our schema, which refuses the same
    expect(() => JudgeAnswerSchema.parse({ type: "boolean", probability: 1.2 })).toThrow();
    expect(() => JudgeAnswerSchema.parse({ type: "choice", choice: "a", probabilities: { a: -0.1 } })).toThrow();
    expect(JudgeAnswerSchema.parse({ type: "boolean", probability: 0.4 })).toEqual({ type: "boolean", probability: 0.4 });
  });

  it("EV1.1 a gateway evaluation model is named by its gateway id", () => {
    const model = gatewayEvaluationModel("acme/judge");
    expect({ provider: model.provider, modelId: model.modelId }).toEqual({ provider: "gateway", modelId: "acme/judge" });
  });

  it("EV1.2 an evaluation model is asked the state and typed questions, and its answers are JudgeAnswers", async () => {
    const { model, calls } = scripted({ correct: { type: "boolean", probability: 0.93 } });
    const { answers } = await experimental_evaluate({ model, maxRetries: 0, state: { reply: "4" }, questions: { correct: { type: "boolean", instructions: "Is the reply right?" } } });
    expect(answers).toEqual({ correct: { type: "boolean", probability: 0.93 } });
    expect(JudgeAnswerSchema.parse(answers.correct)).toEqual({ type: "boolean", probability: 0.93 });
    expect(calls[0]).toMatchObject({ state: { reply: "4" }, questions: { correct: { type: "boolean", instructions: "Is the reply right?" } } });
  });
});

/** A stand-in server speaking TypeSafe's /v1/systemone wire format (noul, choice, score). */
function typesafeServer() {
  const requests: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const f = async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith("/health")) return Response.json({ ok: true });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: href, body, auth: new Headers(init?.headers).get("authorization") });
    const answer = (q: { type: string; criteria?: unknown }): unknown => {
      switch (q.type) {
        case "noul":
          return { type: "noul", noul: 0.41 };
        case "choice": {
          // the first option, most likely; the rest share what is left
          const options = Object.keys(q.criteria as Record<string, unknown>);
          const rest = options.length > 1 ? 0.06 / (options.length - 1) : 0;
          return { type: "choice", choice: options[0], confidence: 0.88, probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? (options.length > 1 ? 0.94 : 1) : rest])) };
        }
        default: {
          // the highest score, certainly
          const n = (q.criteria as unknown[]).length;
          return { type: "score", score: n - 1, probabilities: Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), i === n - 1 ? 1 : 0])) };
        }
      }
    };
    const questions = body["questions"] as Record<string, { type: string; criteria?: unknown }>;
    return Response.json({ model: "local-judge", answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, answer(q)])), usage: { input_tokens: 38 } });
  };
  return { f: f as typeof fetch, requests };
}

describe("judges on a TypeSafe-API server", () => {
  it("CL1.1 asks the server TypeSafe-style questions (boolean as noul) and maps the answers back", async () => {
    const { f, requests } = typesafeServer();
    const model = typesafeApiEvaluationModel({ baseUrl: "http://127.0.0.1:8700/", model: "local-judge", fetch: f });
    const { answers } = await experimental_evaluate({
      model,
      maxRetries: 0,
      state: "Customer: my invoice was charged twice!",
      questions: {
        urgent: { type: "boolean", instructions: "Is this urgent?" },
        team: { type: "choice", instructions: "Which team?", criteria: { billing: "Charges", technical: "Bugs" } },
      },
    });
    expect(requests[0]!.url).toBe("http://127.0.0.1:8700/v1/systemone");
    expect(requests[0]!.body).toMatchObject({ model: "local-judge", state: "Customer: my invoice was charged twice!", questions: { urgent: { type: "noul", instructions: "Is this urgent?" } } });
    expect(answers.urgent).toEqual({ type: "boolean", probability: 0.41 });
    expect(answers.team).toMatchObject({ type: "choice", choice: "billing", probabilities: { billing: 0.94, technical: 0.06 } });
    expect(model.modelId).toBe("local-judge");
  });

  it("CL1.2 sends the key it is given (else a placeholder), and reports whether a service is up", async () => {
    const { f, requests } = typesafeServer();
    const ask = { maxRetries: 0, state: "s", questions: { urgent: { type: "boolean" as const, instructions: "?" } } };
    await experimental_evaluate({ model: typesafeApiEvaluationModel({ baseUrl: "http://x", model: "m", apiKey: "k", fetch: f }), ...ask });
    await experimental_evaluate({ model: typesafeApiEvaluationModel({ baseUrl: "http://x", model: "m", fetch: f }), ...ask });
    expect(requests.map((r) => r.auth)).toEqual(["Bearer k", "Bearer none"]);
    expect(typesafeApiEvaluationModel({ baseUrl: "http://x", model: "m" }).modelId).toBe("m");
    expect(await serviceAvailable("http://x/health", f)).toBe(true);
    expect(await serviceAvailable("http://x/health", (async () => new Response("", { status: 502 })) as typeof fetch)).toBe(false);
    expect(await serviceAvailable("http://x/health", (async () => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch)).toBe(false);
  });
});

judgeContract("TypeSafe-API evaluation model over a fake server", () => typesafeApiEvaluationModel({ baseUrl: "http://x", model: "local-judge", fetch: typesafeServer().f }));

/**
 * A generator standing in for a local model: it answers each question with the option
 * letter it is scripted to prefer, and reports token log-probabilities (or not).
 */
function generator(pick: (prompt: string) => Record<string, number>, options: { readonly logprobs?: boolean; readonly answer?: (letters: string[]) => string } = {}) {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    modelId: "local-generator",
    doGenerate: async (call) => {
      calls.push(call);
      const prompt = JSON.stringify(call.prompt);
      const usage = { inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 3, text: 3, reasoning: undefined } };
      const constraint = constraintOf(call) as unknown as { schema: { enum: string[] } } | undefined;
      // Asked to reason first (unconstrained), it reasons.
      if (!constraint) return { content: [{ type: "text", text: "The reply matches, so it is right." }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
      const probs = pick(prompt);
      const letters = constraint.schema.enum;
      const best = letters.reduce((a, b) => ((probs[b] ?? 0) > (probs[a] ?? 0) ? b : a));
      const text = options.answer ? options.answer(letters) : JSON.stringify(best);
      const top = Object.entries(probs).map(([token, p]) => ({ token, logprob: Math.log(p) }));
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
        ...(options.logprobs === false ? {} : { providerMetadata: { harness: { logprobs: [{ token: '"', logprob: 0, top: [{ token: '"', logprob: 0 }] }, { token: best, logprob: Math.log(probs[best] ?? 1), top: [...top, { token: " The", logprob: -3 }] }] } } }),
      };
    },
  });
  return { model, calls };
}

describe("a generator as a judge (LLM-as-judge)", () => {
  it("GJ1.1 each question is put to the generator with the state, its options as letters, an answer constrained to one letter, and token probabilities asked for", async () => {
    const { model, calls } = generator(() => ({ A: 0.9, B: 0.1 }));
    const { answers } = await experimental_evaluate({ model: generatorJudge(model), maxRetries: 0, state: { question: "What is 17 + 25?", reply: "42" }, questions: { correct: { type: "boolean", instructions: "Does `reply` correctly answer `question`?" } } });
    expect(answers.correct).toEqual({ type: "boolean", probability: expect.closeTo(0.9, 6) });
    const call = calls[1]!;
    expect(constraintOf(call)).toEqual({ type: "json-schema", schema: { type: "string", enum: ["A", "B"] } });
    expect(logprobsOf(call.providerOptions)).toBe(20);
    expect(call.temperature).toBe(0);
    const text = JSON.stringify(call.prompt);
    for (const part of ["What is 17 + 25?", "Does `reply` correctly answer `question`?", "A. true", "B. false"]) expect(text).toContain(part);
  });

  it("GJ1.2 choices and scores get a distribution over their options from the letters' probabilities; a score is its expected level", async () => {
    const { model } = generator((prompt) => (prompt.includes("How complete") ? { A: 0.1, B: 0.2, C: 0.7 } : { A: 0.2, B: 0.6, C: 0.2 }));
    const { answers } = await experimental_evaluate({
      model: generatorJudge(model),
      maxRetries: 0,
      state: "a ticket",
      questions: {
        team: { type: "choice", instructions: "Which team?", criteria: { billing: "Charges and refunds", technical: null, sales: null } },
        quality: { type: "score", instructions: "How complete is it?", criteria: ["poor", "fair", "good"] },
      },
    });
    expect(answers.team).toEqual({ type: "choice", choice: "technical", probabilities: { billing: expect.closeTo(0.2, 6), technical: expect.closeTo(0.6, 6), sales: expect.closeTo(0.2, 6) } });
    expect(answers.quality).toEqual({ type: "score", score: expect.closeTo(1.6, 6), probabilities: { "0": expect.closeTo(0.1, 6), "1": expect.closeTo(0.2, 6), "2": expect.closeTo(0.7, 6) } });
  });

  it("GJ1.3 a generator that reports no token probabilities is taken at its word, and says so; an answer that is not an option is an error", async () => {
    const { model } = generator(() => ({ A: 0.3, B: 0.7 }), { logprobs: false });
    const result = await generatorJudge(model).doEvaluate({ state: "s", questions: { ok: { type: "boolean", instructions: "?" } } });
    expect(result.answers).toEqual({ ok: { type: "boolean", probability: 0 } });
    expect(result.warnings).toEqual([{ type: "other", message: "local-generator reported no token probabilities; its answers count as certain" }]);
    const { model: rambling } = generator(() => ({ A: 1 }), { logprobs: false, answer: () => "maybe" });
    await expect(generatorJudge(rambling).doEvaluate({ state: "s", questions: { ok: { type: "boolean", instructions: "?" } } })).rejects.toThrow('local-generator answered "maybe", not one of A, B');
  });

  it("GJ1.5 the generator reasons before it answers: a bounded, unconstrained call first, whose reasoning precedes the letter it is then asked for", async () => {
    const { model, calls } = generator(() => ({ A: 0.9, B: 0.1 }));
    await generatorJudge(model, { reasoningTokens: 64 }).doEvaluate({ state: { reply: "42" }, questions: { correct: { type: "boolean", instructions: "Is it right?" } } });
    expect(calls).toHaveLength(2);
    const [reason, answer] = calls as [LanguageModelV4CallOptions, LanguageModelV4CallOptions];
    expect({ constraint: constraintOf(reason), logprobs: logprobsOf(reason.providerOptions), max: reason.maxOutputTokens, temperature: reason.temperature }).toEqual({ constraint: undefined, logprobs: undefined, max: 64, temperature: 0 });
    expect(JSON.stringify(reason.prompt)).toContain("reason briefly");
    expect(JSON.stringify(reason.prompt)).toContain("A. true");
    // the letter is asked for after the question, the reasoning (as the generator's own turn) and a request for the letter alone
    expect(answer.prompt.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(JSON.stringify(answer.prompt[1])).not.toContain("reason briefly");
    expect(JSON.stringify(answer.prompt[2])).toContain("The reply matches, so it is right.");
    expect(JSON.stringify(answer.prompt[3])).toContain("letter only");
    expect(answer.maxOutputTokens).toBe(8);
    const { model: plain, calls: byDefault } = generator(() => ({ A: 1 }));
    await generatorJudge(plain).doEvaluate({ state: "s", questions: { ok: { type: "boolean", instructions: "?" } } });
    expect(byDefault[0]!.maxOutputTokens).toBe(192);
  });

  it("GJ1.4 it names the generator it runs on and takes every question type", () => {
    const judge = generatorJudge(generator(() => ({})).model);
    expect({ provider: judge.provider, modelId: judge.modelId, types: judge.supportedQuestionTypes }).toEqual({ provider: "harness.generator-judge", modelId: "local-generator", types: ["boolean", "choice", "score"] });
  });
});

judgeContract("a generator as a judge", () => generatorJudge(generator(() => ({ A: 0.7, B: 0.2, C: 0.1 })).model));
