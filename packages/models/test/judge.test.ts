import { describe, expect, it } from "vitest";
import { EvaluationJudge, gatewayEvaluationModel, serviceAvailable, typesafeApiEvaluationModel } from "@harness/models";
import { FakeEvaluationModel } from "./fake-evaluation-model.ts";

describe("evaluation judges", () => {
  it("EV1.1 a gateway evaluation model is named by its gateway id", () => {
    expect(new EvaluationJudge(gatewayEvaluationModel("acme/judge")).identity).toEqual({ provider: "gateway", modelId: "acme/judge" });
  });

  it("EV1.2 sends the state and typed questions and returns typed answers", async () => {
    const model = new FakeEvaluationModel(() => ({ correct: { type: "boolean", probability: 0.93 } }));
    const judge = new EvaluationJudge(model);
    const answers = await judge.evaluate({ state: { reply: "4" }, questions: { correct: { type: "boolean", instructions: "Is the reply right?" } } });
    expect(answers).toEqual({ correct: { type: "boolean", probability: 0.93 } });
    expect(model.calls[0]).toMatchObject({ state: { reply: "4" }, questions: { correct: { type: "boolean", instructions: "Is the reply right?" } } });
    expect(judge.identity).toEqual({ provider: "fake", modelId: "fake-judge" });
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
    const canned: Record<string, unknown> = {
      noul: { type: "noul", noul: 0.41 },
      choice: { type: "choice", choice: "billing", confidence: 0.88, probabilities: { billing: 0.94, technical: 0.06 } },
    };
    const questions = body["questions"] as Record<string, { type: string }>;
    return Response.json({ model: "local-judge", answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, canned[q.type]])), usage: { input_tokens: 38 } });
  };
  return { f: f as typeof fetch, requests };
}

describe("judges on a TypeSafe-API server", () => {
  it("CL1.1 asks the server TypeSafe-style questions (boolean as noul) and maps the answers back", async () => {
    const { f, requests } = typesafeServer();
    const judge = new EvaluationJudge(typesafeApiEvaluationModel({ baseUrl: "http://127.0.0.1:8700/", model: "local-judge", fetch: f }));
    const answers = await judge.evaluate({
      state: "Customer: my invoice was charged twice!",
      questions: {
        urgent: { type: "boolean", instructions: "Is this urgent?" },
        team: { type: "choice", instructions: "Which team?", criteria: { billing: "Charges", technical: "Bugs" } },
      },
    });
    expect(requests[0]!.url).toBe("http://127.0.0.1:8700/v1/systemone");
    expect(requests[0]!.body).toMatchObject({ model: "local-judge", state: "Customer: my invoice was charged twice!", questions: { urgent: { type: "noul", instructions: "Is this urgent?" } } });
    expect(answers["urgent"]).toEqual({ type: "boolean", probability: 0.41 });
    expect(answers["team"]).toMatchObject({ type: "choice", choice: "billing", probabilities: { billing: 0.94, technical: 0.06 } });
    expect(judge.identity.modelId).toBe("local-judge");
  });

  it("CL1.2 sends the key it is given (else a placeholder), and reports whether a service is up", async () => {
    const { f, requests } = typesafeServer();
    const ask = { state: "s", questions: { urgent: { type: "boolean" as const, instructions: "?" } } };
    await new EvaluationJudge(typesafeApiEvaluationModel({ baseUrl: "http://x", model: "m", apiKey: "k", fetch: f })).evaluate(ask);
    await new EvaluationJudge(typesafeApiEvaluationModel({ baseUrl: "http://x", model: "m", fetch: f })).evaluate(ask);
    expect(requests.map((r) => r.auth)).toEqual(["Bearer k", "Bearer none"]);
    expect(await serviceAvailable("http://x/health", f)).toBe(true);
    expect(await serviceAvailable("http://x/health", (async () => new Response("", { status: 502 })) as typeof fetch)).toBe(false);
    expect(await serviceAvailable("http://x/health", (async () => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch)).toBe(false);
  });
});
