import { describe, expect, it } from "vitest";
import { experimental_evaluate } from "ai";
import { Experimental_EvaluationMockModelV4 } from "ai/test";
import type { Experimental_EvaluationModelV4CallOptions } from "@ai-sdk/provider";
import { gatewayEvaluationModel, serviceAvailable, typesafeApiEvaluationModel } from "@harness/models";
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
