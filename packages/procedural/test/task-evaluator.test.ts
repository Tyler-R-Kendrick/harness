import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { ManualClock, scriptedJudge, SeededEntropy } from "@harness/testkit";
import { parseSettings, taskSuiteEvaluator } from "@harness/procedural";
import type { Settings, TaskSuiteEvaluatorOptions } from "@harness/procedural";
import { settings } from "./dream-fixtures.ts";
import { graphs, guidanceModel, scripted, solverModel, suiteOf } from "./task-fixtures.ts";

const ports = { clock: new ManualClock(1_000), entropy: new SeededEntropy(9) };
const [plain, verifying] = graphs() as [ReturnType<typeof graphs>[0], ReturnType<typeof graphs>[0]];

const evaluator = (over: Partial<TaskSuiteEvaluatorOptions> = {}) => taskSuiteEvaluator({ suite: suiteOf(), settings, model: solverModel(), guidance: guidanceModel(), ...ports, ...over });

/** Host tools: one the suite names, one it does not. */
const hostTools = () => ({
  lookup: tool({ description: "The host's lookup.", inputSchema: z.object({ q: z.string() }), execute: async ({ q }) => `found ${q}` }),
  shell: tool({ description: "Runs anything.", inputSchema: z.object({ command: z.string() }), execute: async () => "ran" }),
});

/** A solver that looks the capital up first, then answers with what the tool found. */
const lookingUp = (calls: string[] = []) =>
  scripted((prompt) => {
    if (!prompt.includes('"role":"tool"')) return [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: JSON.stringify({ q: "Spain" }) }];
    return "Madrid";
  }, calls);

const withoutTaskJudge = (): Settings => {
  const { taskJudge: _judge, ...prompts } = settings.prompts;
  return parseSettings({ ...settings, prompts });
};

describe("taskSuiteEvaluator", () => {
  it("PD3.13 each task runs on a session agent guided by the candidate graph, with the suite's instructions; the metric scores its final answer", async () => {
    const guided: string[] = [];
    const solved: string[] = [];
    const ev = evaluator({ suite: suiteOf({ instructions: "Answer with the city alone." }), model: solverModel(solved), guidance: guidanceModel(guided) });
    expect(await ev.tasks("validation")).toEqual(["v0", "v1"]);
    expect(await ev.tasks("train")).toEqual(["t0", "t1", "t2"]);
    expect(await ev.evaluate(plain, "validation")).toEqual([
      { task: "v0", score: 0 },
      { task: "v1", score: 0 },
    ]);
    expect(await ev.evaluate(verifying, "validation")).toEqual([
      { task: "v0", score: 1 },
      { task: "v1", score: 1 },
    ]);
    // The guidance model saw the candidate's edges; the solver got its advice and the suite's instructions.
    expect(guided.at(-1)).toContain("Verify each answer.");
    expect(guided[0]).not.toContain("Verify each answer.");
    expect(solved.at(-1)).toContain("Procedural Graph Guidance: Verify the answer before you give it.");
    expect(solved.at(-1)).toContain("Answer with the city alone.");
    expect(solved.at(-1)).toContain("Capital of Italy?");
    // Without a guidance model, the solver's own guides it.
    const own: string[] = [];
    const single = taskSuiteEvaluator({ suite: suiteOf(), settings, model: solverModel(own), ...ports });
    await single.evaluate(verifying, "validation", ["v1"]);
    expect(own[0]).toContain("You are an expert cognitive architect and execution guide");
  });

  it("PD3.14 a training rollout returns each task's query and steps, tool calls included; the solver gets only the suite's tools, described as the suite says", async () => {
    const solved: string[] = [];
    const tools: string[][] = [];
    const model = lookingUp(solved);
    const spy = model.doGenerate.bind(model);
    model.doGenerate = async (options) => {
      tools.push((options.tools ?? []).map((t) => `${t.name}: ${t.type === "function" ? t.description : ""}`));
      return spy(options);
    };
    const ev = evaluator({ model, suite: suiteOf({ tools: [{ name: "lookup", description: "Look a capital up." }] }), tools: hostTools() });
    const [rollout] = await ev.evaluate(plain, "train", ["t0"]);
    expect(rollout).toEqual({
      task: "t0",
      score: 1,
      query: "Capital of Spain?",
      steps: [
        { role: "user", content: "Capital of Spain?" },
        { role: "assistant", content: "" },
        { role: "assistant", content: "", call: { name: "lookup", arguments: { q: "Spain" } } },
        { role: "tool", content: "found Spain" },
        { role: "assistant", content: "Madrid" },
      ],
    });
    expect(tools[0]).toEqual(["lookup: Look a capital up."]);
    // A tool the suite names without a description keeps the host's; a function gives the tools anew each evaluation.
    let built = 0;
    const described: string[][] = [];
    const again = lookingUp();
    const inner = again.doGenerate.bind(again);
    again.doGenerate = async (options) => (described.push((options.tools ?? []).map((t) => (t.type === "function" ? `${t.name}: ${t.description}` : ""))), inner(options));
    const fresh = evaluator({ model: again, suite: suiteOf({ tools: [{ name: "lookup" }] }), tools: () => (built++, hostTools()) });
    await fresh.evaluate(plain, "train", ["t0"]);
    await fresh.evaluate(plain, "validation", ["v0"]);
    expect(built).toBe(2);
    expect(described[0]).toEqual(["lookup: The host's lookup."]);
    // A suite with no tools offers none.
    const none: string[][] = [];
    const bare = lookingUp();
    const through = bare.doGenerate.bind(bare);
    bare.doGenerate = async (options) => (none.push((options.tools ?? []).map((t) => t.name)), through(options));
    await evaluator({ model: bare, tools: hostTools() }).evaluate(plain, "validation", ["v0"]).catch(() => undefined);
    expect(none[0]).toEqual([]);
  });

  it("PD3.15 the judge scorer asks the judge about the task, the expected answer and the answer; its probability is the score", async () => {
    const judge = scriptedJudge((_id, _q, state) => ({ type: "boolean", probability: (state as { answer: string }).answer === "Paris" ? 0.9 : 0.2 }));
    let resolved = 0;
    const suite = suiteOf({ scorer: "judge", tasks: [{ id: "v0", prompt: "Capital of France?", expected: "Paris", split: "validation" }, { id: "v1", prompt: "Capital of Italy?", split: "validation" }] });
    const ev = evaluator({ suite, judge: async () => (resolved++, judge) });
    expect(await ev.evaluate(verifying, "validation")).toEqual([
      { task: "v0", score: 0.9 },
      { task: "v1", score: 0.2 },
    ]);
    expect(resolved).toBe(1);
    expect(judge.requests.map((r) => r.state)).toEqual([
      { task: "Capital of France?", expected: "Paris", answer: "Paris" },
      { task: "Capital of Italy?", answer: "Rome" },
    ]);
    expect(judge.requests[0]!.questions).toEqual({ correct: { type: "boolean", instructions: settings.prompts.taskJudge } });
    // The suite's own question wins over the settings'.
    const asked = scriptedJudge(() => ({ type: "boolean", probability: 1 }));
    await evaluator({ suite: suiteOf({ scorer: "judge", judge: { instructions: "Is it a capital?" } }), judge: () => asked, settings: withoutTaskJudge() }).evaluate(plain, "validation", ["v0"]);
    expect(asked.requests[0]!.questions).toEqual({ correct: { type: "boolean", instructions: "Is it a capital?" } });
    // A metric never asks the judge.
    const idle = scriptedJudge();
    await evaluator({ judge: () => idle }).evaluate(plain, "validation");
    expect(idle.requests).toEqual([]);
  });

  it("PD3.16 what cannot be evaluated is refused, naming why", async () => {
    const judged = suiteOf({ scorer: "judge" });
    expect(() => evaluator({ suite: judged })).toThrow(/judge scorer needs a judge/);
    expect(() => evaluator({ suite: judged, judge: () => scriptedJudge(), settings: withoutTaskJudge() })).toThrow(/needs a question: the suite's judge\.instructions or the settings' taskJudge prompt/);
    await expect(evaluator({ suite: suiteOf({ tools: [{ name: "lookup" }, { name: "browser" }, { name: "mail" }] }), tools: hostTools() }).evaluate(plain, "validation")).rejects.toThrow("the task suite names tools this host does not offer: browser, mail");
    await expect(evaluator({ suite: suiteOf({ tools: [{ name: "toString" }] }) }).evaluate(plain, "validation")).rejects.toThrow("does not offer: toString");
    await expect(evaluator().evaluate(plain, "validation", ["t0"])).rejects.toThrow(new RangeError("no validation task t0"));
    const unsure = scriptedJudge(() => ({ type: "boolean", probability: 1.5 }));
    await expect(evaluator({ suite: judged, judge: () => unsure }).evaluate(plain, "validation")).rejects.toThrow(/must return P\(true/);
    const broken = scripted(() => {
      throw new Error("model down");
    });
    await expect(evaluator({ model: broken, guidance: guidanceModel() }).evaluate(plain, "validation", ["v1"])).rejects.toThrow("task v1 failed: model down");
    const refusing = scripted(() => {
      throw "refused";
    });
    await expect(evaluator({ model: refusing }).evaluate(plain, "validation", ["v1"])).rejects.toThrow("task v1 failed: refused");
    // A candidate the preset's cycle policy refuses cannot be held.
    const cyclic = { ...plain, edges: [...plain.edges, { ...plain.edges[0]!, from: plain.edges[0]!.to, to: plain.edges[0]!.from }] };
    const forbidding = parseSettings({ ...settings, presets: { ...settings.presets, harness: { ...settings.presets["harness"]!, dream: { ...settings.presets["harness"]!.dream, cycles: "forbidden" } } } });
    await expect(evaluator({ settings: forbidding }).evaluate(cyclic, "validation")).rejects.toThrow(/^the candidate graph cannot be evaluated: /);
  });

  it("PD3.17 each evaluation holds its candidate apart: the next one sees only its own graph, under the preset named", async () => {
    const guided: string[] = [];
    const ev = evaluator({ guidance: guidanceModel(guided), preset: "paper" });
    await ev.evaluate(verifying, "validation", ["v0"]);
    await ev.evaluate(plain, "validation", ["v0"]);
    expect(guided).toHaveLength(2);
    expect(guided[0]).toContain("Verify each answer.");
    expect(guided[1]).not.toContain("Verify each answer.");
    // The paper preset delivers guidance in the system slot, not as a trailing advisory message.
    const solved: string[] = [];
    await evaluator({ model: solverModel(solved), preset: "paper" }).evaluate(verifying, "validation", ["v0"]);
    expect(solved[0]).toMatch(/^\[\{"role":"system","content":"Procedural Graph Guidance: /);
  });
});
