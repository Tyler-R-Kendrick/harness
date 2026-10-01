import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { experimental_evaluate } from "ai";
import { bytes } from "@harness/cognitive";
import type { Catalog, ModelDescriptor } from "@harness/cognitive";
import { buildNativeEnsemble } from "@harness/platform-native";
import { configuredDecisionsEndpoint, openAiCompatibleEndpoint, readSettingsLayers } from "../src/openai-endpoint.ts";

const localJudge: ModelDescriptor = {
  id: "local-judge",
  name: "local",
  publisher: "t",
  tasks: ["classification"],
  ports: ["judge"],
  locality: "local",
  runtime: "typesafe-api",
  run: { baseUrl: "http://local-judge.test", model: "local" },
  platforms: ["native"],
  license: "MIT",
  downloadBytes: bytes(1),
  benchmarks: [],
};

const catalog: Catalog = { models: [localJudge], preferences: { classification: ["local-judge"] } };

function answering(status: number): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (init?.method === "POST" && String(init.body) === "{}") return new Response("no", { status });
    if (href.endsWith("/v1/models")) return Response.json({ data: [{ id: "listed-model" }] });
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, { criteria: Record<string, string> }> };
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([id, question]) => {
        const options = Object.keys(question.criteria);
        return [id, { type: "choice", choice: options[0], probabilities: Object.fromEntries(options.map((option, index) => [option, index === 0 ? 1 : 0])) }];
      }),
    );
    return Response.json({ answers });
  }) as typeof fetch;
}

describe("harness settings for an OpenAI-compatible decisions endpoint", () => {
  it("OD1.1 a base URL in settings is the endpoint, and a blank one is not", () => {
    expect(openAiCompatibleEndpoint({ openai: "http://127.0.0.1:9/v1" })).toEqual({ baseUrl: "http://127.0.0.1:9/v1" });
    expect(openAiCompatibleEndpoint({ openai: { baseUrl: "http://127.0.0.1:9/v1", model: "served", apiKey: "k" } })).toEqual({
      baseUrl: "http://127.0.0.1:9/v1",
      model: "served",
      apiKey: "k",
    });
    expect(openAiCompatibleEndpoint({ openai: "  " })).toBeUndefined();
    expect(openAiCompatibleEndpoint({ daemon: "/tmp/d.sock" })).toBeUndefined();
    expect(openAiCompatibleEndpoint({ openai: "not a url" })).toBeUndefined();
  });

  it("OD1.2 the workspace endpoint wins over the user one", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-openai-"));
    const project = join(root, "project", ".harness");
    const user = join(root, "user");
    mkdirSync(project, { recursive: true });
    mkdirSync(user, { recursive: true });
    writeFileSync(join(project, "settings.json"), `${JSON.stringify({ openai: "http://project.test/v1" })}\n`);
    writeFileSync(join(user, "settings.json"), `${JSON.stringify({ openai: { baseUrl: "http://user.test/v1", model: "user" } })}\n`);
    expect(readSettingsLayers({ project, user, global: join(root, "missing") }).map(openAiCompatibleEndpoint)).toEqual([
      { baseUrl: "http://project.test/v1" },
      { baseUrl: "http://user.test/v1", model: "user" },
      undefined,
    ]);
  });

  it("OD1.5 a supporting endpoint is the classification decision, and a route that is missing is not", async () => {
    const supported = await configuredDecisionsEndpoint({ layers: [{ openai: "http://decisions.example/v1" }], fetch: answering(400) });
    expect(supported).toEqual({ baseUrl: "http://decisions.example/v1", model: "listed-model" });
    expect(await configuredDecisionsEndpoint({ layers: [{ openai: "http://decisions.example/v1" }], fetch: answering(404) })).toBeUndefined();
    const probed: string[] = [];
    const firstOnly = (async (url: string | URL | Request) => {
      probed.push(String(url));
      return new Response("no", { status: String(url).includes("missing.example") ? 404 : 400 });
    }) as typeof fetch;
    expect(
      await configuredDecisionsEndpoint({
        layers: [{ openai: "http://missing.example/v1" }, { openai: "http://later.example/v1" }],
        fetch: firstOnly,
      }),
    ).toBeUndefined();
    expect(probed.every((url) => url.includes("missing.example"))).toBe(true);
    const unlisted = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.body) === "{}") return new Response("no", { status: 400 });
      return Response.json({ data: [] });
    }) as typeof fetch;
    expect(await configuredDecisionsEndpoint({ layers: [{ openai: "http://decisions.example/v1" }], fetch: unlisted })).toBeUndefined();
    const named = await configuredDecisionsEndpoint({
      layers: [{ openai: { baseUrl: "http://decisions.example/v1", model: "named-model" } }, { openai: "http://other.example/v1" }],
      fetch: answering(400),
    });
    expect(named).toEqual({ baseUrl: "http://decisions.example/v1", model: "named-model" });

    const requests: string[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push(String(url));
      return answering(400)(url, init);
    }) as typeof fetch;
    const { ensemble } = buildNativeEnsemble({
      cacheDir: join(tmpdir(), "harness-decisions-cache"),
      catalog,
      allowHosted: false,
      fetch: fetchFn,
      decisions: { baseUrl: "http://decisions.example/v1", model: "listed-model" },
    });
    const { answers } = await experimental_evaluate({
      model: ensemble.evaluationModel("classification"),
      maxRetries: 0,
      state: "how do I brew tea",
      questions: { q0: { type: "choice", instructions: "Which intent?", criteria: { a: "A how-to procedure", b: "Something else" } } },
    });
    expect(answers["q0"]).toMatchObject({ type: "choice", choice: "a" });
    expect(requests).toEqual(["http://decisions.example/v1/decisions"]);

    const untouched: string[] = [];
    const quiet = (async (url: string | URL | Request, init?: RequestInit) => {
      untouched.push(String(url));
      return answering(400)(url, init);
    }) as typeof fetch;
    const plain = buildNativeEnsemble({ cacheDir: join(tmpdir(), "harness-decisions-cache"), catalog: { models: [], preferences: {} }, allowHosted: false, fetch: quiet });
    await expect(
      experimental_evaluate({
        model: plain.ensemble.evaluationModel("classification"),
        maxRetries: 0,
        state: "tea",
        questions: { q0: { type: "choice", instructions: "Which?", criteria: { a: "tea", b: "other" } } },
      }),
    ).rejects.toThrow(/no judge/);
    expect(untouched).toEqual([]);
  });
});
