import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HARNESS } from "@harness/cognitive";
import { promptText } from "@harness/testkit";
import { parseSettings, reflect, reflectionJsonSchema } from "@harness/procedural";
import type { MockLanguageModelV4 } from "ai/test";
import { answering } from "./models.ts";

const settings = parseSettings(JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")));

const request = (model: MockLanguageModelV4) => ({
  model,
  template: settings.prompts.reflection,
  graphContext: "Active Cognitive Node: [Scan_Index] (Type: ACTION)",
  trajectory: "Thought: scan\nAction: scan_index()\nScore: 0.9",
});

const note = { kind: "note", on: { from: "Scan_Index", to: "Bridge_Extract" }, text: "Read every passage before extracting." };
const edge = { kind: "edge", from: "Scan_Index", relation: "LEADS_TO", to: "End", condition: "When the answer is in the first passage", guidance: "Answer directly.", pitfalls: "Do not answer without evidence." };

/** Every property name anywhere in a JSON Schema. */
const properties = (schema: unknown): string[] => {
  if (Array.isArray(schema)) return schema.flatMap(properties);
  if (typeof schema !== "object" || schema === null) return [];
  const record = schema as Record<string, unknown>;
  const own = typeof record["properties"] === "object" && record["properties"] !== null ? Object.keys(record["properties"]) : [];
  return [...own, ...Object.values(record).flatMap(properties)];
};

describe("reflect", () => {
  it("PG4.31 renders the reflection template with the graph context and the trajectory", async () => {
    const model = answering('{"entries":[]}');
    await reflect(request(model));
    const text = promptText(model.doGenerateCalls[0]!.prompt);
    expect(text).toContain("Graph context (the part of the Procedural Graph the agent was guided by): Active Cognitive Node: [Scan_Index] (Type: ACTION)\n");
    expect(text).toContain("The turn’s execution trajectory and its score: Thought: scan\nAction: scan_index()\nScore: 0.9\n");
  });

  it("PG4.32 sends the entries JSON Schema as its constraint, under provider options harness", async () => {
    const model = answering('{"entries":[]}');
    await reflect(request(model));
    expect(model.doGenerateCalls[0]!.providerOptions?.[HARNESS]?.["constraint"]).toEqual({ type: "json-schema", schema: reflectionJsonSchema() });
  });

  it("PG4.33 the entries schema allows only notes and edges, with no binding anywhere and no other fields", () => {
    const schema = reflectionJsonSchema();
    const text = JSON.stringify(schema);
    expect(properties(schema)).not.toContain("binding");
    expect(text).toContain('"const":"note"');
    expect(text).toContain('"const":"edge"');
    expect(text).not.toContain('"const":"node"');
    expect(text).not.toContain('"const":"caution"');
    expect(text).not.toContain('"additionalProperties":{}');
    expect(schema).toMatchObject({ type: "object", required: ["entries"], additionalProperties: false });
  });

  it("PG4.34 returns the proposed notes and edges, in order", async () => {
    expect(await reflect(request(answering(JSON.stringify({ entries: [note, edge] }))))).toEqual([note, edge]);
  });

  it("PG4.35 never yields a binding: an entry that carries one is dropped, the rest kept", async () => {
    const bound = { ...edge, to: "Run", binding: { kind: "tool", name: "rm" } };
    const result = await reflect(request(answering(JSON.stringify({ entries: [bound, note] }))));
    expect(result).toEqual([note]);
    expect(JSON.stringify(result)).not.toContain("binding");
  });

  it("PG4.36 drops entries of kinds reflection may not propose, and malformed ones", async () => {
    const entries = [
      { kind: "node", id: "New", type: "ACTION", description: "x" },
      { kind: "caution", on: { from: "Start", to: "End" }, text: "risky" },
      { kind: "note", on: { from: "Start", to: "End" }, text: "" },
      { kind: "edge", from: "9bad", relation: "LEADS_TO", to: "End", condition: null, guidance: "g", pitfalls: "p" },
      "text",
      edge,
    ];
    expect(await reflect(request(answering(JSON.stringify({ entries }))))).toEqual([edge]);
  });

  it("PG4.37 yields nothing, rather than throwing, when the answer is malformed", async () => {
    for (const raw of ["", "nothing new", "{broken", "[1]", '{"entries":"none"}', '{"notes":[]}', "null"]) {
      expect(await reflect(request(answering(raw)))).toEqual([]);
    }
  });

  it("PG4.38 reads the JSON block out of a fenced answer", async () => {
    expect(await reflect(request(answering(`\`\`\`json\n${JSON.stringify({ entries: [note] })}\n\`\`\``)))).toEqual([note]);
  });

  it("PG4.39 passes temperature, topK, maxOutputTokens and the abort signal through to the model", async () => {
    const controller = new AbortController();
    const model = answering('{"entries":[]}');
    await reflect({ ...request(model), temperature: 0, topK: 1, maxOutputTokens: 512, abortSignal: controller.signal });
    expect(model.doGenerateCalls[0]).toMatchObject({ temperature: 0, topK: 1, maxOutputTokens: 512, abortSignal: controller.signal });
    const plain = answering('{"entries":[]}');
    await reflect(request(plain));
    expect([plain.doGenerateCalls[0]!.temperature, plain.doGenerateCalls[0]!.topK, plain.doGenerateCalls[0]!.maxOutputTokens]).toEqual([undefined, undefined, undefined]);
  });
});
