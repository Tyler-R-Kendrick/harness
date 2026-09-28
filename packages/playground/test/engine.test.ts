import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateText, isStepCount } from "ai";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { Bash } from "just-bash";
import { usage } from "@harness/cognitive";
import { lexicalDecider, modelDecider } from "../src/decide.ts";
import type { Decider } from "../src/decide.ts";
import { TemplateEngine } from "../src/engine.ts";
import { GENERATIONS } from "../src/engine.ts";
import type { Generation } from "../src/engine.ts";
import { parseEngineSettings } from "../src/engine-settings.ts";
import { TEMPLATES, TemplateStore } from "../src/templates.ts";
import { HOME, vfsTools } from "../src/vfs.ts";

const settings = parseEngineSettings(JSON.parse(readFileSync(new URL("../data/templates.json", import.meta.url), "utf8")));
const seedDir = new URL("../data/templates/", import.meta.url);
const SEEDS = Object.fromEntries(readdirSync(seedDir).map((f) => [`${TEMPLATES}/${f}`, readFileSync(new URL(f, seedDir), "utf8")]));

/** A generator that answers each call with the next scripted JSON value, and records the prompts. */
function generator(...replies: unknown[]) {
  return named("writer", ...replies);
}

/** A generator (test/<modelId>) that answers each call with the next scripted JSON value. */
function named(modelId: string, ...replies: unknown[]) {
  const model = new MockLanguageModelV4({
    provider: "test",
    modelId,
    doGenerate: async (): Promise<LanguageModelV4GenerateResult> => ({
      content: [{ type: "text", text: JSON.stringify(replies.shift() ?? {}) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: usage(),
      warnings: [],
    }),
  });
  return model;
}

function setup(options: { files?: Record<string, string>; generation?: Generation; generators?: MockLanguageModelV4[]; answerers?: MockLanguageModelV4[]; deciders?: () => Decider[] } = {}) {
  const files = { [`${HOME}/README.md`]: "# hello\n", ...SEEDS, ...options.files };
  const bash = new Bash({ cwd: HOME, files });
  /** Scripts tried before a written template is kept, each on its own copy of the files. */
  const tried: string[] = [];
  const trial = async (script: string) => {
    tried.push(script);
    return new Bash({ cwd: HOME, files }).exec(script, { cwd: HOME });
  };
  const store = new TemplateStore(bash.fs, { retireMargin: settings.curation.retireMargin });
  let generation = options.generation ?? "auto";
  const engine = new TemplateEngine({
    store,
    settings,
    facts: { cwd: () => HOME, files: () => "README.md", date: () => "2026-09-28", templates: () => "list-files: Lists the files" },
    deciders: options.deciders ?? (() => [lexicalDecider(settings.lexical)]),
    // As the page gives them: once the local model is ready (a promise).
    generators: async () => options.generators ?? [],
    answerers: async () => options.answerers ?? [],
    generation: () => generation,
    trial,
  });
  const tools = { ...vfsTools(bash), ...engine.tools() };
  const ask = (prompt: string) => generateText({ model: engine.model(), prompt, tools, stopWhen: isStepCount(6) });
  return { bash, store, engine, ask, tried, setGeneration: (g: Generation) => (generation = g) };
}

const haiku = {
  id: "haiku",
  description: "Writes a haiku about a topic",
  examples: ["write a haiku about the sea"],
  kind: "reply",
  body: "A haiku about {{topic}}:\n{{poem}}\n",
  holes: { topic: { description: "the topic", source: "pattern", pattern: "haiku about (.+)$" }, poem: { description: "the haiku" } },
  values: { poem: "waves fold into foam" },
};

describe("the template engine: answers from templates before inference", () => {
  it("TE1.1 a request a template answers is answered from it, filled from facts, with no generator called; the decision is in the call's metadata", async () => {
    const writer = generator();
    const { ask, engine } = setup({ generators: [writer] });
    const result = await ask("list the files here");
    expect(result.text).toBe(`Files in ${HOME}:\nREADME.md\n`);
    expect(writer.doGenerateCalls).toHaveLength(0);
    expect(result.steps[0]!.providerMetadata).toMatchObject({ harness: { template: "list-files", by: "harness.lexical/tf-idf", probability: expect.any(Number) } });
    expect(engine.last).toEqual({ templateId: "list-files", request: "list the files here" });
  });

  it("TE1.11 a decision model that fails leaves the decision to the next one, and the turn's metadata says who decided and why the other did not", async () => {
    const down = modelDecider({ specificationVersion: "v4", provider: "test", modelId: "down", supportedQuestionTypes: ["choice"], doEvaluate: () => Promise.reject(new Error("still loading")) });
    const { ask, engine } = setup({ deciders: () => [down, lexicalDecider(settings.lexical)] });
    const listed = await ask("list the files here");
    expect(listed.steps[0]!.providerMetadata).toMatchObject({ harness: { template: "list-files", by: "harness.lexical/tf-idf", problems: ["test/down: still loading"] } });
    expect(engine.lastProblems).toEqual(["test/down: still loading"]);
    // A choice hole asks the deciders too, and its problems join the decision's.
    const shown = await ask("show me the readme");
    expect(shown.steps[0]!.providerMetadata).toMatchObject({ harness: { template: "show-file", problems: ["test/down: still loading"] } });
  });

  it("TE1.2 a script template runs through the bash tool (a choice hole picked by the decision model), and the reply is its outcome", async () => {
    const { ask } = setup();
    const shown = await ask("show me the readme");
    expect(shown.steps[0]!.toolCalls.map((c) => [c.toolName, c.input])).toEqual([["bash", { command: "cat 'README.md'" }]]);
    expect(shown.text).toBe("exit 0\n# hello\n");
    const ran = await ask("$ echo hi");
    expect(ran.steps[0]!.toolCalls[0]!.input).toEqual({ command: "echo hi" });
    expect(ran.text).toBe("exit 0\nhi\n");
  });

  it("TE1.3 with no template, a generator writes one (a file in the filesystem) and it answers; the next similar request needs no generator", async () => {
    const greet = { id: "greet", description: "Greets someone by name", examples: ["say hello to Ada"], kind: "reply", body: "Hello, {{name}}! Welcome to {{cwd}}.\n", holes: { name: { description: "who", source: "pattern", pattern: "hello to (\\w+)" } } };
    const writer = generator(greet);
    const { ask, bash } = setup({ generators: [writer] });
    const first = await ask("say hello to Ada");
    expect(first.steps[0]!.toolCalls[0]).toMatchObject({ toolName: "write_template", input: { request: "say hello to Ada" } });
    expect(first.text).toBe(`Hello, Ada! Welcome to ${HOME}.\n`);
    expect(await bash.readFile(`${TEMPLATES}/greet.md`)).toContain("origin: generated:test/writer");
    expect(JSON.stringify(writer.doGenerateCalls[0]!.prompt)).toContain("say hello to Ada");
    const second = await ask("say hello to Grace");
    expect(second.text).toBe(`Hello, Grace! Welcome to ${HOME}.\n`);
    expect(second.steps[0]!.toolCalls).toEqual([]);
    expect(writer.doGenerateCalls).toHaveLength(1);
  });

  it("TE1.3b a written template whose id is taken gets a free one; the generator hears the facts it can use", async () => {
    const writer = generator({ ...haiku, id: "list-files" });
    const { ask, bash } = setup({ generators: [writer] });
    expect((await ask("write a haiku about the sea")).text).toBe("A haiku about the sea:\nwaves fold into foam\n");
    expect(await bash.fs.exists(`${TEMPLATES}/list-files-2.md`)).toBe(true);
    expect(JSON.stringify(writer.doGenerateCalls[0]!.prompt)).toContain("- files: README.md");
  });

  it("TE1.4 a template with text holes has only those holes filled by a generator: the fixed text is not generated", async () => {
    const filler = generator({ poem: "pines hold the snow" });
    const { ask, store } = setup({ generators: [filler] });
    const { values: _v, ...draft } = haiku;
    await store.put({ ...draft, kind: "reply", helpful: 0, harmful: 0, version: 1, origin: "written", holes: haiku.holes as never });
    const result = await ask("write a haiku about winter");
    expect(result.steps[0]!.toolCalls[0]).toMatchObject({ toolName: "fill_template", input: { id: "haiku", holes: ["poem"] } });
    expect(result.text).toBe("A haiku about winter:\npines hold the snow\n");
    const schema = filler.doGenerateCalls[0]!.responseFormat;
    expect(schema).toMatchObject({ type: "json", schema: { properties: { poem: { type: "string" } }, required: ["poem"] } });
  });

  it("TE1.5 a template rated harmful with a note is rewritten the next time it is chosen, the old version kept", async () => {
    const writer = generator({ ...haiku, id: "list-files", description: "Lists the files in the working directory", examples: ["list the files"], body: "Here are the files in {{cwd}}:\n{{files}}\n", holes: {}, values: {} });
    const { ask, store, bash } = setup({ generators: [writer] });
    await store.feedback("list-files", "harmful", "say here are");
    const result = await ask("list the files");
    expect(result.steps[0]!.toolCalls[0]).toMatchObject({ toolName: "refine_template", input: { id: "list-files", note: "say here are" } });
    expect(result.text).toBe(`Here are the files in ${HOME}:\nREADME.md\n`);
    expect(await bash.readFile(`${TEMPLATES}/.history/list-files.v1.md`)).toContain("Files in {{cwd}}");
    expect((await store.get("list-files"))?.refine).toBeUndefined();
  });

  it("TE1.6 with generation off nothing is generated and the reply says how to allow it; with no generator the tool says so", async () => {
    const { ask, setGeneration } = setup({ generation: "off" });
    const off = await ask("write a haiku about the sea");
    expect(off.steps[0]!.toolCalls).toEqual([]);
    expect(off.text).toMatch(/no template answers this.*generation is off.*\/generate auto/is);
    setGeneration("auto");
    const none = await ask("write a haiku about the sea");
    expect(none.text).toMatch(/could not write a template: no generator is available/i);
  });

  it("TE1.7 a generator's answer that is not a template is refused, and the reply says why", async () => {
    const { ask } = setup({ generators: [generator({ ...haiku, body: "{{a}}{{b}}" })] });
    expect((await ask("write a haiku about the sea")).text).toMatch(/could not write a template: .*next to each other/i);
  });

  it("TE1.12 generators are asked in order: one that fails (it throws, or its answer is not a template) leaves the writing to the next, and the metadata says who wrote and why the ones before did not", async () => {
    const local = new MockLanguageModelV4({ provider: "local", modelId: "small", doGenerate: () => Promise.reject(new Error("out of memory")) });
    const garbled = named("garbled", { ...haiku, body: "{{a}}{{b}}" });
    const claude = named("claude", haiku);
    const { ask, engine, bash } = setup({ generators: [local, garbled, claude] });
    const written = await ask("write a haiku about the sea");
    expect(written.text).toBe("A haiku about the sea:\nwaves fold into foam\n");
    const problems = ["local/small: out of memory", expect.stringMatching(/^test\/garbled: .*next to each other/)];
    expect(written.steps.at(-1)!.providerMetadata).toMatchObject({ harness: { template: "haiku", by: "test/claude", after: "write_template", problems } });
    expect(engine.lastWriteProblems).toEqual(problems);
    expect(await bash.readFile(`${TEMPLATES}/haiku.md`)).toContain("origin: generated:test/claude");
    // The first that writes is the only one asked; a later write that needs no fallback clears the problems.
    const { ask: ask2, engine: engine2 } = setup({ generators: [named("local", haiku), claude] });
    expect((await ask2("write a haiku about the sea")).steps.at(-1)!.providerMetadata).toMatchObject({ harness: { by: "test/local" } });
    expect(engine2.lastWriteProblems).toEqual([]);
    // When every generator fails, the last one's error is the reply, the others' in the metadata.
    const { ask: ask3, engine: engine3 } = setup({ generators: [local, named("garbled", { ...haiku, body: "{{a}}{{b}}" })] });
    const failed = await ask3("write a haiku about the sea");
    expect(failed.text).toMatch(/^Could not write a template: .*next to each other/);
    expect(failed.steps.at(-1)!.providerMetadata).toMatchObject({ harness: { problems: ["local/small: out of memory"] } });
    expect(engine3.lastWriteProblems).toEqual(["local/small: out of memory", expect.stringMatching(/^test\/garbled: /)]);
  });

  it("TE1.13 a generator is shown the seed templates named in the settings as worked examples, capped in length, and held to a schema bounded by the settings", async () => {
    const writer = generator(haiku);
    const { ask } = setup({ generators: [writer] });
    await ask("write a haiku about the sea");
    const call = writer.doGenerateCalls[0]!;
    expect(call.maxOutputTokens).toBe(settings.generation.maxTokens);
    const system = JSON.stringify(call.prompt[0]);
    for (const id of settings.generation.examples) expect(system).toContain(`\\"id\\": \\"${id}\\"`);
    const schema = (call.responseFormat as unknown as { schema: { properties: Record<string, Record<string, unknown>> } }).schema.properties;
    const { limits } = settings.generation;
    expect(schema["id"]).toMatchObject({ maxLength: limits.id, pattern: expect.any(String) });
    expect(schema["examples"]).toMatchObject({ minItems: 1, maxItems: limits.examples, items: { maxLength: limits.text } });
    expect(schema["body"]).toMatchObject({ maxLength: limits.body });
    // An id that is not kebab-case is refused, as the schema says.
    const { ask: ask2 } = setup({ generators: [generator({ ...haiku, id: "1" })] });
    expect((await ask2("write a haiku about the sea")).text).toMatch(/could not write a template/i);
  });

  it("TE1.14 a written template is tried before it is kept: one that leaves a hole without a value, or a script that fails on a copy of the files, leaves the writing to the next generator", async () => {
    const script = (id: string, body: string, holes = {}) => ({ id, description: "How many lines a file has", examples: ["tally the lines in notes.txt"], kind: "script", body, holes, values: {} });
    const prose = named("prose", script("greet", "Hello, I am Sam.\n"));
    const unvalued = named("unvalued", script("count", "wc -l < '{{path}}'\n"));
    const good = named("good", script("count-lines", "wc -l < '{{path}}'\n", { path: { description: "the file", source: "pattern", pattern: "lines in (\\S+)" } }));
    const { ask, store, tried } = setup({ generators: [prose, unvalued, good], files: { [`${HOME}/notes.txt`]: "one\ntwo\n" } });
    const counted = await ask("tally the lines in notes.txt");
    // The step that ran the template's script carries who wrote it (the last step is its outcome).
    expect(counted.steps.at(-2)!.providerMetadata).toMatchObject({
      harness: { template: "count-lines", by: "test/good", problems: [expect.stringMatching(/^test\/prose: its script failed on a copy of the files \(exit 127: .*Hello/), "test/unvalued: it leaves path without a value"] },
    });
    expect(counted.text).toMatch(/^exit 0\n\s*2\n$/);
    // Only the script that ran cleanly was kept; the trial ran each script as it would answer this request.
    expect([await store.get("greet"), await store.get("count")]).toEqual([undefined, undefined]);
    expect(tried).toEqual(["Hello, I am Sam.", "wc -l < 'notes.txt'"]);
    // A reply is rendered, not run.
    const { ask: ask2, tried: tried2 } = setup({ generators: [generator(haiku)] });
    expect((await ask2("write a haiku about the sea")).text).toBe("A haiku about the sea:\nwaves fold into foam\n");
    expect(tried2).toEqual([]);
  });

  it("TE1.15 a written template that repeats one already kept (the same kind and body) is refused, and the writing goes to the next generator", async () => {
    const copy = named("copier", { id: "time-now", description: "The time now", examples: ["what time is it?"], kind: "reply", body: "Today is {{date}}.\n", holes: { date: { description: "today's date", source: "fact" } } });
    const clock = named("clock", { id: "time-now", description: "The time now", examples: ["what time is it?"], kind: "reply", body: "It is {{time}}.\n", holes: { time: { description: "the time" } }, values: { time: "noon" } });
    const { ask } = setup({ generators: [copy, clock] });
    const told = await ask("what time is it?");
    expect(told.text).toBe("It is noon.\n");
    expect(told.steps.at(-1)!.providerMetadata).toMatchObject({ harness: { by: "test/clock", problems: ["test/copier: it repeats today"] } });
  });

  it("TE1.16 when no template can be written, the local model answers the request itself, with no question asked; the metadata says so, and nothing is kept", async () => {
    const answerer = new MockLanguageModelV4({
      provider: "local",
      modelId: "tiny",
      doGenerate: async (): Promise<LanguageModelV4GenerateResult> => ({ content: [{ type: "text", text: "The capital of France is Paris." }], finishReason: { unified: "stop", raw: undefined }, usage: usage(), warnings: [] }),
    });
    // No writer (the local model enforces no JSON Schema): the answer comes straight away.
    const { ask, store, engine } = setup({ answerers: [answerer] });
    const before = (await store.list()).templates.length;
    const told = await ask("what is the capital of France?");
    expect(told.text).toBe("The capital of France is Paris.");
    expect(told.steps.at(-1)!.providerMetadata).toMatchObject({ harness: { answered: true, by: "local/tiny", after: "write_template" } });
    expect((await store.list()).templates).toHaveLength(before);
    const call = answerer.doGenerateCalls[0]!;
    expect(call.maxOutputTokens).toBe(settings.generation.answerTokens);
    expect(JSON.stringify(call.prompt)).toContain(settings.generation.answer);
    // A writer whose template is refused leaves the request to the answerer, and the refusal shows.
    const refused = named("writer", { ...haiku, body: "{{a}}{{b}}" });
    const { ask: ask2, engine: engine2 } = setup({ generators: [refused], answerers: [answerer] });
    const second = await ask2("what is the capital of France?");
    expect(second.text).toBe("The capital of France is Paris.");
    expect(second.steps.at(-1)!.providerMetadata).toMatchObject({ harness: { answered: true, problems: [expect.stringMatching(/^test\/writer: .*next to each other/)] } });
    expect(engine2.lastWriteProblems).toEqual([expect.stringMatching(/^test\/writer: /)]);
    expect(engine.lastWriteProblems).toEqual([]);
    // With no local model at all, the reply says so.
    const { ask: ask3 } = setup();
    expect((await ask3("what is the capital of France?")).text).toMatch(/could not write a template: no generator is available/i);
  });

  it("TE1.8 generation never asks: it runs on auto, and is refused when off; bash and writes follow the approval policy elsewhere", () => {
    const { engine, setGeneration } = setup({ generation: "auto" });
    expect(engine.approval("write_template")).toBe("not-applicable");
    expect(engine.approval("bash")).toBeUndefined();
    expect(engine.approval("fill_template")).toBe("not-applicable");
    expect([...GENERATIONS]).toEqual(["auto", "off"]);
    setGeneration("off");
    expect(engine.approval("refine_template")).toBe("denied");
  });

  it("TE1.9 a declined generation is reported, and a template that needs text while generation is off says which holes", async () => {
    const { engine, store, setGeneration } = setup({ generation: "auto" });
    const { values: _v, ...draft } = haiku;
    await store.put({ ...draft, kind: "reply", helpful: 0, harmful: 0, version: 1, origin: "written", holes: haiku.holes as never });
    const declined = await generateText({
      model: engine.model(),
      messages: [
        { role: "user", content: "write a haiku about the moon" },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "fill_template", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "fill_template", output: { type: "execution-denied" } }] },
      ],
    });
    expect(declined.text).toMatch(/not generated: declined/i);
    setGeneration("off");
    const off = await generateText({ model: engine.model(), prompt: "write a haiku about the moon" });
    expect(off.text).toMatch(/haiku needs text for poem.*generation is off/is);
  });

  it("TE1.10 after a tool, an odd result is said plainly: no result, a result that is not JSON, a template gone, a tool for a template that is not there, a generator that throws", async () => {
    const after = (engine: TemplateEngine, toolName: string, output: object) =>
      generateText({
        model: engine.model(),
        messages: [
          { role: "user", content: "say hello to Ada" },
          { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName, input: {} }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName, output: output as never }] },
        ],
      });
    const { engine } = setup();
    expect((await after(engine, "write_template", { type: "text", value: "?" })).text).toBe("Could not write a template: the tool gave no result");
    expect((await after(engine, "fill_template", { type: "json", value: { id: "gone", values: {}, by: "x" } })).text).toBe("Could not fill a template: gone is gone.");
    expect((await after(engine, "readFile", { type: "json", value: { content: "hi" } })).text).toBe('{"content":"hi"}');
    const empty = await generateText({ model: engine.model(), messages: [{ role: "user", content: "x" }, { role: "tool", content: [] }] });
    expect(empty.text).toBe("");

    const throwing = new MockLanguageModelV4({ doGenerate: () => Promise.reject(new Error("rate limited")) });
    const tools = setup({ generators: [throwing] }).engine.tools();
    const exec = (name: string, input: object) => (tools[name]!.execute as (i: object, o: object) => Promise<unknown>)(input, { toolCallId: "t", messages: [] });
    expect(await exec("write_template", { request: "x" })).toEqual({ error: "rate limited" });
    expect(await exec("fill_template", { id: "nope", request: "x", holes: ["a"] })).toEqual({ error: "no template nope" });
    expect(await exec("refine_template", { id: "nope", request: "x", note: "n" })).toEqual({ error: "no template nope" });
  });
});
