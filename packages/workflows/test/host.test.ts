import { describe, expect, it } from "vitest";
import { bytes, Ensemble, invokeCognitive } from "@harness/cognitive";
import type { ModelDescriptor } from "@harness/cognitive";
import { askModel, MemoryLibrary, parseWorkflow, WorkflowHost, workflowsExtension } from "@harness/workflows";
import { MemoryStorage, promptText, scriptedModel } from "@harness/testkit";

const greet = parseWorkflow({
  name: "greet",
  description: "Greets someone by name.",
  inputs: { type: "object", properties: { who: { type: "string" } }, required: ["who"] },
  code: `async function workflow(input, ctx) { return "Hello, " + input.who + "!"; }`,
});
const welcome = parseWorkflow({
  name: "welcome",
  description: "Greets, then asks for a tip.",
  inputs: { type: "object" },
  code: `async function workflow(input, ctx) {
    const hello = await ctx.tool("greet", { who: input.who });
    const tip = await ctx.ask("One tip for " + input.who);
    const ticket = await ctx.tool("open_ticket", { title: hello });
    return { hello, tip, ticket };
  }`,
});

function host(options: { tools?: boolean } = {}) {
  const journals = new Map<string, MemoryStorage>();
  const library = new MemoryLibrary([greet, welcome]);
  const called: string[] = [];
  const h = new WorkflowHost({
    library,
    journal: (run) => journals.get(run) ?? (journals.set(run, new MemoryStorage()), journals.get(run)!),
    ask: async (prompt) => `tip: ${prompt}`,
    ...(options.tools === false ? {} : { tools: { call: async (name, args) => (called.push(`${name}:${JSON.stringify(args)}`), { id: 7 }) } }),
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

  it("WH1.2 an unknown workflow, or a tool nobody provides, is an error; a failing tool leaves the run resumable", async () => {
    const { h } = host({ tools: false });
    await expect(h.run("nope", {}, "r1")).rejects.toThrow("no workflow nope");
    await expect(h.run("welcome", { who: "Ada" }, "r2")).rejects.toThrow("no tool open_ticket is available to workflows");
  });

  it("WH1.3 definitions are parsed: names are kebab-case, code must be present, inputs a JSON Schema object", () => {
    expect(() => parseWorkflow({ ...greet, name: "Not Kebab" })).toThrow(/name/);
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
    const extension = workflowsExtension({ library: new MemoryLibrary([greet, welcome]), journal: (run) => journals.get(run) ?? (journals.set(run, new MemoryStorage()), journals.get(run)!), model: ensemble.languageModel(), tools: { call: async () => ({ id: 1 }) } });
    ensemble.install(extension);
    expect(ensemble.extensions()).toEqual(["workflows"]);
    expect(await invokeCognitive(ensemble, "workflows.list", {})).toEqual({ workflows: [{ name: "greet", description: "Greets someone by name.", inputs: greet.inputs }, { name: "welcome", description: "Greets, then asks for a tip.", inputs: welcome.inputs }] });
    expect(await invokeCognitive(ensemble, "workflows.run", { name: "welcome", input: { who: "Ada" }, run: "w1" })).toMatchObject({ status: "completed", output: { tip: "Stretch." } });
    expect(await invokeCognitive(ensemble, "workflows.get", { name: "greet" })).toEqual(greet);
    await expect(invokeCognitive(ensemble, "workflows.run", { name: "welcome" })).rejects.toThrow(/invalid workflows.run input/);
    await expect(invokeCognitive(ensemble, "workflows.get", { name: "nope" })).rejects.toThrow("no workflow nope");
  });

  it("WH1.6 a nested workflow that fails fails its caller's step; a run without input gets {}", async () => {
    const broken = parseWorkflow({ name: "broken", description: "", inputs: {}, code: "async function workflow() { throw new Error('inner'); }" });
    const caller = parseWorkflow({ name: "caller", description: "", inputs: {}, code: "async function workflow(input, ctx) { return [input, await ctx.tool('broken', {})]; }" });
    const h = new WorkflowHost({ library: new MemoryLibrary([broken, caller]), journal: () => new MemoryStorage(), ask: async () => "" });
    await expect(h.run("caller", {}, "r1")).rejects.toThrow("workflow broken failed: Error: inner");
    expect(h.library).toBeInstanceOf(MemoryLibrary);
    const echo = parseWorkflow({ name: "echo", description: "", inputs: {}, code: "async function workflow(input) { return input; }" });
    const ext = workflowsExtension({ library: new MemoryLibrary([echo]), journal: () => new MemoryStorage(), model: scriptedModel(() => "") });
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
});

