import { describe, expect, it } from "vitest";
import { clm, clmAvailable, EvaluationJudge, JEV_MODEL_ID } from "@harness/models";
import { FakeEvaluationModel } from "./fake-evaluation-model.ts";

describe("evaluation judges", () => {
  it("EV1.1 defaults to Jev on the Vercel AI Gateway", () => {
    expect(JEV_MODEL_ID).toBe("typesafe-ai/jev");
    expect(new EvaluationJudge().identity).toEqual({ provider: "gateway", modelId: "typesafe-ai/jev" });
  });

  it("EV1.2 sends the state and typed questions and returns typed answers", async () => {
    const model = new FakeEvaluationModel(() => ({ correct: { type: "boolean", probability: 0.93 } }));
    const judge = new EvaluationJudge(model);
    const answers = await judge.evaluate({ state: { reply: "4" }, questions: { correct: { type: "boolean", instructions: "Is the reply right?" } } });
    expect(answers).toEqual({ correct: { type: "boolean", probability: 0.93 } });
    expect(model.calls[0]).toMatchObject({ state: { reply: "4" }, questions: { correct: { type: "boolean", instructions: "Is the reply right?" } } });
    expect(judge.identity).toEqual({ provider: "fake", modelId: "fake-jev" });
  });
});

/** A stand-in clm-serve speaking its /v1/systemone wire format (noul, choice, score). */
function clmServe() {
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
    return Response.json({ model: "clm-latest", answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, canned[q.type]])), usage: { input_tokens: 38 } });
  };
  return { f: f as typeof fetch, requests };
}

describe("CLM, the local judge", () => {
  it("CL1.1 asks clm-serve TypeSafe-style questions (boolean as noul) and maps the answers back", async () => {
    const { f, requests } = clmServe();
    const judge = new EvaluationJudge(clm({ baseUrl: "http://127.0.0.1:8700/", fetch: f }));
    const answers = await judge.evaluate({
      state: "Customer: my invoice was charged twice!",
      questions: {
        urgent: { type: "boolean", instructions: "Is this urgent?" },
        team: { type: "choice", instructions: "Which team?", criteria: { billing: "Charges", technical: "Bugs" } },
      },
    });
    expect(requests[0]!.url).toBe("http://127.0.0.1:8700/v1/systemone");
    expect(requests[0]!.body).toMatchObject({ model: "clm-latest", state: "Customer: my invoice was charged twice!", questions: { urgent: { type: "noul", instructions: "Is this urgent?" } } });
    expect(answers["urgent"]).toEqual({ type: "boolean", probability: 0.41 });
    expect(answers["team"]).toMatchObject({ type: "choice", choice: "billing", probabilities: { billing: 0.94, technical: 0.06 } });
    expect(judge.identity.modelId).toBe("clm-latest");
  });

  it("CL1.2 sends a key only when given one, and reports whether clm-serve is up", async () => {
    const { f, requests } = clmServe();
    await new EvaluationJudge(clm({ baseUrl: "http://x", apiKey: "k", fetch: f })).evaluate({ state: "s", questions: { urgent: { type: "boolean", instructions: "?" } } });
    expect(requests[0]!.auth).toBe("Bearer k");
    expect(await clmAvailable({ baseUrl: "http://x", fetch: f })).toBe(true);
    expect(await clmAvailable({ baseUrl: "http://x", fetch: (async () => new Response("", { status: 502 })) as typeof fetch })).toBe(false);
    expect(await clmAvailable({ baseUrl: "http://x", fetch: (async () => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch })).toBe(false);
  });
});
