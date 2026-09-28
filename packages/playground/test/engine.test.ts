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
import type { Generation } from "../src/engine.ts";
import { parseEngineSettings } from "../src/engine-settings.ts";
import { TEMPLATES, TemplateStore } from "../src/templates.ts";
import { HOME, vfsTools } from "../src/vfs.ts";

const settings = parseEngineSettings(JSON.parse(readFileSync(new URL("../data/templates.json", import.meta.url), "utf8")));
const seedDir = new URL("../data/templates/", import.meta.url);
const SEEDS = Object.fromEntries(readdirSync(seedDir).map((f) => [`${TEMPLATES}/${f}`, readFileSync(new URL(f, seedDir), "utf8")]));

/** A generator that answers each call with the next scripted JSON value, and records the prompts. */
function generator(...replies: unknown[]) {
  const model = new MockLanguageModelV4({
    provider: "test",
    modelId: "writer",
    doGenerate: async (): Promise<LanguageModelV4GenerateResult> => ({
      content: [{ type: "text", text: JSON.stringify(replies.shift() ?? {}) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: usage(),
      warnings: [],
    }),
  });
  return model;
}

function setup(options: { files?: Record<string, string>; generation?: Generation; generators?: MockLanguageModelV4[]; deciders?: () => Decider[] } = {}) {
  const bash = new Bash({ cwd: HOME, files: { [`${HOME}/README.md`]: "# hello\n", ...SEEDS, ...options.files } });
  const store = new TemplateStore(bash.fs, { retireMargin: settings.curation.retireMargin });
  let generation = options.generation ?? "auto";
  const engine = new TemplateEngine({
    store,
    settings,
    facts: { cwd: () => HOME, files: () => "README.md", date: () => "2026-09-28", templates: () => "list-files: Lists the files" },
    deciders: options.deciders ?? (() => [lexicalDecider(settings.lexical)]),
    generators: () => options.generators ?? [],
    generation: () => generation,
  });
  const tools = { ...vfsTools(bash), ...engine.tools() };
  const ask = (prompt: string) => generateText({ model: engine.model(), prompt, tools, stopWhen: isStepCount(6) });
  return { bash, store, engine, ask, setGeneration: (g: Generation) => (generation = g) };
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
    expect(off.text).toMatch(/no template answers this.*generation is off.*\/generate ask/is);
    setGeneration("auto");
    const none = await ask("write a haiku about the sea");
    expect(none.text).toMatch(/could not write a template: no generator is available/i);
  });

  it("TE1.7 a generator's answer that is not a template is refused, and the reply says why", async () => {
    const { ask } = setup({ generators: [generator({ ...haiku, body: "{{a}}{{b}}" })] });
    expect((await ask("write a haiku about the sea")).text).toMatch(/could not write a template: .*next to each other/i);
  });

  it("TE1.8 generation asks for approval unless it is on auto; bash and writes follow the approval policy elsewhere", () => {
    const { engine, setGeneration } = setup({ generation: "ask" });
    expect(engine.approval("write_template")).toBe("user-approval");
    expect(engine.approval("bash")).toBeUndefined();
    setGeneration("auto");
    expect(engine.approval("fill_template")).toBe("not-applicable");
    setGeneration("off");
    expect(engine.approval("refine_template")).toBe("denied");
  });

  it("TE1.9 a declined generation is reported, and a template that needs text while generation is off says which holes", async () => {
    const { engine, store, setGeneration } = setup({ generation: "ask" });
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
