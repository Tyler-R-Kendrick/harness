import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { jsonSchema, tool } from "ai";
import { z } from "zod";
import type { ToolSet } from "ai";
import { Sha256Schema } from "@harness/cognitive";
import { coreView, modelTask, parseSettings, PlanPayloadSchema } from "@harness/procedural";
import type { PlanPayload } from "@harness/procedural";
import { chainDoc, graphOf } from "./compose-fixtures.ts";
import { scripted } from "./task-fixtures.ts";

const settings = parseSettings(JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")));
const graph = coreView(graphOf(chainDoc()));

const fetchPayload: PlanPayload = PlanPayloadSchema.parse({ node: { id: "Fetch_Page", type: "ACTION", description: "Fetch the best hit." }, binding: { kind: "tool", name: "fetch" } });

/** A fetch tool that records its calls and fails on a url it cannot reach. */
function fetchTools(calls: unknown[] = []): ToolSet {
  return {
    fetch: tool({
      description: "Fetch a page.",
      inputSchema: z.strictObject({ url: z.string() }),
      execute: async ({ url }) => {
        calls.push(url);
        if (url.includes("down")) throw new Error(`${url} is down`);
        return { page: `<html>${url}</html>` };
      },
    }),
    other: tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => "other" }),
  };
}

const callTool = (toolName: string, input: unknown) => [{ type: "tool-call" as const, toolCallId: "call-1", toolName, input: JSON.stringify(input) }];

describe("plan tasks on a model (modelTask)", () => {
  it("PC1.63 a bound task offers the model only its tool and forces it; the prompt is the settings' with the task, its transitions in the plan's graph and its inputs; the tool's result is the output", async () => {
    const options: LanguageModelV4CallOptions[] = [];
    const model = scripted((_, o) => {
      options.push(o);
      return callTool("fetch", { url: "https://example.com/a" });
    });
    const calls: unknown[] = [];
    const run = modelTask({ model, tools: fetchTools(calls), settings, graph });
    expect(await run({ id: "Fetch_Page", payload: fetchPayload, inputs: { search: "https://example.com/a" } })).toEqual({ ok: true, output: { page: "<html>https://example.com/a</html>" } });
    expect(calls).toEqual(["https://example.com/a"]);
    expect(options).toHaveLength(1);
    expect(options[0]!.tools!.map((t) => t.name)).toEqual(["fetch"]);
    expect(options[0]!.toolChoice).toEqual({ type: "tool", toolName: "fetch" });
    expect(options[0]!).toMatchObject({ temperature: settings.decoding.temperature, topK: settings.decoding.topK, maxOutputTokens: settings.decoding.solverMaxTokens });
    const prompt = JSON.stringify(options[0]!.prompt);
    const expected = settings.prompts.planTask
      .replace("{task}", "[Fetch_Page] (Type: ACTION)\nDescription: Fetch the best hit.")
      .replace("{guidance}", "- Transition: [search] → [Fetch_Page] (Condition: )\n  * Guidance: After search, go to Fetch_Page.\n  * Pitfalls to Avoid: Do not skip Fetch_Page.")
      .replace("{inputs}", JSON.stringify({ search: "https://example.com/a" }));
    expect(prompt).toContain(JSON.stringify(expected).slice(1, -1));
  });

  it("PC1.64 a workflow or skill binding is called by its name like a tool (revisionTools offers the workflows a head binds)", async () => {
    const model = scripted((_, o) => callTool(o.tools![0]!.name, {}));
    const code = Sha256Schema.parse("a".repeat(64));
    const tools: ToolSet = { "search-fetch": tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => ["hit"] }) };
    const run = modelTask({ model, tools, settings, graph });
    for (const binding of [{ kind: "workflow", name: "search-fetch", code }, { kind: "skill", name: "search-fetch", content: code }] as const) {
      const payload = PlanPayloadSchema.parse({ node: { id: "search-fetch", type: "ACTION", description: "Search and fetch." }, binding });
      expect(await run({ id: "search-fetch", payload, inputs: {} })).toEqual({ ok: true, output: ["hit"] });
    }
  });

  it("PC1.65 a tool that throws, arguments its schema refuses, a tool the host does not offer, a tool that returns nothing and an answer that calls no tool are failures (a throw fails the task in runPlan)", async () => {
    const down = modelTask({ model: scripted(() => callTool("fetch", { url: "https://down.example" })), tools: fetchTools(), settings, graph });
    expect(await down({ id: "Fetch_Page", payload: fetchPayload, inputs: {} })).toEqual({ ok: false, error: "https://down.example is down" });
    const invalid = modelTask({ model: scripted(() => callTool("fetch", { link: 1 })), tools: fetchTools(), settings, graph });
    expect(await invalid({ id: "Fetch_Page", payload: fetchPayload, inputs: {} })).toMatchObject({ ok: false, error: expect.stringContaining("fetch") });
    const asked: string[] = [];
    const missing = modelTask({ model: scripted(() => "no", asked), tools: { other: fetchTools()["other"]! }, settings, graph });
    expect(await missing({ id: "Fetch_Page", payload: fetchPayload, inputs: {} })).toEqual({ ok: false, error: "tool fetch is not available to plans" });
    expect(asked).toEqual([]);
    const silent = modelTask({ model: scripted(() => "I would rather not."), tools: fetchTools(), settings, graph });
    await expect(silent({ id: "Fetch_Page", payload: fetchPayload, inputs: {} })).rejects.toThrow("did not contain a call to the required tool 'fetch'");
    const inert = modelTask({ model: scripted(() => callTool("fetch", { url: "u" })), tools: { fetch: tool({ inputSchema: z.strictObject({ url: z.string() }) }) }, settings, graph });
    expect(await inert({ id: "Fetch_Page", payload: fetchPayload, inputs: {} })).toEqual({ ok: false, error: "tool fetch returned no result" });
  });

  it("PC1.66 an unbound task is done by the model in text, offered no tools; without the plan's graph, or for a node not in it, it has no guidance", async () => {
    const options: LanguageModelV4CallOptions[] = [];
    const model = scripted((_, o) => {
      options.push(o);
      return "A summary.";
    });
    const summarize = PlanPayloadSchema.parse({ node: { id: "summarize", type: "ACTION", description: "Summarize the page." }, binding: null });
    expect(await modelTask({ model, tools: fetchTools(), settings, graph })({ id: "summarize", payload: summarize, inputs: {} })).toEqual({ ok: true, output: "A summary." });
    expect(options[0]!.tools).toBeUndefined();
    expect(JSON.stringify(options[0]!.prompt)).toContain("Transition: [Fetch_Page] → [summarize]");
    for (const [g, id] of [[undefined, "summarize"], [graph, "Ghost"]] as const) {
      await modelTask({ model, tools: {}, settings, ...(g === undefined ? {} : { graph: g }) })({ id, payload: summarize, inputs: {} });
      expect(JSON.stringify(options.at(-1)!.prompt)).not.toContain("Transition:");
    }
  });
});
