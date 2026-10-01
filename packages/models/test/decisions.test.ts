import { describe, expect, it } from "vitest";
import { experimental_evaluate } from "ai";
import { decisionsApiAvailable, decisionsUrl, openAiCompatibleDecisionsModel } from "@harness/models";

describe("an OpenAI-compatible decisions endpoint", () => {
  it("OD1.3 the decisions route is the server's /v1/decisions, and a missing route is not support", async () => {
    expect(decisionsUrl("http://127.0.0.1:9/v1/")).toBe("http://127.0.0.1:9/v1/decisions");
    const seen: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response("no", { status: seen.length === 1 ? 400 : 404 });
    }) as typeof fetch;
    expect(await decisionsApiAvailable("http://127.0.0.1:9", fetchFn)).toBe(true);
    expect(await decisionsApiAvailable("http://127.0.0.1:9/v1", fetchFn)).toBe(false);
    expect(seen).toEqual(["http://127.0.0.1:9/v1/decisions", "http://127.0.0.1:9/v1/decisions"]);
    const down = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await decisionsApiAvailable("http://127.0.0.1:9", down)).toBe(false);
  });

  it("OD1.4 a decision posts the state and the named questions to the configured endpoint", async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(url), body });
      const questions = body["questions"] as Record<string, { criteria: Record<string, string> }>;
      const answers = Object.fromEntries(
        Object.entries(questions).map(([id, question]) => {
          const options = Object.keys(question.criteria);
          return [id, { type: "choice", choice: options[0], probabilities: Object.fromEntries(options.map((option, index) => [option, index === 0 ? 1 : 0])) }];
        }),
      );
      return Response.json({ answers });
    }) as typeof fetch;
    const model = openAiCompatibleDecisionsModel({ baseUrl: "http://decisions.example/v1", model: "served-model", fetch: fetchFn });
    const { answers } = await experimental_evaluate({
      model,
      maxRetries: 0,
      state: "how do I brew tea",
      questions: { q0: { type: "choice", instructions: "Which intent?", criteria: { a: "A how-to procedure", b: "Something else" } } },
    });
    expect(requests.map((request) => request.url)).toEqual(["http://decisions.example/v1/decisions"]);
    expect(requests[0]?.body).toMatchObject({ model: "served-model", state: "how do I brew tea" });
    expect(answers["q0"]).toMatchObject({ type: "choice", choice: "a" });
  });
});
