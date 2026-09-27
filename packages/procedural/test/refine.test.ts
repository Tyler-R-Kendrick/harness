import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HARNESS } from "@harness/cognitive";
import { promptText } from "@harness/testkit";
import { editSetJsonSchema, parseSettings, refine } from "@harness/procedural";
import type { MockLanguageModelV4 } from "ai/test";
import { answering } from "./models.ts";

const settings = parseSettings(JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")));

const request = (model: MockLanguageModelV4) => ({
  model,
  template: settings.prompts.refiner,
  task: "answer a multi-hop question",
  mode: "static_incremental",
  tools: ["first_hop_retrieve", "scan_index"],
  attempts: "Trajectory 1 (score 0.5): ...",
  graphJson: '{"nodes":[]}',
  rejected: "Candidate 1: score 0.2",
});

const edits = {
  add_nodes: [{ id: "Verify", type: "REASONING", description: "Check the answer against the evidence." }],
  delete_nodes: ["Scan_Index"],
  add_edges: [{ source: "Bridge_Extract", target: "Verify", relation: "LEADS_TO", condition: null, guidance: "Verify before answering.", pitfalls: "Do not answer unverified." }],
  delete_edges: [{ source: "Start", target: "End" }],
};

describe("refine", () => {
  it("PG4.21 renders the refiner template with the task, mode, tools, attempts, graph and rejections", async () => {
    const model = answering(JSON.stringify(edits));
    await refine(request(model));
    const text = promptText(model.doGenerateCalls[0]!.prompt);
    expect(text).toContain("Task context: answer a multi-hop question\n");
    expect(text).toContain("Refinement mode: static_incremental\n");
    expect(text).toContain("(the agent can only execute these actions): first_hop_retrieve, scan_index\n");
    expect(text).toContain("Recent execution trajectories: Trajectory 1 (score 0.5): ...\n");
    expect(text).toContain('Current Procedural Graph representation: {"nodes":[]}\n');
    expect(text).toContain("Previously rejected candidates: Candidate 1: score 0.2\n");
  });

  it("PG4.22 sends the edit-set JSON Schema as its constraint, under provider options harness", async () => {
    const model = answering(JSON.stringify(edits));
    await refine(request(model));
    expect(model.doGenerateCalls[0]!.providerOptions?.[HARNESS]?.["constraint"]).toEqual({ type: "json-schema", schema: editSetJsonSchema() });
  });

  it("PG4.23 parses a well-formed answer into an edit set, keeping the raw text", async () => {
    const raw = JSON.stringify(edits);
    expect(await refine(request(answering(raw)))).toEqual({ edits, raw });
  });

  it("PG4.24 fills an edit set's missing lists with empty ones", async () => {
    const raw = '{"delete_nodes":["Scan_Index"]}';
    expect(await refine(request(answering(raw)))).toEqual({ edits: { add_nodes: [], delete_nodes: ["Scan_Index"], add_edges: [], delete_edges: [] }, raw });
  });

  it("PG4.25 reads the JSON block out of a fenced answer or one with prose around it", async () => {
    const fenced = `\`\`\`json\n${JSON.stringify(edits)}\n\`\`\``;
    expect(await refine(request(answering(fenced)))).toEqual({ edits, raw: fenced });
    const prose = `Here are the edits: ${JSON.stringify(edits)} Done.`;
    expect(await refine(request(answering(prose)))).toEqual({ edits, raw: prose });
  });

  it("PG4.26 returns an error with the raw text, not an exception, when the answer is not JSON", async () => {
    for (const raw of ["", "no edits today", "{not json}", "} {"]) {
      const result = await refine(request(answering(raw)));
      expect(result).toEqual({ error: expect.stringMatching(/^the refiner's answer is not JSON/), raw });
    }
  });

  it("PG4.27 returns an error naming where, with the raw text, when the JSON is not an edit set", async () => {
    const bad = JSON.stringify({ ...edits, add_nodes: [{ id: "9bad", type: "ACTION", description: "x" }] });
    expect(await refine(request(answering(bad)))).toEqual({ error: expect.stringMatching(/^the refiner's answer is not an edit set[\s\S]*add_nodes/), raw: bad });
    const bound = JSON.stringify({ add_nodes: [{ id: "Run", type: "ACTION", description: "x", binding: { kind: "tool", name: "rm" } }] });
    expect(await refine(request(answering(bound)))).toMatchObject({ error: expect.stringMatching(/binding/), raw: bound });
    expect(await refine(request(answering("[1, 2]")))).toMatchObject({ error: expect.stringMatching(/^the refiner's answer is not an edit set/) });
  });

  it("PG4.28 fills dream's consolidation blocks when they are given", async () => {
    const model = answering(JSON.stringify(edits));
    await refine({ ...request(model), template: settings.prompts.dream, consolidation: { overlayEntries: "E1 active", cautionedEdges: "Start→End poor", rejectionReasons: "cycle" } });
    const text = promptText(model.doGenerateCalls[0]!.prompt);
    expect(text).toContain("candidates to absorb into the graph): E1 active\n");
    expect(text).toContain("candidates to prune or rewrite): Start→End poor\n");
    expect(text).toContain("do not propose them again): cycle\n");
    expect(text).not.toMatch(/\{[a-z_]+\}/);
  });

  it("PG4.29 passes temperature, topK and maxOutputTokens through to the model", async () => {
    const model = answering(JSON.stringify(edits));
    await refine({ ...request(model), temperature: 0, topK: 1, maxOutputTokens: 8192 });
    expect(model.doGenerateCalls[0]).toMatchObject({ temperature: 0, topK: 1, maxOutputTokens: 8192 });
  });

  it("PG4.30 leaves decoding to the model when no option is given, and passes the abort signal through", async () => {
    const controller = new AbortController();
    const model = answering(JSON.stringify(edits));
    await refine({ ...request(model), abortSignal: controller.signal });
    const [call] = model.doGenerateCalls;
    expect([call!.temperature, call!.topK, call!.maxOutputTokens]).toEqual([undefined, undefined, undefined]);
    expect(call!.abortSignal).toBe(controller.signal);
  });
});
