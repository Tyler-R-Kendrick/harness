import { describe, expect, it } from "vitest";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { Experimental_EvaluationMockModelV4, MockLanguageModelV4 } from "ai/test";
import { bytes, cascadePolicy, decideToolCalls, Ensemble, HARNESS, usage } from "@harness/cognitive";
import type { Ensemble as EnsembleType, ModelDescriptor, TaskCategory, ToolCall, ToolSpec } from "@harness/cognitive";

const tools: ToolSpec[] = [
  { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  { name: "set_timer", description: "Start a timer", parameters: { type: "object", properties: { minutes: { type: "integer" } }, required: ["minutes"] } },
];

function d(id: string, tasks: readonly TaskCategory[], ports: ModelDescriptor["ports"], locality: ModelDescriptor["locality"] = "local"): ModelDescriptor {
  return { id, name: id, publisher: "t", tasks, ports, locality, runtime: "transformers.js", run: { dtype: "q4" }, platforms: ["native"], license: "MIT", downloadBytes: bytes(1), benchmarks: [] };
}

interface Routing {
  readonly calls: readonly ToolCall[];
  readonly confidence: number;
  readonly reasoning: string;
}

const toolCalls = (calls: readonly ToolCall[]) => calls.map((c, i) => ({ type: "tool-call" as const, toolCallId: `call_${i}`, toolName: c.name, input: JSON.stringify(c.arguments) }));

function setup(options: { routing?: Routing; judgeP?: number; judgeAnswer?: { type: string } | null; generated?: string | null; alsoGenerate?: ToolCall }) {
  const calls = { route: 0, judge: [] as { state: unknown; questions: Record<string, unknown> }[], generate: 0, requests: [] as LanguageModelV4CallOptions[] };
  const e = new Ensemble({ platform: "native" });
  if (options.routing) {
    const r = options.routing;
    e.register(d("router-a", ["tool-calling"], ["router"]), async () => ({
      router: new MockLanguageModelV4({
        doGenerate: async () => (
          calls.route++,
          {
            content: [{ type: "reasoning", text: r.reasoning }, ...toolCalls(r.calls)],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: usage(),
            providerMetadata: { [HARNESS]: { confidence: r.confidence } },
            warnings: [],
          }
        ),
      }),
    }));
  }
  if (options.judgeP !== undefined || options.judgeAnswer !== undefined)
    e.register(d("judge-a", ["judgment"], ["judge"], "hosted"), async () => ({
      judge: new Experimental_EvaluationMockModelV4({
        doEvaluate: async (o) => {
          calls.judge.push({ state: o.state, questions: o.questions });
          if (options.judgeAnswer === null) return { answers: {}, warnings: [] };
          return { answers: { correct: (options.judgeAnswer ?? { type: "boolean", probability: options.judgeP! }) as never }, warnings: [] };
        },
      }),
    }));
  if (options.generated !== undefined && options.generated !== null) {
    const raw = options.generated;
    e.register(d("generator-a", ["tool-calling", "chat"], ["generator"]), async () => ({
      generator: new MockLanguageModelV4({
        doGenerate: async (request) => {
          calls.generate++;
          calls.requests.push(request);
          return {
            content: [...(raw ? [{ type: "text" as const, text: raw }] : []), ...toolCalls([{ name: "set_timer", arguments: { minutes: 5 } }, ...(options.alsoGenerate ? [options.alsoGenerate] : [])])],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: usage(),
            warnings: [],
          };
        },
      }),
    }));
  }
  return { e, calls };
}

const weather: Routing = { calls: [{ name: "get_weather", arguments: { city: "Lagos" } }], confidence: 0.97, reasoning: "city named" };

describe("tool-call cascade: router, then judge, then generator", () => {
  it("CA1.1 a confident, valid routing is taken as is", async () => {
    const { e, calls } = setup({ routing: weather, judgeP: 0.1, generated: "" });
    const decision = await decideToolCalls(e, { input: "weather in Lagos?", tools });
    expect(decision).toMatchObject({ calls: weather.calls, decidedBy: "router", confidence: 0.97 });
    expect(calls).toMatchObject({ route: 1, judge: [], generate: 0 });
  });

  it("CA1.2 a middling routing is checked by the judge and kept when the judge agrees", async () => {
    const { e, calls } = setup({ routing: { ...weather, confidence: 0.7 }, judgeP: 0.92, generated: "" });
    const decision = await decideToolCalls(e, { input: "weather in Lagos?", tools });
    expect(decision).toMatchObject({ calls: weather.calls, decidedBy: "router+judge", confidence: 0.92 });
    expect(calls.judge[0]!.state).toEqual({
      request: "weather in Lagos?",
      tools: [
        { name: "get_weather", description: "Weather for a city" },
        { name: "set_timer", description: "Start a timer" },
      ],
      calls: weather.calls,
    });
    expect(calls.judge[0]!.questions["correct"]).toMatchObject({ type: "boolean" });
    expect(calls.generate).toBe(0);
  });

  it("CA1.3 when the judge disagrees the generator decides", async () => {
    const { e, calls } = setup({ routing: { ...weather, confidence: 0.7 }, judgeP: 0.3, generated: "" });
    const decision = await decideToolCalls(e, { input: "5 minute timer", tools });
    expect(decision).toMatchObject({ calls: [{ name: "set_timer", arguments: { minutes: 5 } }], decidedBy: "generator" });
    expect(decision.trace.map((s) => s.step)).toEqual(["route", "verify", "escalate"]);
    expect(calls.generate).toBe(1);
  });

  it("CA1.4 a low-confidence routing skips the judge and escalates", async () => {
    const { e, calls } = setup({ routing: { ...weather, confidence: 0.2 }, judgeP: 0.99, generated: "" });
    expect((await decideToolCalls(e, { input: "?", tools })).decidedBy).toBe("generator");
    expect(calls.judge).toEqual([]);
  });

  it("CA1.5 a routed call to an unknown tool, or one missing a required argument, escalates whatever its confidence", async () => {
    for (const bad of [
      { name: "launch_rocket", arguments: {} },
      { name: "get_weather", arguments: {} },
    ]) {
      const { e } = setup({ routing: { calls: [bad], confidence: 1, reasoning: "" }, judgeP: 0.99, generated: "" });
      const decision = await decideToolCalls(e, { input: "x", tools });
      expect(decision.decidedBy).toBe("generator");
      expect(decision.trace[0]).toMatchObject({ step: "route", outcome: expect.stringMatching(/invalid/) });
    }
  });

  it("CA1.6 with no generator the router's answer stands, flagged unverified", async () => {
    const { e } = setup({ routing: { ...weather, confidence: 0.2 }, generated: null });
    const decision = await decideToolCalls(e, { input: "?", tools });
    expect(decision).toMatchObject({ calls: weather.calls, decidedBy: "router", unverified: true });
    expect(decision.trace.at(-1)).toMatchObject({ step: "escalate", outcome: expect.stringMatching(/no generator/) });
  });

  it("CA1.7 with no router the generator decides directly", async () => {
    const { e } = setup({ generated: "" });
    expect(await decideToolCalls(e, { input: "timer", tools })).toMatchObject({ decidedBy: "generator", calls: [{ name: "set_timer", arguments: { minutes: 5 } }] });
  });

  it("CA1.8 an empty, confident routing means no tool applies", async () => {
    const { e } = setup({ routing: { calls: [], confidence: 0.96, reasoning: "no poem tool" }, generated: "" });
    expect(await decideToolCalls(e, { input: "write a poem", tools })).toMatchObject({ calls: [], decidedBy: "router" });
  });

  it("CA1.9 thresholds must be ordered probabilities: a policy that is not one cannot be made", () => {
    expect(() => cascadePolicy({ act: 0.5, verify: 0.8, accept: 0.8 })).toThrow(/verify must not be above act/);
    expect(() => cascadePolicy({ act: 0.9, verify: 0.5, accept: 1.2 })).toThrow(/invalid cascade thresholds[\s\S]*accept/);
  });

  it("CA2.1 the trace records each step exactly: who answered, with what confidence, and why it moved on", async () => {
    expect((await decideToolCalls(setup({ routing: weather }).e, { input: "x", tools })).trace).toEqual([{ step: "route", member: "router-a", outcome: "confidence 0.97" }]);
    expect((await decideToolCalls(setup({ routing: { ...weather, confidence: 0.7 }, judgeP: 0.92 }).e, { input: "x", tools })).trace).toEqual([
      { step: "route", member: "router-a", outcome: "confidence 0.7" },
      { step: "verify", member: "judge-a", outcome: "p=0.92" },
    ]);
    const unknown = await decideToolCalls(setup({ routing: { calls: [{ name: "launch_rocket", arguments: {} }], confidence: 1, reasoning: "" }, generated: "" }).e, { input: "x", tools });
    expect(unknown.trace[0]).toEqual({ step: "route", member: "router-a", outcome: expect.stringMatching(/^invalid: launch_rocket: .*launch_rocket/) });
    const missing = await decideToolCalls(setup({ routing: { calls: [{ name: "get_weather", arguments: {} }], confidence: 1, reasoning: "" }, generated: "" }).e, { input: "x", tools });
    expect(missing.trace[0]).toEqual({ step: "route", member: "router-a", outcome: expect.stringMatching(/^invalid: get_weather: .*city/s) });
    expect((await decideToolCalls(setup({ generated: "" }).e, { input: "x", tools })).trace).toEqual([
      { step: "route", outcome: "no router available" },
      { step: "escalate", member: "generator-a", outcome: "1 call(s)" },
    ]);
    expect((await decideToolCalls(setup({ routing: { ...weather, confidence: 0.7 }, generated: "" }).e, { input: "x", tools })).trace).toEqual([
      { step: "route", member: "router-a", outcome: "confidence 0.7" },
      { step: "verify", outcome: "no judge available" },
      { step: "escalate", member: "generator-a", outcome: "1 call(s)" },
    ]);
  });

  it("CA2.2 the generator is asked with the tool system prompt, the user's words and the tools; its invalid calls are dropped and counted", async () => {
    const { e, calls } = setup({ generated: "", alsoGenerate: { name: "launch_rocket", arguments: {} } });
    const decision = await decideToolCalls(e, { input: "5 minute timer", tools });
    expect(decision.calls).toEqual([{ name: "set_timer", arguments: { minutes: 5 } }]);
    expect(decision.trace.at(-1)).toEqual({ step: "escalate", member: "generator-a", outcome: "1 call(s), 1 invalid dropped" });
    expect(calls.requests[0]!.prompt).toEqual([
      { role: "system", content: "Call the tools that fulfil the user's request. Call nothing if no tool applies." },
      { role: "user", content: [{ type: "text", text: "5 minute timer" }] },
    ]);
    expect(calls.requests[0]!.tools!.map((t) => t.name)).toEqual(["get_weather", "set_timer"]);
  });

  it("CA2.3 thresholds are inclusive: confidence equal to act is taken, equal to verify is judged, and p equal to accept is kept", async () => {
    const policy = cascadePolicy({ act: 0.9, verify: 0.5, accept: 0.8 });
    expect((await decideToolCalls(setup({ routing: { ...weather, confidence: 0.9 }, judgeP: 0, generated: "" }).e, { input: "x", tools }, policy)).decidedBy).toBe("router");
    expect((await decideToolCalls(setup({ routing: { ...weather, confidence: 0.5 }, judgeP: 0.8, generated: "" }).e, { input: "x", tools }, policy)).decidedBy).toBe("router+judge");
    // boundaries are legal policies: equal verify and act, and the ends of [0, 1]
    await expect(decideToolCalls(setup({ routing: weather }).e, { input: "x", tools }, cascadePolicy({ act: 0.5, verify: 0.5, accept: 0.5 }))).resolves.toBeDefined();
    await expect(decideToolCalls(setup({ routing: weather }).e, { input: "x", tools }, cascadePolicy({ act: 1, verify: 0, accept: 0 }))).resolves.toBeDefined();
    expect(() => cascadePolicy({ act: 0.9, verify: -0.1, accept: 0.8 })).toThrow(/threshold/);
    expect(() => cascadePolicy({ act: 1.1, verify: 0.5, accept: 0.8 })).toThrow(/threshold/);
  });

  it("CA2.4 a judge that answers some other way, or not at all, counts as p=0, and the trace says why", async () => {
    for (const judgeAnswer of [{ type: "score" as const, score: 1 }, null]) {
      const decision = await decideToolCalls(setup({ routing: { ...weather, confidence: 0.7 }, judgeAnswer, generated: "" }).e, { input: "x", tools });
      expect(decision.decidedBy).toBe("generator");
      expect(decision.trace[1]).toEqual({ step: "verify", outcome: expect.stringMatching(/^p=0: (Question "correct" returned an answer with the wrong type|Evaluation must return exactly one answer for every question)/) });
    }
  });

  it("CA2.5 with no generator only the router's valid calls stand; with neither router nor generator there is no member", async () => {
    const mixed: Routing = { calls: [...weather.calls, { name: "launch_rocket", arguments: {} }], confidence: 0.99, reasoning: "" };
    expect((await decideToolCalls(setup({ routing: mixed }).e, { input: "x", tools })).calls).toEqual(weather.calls);
    await expect(decideToolCalls(setup({}).e, { input: "x", tools })).rejects.toMatchObject({ code: "no_member", message: expect.stringMatching(/tool-calling on native/) });
  });

  it("CA2.6 an unexpected failure resolving a member is not mistaken for an absent member", async () => {
    const broken = { platform: "native", serves: () => true, languageModel: () => new MockLanguageModelV4({ doGenerate: async () => Promise.reject(new Error("disk on fire")) }) } as unknown as EnsembleType;
    await expect(decideToolCalls(broken, { input: "x", tools })).rejects.toThrow("disk on fire");
  });
});
