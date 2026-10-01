import { describe, expect, it } from "vitest";
import { Bash } from "just-bash";
import { Ensemble, fillTemplate, invokeCognitive } from "@harness/cognitive";
import { Dialogue, dialogueExtension } from "@harness/dialogue";
import { parseTemplate, templateText, TemplateStore } from "../../playground/src/templates.ts";
import { HOME } from "../../playground/src/vfs.ts";
import { MemoryStorage } from "@harness/testkit";
import { MemoryLibrary, parseWorkflow, quickjsCodeMode, WorkflowHost, workflowText } from "@harness/workflows";
import type { WorkflowLibrary } from "@harness/workflows";
import { aiCodeMode } from "@harness/workflows/node";
import { settings } from "./helpers.ts";

const codeMode = quickjsCodeMode();

/** The feedback operation a person already invokes, aimed at scripts, templates, and workflows. */
async function world() {
  const dialogue = new Dialogue({
    settings: settings(),
    book: {
      scripts: [
        { id: "greet", intent: "Greet", patterns: ["hi"], reply: ["Hello"] },
        { id: "other", intent: "Other", patterns: ["stay"], reply: ["Stay"] },
      ],
    },
  });
  const store = new TemplateStore(new Bash({ cwd: HOME }).fs);
  await store.put(parseTemplate("greet", "---\ndescription: Greets\n---\nHello"));
  await store.put(parseTemplate("other", "---\ndescription: Other\n---\nStay"));
  const library = new MemoryLibrary([
    parseWorkflow({ name: "greet", description: "Greets", inputs: { type: "object" }, code: `return "Hello";` }),
    parseWorkflow({ name: "other", description: "Other", inputs: { type: "object" }, code: `return "Stay";` }),
  ]);
  const journals = new Map<string, MemoryStorage>();
  const host = new WorkflowHost({
    codeMode,
    library,
    journal: (run) => journals.get(run) ?? journals.set(run, new MemoryStorage()).get(run)!,
    ask: async () => "",
  });
  const ensemble = new Ensemble({ platform: "native" });
  ensemble.install(dialogueExtension({ dialogue, artifacts: { template: templateText(store), workflow: workflowText(library) } }));
  const feedback = (input: Record<string, unknown>) => invokeCognitive(ensemble, "dialogue.feedback", input);
  return { dialogue, store, library, host, feedback };
}

function correction(artifact: "script" | "template" | "workflow", action: "rating" | "replacement" | "steering", text: string) {
  return { id: "greet", kind: "harmful", artifact, utterance: "hi", answer: "Hello", text, action };
}

async function scriptAnswer(dialogue: Dialogue, utterance: string): Promise<string> {
  const decision = await dialogue.respond({ utterance });
  if (decision.kind !== "reply") throw new Error(`expected a reply, got ${decision.kind}`);
  return decision.text;
}

async function templateAnswer(store: TemplateStore, id: string): Promise<string> {
  const template = await store.get(id);
  if (!template) throw new Error(`no template ${id}`);
  return fillTemplate(template.constraint, {});
}

async function workflowAnswer(host: WorkflowHost, name: string, run: string): Promise<string> {
  const result = await host.run(name, {}, run);
  if (result.status !== "completed") throw new Error(result.error);
  return String(result.output);
}

async function workflowCode(library: WorkflowLibrary, name: string): Promise<string> {
  const workflow = await library.get(name);
  if (!workflow) throw new Error(`no workflow ${name}`);
  return workflow.code;
}

describe("a correction changes the artifact that answered", () => {
  it("RF2.1 a replacement rewrites the chat script the next answer returns", async () => {
    const { dialogue, feedback } = await world();
    await feedback(correction("script", "replacement", "Goodbye"));
    expect(await scriptAnswer(dialogue, "hi")).toBe("Goodbye");
  });

  it("RF2.2 a replacement rewrites the answer template the next answer returns", async () => {
    const { store, feedback } = await world();
    await feedback(correction("template", "replacement", "Goodbye"));
    expect(await templateAnswer(store, "greet")).toBe("Goodbye");
  });

  it("RF2.3 a replacement rewrites the workflow the next run returns", async () => {
    const { host, feedback } = await world();
    await feedback(correction("workflow", "replacement", "Goodbye"));
    expect(await workflowAnswer(host, "greet", "after-replacement")).toBe("Goodbye");
  });

  it("RF2.4 a steering instruction augments the chat script and the next answer keeps the previous text", async () => {
    const { dialogue, feedback } = await world();
    await feedback(correction("script", "steering", "be brief"));
    const text = await scriptAnswer(dialogue, "hi");
    expect(text).toContain("Hello");
    expect(text).toContain("be brief");
  });

  it("RF2.5 a steering instruction augments the answer template and the next answer keeps the previous text", async () => {
    const { store, feedback } = await world();
    await feedback(correction("template", "steering", "be brief"));
    const text = await templateAnswer(store, "greet");
    expect(text).toContain("Hello");
    expect(text).toContain("be brief");
  });

  it("RF2.6 a steering instruction augments the workflow and the next run keeps the previous output", async () => {
    const { host, library, feedback } = await world();
    await feedback(correction("workflow", "steering", "be brief"));
    expect(await workflowCode(library, "greet")).toContain(`return "Hello";`);
    const text = await workflowAnswer(host, "greet", "after-steering");
    expect(text).toContain("Hello");
    expect(text).toContain("be brief");
  });

  it("RF2.7 a correction leaves a different script, template, and workflow unchanged", async () => {
    const { dialogue, store, library, feedback } = await world();
    await feedback(correction("script", "replacement", "Goodbye"));
    await feedback(correction("template", "replacement", "Goodbye"));
    await feedback(correction("workflow", "replacement", "Goodbye"));
    expect(await scriptAnswer(dialogue, "hi")).toBe("Goodbye");
    expect(await scriptAnswer(dialogue, "stay")).toBe("Stay");
    expect(await templateAnswer(store, "other")).toBe("Stay");
    expect(await workflowCode(library, "other")).toBe(`return "Stay";`);
  });

  it("RF2.8 a bare negative rating leaves the artifact text in place and stores the preference record", async () => {
    const { dialogue, store, library, feedback } = await world();
    await feedback(correction("script", "rating", ""));
    await feedback(correction("template", "rating", ""));
    await feedback(correction("workflow", "rating", ""));
    expect(await scriptAnswer(dialogue, "hi")).toBe("Hello");
    expect(await templateAnswer(store, "greet")).toBe("Hello");
    expect(await workflowCode(library, "greet")).toBe(`return "Hello";`);
    expect(dialogue.preferences()).toEqual([
      { utterance: "hi", answer: "Hello", text: "", signal: "negative", action: "rating", artifact: { kind: "script", id: "greet" } },
      { utterance: "hi", answer: "Hello", text: "", signal: "negative", action: "rating", artifact: { kind: "template", id: "greet" } },
      { utterance: "hi", answer: "Hello", text: "", signal: "negative", action: "rating", artifact: { kind: "workflow", id: "greet" } },
    ]);
  });

  it("RF2.9 a steering instruction keeps a generate hole and applies the instruction", async () => {
    const dialogue = new Dialogue({
      settings: settings(),
      book: { scripts: [{ id: "greet", intent: "Greet", patterns: ["hi"], reply: ["Hello ", { generate: "name" }] }] },
    });
    const ensemble = new Ensemble({ platform: "native" });
    ensemble.install(dialogueExtension({ dialogue }));
    await invokeCognitive(ensemble, "dialogue.feedback", {
      id: "greet",
      kind: "harmful",
      artifact: "script",
      utterance: "hi",
      answer: "Hello",
      text: "be brief",
      action: "steering",
    });
    expect(dialogue.script("greet")?.reply).toEqual(["Hello ", { generate: "name" }, "\nbe brief"]);
    const decision = await dialogue.respond({ utterance: "hi" });
    expect(decision.kind).toBe("generate");
    expect(JSON.stringify(decision.kind === "generate" ? decision.template : decision)).toContain("Hello ");
    expect(JSON.stringify(decision.kind === "generate" ? decision.template : decision)).toContain("name");
    expect(JSON.stringify(decision.kind === "generate" ? decision.template : decision)).toContain("be brief");
  });

  it("RF2.10 a steering instruction keeps a chat script's flow running and applies the instruction", async () => {
    const journals = new Map<string, MemoryStorage>();
    const host = new WorkflowHost({
      codeMode: aiCodeMode,
      library: new MemoryLibrary([
        parseWorkflow({
          name: "harness-menu",
          kind: "flow",
          description: "Menu",
          inputs: { type: "object" },
          code: `await tools.say({ text: "Menu" });`,
        }),
      ]),
      journal: (run) => journals.get(run) ?? journals.set(run, new MemoryStorage()).get(run)!,
      ask: async () => "",
    });
    const dialogue = new Dialogue({
      settings: settings(),
      book: { scripts: [{ id: "menu", intent: "Menu", patterns: ["hi"], reply: [{ flow: "harness-menu" }] }] },
      flows: host,
    });
    const ensemble = new Ensemble({ platform: "native" });
    ensemble.install(dialogueExtension({ dialogue }));
    await invokeCognitive(ensemble, "dialogue.feedback", {
      id: "menu",
      kind: "harmful",
      artifact: "script",
      utterance: "hi",
      answer: "Menu",
      text: "skip the intro",
      action: "steering",
    });
    expect(dialogue.script("menu")?.reply).toEqual([{ flow: "harness-menu" }]);
    const decision = await dialogue.respond({ sessionId: "s", utterance: "hi" });
    expect(decision).toMatchObject({ kind: "flow", flow: "harness-menu" });
    const text = "text" in decision ? decision.text : "";
    expect(text).toContain("Menu");
    expect(text).toContain("skip the intro");
  });

  it("RF2.11 a steering instruction keeps a workflow's object result and applies the instruction", async () => {
    const { library, host, feedback } = await world();
    await library.put(parseWorkflow({ name: "greet", description: "Greets", inputs: { type: "object" }, code: `return { say: "Hello", n: 2 };` }));
    await feedback(correction("workflow", "steering", "be brief"));
    const result = await host.run("greet", {}, "after-object");
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.output).toMatchObject({ say: "Hello", n: 2 });
    expect(JSON.stringify(result.output)).toContain("be brief");
    expect(await workflowCode(library, "greet")).toContain(`return { say: "Hello", n: 2 };`);
  });

  it("RF2.12 two corrections at once both land on the artifact", async () => {
    const { store, feedback } = await world();
    await Promise.all([feedback(correction("template", "steering", "be brief")), feedback(correction("template", "steering", "say goodbye"))]);
    const text = await templateAnswer(store, "greet");
    expect(text).toContain("be brief");
    expect(text).toContain("say goodbye");
  });

  it("RF2.13 a saved book's preferences are not changed by a later correction", async () => {
    const { dialogue, feedback } = await world();
    await feedback(correction("script", "replacement", "Goodbye"));
    const saved = dialogue.save() as { preferences?: { text: string }[] };
    expect(saved.preferences).toHaveLength(1);
    await feedback(correction("script", "replacement", "Farewell"));
    expect(saved.preferences).toHaveLength(1);
    expect(saved.preferences?.[0]?.text).toBe("Goodbye");
  });
});
