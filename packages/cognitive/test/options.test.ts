import { describe, expect, it } from "vitest";
import { constrain, constraintOf, dimensions, jsonResponseFormat, embedding, embedInputs, HARNESS, STATE_KIND, stateContent, stateOf } from "@harness/cognitive";

describe("our settings on AI SDK calls", () => {
  it("OP1.1 a constraint travels as harness provider options and reads back parsed; a JSON response format is a JSON Schema constraint", () => {
    const template = { type: "template" as const, parts: ["a: ", { hole: "a" }] };
    expect(constrain(template)).toEqual({ providerOptions: { [HARNESS]: { constraint: template } } });
    expect(constraintOf(constrain(template))).toEqual(template);
    expect(constraintOf({ responseFormat: { type: "json", schema: { type: "integer" } } })).toEqual({ type: "json-schema", schema: { type: "integer" } });
    expect(constraintOf({ responseFormat: { type: "json" } })).toEqual({ type: "json-schema", schema: {} });
    expect(constraintOf({ responseFormat: { type: "text" } })).toBeUndefined();
    expect(constraintOf({})).toBeUndefined();
    expect(constraintOf({ providerOptions: { other: { constraint: template } } })).toBeUndefined();
    // ours wins over the response format
    expect(constraintOf({ ...constrain({ type: "regex", pattern: "[0-9]+" }), responseFormat: { type: "json" } })).toEqual({ type: "regex", pattern: "[0-9]+" });
  });

  it("OP1.2 a constraint that is not one is refused, saying where", () => {
    expect(() => constraintOf({ providerOptions: { [HARNESS]: { constraint: { type: "template", parts: [{ hole: "Bad Name" }] } } } })).toThrow(/invalid constraint in provider options[\s\S]*parts/);
  });

  it("OP1.5 a JSON Schema constraint of ours becomes the AI SDK response format, so any provider that enforces one does", async () => {
    const schema = { type: "object", properties: { n: { type: "integer" } } };
    const transform = (params: Parameters<NonNullable<typeof jsonResponseFormat.transformParams>>[0]["params"]) => jsonResponseFormat.transformParams!({ type: "generate", params, model: undefined as never });
    const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "x" }] }];
    expect(await transform({ prompt, ...constrain({ type: "json-schema", schema }) })).toEqual({ prompt, ...constrain({ type: "json-schema", schema }), responseFormat: { type: "json", schema } });
    // a response format already set is kept, and other kinds of constraint are left to our own models
    expect(await transform({ prompt, ...constrain({ type: "json-schema", schema }), responseFormat: { type: "text" } })).toEqual({ prompt, ...constrain({ type: "json-schema", schema }), responseFormat: { type: "text" } });
    expect(await transform({ prompt, ...constrain({ type: "regex", pattern: "a" }) })).toEqual({ prompt, ...constrain({ type: "regex", pattern: "a" }) });
    expect(await transform({ prompt })).toEqual({ prompt });
    expect(jsonResponseFormat.specificationVersion).toBe("v4");
  });

  it("OP1.3 embedding settings say what the texts are and the size wanted; documents are the default", () => {
    expect(embedding({ kind: "query", task: "search", dimensions: dimensions(8) })).toEqual({ providerOptions: { [HARNESS]: { kind: "query", task: "search", dimensions: 8 } } });
    expect(embedInputs(["q"], embedding({ kind: "query", task: "search", dimensions: dimensions(8) }).providerOptions)).toEqual({ inputs: [{ kind: "query", text: "q", task: "search" }], dimensions: 8 });
    expect(embedInputs(["d", "e"], embedding({ kind: "document", title: "T" }).providerOptions)).toEqual({ inputs: [{ kind: "document", text: "d", title: "T" }, { kind: "document", text: "e", title: "T" }] });
    expect(embedInputs(["d"], undefined)).toStrictEqual({ inputs: [{ kind: "document", text: "d" }] });
    // a title means nothing to a query, a task nothing to a document
    expect(embedInputs(["q"], { [HARNESS]: { kind: "query", title: "T" } }).inputs).toEqual([{ kind: "query", text: "q" }]);
    expect(embedInputs(["d"], { [HARNESS]: { kind: "document", task: "x" } }).inputs).toEqual([{ kind: "document", text: "d" }]);
    expect(() => embedInputs(["d"], { [HARNESS]: { kind: "summary" } })).toThrow(/invalid embedding options[\s\S]*kind/);
    expect(() => embedInputs(["d"], { [HARNESS]: { dimensions: 0 } })).toThrow(/dimensions/);
  });

  it("OP1.4 a state change is custom content of kind harness.state, and reads back only from that kind", () => {
    const part = stateContent({ state: "soothing", from: "neutral", cause: "insult" });
    expect(part).toEqual({ type: "custom", kind: STATE_KIND, providerMetadata: { [HARNESS]: { state: "soothing", from: "neutral", cause: "insult" } } });
    expect(stateOf(part)).toEqual({ state: "soothing", from: "neutral", cause: "insult" });
    expect(stateOf(stateContent({ state: "calm" }))).toEqual({ state: "calm" });
    expect(stateOf({ ...part, kind: "other.kind" })).toBeUndefined();
    expect(stateOf({ type: "text-delta" })).toBeUndefined();
    expect(stateOf({ ...part, type: "file" })).toBeUndefined();
    expect(stateOf({ type: "custom", kind: STATE_KIND, providerMetadata: { [HARNESS]: { state: 3 } } })).toBeUndefined();
    expect(stateOf({ type: "custom", kind: STATE_KIND })).toBeUndefined();
  });
});
