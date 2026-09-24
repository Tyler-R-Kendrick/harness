import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Learning, Plugins, TARGETS } from "@harness/learning";
import type { Lesson } from "@harness/learning";
import { MemoryLibrary, WorkflowHost } from "@harness/workflows";
import type { ToolSpec } from "@harness/cognitive";
import { MemoryStorage } from "@harness/testkit";
import { compileProcedure, parsePluginSettings, pluginSettingsJsonSchema, skillBuilder, toolBuilder, workflowBuilder } from "@harness/learning-plugins";
import { reply, settings as learningSettings, setup } from "../../learning/test/helpers.ts";

const settingsFile = JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")) as Record<string, unknown>;
const settings = parsePluginSettings(settingsFile);
const migrate: ToolSpec = { name: "run_migrations", description: "run pending database migrations", parameters: {} };
const procedure = { op: "add", kind: "procedure", title: "staging deploy", text: "deploy the web app to staging safely", when: "deploying to staging", steps: ["run pending database migrations", "write the release notes"] };

async function learned(reflect = () => reply([procedure])) {
  const s = setup({ reflect });
  const learning = new Learning({ reasoner: s.ensemble, memory: s.memory, settings: learningSettings });
  await learning.observe({ id: "t1", task: "deploy to staging", steps: [], outcome: { status: "success" } });
  return { ...s, learning };
}
const host = (library: MemoryLibrary, tools: Record<string, unknown> = {}) =>
  new WorkflowHost({ library, journal: () => new MemoryStorage(), ask: async (p) => `answer(${p.split("\n")[0]})`, tools: { call: async (name) => tools[name] ?? { ok: true } } });

describe("plugin settings (data/settings.json)", () => {
  it("LP1.1 the shipped settings parse and name their generated JSON Schema", async () => {
    expect(settingsFile["$schema"]).toBe("./settings.schema.json");
    await expect(`${JSON.stringify(pluginSettingsJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/settings.schema.json");
    expect(() => parsePluginSettings({ ...settingsFile, workflow: { toolConfidence: 2 } })).toThrow(/workflow\.toolConfidence/);
  });
});

describe("workflow builder", () => {
  it("LP2.1 a learned procedure compiles to deterministic workflow code: a step a tool fits calls it, other steps ask the model", async () => {
    const { learning, ensemble } = await learned();
    const lesson = learning.lesson("l1");
    const workflow = await compileProcedure({ reasoner: ensemble, settings }, { purpose: "deploy to staging", lessons: [lesson], tools: [migrate] });
    expect(workflow.name).toBe("deploy-to-staging");
    expect(workflow.code).toContain('await ctx.tool("run_migrations", {})');
    expect(workflow.code).toContain("await ctx.ask(");
    // The same lessons and tools give the same code.
    expect((await compileProcedure({ reasoner: ensemble, settings }, { purpose: "deploy to staging", lessons: [lesson], tools: [migrate] })).code).toBe(workflow.code);
    const run = await host(new MemoryLibrary([workflow]), { run_migrations: { applied: 3 } }).run(workflow.name, { env: "staging" }, "r1");
    expect(run).toMatchObject({ status: "completed", output: { steps: [{ applied: 3 }, expect.stringMatching(/^answer\(Step 2 of "deploy to staging": write the release notes/)] } });
  });

  it("LP2.2 without a fitting tool, or without a router, every step asks the model; lessons that are not procedures become guidance", async () => {
    const { learning, ensemble } = await learned(() => reply([{ op: "add", kind: "pitfall", title: "fridays", text: "never deploy on fridays" }]));
    const workflow = await compileProcedure({ reasoner: { route: async () => Promise.reject(new Error("no router")) }, settings }, { purpose: "ship it", lessons: learning.lessons(), tools: [migrate] });
    expect(workflow.code).not.toContain("ctx.tool");
    expect(workflow.code).toContain("never deploy on fridays");
    expect(ensemble).toBeDefined();
  });

  it("LP2.3 as a plugin it keeps the workflow in the library, runnable by name, and returns its files", async () => {
    const { learning, ensemble } = await learned();
    const library = new MemoryLibrary();
    const plugins = new Plugins();
    plugins.use(workflowBuilder({ reasoner: ensemble, library, settings }));
    const made = await plugins.materialize(learning, { target: TARGETS.workflow, lessons: ["l1"], tools: [migrate] });
    expect(made).toMatchObject({ target: "workflow", name: "staging-deploy" });
    expect(made.files.map((f) => f.path)).toEqual(["staging-deploy/workflow.json", "staging-deploy/workflow.js"]);
    expect(JSON.parse(made.files[0]!.content)).toEqual(await library.get("staging-deploy"));
    expect(learning.lesson("l1").artifacts).toEqual([{ target: "workflow", name: "staging-deploy" }]);
  });
});

describe("skill builder", () => {
  it("LP3.1 a learned behavior becomes an agent skill whose instructions run its durable workflow", async () => {
    const { learning, ensemble } = await learned();
    const library = new MemoryLibrary();
    const plugins = new Plugins();
    plugins.use(skillBuilder({ reasoner: ensemble, library, settings }));
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
    const made = await skillBuilder({ reasoner: { route: async () => ({ calls: [], confidence: 0, reasoning: "" }) }, library: new MemoryLibrary(), settings }).materialize({ purpose: "p", lessons: [long], tools: [] });
    const front = (made as { files: { content: string }[] }).files[0]!.content.split("\n");
    expect(front[1]!.length).toBeLessThanOrEqual("name: ".length + 64);
    expect(front[2]!.length).toBeLessThanOrEqual("description: ".length + 1024);
  });
});

describe("tool builder (code mode)", () => {
  const draft = (code: string, name = "count-words") => JSON.stringify({ name, description: "Counts the words in a text.", parameters: { type: "object", properties: { text: { type: "string" } } }, code });

  it("LP4.1 a model writes the tool as workflow code; it is checked, kept in the library, and runs durably as a tool", async () => {
    const good = draft(`async function workflow(input, ctx) {
      if (typeof input.text !== "string") throw new Error("text is required");
      const saved = await ctx.tool("save_note", { words: input.text.split(/\\s+/).length });
      return { words: input.text.split(/\\s+/).length, saved };
    }`);
    const s = setup({ reflect: () => good });
    const library = new MemoryLibrary();
    const builder = toolBuilder({ reasoner: s.ensemble, library, settings });
    const made = (await builder.materialize({ purpose: "count the words in a text", lessons: [], tools: [{ name: "save_note", description: "saves a note", parameters: {} }] })) as { tool: ToolSpec; files: unknown[] };
    expect(made.tool).toEqual({ name: "count-words", description: "Counts the words in a text.", parameters: { type: "object", properties: { text: { type: "string" } } } });
    expect(s.generator.requests[0]!.messages[0]).toEqual({ role: "system", content: settings.toolBuilder.system });
    expect(JSON.parse(String(s.generator.requests[0]!.messages[1]!.content))).toMatchObject({ task: "count the words in a text", tools: [{ name: "save_note" }] });
    expect(await host(library, { save_note: "saved" }).run("count-words", { text: "one two three" }, "r1")).toMatchObject({ status: "completed", output: { words: 3, saved: "saved" } });
  });

  it("LP4.2 drafts that do not compile, use tools that do not exist, or are not JSON are sent back with the reason; after the attempts it gives up", async () => {
    const drafts = ["no json here", draft("async function workflow( {"), draft(`async function workflow(i, ctx) { return ctx.tool("delete_everything", {}); }`), draft("async function workflow() { return 1; }")];
    const s = setup({ reflect: () => drafts.shift()! });
    const builder = toolBuilder({ reasoner: s.ensemble, library: new MemoryLibrary(), settings: { ...settings, toolBuilder: { ...settings.toolBuilder, attempts: 4 } } });
    await builder.materialize({ purpose: "p", lessons: [], tools: [] });
    const feedback = s.generator.requests.slice(1).map((r) => String(r.messages.at(-1)!.content));
    expect(feedback[0]).toMatch(/held no JSON object/);
    expect(feedback[1]).toMatch(/SyntaxError/);
    expect(feedback[2]).toMatch(/calls tools that are not available: delete_everything/);
    const stubborn = setup({ reflect: () => "still no json" });
    await expect(toolBuilder({ reasoner: stubborn.ensemble, library: new MemoryLibrary(), settings }).materialize({ purpose: "p", lessons: [], tools: [] })).rejects.toThrow(/no usable tool after 3 attempts/);
  });

  it("LP4.3 on the ladder, a built tool is learned and found again for the task", async () => {
    const s = setup({ reflect: () => draft("async function workflow(input) { return input.text.length; }", "text-length") });
    const learning = new Learning({ reasoner: s.ensemble, memory: s.memory, settings: learningSettings });
    const plugins = new Plugins();
    plugins.use(toolBuilder({ reasoner: s.ensemble, library: new MemoryLibrary(), settings }));
    const made = await plugins.buildTool(learning, { task: "measure the length of a text" });
    expect(made.tool?.name).toBe("text-length");
    expect(learning.lessons()).toMatchObject([{ kind: "tool", tool: { name: "text-length" } }]);
  });

  it("LP4.4 answers that are broken JSON or not shaped like a tool are sent back too", async () => {
    const drafts = ['{"name": "x",', JSON.stringify({ name: "Bad Name", description: "d", parameters: {}, code: "async function workflow() {}" }), draft("async function workflow() { return 1; }")];
    const s = setup({ reflect: () => drafts.shift()! });
    await toolBuilder({ reasoner: s.ensemble, library: new MemoryLibrary(), settings }).materialize({ purpose: "p", lessons: [], tools: [] });
    const feedback = s.generator.requests.slice(1).map((r) => String(r.messages.at(-1)!.content));
    expect(feedback[0]).toMatch(/not valid JSON/);
    expect(feedback[1]).toMatch(/not a tool[\s\S]*name/);
  });
});

describe("names and descriptions", () => {
  it("LP2.4 names are kebab-case within 64 characters, never empty; a description says when to use it only if a lesson does", async () => {
    const { kebab } = await import("@harness/learning-plugins");
    expect(kebab("Deploy the Web-App!")).toBe("deploy-the-web-app");
    expect(kebab("???")).toBe("workflow");
    expect(kebab(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
    const workflow = await compileProcedure({ reasoner: { route: async () => ({ calls: [], confidence: 1, reasoning: "" }) }, settings }, { purpose: "tidy up", lessons: [], tools: [] });
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
  const router = (confidence: number) => ({ route: async (r: { input: string }) => (r.input.includes("migrations") ? { calls: [{ name: "run_migrations", arguments: { all: true } }], confidence, reasoning: "" } : { calls: [], confidence: 0.1, reasoning: "" }) });

  it("LP2.5 the workflow code for procedures, guidance and a fitting tool", async () => {
    const workflow = await compileProcedure({ reasoner: router(0.6), settings }, { purpose: "ship  it", lessons, tools: [migrate] });
    expect(workflow).toMatchObject({ name: "ship-it", description: "deploy the web app to staging never deploy on fridays smoke test the site. Use when deploying to staging.", inputs: { type: "object", additionalProperties: true } });
    expect(workflow.code).toMatchInlineSnapshot(`
      "// ship-it: ship it
      // Compiled by the workflow builder from lessons l1, l2, l3. Deterministic: every effect goes through ctx.
      async function workflow(input, ctx) {
        const steps = [];
        // 1. run pending database migrations
        steps.push(await ctx.tool("run_migrations", {"all":true}));
        // 2. write the release notes
        steps.push(await ctx.ask("Step 2 of \\"ship it\\": write the release notes\\nGuidance: fridays: never deploy on fridays\\nContext: " + JSON.stringify({ input, steps })));
        // 3. smoke test the site
        steps.push(await ctx.ask("Step 3 of \\"ship it\\": smoke test the site\\nGuidance: fridays: never deploy on fridays\\nContext: " + JSON.stringify({ input, steps })));
        return { steps };
      }
      "
    `);
    const below = await compileProcedure({ reasoner: router(0.59), settings }, { purpose: "ship it", lessons, tools: [migrate] });
    expect(below.code).not.toContain("ctx.tool");
  });

  it("LP3.3 the SKILL.md for the same lessons", async () => {
    const made = (await skillBuilder({ reasoner: router(0.9), library: new MemoryLibrary(), settings }).materialize({ purpose: "ship it", lessons, tools: [migrate] })) as { name: string; files: { path: string; content: string }[] };
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
    const bare = (await skillBuilder({ reasoner: router(0.9), library: new MemoryLibrary(), settings }).materialize({ purpose: "tidy the  desk", lessons: [], tools: [] })) as { name: string; files: { content: string }[] };
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
  const draft = (code: string) => JSON.stringify({ name: "t", description: "d", parameters: {}, code });
  const lesson: Lesson = { id: "l1", kind: "procedure", title: "how", text: "do it", steps: ["a", "b"], helpful: 0, harmful: 0, sources: [], artifacts: [], memoryId: "m1" };

  it("LP4.5 the request carries the task, the tools and the lessons; tool names are found however the call is spaced", async () => {
    const s = setup({ reflect: () => draft(`async function workflow(i, ctx) { return ctx . tool ( 'missing' , {}); }`) });
    const err = await toolBuilder({ reasoner: s.ensemble, library: new MemoryLibrary(), settings: { ...settings, toolBuilder: { ...settings.toolBuilder, attempts: 2 } } })
      .materialize({ purpose: "p", lessons: [lesson], tools: [migrate] })
      .catch((e: Error) => e.message);
    expect(JSON.parse(String(s.generator.requests[0]!.messages[1]!.content))).toEqual({ task: "p", tools: [migrate], lessons: [{ title: "how", text: "do it", steps: ["a", "b"] }] });
    expect(s.generator.requests).toHaveLength(2);
    expect(s.generator.requests[1]!.messages.slice(2)).toEqual([
      { role: "assistant", content: expect.stringContaining("missing") },
      { role: "user", content: "That draft failed its check: the code calls tools that are not available: missing\nAnswer with a corrected JSON object." },
    ]);
    expect(err).toBe("no usable tool after 2 attempts:\n- the code calls tools that are not available: missing\n- the code calls tools that are not available: missing");
  });
});

