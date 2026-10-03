import { describe, expect, it } from "vitest";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { Experimental_EvaluationMockModelV4, MockLanguageModelV4 } from "ai/test";
import { bytes, cascadePolicy, decideToolCalls, Ensemble, HARNESS, usage } from "@harness/cognitive";
import type { Ensemble as EnsembleType, ModelDescriptor, TaskCategory, ToolCall, ToolSpec } from "@harness/cognitive";
import { decideToolCallsRecorded, TOOL_FORK } from "../src/tool-fork.ts";
import { DecisionRecordSchema } from "../src/types.ts";
import { policyJson, rig } from "./fork-fixtures.ts";

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
}

const toolCalls = (calls: readonly ToolCall[]) => calls.map((c, i) => ({ type: "tool-call" as const, toolCallId: `call_${i}`, toolName: c.name, input: JSON.stringify(c.arguments) }));

function setup(options: { routing?: Routing; judgeP?: number; generated?: boolean }) {
  const e = new Ensemble({ platform: "native" });
  if (options.routing) {
    const r = options.routing;
    e.register(d("router-a", ["tool-calling"], ["router"]), async () => ({
      router: new MockLanguageModelV4({
        doGenerate: async (_o: LanguageModelV4CallOptions) => ({
          content: toolCalls(r.calls),
          finishReason: { unified: "tool-calls", raw: undefined },
          usage: usage(),
          providerMetadata: { [HARNESS]: { confidence: r.confidence } },
          warnings: [],
        }),
      }),
    }));
  }
  if (options.judgeP !== undefined)
    e.register(d("judge-a", ["judgment"], ["judge"], "hosted"), async () => ({
      judge: new Experimental_EvaluationMockModelV4({ doEvaluate: async () => ({ answers: { correct: { type: "boolean", probability: options.judgeP! } as never }, warnings: [] }) }),
    }));
  if (options.generated)
    e.register(d("generator-a", ["tool-calling", "chat"], ["generator"]), async () => ({
      generator: new MockLanguageModelV4({
        doGenerate: async () => ({ content: toolCalls([{ name: "set_timer", arguments: { minutes: 5 } }]), finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(), warnings: [] }),
      }),
    }));
  return e;
}

const weather: Routing = { calls: [{ name: "get_weather", arguments: { city: "Lagos" } }], confidence: 0.97 };
const request = { input: "weather in Lagos?", tools };

describe("decideToolCallsRecorded", () => {
  it("TFK1.1 a confident router's decision is recorded once as a model decision, and returned as the cascade made it", async () => {
    const { decider, log } = rig();
    const decision = await decideToolCallsRecorded(decider, setup({ routing: weather }), request);
    expect(decision).toEqual(await decideToolCalls(setup({ routing: weather }), request));
    expect(await log.size()).toBe(1);
    const record = (await log.get("dec-0"))!;
    expect(record).toMatchObject({
      fork: "tool.calls",
      forkVersion: TOOL_FORK.version,
      rung: "model",
      confidence: 0.97,
      member: "router-a",
      action: { calls: [{ name: "get_weather", arguments: { city: "Lagos" } }] },
      propensity: 1,
      explored: false,
      input: { request: "weather in Lagos?", tools: ["get_weather", "set_timer"] },
    });
    expect(record.trace).toEqual([{ rung: "model", member: "router-a", outcome: "confidence 0.97" }]);
    expect(record).not.toHaveProperty("session");
    expect(record).not.toHaveProperty("correlation");
    expect(DecisionRecordSchema.safeParse(record).success).toBe(true);
  });

  it("TFK1.2 a routing the judge confirmed is a judge decision with the judge's probability, made by the router's model", async () => {
    const { decider, log } = rig();
    const decision = await decideToolCallsRecorded(decider, setup({ routing: { ...weather, confidence: 0.7 }, judgeP: 0.92 }), request);
    expect(decision.decidedBy).toBe("router+judge");
    const record = (await log.get("dec-0"))!;
    expect(record).toMatchObject({ rung: "judge", confidence: 0.92, member: "router-a" });
    expect(record.trace).toEqual([
      { rung: "model", member: "router-a", outcome: "confidence 0.7" },
      { rung: "judge", member: "judge-a", outcome: "p=0.92" },
    ]);
  });

  it("TFK1.3 a generator's decision is a generator decision made by the generator's model, with no confidence to record", async () => {
    const { decider, log } = rig();
    const decision = await decideToolCallsRecorded(decider, setup({ routing: { ...weather, confidence: 0.2 }, generated: true }), request);
    expect(decision.decidedBy).toBe("generator");
    const record = (await log.get("dec-0"))!;
    expect(record).toMatchObject({ rung: "generator", confidence: 0, member: "generator-a", action: { calls: [{ name: "set_timer", arguments: { minutes: 5 } }] } });
    expect(record.trace.map((s) => [s.rung, s.member])).toEqual([["model", "router-a"], ["generator", "generator-a"]]);
  });

  it("TFK1.4 a generator with no router is still a generator decision and its trace starts at the missing router", async () => {
    const { decider, log } = rig();
    await decideToolCallsRecorded(decider, setup({ generated: true }), request);
    const record = (await log.get("dec-0"))!;
    expect(record.trace[0]).toEqual({ rung: "model", outcome: "no router available" });
    expect(record.member).toBe("generator-a");
  });

  it("TFK1.5 a routing that could not be verified is a model decision whose trace says so, with the router's confidence", async () => {
    const { decider, log } = rig();
    const decision = await decideToolCallsRecorded(decider, setup({ routing: { ...weather, confidence: 0.2 } }), request);
    expect(decision.unverified).toBe(true);
    const record = (await log.get("dec-0"))!;
    expect(record).toMatchObject({ rung: "model", confidence: 0.2, member: "router-a" });
    expect(record.trace.at(-1)).toEqual({ rung: "model", outcome: "unverified: no stronger model was available", confidence: 0.2 });
    expect(record.trace.at(-2)).toEqual({ rung: "generator", outcome: "no generator available" });
  });

  it("TFK1.6 the session and correlation go into the record, and the decision is published", async () => {
    const { decider, log, published } = rig();
    await decideToolCallsRecorded(decider, setup({ routing: weather }), request, undefined, { session: "s1", correlation: "saga-1" });
    expect(await log.get("dec-0")).toMatchObject({ session: "s1", correlation: "saga-1" });
    expect(published).toEqual([{ type: "decision.made", payload: expect.objectContaining({ fork: "tool.calls", rung: "model", mode: "active" }), sessionId: "s1" }]);
  });

  it("TFK1.7 the cascade policy given is the one the cascade runs with", async () => {
    const { decider } = rig();
    const policy = cascadePolicy({ act: 0.5, verify: 0.5, accept: 0.5 });
    const decision = await decideToolCallsRecorded(decider, setup({ routing: { ...weather, confidence: 0.6 }, generated: true }), request, policy);
    expect(decision.decidedBy).toBe("router");
    const strict = await decideToolCallsRecorded(decider, setup({ routing: { ...weather, confidence: 0.6 }, generated: true }), request);
    expect(strict.decidedBy).toBe("generator");
  });

  it("TFK1.8 a cascade that finds no member throws as before and records nothing", async () => {
    const { decider, log } = rig();
    await expect(decideToolCallsRecorded(decider, setup({}), request)).rejects.toMatchObject({ code: "no_member" });
    expect(await log.size()).toBe(0);
  });

  it("TFK1.9 the fork's policy sets the mode of the record; the decision returned is the cascade's all the same", async () => {
    const { decider, log } = rig({ policy: policyJson({ forks: { "tool.calls": { mode: "shadow" } } }) });
    const decision = await decideToolCallsRecorded(decider, setup({ routing: weather }), request);
    expect(decision.decidedBy).toBe("router");
    expect((await log.get("dec-0"))?.mode).toBe("shadow");
  });

  it("TFK1.10 a decision with no calls is recorded as an empty list of calls", async () => {
    const { decider, log } = rig();
    await decideToolCallsRecorded(decider, setup({ routing: { calls: [], confidence: 0.96 } }), request);
    expect((await log.get("dec-0"))?.action).toEqual({ calls: [] });
  });

  it("TFK1.11 each call is one record", async () => {
    const { decider, log } = rig();
    await decideToolCallsRecorded(decider, setup({ routing: weather }), request);
    await decideToolCallsRecorded(decider, setup({ routing: weather }), request);
    expect((await log.query()).map((r) => r.id)).toEqual(["dec-0", "dec-1"]);
  });

  it("TFK1.13 a router that does not name its model leaves the record without a member", async () => {
    const anonymous = {
      platform: "native",
      serves: (_task: string, port?: string) => port === "router",
      languageModel: () =>
        new MockLanguageModelV4({
          doGenerate: async () => ({ content: toolCalls(weather.calls), finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(), providerMetadata: { [HARNESS]: { confidence: 0.97 } }, warnings: [] }),
        }),
    } as unknown as EnsembleType;
    const { decider, log } = rig();
    await decideToolCallsRecorded(decider, anonymous, request);
    const record = (await log.get("dec-0"))!;
    expect(record).not.toHaveProperty("member");
    expect(record.trace).toEqual([{ rung: "model", outcome: "confidence 0.97" }]);
  });

  it("TFK1.12 the tool fork is named tool.calls", () => {
    expect(TOOL_FORK.id).toBe("tool.calls");
  });
});
