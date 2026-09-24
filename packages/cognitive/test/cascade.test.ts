import { describe, expect, it } from "vitest";
import { decideToolCalls, Ensemble } from "@harness/cognitive";
import type { Ensemble as EnsembleType, GenerateRequest, GenerationEvent, JudgeAnswer, JudgeRequest, ModelDescriptor, Routing, TaskCategory, ToolCall, ToolSpec } from "@harness/cognitive";

const tools: ToolSpec[] = [
  { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  { name: "set_timer", description: "Start a timer", parameters: { type: "object", properties: { minutes: { type: "integer" } }, required: ["minutes"] } },
];

function d(id: string, tasks: readonly TaskCategory[], ports: ModelDescriptor["ports"], locality: ModelDescriptor["locality"] = "local"): ModelDescriptor {
  return { id, name: id, publisher: "t", tasks, ports, locality, runtime: "transformers.js", platforms: ["native"], license: "MIT", downloadBytes: 1, benchmarks: [] };
}

function setup(options: { routing?: Routing; judgeP?: number; judgeAnswer?: JudgeAnswer | null; generated?: string | null; alsoGenerate?: ToolCall }) {
  const calls = { route: 0, judge: [] as JudgeRequest[], generate: 0, requests: [] as GenerateRequest[] };
  const e = new Ensemble({ platform: "native" });
  if (options.routing)
    e.register(d("needle", ["tool-calling"], ["router"]), async () => ({
      router: { route: async () => (calls.route++, options.routing!) },
    }));
  if (options.judgeP !== undefined || options.judgeAnswer !== undefined)
    e.register(d("jev", ["judgment"], ["judge"], "hosted"), async () => ({
      judge: {
        evaluate: async (r) => {
          calls.judge.push(r);
          if (options.judgeAnswer === null) return {};
          return { correct: options.judgeAnswer ?? { type: "boolean" as const, probability: options.judgeP! } };
        },
      },
    }));
  if (options.generated !== undefined && options.generated !== null) {
    const raw = options.generated;
    e.register(d("ornith", ["tool-calling", "chat"], ["generator"]), async () => ({
      generator: {
        async *generate(request: GenerateRequest): AsyncIterable<GenerationEvent> {
          calls.generate++;
          calls.requests.push(request);
          yield { type: "text", text: raw };
          yield { type: "tool-call", call: { name: "set_timer", arguments: { minutes: 5 } } };
          if (options.alsoGenerate) yield { type: "tool-call", call: options.alsoGenerate };
          yield { type: "finish", reason: "tool-calls" };
        },
      },
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

  it("CA1.9 thresholds must be ordered probabilities", async () => {
    const { e } = setup({ routing: weather });
    await expect(decideToolCalls(e, { input: "x", tools }, { act: 0.5, verify: 0.8, accept: 0.8 })).rejects.toThrow(/threshold/);
    await expect(decideToolCalls(e, { input: "x", tools }, { act: 0.9, verify: 0.5, accept: 1.2 })).rejects.toThrow(/threshold/);
  });

  it("CA2.1 the trace records each step exactly: who answered, with what confidence, and why it moved on", async () => {
    expect((await decideToolCalls(setup({ routing: weather }).e, { input: "x", tools })).trace).toEqual([{ step: "route", member: "needle", outcome: "confidence 0.97" }]);
    expect((await decideToolCalls(setup({ routing: { ...weather, confidence: 0.7 }, judgeP: 0.92 }).e, { input: "x", tools })).trace).toEqual([
      { step: "route", member: "needle", outcome: "confidence 0.7" },
      { step: "verify", member: "jev", outcome: "p=0.92" },
    ]);
    const unknown = await decideToolCalls(setup({ routing: { calls: [{ name: "launch_rocket", arguments: {} }], confidence: 1, reasoning: "" }, generated: "" }).e, { input: "x", tools });
    expect(unknown.trace[0]).toEqual({ step: "route", member: "needle", outcome: "invalid: unknown tool launch_rocket" });
    const missing = await decideToolCalls(setup({ routing: { calls: [{ name: "get_weather", arguments: {} }], confidence: 1, reasoning: "" }, generated: "" }).e, { input: "x", tools });
    expect(missing.trace[0]).toEqual({ step: "route", member: "needle", outcome: "invalid: get_weather is missing city" });
    expect((await decideToolCalls(setup({ generated: "" }).e, { input: "x", tools })).trace).toEqual([
      { step: "route", outcome: "no router available" },
      { step: "escalate", member: "ornith", outcome: "1 call(s)" },
    ]);
    expect((await decideToolCalls(setup({ routing: { ...weather, confidence: 0.7 }, generated: "" }).e, { input: "x", tools })).trace).toEqual([
      { step: "route", member: "needle", outcome: "confidence 0.7" },
      { step: "verify", outcome: "no judge available" },
      { step: "escalate", member: "ornith", outcome: "1 call(s)" },
    ]);
  });

  it("CA2.2 the generator is asked with the tool system prompt, the user's words and the tools; its invalid calls are dropped and counted", async () => {
    const { e, calls } = setup({ generated: "", alsoGenerate: { name: "launch_rocket", arguments: {} } });
    const decision = await decideToolCalls(e, { input: "5 minute timer", tools });
    expect(decision.calls).toEqual([{ name: "set_timer", arguments: { minutes: 5 } }]);
    expect(decision.trace.at(-1)).toEqual({ step: "escalate", member: "ornith", outcome: "1 call(s), 1 invalid dropped" });
    expect(calls.requests[0]).toEqual({
      messages: [
        { role: "system", content: "Call the tools that fulfil the user's request. Call nothing if no tool applies." },
        { role: "user", content: "5 minute timer" },
      ],
      tools,
    });
  });

  it("CA2.3 thresholds are inclusive: confidence equal to act is taken, equal to verify is judged, and p equal to accept is kept", async () => {
    const policy = { act: 0.9, verify: 0.5, accept: 0.8 };
    expect((await decideToolCalls(setup({ routing: { ...weather, confidence: 0.9 }, judgeP: 0, generated: "" }).e, { input: "x", tools }, policy)).decidedBy).toBe("router");
    expect((await decideToolCalls(setup({ routing: { ...weather, confidence: 0.5 }, judgeP: 0.8, generated: "" }).e, { input: "x", tools }, policy)).decidedBy).toBe("router+judge");
    // boundaries are legal policies: equal verify and act, and the ends of [0, 1]
    await expect(decideToolCalls(setup({ routing: weather }).e, { input: "x", tools }, { act: 0.5, verify: 0.5, accept: 0.5 })).resolves.toBeDefined();
    await expect(decideToolCalls(setup({ routing: weather }).e, { input: "x", tools }, { act: 1, verify: 0, accept: 0 })).resolves.toBeDefined();
    await expect(decideToolCalls(setup({ routing: weather }).e, { input: "x", tools }, { act: 0.9, verify: -0.1, accept: 0.8 })).rejects.toThrow(/threshold/);
    await expect(decideToolCalls(setup({ routing: weather }).e, { input: "x", tools }, { act: 1.1, verify: 0.5, accept: 0.8 })).rejects.toThrow(/threshold/);
  });

  it("CA2.4 a judge that answers some other way, or not at all, counts as p=0", async () => {
    for (const judgeAnswer of [{ type: "score" as const, score: 1 }, null]) {
      const decision = await decideToolCalls(setup({ routing: { ...weather, confidence: 0.7 }, judgeAnswer, generated: "" }).e, { input: "x", tools });
      expect(decision.decidedBy).toBe("generator");
      expect(decision.trace[1]).toEqual({ step: "verify", member: "jev", outcome: "p=0" });
    }
  });

  it("CA2.5 with no generator only the router's valid calls stand; with neither router nor generator there is no member", async () => {
    const mixed: Routing = { calls: [...weather.calls, { name: "launch_rocket", arguments: {} }], confidence: 0.99, reasoning: "" };
    expect((await decideToolCalls(setup({ routing: mixed }).e, { input: "x", tools })).calls).toEqual(weather.calls);
    await expect(decideToolCalls(setup({}).e, { input: "x", tools })).rejects.toMatchObject({ code: "no_member", message: expect.stringMatching(/tool-calling on native/) });
  });

  it("CA2.6 an unexpected failure resolving a member is not mistaken for an absent member", async () => {
    const broken = { platform: "native", resolve: async () => Promise.reject(new Error("disk on fire")) } as unknown as EnsembleType;
    await expect(decideToolCalls(broken, { input: "x", tools })).rejects.toThrow("disk on fire");
  });
});
