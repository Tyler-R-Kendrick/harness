import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { HARNESS, probability, usage } from "@harness/cognitive";
import { Learning, planTask, Plugins, TARGETS } from "@harness/learning";
import type { Materializer, Teacher } from "@harness/learning";
import type { JudgeQuestion, ToolSpec } from "@harness/cognitive";
import { settings, setup } from "./helpers.ts";

const weather: ToolSpec = { name: "get_weather", description: "current weather for a city", parameters: {} };
/** The judge's probability per ladder question (matched by the settings' wording). */
const judging = (native: number, build: number) => (_: string, q: JudgeQuestion) =>
  q.type === "boolean" ? { type: "boolean" as const, probability: probability(q.instructions === settings.ladder.native.question ? native : build) } : undefined;
const builder = (tool?: ToolSpec): Materializer & { inputs: unknown[] } => {
  const inputs: unknown[] = [];
  return {
    kind: "materializer",
    id: "code-mode",
    target: TARGETS.tool,
    inputs,
    materialize: async (input) => (inputs.push(input), { target: "tool", name: "csv_to_chart", description: "draws a chart from a CSV", files: [{ path: "tool.ts", content: "export default () => 1" }], ...(tool ? { tool } : {}) }),
  };
};
const teacher: Teacher = { kind: "teacher", id: "screen-recorder", modalities: ["screen", "audio"], demonstrate: async () => ({ id: "d1", task: "x", steps: [], outcome: { status: "success" } }) };

function context(options: Parameters<typeof setup>[0] = {}, plugins: Plugins = new Plugins(), discover?: (task: string) => Promise<readonly ToolSpec[]>) {
  const s = setup(options);
  const learning = new Learning({ reasoner: s.reasoner, memory: s.memory, settings });
  return { ...s, learning, ctx: { learning, reasoner: s.reasoner, plugins, ...(discover ? { discover } : {}) } };
}

describe("the capability ladder", () => {
  it("LD1.1 what the model knows how to do natively needs no tools", async () => {
    const { ctx, judge, router } = context({ judge: judging(0.9, 0.9) });
    const plan = await planTask(ctx, { task: "summarize this paragraph", tools: [weather] });
    expect(plan).toMatchObject({ rung: "native", evidence: [{ rung: "native", decision: "yes", detail: "p=0.9 ≥ 0.7" }] });
    expect(judge.requests[0]!.questions).toEqual({ native: { type: "boolean", instructions: settings.ladder.native.question } });
    expect(router.doGenerateCalls).toEqual([]);
  });

  it("LD1.2 otherwise an available tool is used: offered, or found by discovery", async () => {
    const discovered: string[] = [];
    const { ctx } = context({ judge: judging(0.2, 0.9) }, new Plugins(), async (task) => (discovered.push(task), [weather]));
    const plan = await planTask(ctx, { task: "what is the weather in Lagos city" });
    expect(discovered).toEqual(["what is the weather in Lagos city"]);
    expect(plan.rung).toBe("tool");
    expect(plan.calls).toEqual([{ name: "get_weather", arguments: {} }]);
    expect(plan.evidence.map((e) => [e.rung, e.decision])).toEqual([
      ["native", "no"],
      ["tool", "yes"],
    ]);
  });

  it("LD1.3 without a fitting tool, a model that knows how builds one, with a tool-building plugin", async () => {
    const plugins = new Plugins();
    plugins.use(builder());
    const { ctx } = context({ judge: judging(0.2, 0.8) }, plugins);
    const plan = await planTask(ctx, { task: "convert csv rows into chart image", tools: [weather] });
    expect(plan).toMatchObject({ rung: "build-tool", builder: "code-mode" });
    expect(plan.evidence.map((e) => [e.rung, e.decision])).toEqual([
      ["native", "no"],
      ["tool", "no"],
      ["build-tool", "yes"],
    ]);
  });

  it("LD1.4 when it does not know how, or cannot build, it asks to be taught, saying what teachers can observe", async () => {
    const plugins = new Plugins();
    plugins.use(teacher);
    plugins.use(builder());
    const unsure = await planTask(context({ judge: judging(0.2, 0.3) }, plugins).ctx, { task: "file my expense report in the company portal" });
    expect(unsure).toMatchObject({ rung: "teach", teach: { teachers: [{ id: "screen-recorder", modalities: ["screen", "audio"] }] } });
    expect(unsure.evidence.at(-1)).toEqual({ rung: "build-tool", decision: "no", detail: "p=0.3 < 0.6" });
    const noBuilder = await planTask(context({ judge: judging(0.2, 0.9) }).ctx, { task: "file my expense report" });
    expect(noBuilder).toMatchObject({ rung: "teach", teach: { teachers: [] } });
    expect(noBuilder.evidence.at(-1)).toEqual({ rung: "build-tool", decision: "no", detail: "no tool-building plugin is installed" });
  });

  it("LD1.5 without a judge or router, the ladder still decides, and says what it could not assess", async () => {
    const plan = await planTask(context({ noJudge: true, noRouter: true }).ctx, { task: "anything", tools: [weather] });
    expect(plan.rung).toBe("teach");
    expect(plan.evidence.map((e) => [e.rung, e.decision])).toEqual([
      ["native", "unknown"],
      ["tool", "unknown"],
      ["build-tool", "no"],
    ]);
    expect(plan.evidence[0]!.detail).toMatch(/no judge member/);
  });

  it("LD1.6 every plan brings the related lessons, and learned tools count as available", async () => {
    const plugins = new Plugins();
    const chart: ToolSpec = { name: "csv_to_chart", description: "draws a chart from a csv file", parameters: {} };
    plugins.use(builder(chart));
    const { ctx, learning } = context({ judge: judging(0.1, 0.9) }, plugins);
    const built = await ctx.plugins.buildTool(ctx.learning, { task: "draw a chart from a csv file", tools: [weather] });
    expect(built.tool).toEqual(chart);
    expect(learning.lessons()).toMatchObject([{ kind: "tool", tool: chart, artifacts: [{ target: "tool", name: "csv_to_chart" }] }]);
    const plan = await planTask(ctx, { task: "draw a chart from a csv file" });
    expect(plan.rung).toBe("tool");
    expect(plan.calls).toEqual([{ name: "csv_to_chart", arguments: {} }]);
    expect(plan.lessons.map((l) => l.kind)).toEqual(["tool"]);
    expect(plan.playbook).toContain("csv_to_chart");
  });

  it("LD1.7 thresholds are inclusive, a judge that answers another type counts as no, and the evidence says why", async () => {
    const atThreshold = await planTask(context({ judge: judging(0.7, 0) }).ctx, { task: "summarize" });
    expect(atThreshold.evidence).toEqual([{ rung: "native", decision: "yes", detail: "p=0.7 ≥ 0.7" }]);
    const odd = await planTask(context({ judge: () => ({ type: "score", score: 1 }) }).ctx, { task: "summarize" });
    expect(odd.evidence[0]).toEqual({ rung: "native", decision: "no", detail: 'p=0 < 0.7 (Question "native" returned an answer with the wrong type.)' });
    expect(odd.evidence[1]).toEqual({ rung: "tool", decision: "no", detail: "no tools are available" });
    const unsure = await planTask(context({ judge: judging(0.1, 0) }).ctx, { task: "what is the weather in lagos city", tools: [weather] });
    expect(unsure.evidence[1]).toEqual({ rung: "tool", decision: "yes", detail: "confidence 0.99 ≥ 0.6" });
    const noFit = await planTask(context({ judge: judging(0.1, 0) }).ctx, { task: "zebra", tools: [weather] });
    expect(noFit.evidence[1]).toEqual({ rung: "tool", decision: "no", detail: "no tool fits: no tool shares a word with the request" });
  });

  it("LD1.8 a router pick below the confidence bar is not used; tools with one name are offered once", async () => {
    const s = setup({ judge: judging(0.1, 0) });
    const learning = new Learning({ reasoner: s.reasoner, memory: s.memory, settings });
    const seen: number[] = [];
    const router = new MockLanguageModelV4({
      doGenerate: async (o) => (
        seen.push(o.tools?.length ?? 0),
        { content: [{ type: "tool-call", toolCallId: "c", toolName: "get_weather", input: "{}" }], finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(), providerMetadata: { [HARNESS]: { confidence: 0.59 } }, warnings: [] }
      ),
    });
    const reasoner = { ...s.reasoner, router };
    const plan = await planTask({ learning, reasoner, plugins: new Plugins(), discover: async () => [weather] }, { task: "weather", tools: [weather] });
    expect(seen).toEqual([1]);
    expect(plan.evidence[1]).toEqual({ rung: "tool", decision: "no", detail: "confidence 0.59 < 0.6" });
  });
});

