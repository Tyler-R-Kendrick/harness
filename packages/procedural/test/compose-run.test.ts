import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { usage } from "@harness/cognitive";
import { askModel, checkWorkflow, quickjsCodeMode, WorkflowHost } from "@harness/workflows";
import { MemoryStorage } from "@harness/testkit";
import { compilePath, composeCandidate, parseCompositionSettings, parseGraph, pathCandidates, recordedRuns, revisionTools, StagingLibrary } from "@harness/procedural";
import { chain, observed, PATH, RUNS, SPECS, turn } from "./compose-fixtures.ts";

const file = JSON.parse(readFileSync(new URL("../data/composition.json", import.meta.url), "utf8")) as unknown;

/** The text of a call's single user message. */
const promptOf = (options: LanguageModelV4CallOptions): string =>
  options.prompt.flatMap((m) => (m.role === "user" ? m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])) : [])).join("");

describe("composition end to end", () => {
  it("PC1.34 a path learned from live turns compiles, stages, binds in a candidate core, and runs on QuickJS with its data flow kept", async () => {
    const g = chain();
    // Three sessions walked search → Fetch_Page → summarize and scored well.
    const events = [observed("s1/t1", PATH, 0.9), observed("s2/t1", PATH, 0.8), observed("s3/t1", [...PATH, "End"], 1)];
    const [candidate] = pathCandidates(g, events, parseCompositionSettings(file));
    expect(candidate?.path).toEqual([...PATH]);

    const runs = recordedRuns(g, [turn(g, "s1", RUNS[0]!), turn(g, "s2", RUNS[1]!)], candidate!.path, "exact");
    const compiled = compilePath(candidate!.path, runs, SPECS);
    if (!compiled.ok) throw new Error(compiled.error);
    const w = compiled.workflow;
    expect(checkWorkflow(w.code)).toEqual({ ok: true });

    const staging = new StagingLibrary();
    const binding = await staging.stage(w);
    const composed = composeCandidate(g, candidate!.path, w);
    if (!composed.ok) throw new Error(composed.error);
    expect(composed.binding).toEqual(binding);
    const revision = parseGraph(composed.document);
    if (!revision.ok) throw new Error(JSON.stringify(revision.diagnostics));

    // The tools the workflow reaches, and a model that fills each later call from the results so far.
    const performed: { name: string; args: unknown }[] = [];
    const record = (name: string, result: unknown) =>
      tool({ inputSchema: jsonSchema({ type: "object" }), execute: async (args: unknown) => (performed.push({ name, args }), result) });
    const base = {
      search: record("search", { hits: ["https://a.example/hopper"] }),
      fetch: record("fetch", { text: "Grace Hopper wrote the first compiler." }),
      summarize: record("summarize", { summary: "Hopper: compilers." }),
    };
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const prompt = promptOf(options);
        const context = JSON.parse(prompt.slice(prompt.indexOf("so far:\n") + "so far:\n".length)) as { input: { query: string }; steps: Record<string, unknown>[] };
        const text = prompt.includes("tool fetch") ? { url: (context.steps[0]!["hits"] as string[])[0] } : { text: context.steps[1]!["text"] };
        return { content: [{ type: "text", text: JSON.stringify(text) }], finishReason: { unified: "stop", raw: undefined }, usage: usage(1, 1), warnings: [] };
      },
    });
    const journals = new Map<string, MemoryStorage>();
    const host = new WorkflowHost({
      library: staging,
      tools: base,
      codeMode: quickjsCodeMode(),
      ask: askModel(model),
      journal: (run) => journals.get(run) ?? (journals.set(run, new MemoryStorage()), journals.get(run)!),
    });

    const tools = await revisionTools({ base, pinnedCore: revision.graph, staging: host });
    expect(Object.keys(tools).sort()).toEqual(["fetch", "search", "summarize", w.name].sort());
    const output = await tools[w.name]!.execute!({ query: "grace hopper" }, { toolCallId: "call-1", messages: [], context: undefined });

    expect(performed).toEqual([
      { name: "search", args: { query: "grace hopper", limit: 5 } },
      { name: "fetch", args: { url: "https://a.example/hopper", format: "md" } },
      { name: "summarize", args: { text: "Grace Hopper wrote the first compiler.", words: 50 } },
    ]);
    expect(output).toEqual({ steps: [{ hits: ["https://a.example/hopper"] }, { text: "Grace Hopper wrote the first compiler." }, { summary: "Hopper: compilers." }] });
    // Each question went with its constraint: the varying arguments, typed by the tool's own schema.
    expect(model.doGenerateCalls.map((c) => c.responseFormat)).toEqual([
      { type: "json", schema: { type: "object", properties: { url: { type: "string", format: "uri" } }, required: ["url"], additionalProperties: false } },
      { type: "json", schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
    ]);
    // The run is durable: journaled under the tool call's id, so calling again replays rather than reruns.
    expect([...journals.keys()]).toEqual(["tool/call-1"]);
    await tools[w.name]!.execute!({ query: "grace hopper" }, { toolCallId: "call-1", messages: [], context: undefined });
    expect(performed).toHaveLength(3);
  });
});
