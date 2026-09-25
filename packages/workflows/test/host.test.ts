import { describe, expect, it } from "vitest";
import { generateText, isStepCount, tool } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { bytes, Ensemble, invokeCognitive, usage } from "@harness/cognitive";
import type { ModelDescriptor } from "@harness/cognitive";
import { askModel, MemoryLibrary, parseWorkflow, WorkflowHost, workflowsExtension, workflowTools } from "@harness/workflows";
import { MemoryStorage, promptText, scriptedModel } from "@harness/testkit";

const greet = parseWorkflow({
  name: "greet",
  description: "Greets someone by name.",
  inputs: { type: "object", properties: { who: { type: "string" } }, required: ["who"] },
  code: `return "Hello, " + input.who + "!";`,
});
const welcome = parseWorkflow({
  name: "welcome",
  description: "Greets, then asks for a tip.",
  inputs: { type: "object" },
  code: `const hello = await tools.greet({ who: input.who });
const tip = await tools.ask({ prompt: "One tip for " + input.who });
const ticket = await tools.open_ticket({ title: hello });
return { hello, tip, ticket };`,
});

function host(options: { tools?: boolean } = {}) {
  const journals = new Map<string, MemoryStorage>();
  const library = new MemoryLibrary([greet, welcome]);
  const called: string[] = [];
  const h = new WorkflowHost({
    library,
    journal: (run) => journals.get(run) ?? (journals.set(run, new MemoryStorage()), journals.get(run)!),
    ask: async (prompt) => `tip: ${prompt}`,
    ...(options.tools === false ? {} : { tools: { open_ticket: tool({ description: "Opens a ticket.", inputSchema: z.object({ title: z.string() }), execute: async (args) => (called.push(`open_ticket:${JSON.stringify(args)}`), { id: 7 }) }) } }),
  });
  return { h, journals, library, called };
}

describe("workflow library and host", () => {
  it("WH1.1 a library workflow runs by name; other workflows are tools to it, run durably as nested runs", async () => {
    const { h, journals, called } = host();
    expect(await h.run("welcome", { who: "Ada" }, "r1")).toEqual({ status: "completed", output: { hello: "Hello, Ada!", tip: "tip: One tip for Ada", ticket: { id: 7 } }, replayed: 0, performed: 3 });
    expect([...journals.keys()].sort()).toEqual(["r1", "r1/1:greet"]);
    expect(called).toEqual(['open_ticket:{"title":"Hello, Ada!"}']);
  });

  it("WH1.2 an unknown workflow is an error; a tool nobody provides is not there for the code, so the run fails saying so", async () => {
    const { h } = host({ tools: false });
    await expect(h.run("nope", {}, "r1")).rejects.toThrow("no workflow nope");
    expect(await h.run("welcome", { who: "Ada" }, "r2")).toMatchObject({ status: "failed", error: expect.stringMatching(/Unknown tool: open_ticket/) });
  });

  it("WH1.3 definitions are parsed: names are kebab-case (and not ask), code must be present, inputs a JSON Schema object", () => {
    expect(() => parseWorkflow({ ...greet, name: "Not Kebab" })).toThrow(/name/);
    expect(() => parseWorkflow({ ...greet, name: "ask" })).toThrow("a workflow cannot be named ask: tools.ask is the model");
    expect(() => parseWorkflow({ ...greet, code: "" })).toThrow(/code/);
    expect(() => parseWorkflow({ ...greet, inputs: "x" })).toThrow(/inputs/);
  });

  it("WH1.4 the library lists, gets and replaces workflows", async () => {
    const { library } = host();
    await library.put({ ...greet, description: "Says hello." });
    expect((await library.list()).map((w) => [w.name, w.description])).toEqual([
      ["greet", "Says hello."],
      ["welcome", "Greets, then asks for a tip."],
    ]);
    expect(await library.get("missing")).toBeUndefined();
  });

  it("WH1.5 as a cognitive-core extension, workflows are listed and run through the invoke operation; the ensemble answers questions", async () => {
    const ensemble = new Ensemble({ platform: "native" });
    const generator = scriptedModel(() => "Stretch.");
    ensemble.register({ id: "g", name: "g", publisher: "t", tasks: ["chat"], ports: ["generator"], locality: "local", runtime: "transformers.js", run: { dtype: "q4" }, platforms: ["native"], license: "MIT", downloadBytes: bytes(1), benchmarks: [] } as ModelDescriptor, async () => ({ generator }));
    const journals = new Map<string, MemoryStorage>();
    const host = new WorkflowHost({ library: new MemoryLibrary([greet, welcome]), journal: (run) => journals.get(run) ?? (journals.set(run, new MemoryStorage()), journals.get(run)!), ask: askModel(ensemble.languageModel()), tools: { open_ticket: tool({ inputSchema: z.object({}).loose(), execute: async () => ({ id: 1 }) }) } });
    const extension = workflowsExtension({ host });
    ensemble.install(extension);
    expect(ensemble.extensions()).toEqual(["workflows"]);
    expect(await invokeCognitive(ensemble, "workflows.list", {})).toEqual({ workflows: [{ name: "greet", description: "Greets someone by name.", inputs: greet.inputs }, { name: "welcome", description: "Greets, then asks for a tip.", inputs: welcome.inputs }] });
    expect(await invokeCognitive(ensemble, "workflows.run", { name: "welcome", input: { who: "Ada" }, run: "w1" })).toMatchObject({ status: "completed", output: { tip: "Stretch." } });
    expect(await invokeCognitive(ensemble, "workflows.get", { name: "greet" })).toEqual(greet);
    await expect(invokeCognitive(ensemble, "workflows.run", { name: "welcome" })).rejects.toThrow(/invalid workflows.run input/);
    await expect(invokeCognitive(ensemble, "workflows.get", { name: "nope" })).rejects.toThrow("no workflow nope");
  });

  it("WH1.6 a nested workflow that fails fails its caller's step; a run without input gets {}", async () => {
    const broken = parseWorkflow({ name: "broken", description: "", inputs: {}, code: "throw new Error('inner');" });
    const caller = parseWorkflow({ name: "caller", description: "", inputs: {}, code: "return [input, await tools.broken({})];" });
    const h = new WorkflowHost({ library: new MemoryLibrary([broken, caller]), journal: () => new MemoryStorage(), ask: async () => "" });
    await expect(h.run("caller", {}, "r1")).rejects.toThrow(/workflow broken failed: .*inner/);
    expect(h.library).toBeInstanceOf(MemoryLibrary);
    const echo = parseWorkflow({ name: "echo", description: "", inputs: {}, code: "return input;" });
    const ext = workflowsExtension({ host: new WorkflowHost({ library: new MemoryLibrary([echo]), journal: () => new MemoryStorage(), ask: askModel(scriptedModel(() => "")) }) });
    expect(await ext.operations!["run"]!({ name: "echo", run: "r" })).toMatchObject({ output: {} });
    await expect(ext.operations!["get"]!(undefined)).rejects.toThrow(/invalid workflows.get input/);
  });

  it("WH1.7 a model answers a workflow's question with its text (reasoning left out), constraints go with it, and the library lists by name", async () => {
    const model = scriptedModel((o) => (o.responseFormat?.type === "json" ? '{"ok":true}' : "<think>hmm</think>Yes."));
    expect(await askModel(model)("Ready?")).toBe("Yes.");
    expect(promptText(model.doGenerateCalls[0]!.prompt)).toBe("Ready?");
    expect(model.doGenerateCalls[0]!.providerOptions).toBeUndefined();
    await askModel(model)("Ready?", { type: "regex", pattern: "Yes\\." });
    expect(model.doGenerateCalls[1]!.providerOptions).toEqual({ harness: { constraint: { type: "regex", pattern: "Yes\\." } } });
    // a JSON Schema is asked for as structured output, and the answer's text comes back
    expect(await askModel(model)("Ok?", { type: "json-schema", schema: { type: "object" } })).toBe('{"ok":true}');
    expect(model.doGenerateCalls[2]!.responseFormat).toEqual({ type: "json", schema: { type: "object" } });
    const library = new MemoryLibrary([welcome, greet]);
    expect((await library.list()).map((w) => w.name)).toEqual(["greet", "welcome"]);
    await library.put({ ...greet, name: "a-first" });
    expect((await library.list()).map((w) => w.name)).toEqual(["a-first", "greet", "welcome"]);
  });

  it("WH1.8 the library's workflows are AI SDK tools for agents: a call runs its workflow durably under the call's id, and a failed run is a failed call", async () => {
    const { h, journals } = host();
    const tools = await workflowTools(h);
    expect(Object.keys(tools)).toEqual(["greet", "welcome"]);
    expect(tools["greet"]!.description).toBe("Greets someone by name.");
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => ({
        stream: convertArrayToReadableStream<LanguageModelV4StreamPart>(
          prompt.some((m) => m.role === "tool")
            ? [{ type: "text-start", id: "0" }, { type: "text-delta", id: "0", delta: "done" }, { type: "text-end", id: "0" }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage() }]
            : [{ type: "tool-call", toolCallId: "call-1", toolName: "greet", input: '{"who":"Ada"}' }, { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage() }],
        ),
      }),
      doGenerate: async ({ prompt }) =>
        prompt.some((m) => m.role === "tool")
          ? { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: undefined }, usage: usage(), warnings: [] }
          : { content: [{ type: "tool-call", toolCallId: "call-1", toolName: "greet", input: '{"who":"Ada"}' }], finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(), warnings: [] },
    });
    const result = await generateText({ model, prompt: "greet Ada", tools, stopWhen: isStepCount(2), maxRetries: 0 });
    expect(result.steps[0]!.toolResults.map((r) => r.output)).toEqual(["Hello, Ada!"]);
    expect([...journals.keys()]).toEqual(["tool/call-1"]);
    const broken = parseWorkflow({ name: "broken", description: "Fails.", inputs: {}, code: "throw new Error('inner');" });
    const failing = await workflowTools(new WorkflowHost({ library: new MemoryLibrary([broken]), journal: () => new MemoryStorage(), ask: async () => "" }));
    await expect(failing["broken"]!.execute!({}, { toolCallId: "x", messages: [], context: undefined })).rejects.toThrow(/workflow broken failed: .*inner/);
  });
});
