import { describe, expect, it } from "vitest";
import { decideToolCalls, Ensemble } from "@harness/cognitive";
import type { GenerationEvent, JudgeRequest, ModelDescriptor, Routing, TaskCategory, ToolSpec } from "@harness/cognitive";

const tools: ToolSpec[] = [
  { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  { name: "set_timer", description: "Start a timer", parameters: { type: "object", properties: { minutes: { type: "integer" } }, required: ["minutes"] } },
];

function d(id: string, tasks: readonly TaskCategory[], ports: ModelDescriptor["ports"], locality: ModelDescriptor["locality"] = "local"): ModelDescriptor {
  return { id, name: id, publisher: "t", tasks, ports, locality, runtime: "transformers.js", platforms: ["native"], license: "MIT", downloadBytes: 1, benchmarks: [] };
}

function setup(options: { routing?: Routing; judgeP?: number; generated?: string | null }) {
  const calls = { route: 0, judge: [] as JudgeRequest[], generate: 0 };
  const e = new Ensemble({ platform: "native" });
  if (options.routing)
    e.register(d("needle", ["tool-calling"], ["router"]), async () => ({
      router: { route: async () => (calls.route++, options.routing!) },
    }));
  if (options.judgeP !== undefined)
    e.register(d("jev", ["judgment"], ["judge"], "hosted"), async () => ({
      judge: { evaluate: async (r) => (calls.judge.push(r), { correct: { type: "boolean" as const, probability: options.judgeP! } }) },
    }));
  if (options.generated !== undefined && options.generated !== null) {
    const raw = options.generated;
    e.register(d("ornith", ["tool-calling", "chat"], ["generator"]), async () => ({
      generator: {
        async *generate(): AsyncIterable<GenerationEvent> {
          calls.generate++;
          yield { type: "text", text: raw };
          yield { type: "tool-call", call: { name: "set_timer", arguments: { minutes: 5 } } };
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
});
