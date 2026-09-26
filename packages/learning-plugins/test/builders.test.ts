import { readFileSync } from "node:fs";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { HARNESS, usage } from "@harness/cognitive";
import { describe, expect, it } from "vitest";
import { Learning, Plugins, TARGETS } from "@harness/learning";
import type { Lesson, Materialized } from "@harness/learning";
import { MemoryLibrary, WorkflowHost } from "@harness/workflows";
import type { ToolSpec } from "@harness/cognitive";
import { MemoryStorage, promptText } from "@harness/testkit";
import { compileProcedure, harnessSkill, parsePluginSettings, pluginSettingsJsonSchema, skillBuilder, TOOL_TEMPLATE, toolBuilder, workflowBuilder } from "@harness/learning-plugins";
import { reply, settings as learningSettings, setup } from "../../learning/test/helpers.ts";

const settingsFile = JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")) as Record<string, unknown>;
const settings = parsePluginSettings(settingsFile);
/** A router model answering each step (the last user message) with `answer`'s calls and confidence. */
const routes = (answer: (input: string) => { calls: { name: string; arguments: Record<string, unknown> }[]; confidence: number }) =>
  new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const { calls, confidence } = answer(promptText(prompt));
      return {
        content: calls.map((c, i) => ({ type: "tool-call" as const, toolCallId: `c${i}`, toolName: c.name, input: JSON.stringify(c.arguments) })),
        finishReason: { unified: calls.length ? "tool-calls" : "stop", raw: undefined },
        usage: usage(),
        providerMetadata: { [HARNESS]: { confidence } },
        warnings: [],
      };
    },
  });
const migrate: ToolSpec = { name: "run_migrations", description: "run pending database migrations", parameters: {} };
const procedure = { op: "add", kind: "procedure", title: "staging deploy", text: "deploy the web app to staging safely", when: "deploying to staging", steps: ["run pending database migrations", "write the release notes"] };

async function learned(reflect = () => reply([procedure])) {
  const s = setup({ reflect });
  const learning = new Learning({ reasoner: s.reasoner, memory: s.memory, settings: learningSettings });
  await learning.observe({ id: "t1", task: "deploy to staging", steps: [], outcome: { status: "success" } });
  return { ...s, learning };
}
/** A host whose tools (the ones these tests offer) answer with `results`, or { ok: true }. */
const host = (library: MemoryLibrary, results: Record<string, unknown> = {}) =>
  new WorkflowHost({
    library,
    journal: () => new MemoryStorage(),
    ask: async (p) => `answer(${p.split("\n")[0]})`,
    tools: Object.fromEntries(["run_migrations", "save_note"].map((name) => [name, tool({ inputSchema: z.object({}).loose(), execute: async () => results[name] ?? { ok: true } })])),
  });

describe("plugin settings (data/settings.json)", () => {
  it("LP1.1 the shipped settings parse and name their generated JSON Schema", async () => {
    expect(settingsFile["$schema"]).toBe("./settings.schema.json");
    await expect(`${JSON.stringify(pluginSettingsJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/settings.schema.json");
    expect(() => parsePluginSettings({ ...settingsFile, workflow: { toolConfidence: 2 } })).toThrow(/workflow\.toolConfidence/);
  });
});

describe("workflow builder", () => {
  it("LP2.1 a learned procedure compiles to deterministic workflow code: a step a tool fits calls it, other steps ask the model", async () => {
    const { learning, reasoner } = await learned();
    const lesson = learning.lesson("l1");
    const workflow = await compileProcedure({ router: reasoner.router, settings }, { purpose: "deploy to staging", lessons: [lesson], tools: [migrate] });
    expect(workflow.name).toBe("deploy-to-staging");
    expect(workflow.code).toContain('await tools["run_migrations"]({})');
    expect(workflow.code).toContain("await tools.ask({ prompt: ");
    // The same lessons and tools give the same code.
    expect((await compileProcedure({ router: reasoner.router, settings }, { purpose: "deploy to staging", lessons: [lesson], tools: [migrate] })).code).toBe(workflow.code);
    const run = await host(new MemoryLibrary([workflow]), { run_migrations: { applied: 3 } }).run(workflow.name, { env: "staging" }, "r1");
    expect(run).toMatchObject({ status: "completed", output: { steps: [{ applied: 3 }, expect.stringMatching(/^answer\(Step 2 of "deploy to staging": write the release notes/)] } });
  });

  it("LP2.2 without a fitting tool, or without a router, every step asks the model; lessons that are not procedures become guidance", async () => {
    const { learning, reasoner } = await learned(() => reply([{ op: "add", kind: "pitfall", title: "fridays", text: "never deploy on fridays" }]));
    const workflow = await compileProcedure({ router: new MockLanguageModelV4({ doGenerate: async () => Promise.reject(new Error("no router")) }), settings }, { purpose: "ship it", lessons: learning.lessons(), tools: [migrate] });
    expect(workflow.code).not.toContain("tools[");
    expect(workflow.code).toContain("never deploy on fridays");
    expect(reasoner).toBeDefined();
  });

  it("LP2.3 as a plugin it keeps the workflow in the library, runnable by name, and returns its files", async () => {
    const { learning, reasoner } = await learned();
    const library = new MemoryLibrary();
    const plugins = new Plugins();
    plugins.use(workflowBuilder({ router: reasoner.router, library, settings }));
    const made = await plugins.materialize(learning, { target: TARGETS.workflow, lessons: ["l1"], tools: [migrate] });
    expect(made).toMatchObject({ target: "workflow", name: "staging-deploy" });
    expect(made.files.map((f) => f.path)).toEqual(["staging-deploy/workflow.json", "staging-deploy/workflow.js"]);
    expect(JSON.parse(made.files[0]!.content)).toEqual(await library.get("staging-deploy"));
    expect(learning.lesson("l1").artifacts).toEqual([{ target: "workflow", name: "staging-deploy" }]);
  });
});

describe("skill builder", () => {
  it("LP3.1 a learned behavior becomes an agent skill whose instructions run its durable workflow", async () => {
    const { learning, reasoner } = await learned();
    const library = new MemoryLibrary();
    const plugins = new Plugins();
    plugins.use(skillBuilder({ router: reasoner.router, library, settings }));
    const made = await plugins.materialize(learning, { target: TARGETS.agentSkill, lessons: ["l1"], tools: [migrate] });
    expect(made.files.map((f) => f.path)).toEqual(["staging-deploy/SKILL.md", "staging-deploy/workflow.json"]);
    const skill = made.files[0]!.content;
    expect(skill).toMatch(/^---\nname: staging-deploy\ndescription: deploy the web app to staging safely\. Use when deploying to staging\.\n---\n/);
    expect(skill).toContain("1. run pending database migrations");
    expect(skill).toContain("harness-workflow run workflow.json --run <run-id>");
    expect(skill).toContain("workflows.run");
    expect(await library.get("staging-deploy")).toBeDefined();
  });

  it("LP3.2 a skill's name and description keep to the agent-skills limits", async () => {
    const long: Lesson = { id: "l1", kind: "strategy", title: "A".repeat(80), text: "x ".repeat(700), helpful: 0, harmful: 0, sources: [], artifacts: [], memoryId: "m1" };
    const made = await skillBuilder({ router: routes(() => ({ calls: [], confidence: 0 })), library: new MemoryLibrary(), settings }).materialize({ purpose: "p", lessons: [long], tools: [] });
    const front = (made as { files: { content: string }[] }).files[0]!.content.split("\n");
    expect(front[1]!.length).toBeLessThanOrEqual("name: ".length + 64);
    expect(front[2]!.length).toBeLessThanOrEqual("description: ".length + 1024);
  });
});

describe("tool builder (code mode)", () => {
  /** An answer in the tool template: the model writes the name, description, parameters and the code. */
  const draft = (body: string, name = "count-words") =>
    `name: ${name}\ndescription: Counts the words in a text.\nparameters: {"type": "object", "properties": {"text": {"type": "string"}}}\n\`\`\`js\n${body}\n\`\`\`\n`;

  it("LP4.1 a model writes the tool as workflow code; it is checked, kept in the library, and runs durably as a tool", async () => {
    const good = draft(`  if (typeof input.text !== "string") throw new Error("text is required");
  const saved = await tools.save_note({ words: input.text.split(/\\s+/).length });
  return { words: input.text.split(/\\s+/).length, saved };`);
    const s = setup({ reflect: () => good });
    const library = new MemoryLibrary();
    const builder = toolBuilder({ coder: s.ensemble.languageModel("coding"), library, settings });
    const made = (await builder.materialize({ purpose: "count the words in a text", lessons: [], tools: [{ name: "save_note", description: "saves a note", parameters: {} }] })) as { tool: ToolSpec; files: unknown[] };
    expect(made.tool).toEqual({ name: "count-words", description: "Counts the words in a text.", parameters: { type: "object", properties: { text: { type: "string" } } } });
    expect(s.generator.doGenerateCalls[0]!.prompt[0]).toEqual({ role: "system", content: settings.toolBuilder.system });
    expect(s.generator.doGenerateCalls[0]!.providerOptions?.[HARNESS]?.["constraint"]).toEqual(TOOL_TEMPLATE);
    expect(JSON.parse(promptText(s.generator.doGenerateCalls[0]!.prompt))).toMatchObject({ task: "count the words in a text", tools: [{ name: "save_note" }] });
    expect(await host(library, { save_note: "saved" }).run("count-words", { text: "one two three" }, "r1")).toMatchObject({ status: "completed", output: { words: 3, saved: "saved" } });
  });

  it("LP4.2 drafts that do not compile, use tools that do not exist, or do not follow the template are sent back with the reason; after the attempts it gives up", async () => {
    const drafts = ["no template here", draft("  return ("), draft(`  return tools["delete_everything"]({});`), draft("  return 1;")];
    const s = setup({ reflect: () => drafts.shift()! });
    const builder = toolBuilder({ coder: s.ensemble.languageModel("coding"), library: new MemoryLibrary(), settings: { ...settings, toolBuilder: { ...settings.toolBuilder, attempts: 4 } } });
    await builder.materialize({ purpose: "p", lessons: [], tools: [] });
    const feedback = s.generator.doGenerateCalls.slice(1).map((r) => promptText(r.prompt));
    expect(feedback[0]).toMatch(/does not follow the template: the output does not start with "name: "/);
    expect(feedback[1]).toMatch(/SyntaxError/);
    expect(feedback[2]).toMatch(/calls tools that are not available: delete_everything/);
    const stubborn = setup({ reflect: () => "still no template" });
    await expect(toolBuilder({ coder: stubborn.ensemble.languageModel("coding"), library: new MemoryLibrary(), settings }).materialize({ purpose: "p", lessons: [], tools: [] })).rejects.toThrow(/no usable tool after 3 attempts/);
  });

  it("LP4.3 on the ladder, a built tool is learned and found again for the task", async () => {
    const s = setup({ reflect: () => draft("  return input.text.length;", "text-length") });
    const learning = new Learning({ reasoner: s.reasoner, memory: s.memory, settings: learningSettings });
    const plugins = new Plugins();
    plugins.use(toolBuilder({ coder: s.ensemble.languageModel("coding"), library: new MemoryLibrary(), settings }));
    const made = await plugins.buildTool(learning, { task: "measure the length of a text" });
    expect(made.tool?.name).toBe("text-length");
    expect(learning.lessons()).toMatchObject([{ kind: "tool", tool: { name: "text-length" } }]);
  });

  it("LP4.4 answers whose parameters are not JSON, or whose holes break their constraints, are sent back too", async () => {
    const drafts = [draft("  return 1;").replace('{"type": "object", "properties": {"text": {"type": "string"}}}', "{oops"), draft("  return 1;", "Bad Name"), draft("  return 1;")];
    const s = setup({ reflect: () => drafts.shift()! });
    await toolBuilder({ coder: s.ensemble.languageModel("coding"), library: new MemoryLibrary(), settings }).materialize({ purpose: "p", lessons: [], tools: [] });
    const feedback = s.generator.doGenerateCalls.slice(1).map((r) => promptText(r.prompt));
    expect(feedback[0]).toMatch(/the parameters are not JSON/);
    expect(feedback[1]).toMatch(/hole name does not match/);
  });
});

describe("names and descriptions", () => {
  it("LP2.4 names are kebab-case within 64 characters, never empty; a description says when to use it only if a lesson does", async () => {
    const { kebab } = await import("@harness/learning-plugins");
    expect(kebab("Deploy the Web-App!")).toBe("deploy-the-web-app");
    expect(kebab("???")).toBe("workflow");
    expect(kebab(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
    const workflow = await compileProcedure({ router: routes(() => ({ calls: [], confidence: 1 })), settings }, { purpose: "tidy up", lessons: [], tools: [] });
    expect([workflow.name, workflow.description]).toEqual(["tidy-up", "tidy up"]);
    expect(workflow.code).toContain('Step 1 of \\"tidy up\\": tidy up');
  });
});

describe("generated artifacts, exactly", () => {
  const lessons: Lesson[] = [
    { id: "l1", kind: "procedure", title: "staging  deploy", text: "deploy the web app\nto staging", when: "deploying  to staging", steps: ["run pending database migrations", "write the  release notes"], helpful: 0, harmful: 0, sources: [], artifacts: [], memoryId: "m1" },
    { id: "l2", kind: "pitfall", title: "fridays", text: "never deploy on fridays", helpful: 0, harmful: 0, sources: [], artifacts: [], memoryId: "m2" },
    { id: "l3", kind: "procedure", title: "smoke", text: "smoke test the site", helpful: 0, harmful: 0, sources: [], artifacts: [], memoryId: "m3" },
  ];
  const router = (confidence: number) => routes((input) => (input.includes("migrations") ? { calls: [{ name: "run_migrations", arguments: { all: true } }], confidence } : { calls: [], confidence: 0.1 }));

  it("LP2.5 the workflow code for procedures, guidance and a fitting tool", async () => {
    const workflow = await compileProcedure({ router: router(0.6), settings }, { purpose: "ship  it", lessons, tools: [migrate] });
    expect(workflow).toMatchObject({ name: "ship-it", description: "deploy the web app to staging never deploy on fridays smoke test the site. Use when deploying to staging.", inputs: { type: "object", additionalProperties: true } });
    expect(workflow.code).toMatchInlineSnapshot(`
      "// ship-it: ship it
      // Compiled by the workflow builder from lessons l1, l2, l3. Every effect goes through tools, so it runs durably.
      const steps = [];
      // 1. run pending database migrations
      steps.push(await tools["run_migrations"]({"all":true}));
      // 2. write the release notes
      steps.push(await tools.ask({ prompt: "Step 2 of \\"ship it\\": write the release notes\\nGuidance: fridays: never deploy on fridays\\nContext: " + JSON.stringify({ input, steps }) }));
      // 3. smoke test the site
      steps.push(await tools.ask({ prompt: "Step 3 of \\"ship it\\": smoke test the site\\nGuidance: fridays: never deploy on fridays\\nContext: " + JSON.stringify({ input, steps }) }));
      return { steps };
      "
    `);
    const below = await compileProcedure({ router: router(0.59), settings }, { purpose: "ship it", lessons, tools: [migrate] });
    expect(below.code).not.toContain("tools[");
  });

  it("LP3.4 a made skill is an AI SDK harness skill: SKILL.md is its content, and its other files are bundled relative to it", async () => {
    const made = (await skillBuilder({ router: router(0.9), library: new MemoryLibrary(), settings }).materialize({ purpose: "ship it", lessons, tools: [migrate] })) as Materialized;
    const skill = harnessSkill(made);
    expect(skill.name).toBe("staging-deploy");
    expect(skill.description).toBe(made.description);
    expect(skill.content).toMatch(/^---\nname: staging-deploy\n/);
    expect(skill.files.map((f) => f.path)).toEqual(["workflow.json"]);
    expect(JSON.parse(skill.files[0]!.content)).toMatchObject({ name: "staging-deploy" });
    expect(harnessSkill({ ...made, files: [...made.files, { path: "elsewhere/notes.md", content: "x" }] }).files.map((f) => f.path)).toEqual(["workflow.json", "elsewhere/notes.md"]);
    const workflow = (await workflowBuilder({ router: router(0.9), library: new MemoryLibrary(), settings }).materialize({ purpose: "ship it", lessons, tools: [migrate] })) as Materialized;
    expect(() => harnessSkill(workflow)).toThrow("ship-it is not an agent skill");
    expect(() => harnessSkill({ ...made, files: made.files.slice(1) })).toThrow("staging-deploy is not an agent skill");
  });

  it("LP3.3 the SKILL.md for the same lessons", async () => {
    const made = (await skillBuilder({ router: router(0.9), library: new MemoryLibrary(), settings }).materialize({ purpose: "ship it", lessons, tools: [migrate] })) as { name: string; files: { path: string; content: string }[] };
    expect(made.name).toBe("staging-deploy");
    expect(made.files[0]!.content).toMatchInlineSnapshot(`
      "---
      name: staging-deploy
      description: deploy the web app to staging never deploy on fridays smoke test the site. Use when deploying to staging.
      ---

      # staging deploy

      - deploy the web app to staging (when deploying to staging)
      - never deploy on fridays
      - smoke test the site

      ## Steps

      1. run pending database migrations
      2. write the release notes

      ## Run

      These steps are a durable workflow (\`workflow.json\`). Run it instead of doing the steps by hand;
      if it is interrupted, run the same command again: finished steps are not repeated.

      \`\`\`sh
      harness-workflow run workflow.json --run <run-id> --input '<json>'
      \`\`\`

      Through a harness daemon, invoke \`workflows.run\` with \`{ "name": "staging-deploy", "run": "<run-id>", "input": {} }\`.
      "
    `);
    const bare = (await skillBuilder({ router: router(0.9), library: new MemoryLibrary(), settings }).materialize({ purpose: "tidy the  desk", lessons: [], tools: [] })) as { name: string; files: { content: string }[] };
    expect(bare.name).toBe("tidy-the-desk");
    expect(bare.files[0]!.content).toContain("# tidy the desk\n");
    expect(bare.files[0]!.content).not.toContain("## Steps");
  });

  it("LP2.6 kebab names: runs of other characters become one hyphen, trimmed at both ends", async () => {
    const { kebab } = await import("@harness/learning-plugins");
    expect(kebab("  A  b__c  ")).toBe("a-b-c");
    expect(kebab(`${"a".repeat(63)}  b`)).toBe("a".repeat(63));
  });
});

describe("tool builder, in detail", () => {
  const draft = (body: string) => `name: t\ndescription: d\nparameters: {}\n\`\`\`js\n${body}\n\`\`\`\n`;
  const lesson: Lesson = { id: "l1", kind: "procedure", title: "how", text: "do it", steps: ["a", "b"], helpful: 0, harmful: 0, sources: [], artifacts: [], memoryId: "m1" };

  it("LP4.5 the request carries the task, the tools and the lessons; tool names are found however the call is spaced", async () => {
    const s = setup({ reflect: () => draft(`  const a = await tools . ask ({ prompt: "x" }); return tools [ 'missing' ] ({ a });`) });
    const err = await toolBuilder({ coder: s.ensemble.languageModel("coding"), library: new MemoryLibrary(), settings: { ...settings, toolBuilder: { ...settings.toolBuilder, attempts: 2 } } })
      .materialize({ purpose: "p", lessons: [lesson], tools: [migrate] })
      .catch((e: Error) => e.message);
    expect(JSON.parse(promptText(s.generator.doGenerateCalls[0]!.prompt))).toEqual({ task: "p", tools: [migrate], lessons: [{ title: "how", text: "do it", steps: ["a", "b"] }] });
    expect(s.generator.doGenerateCalls).toHaveLength(2);
    expect(s.generator.doGenerateCalls[1]!.prompt.slice(2)).toEqual([
      { role: "assistant", content: [{ type: "text", text: expect.stringContaining("missing") }] },
      { role: "user", content: [{ type: "text", text: "That draft failed its check: the code calls tools that are not available: missing\nAnswer again, in the same format, with it fixed." }] },
    ]);
    expect(err).toBe("no usable tool after 2 attempts:\n- the code calls tools that are not available: missing\n- the code calls tools that are not available: missing");
  });
});

describe("the tool template under real constrained decoding", () => {
  it("LP4.6 XGrammar forces the template's fixed text and accepts a well-formed answer to the end", async () => {
    const { ConstraintEngine } = await import("@harness/constrained");
    const { loadXGrammar } = await import("../../constrained/test/xgrammar.ts");
    const tokens = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), "\n", "<eos>"];
    const engine = await ConstraintEngine.create(() => loadXGrammar(), { tokens, stopTokens: [tokens.length - 1] });
    const m = await engine.matcher(TOOL_TEMPLATE);
    expect(m.forced()).toBe("name: ");
    const answer = 'name: count-words\ndescription: Counts words.\nparameters: {"type": "object"}\n```js\nreturn await tools.ask({ prompt: "one" });\n```\n';
    const rejected = [...answer].filter((ch) => !m.accept(tokens.indexOf(ch)));
    expect(rejected).toEqual([]);
    expect(m.accept(tokens.length - 1)).toBe(true);
    expect(m.done).toBe(true);
  });
});

