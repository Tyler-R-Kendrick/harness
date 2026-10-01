import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateText, streamText, tool } from "ai";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { f } from "@ax-llm/ax";
import { z } from "zod";
import { collectParts, constrain, constraintOf, HARNESS, inSession, sessionOf, usage } from "@harness/cognitive";
import { Dialogue, parseSettings } from "@harness/dialogue";
import { replySignature, sessionModel } from "@harness/workers";

const settingsFile = JSON.parse(readFileSync(new URL("../../dialogue/data/settings.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown>>;
const settings = parseSettings(settingsFile);

/** The output half of an Ax signature: the object constrained decoding has to produce. */
function outputSchema(signature: typeof replySignature): Record<string, unknown> {
  const full = signature.toJSONSchema();
  const names = new Set(signature.getOutputFields().map((field) => field.name));
  const properties = Object.fromEntries(Object.entries(full.properties ?? {}).filter(([name]) => names.has(name)));
  return {
    type: "object",
    ...(full.title === undefined ? {} : { title: full.title }),
    properties,
    required: (full.required ?? []).filter((name) => names.has(name)),
    additionalProperties: false,
  };
}

const expectedSignature = f()
  .input("utterance", f.string("What the person just said."))
  .output("reply", f.string("The sentence the person reads back."))
  .description("A conversation turn. The reply is the words the person hears, with no markup.")
  .useStructured()
  .build();

function answering(text: string | readonly string[]): MockLanguageModelV4 & { readonly calls: LanguageModelV4CallOptions[] } {
  const calls: LanguageModelV4CallOptions[] = [];
  const deltas = typeof text === "string" ? [text] : text;
  const parts = (): LanguageModelV4StreamPart[] => [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
    ...deltas.map((delta) => ({ type: "text-delta" as const, id: "0", delta })),
    { type: "text-end", id: "0" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage() },
  ];
  const model = new MockLanguageModelV4({
    doGenerate: async (call) => {
      calls.push(call);
      return collectParts(parts());
    },
    doStream: async (call) => {
      calls.push(call);
      return { stream: convertArrayToReadableStream(parts()) };
    },
  });
  return Object.assign(model, { calls });
}

describe("typed session replies", () => {
  it("TY1.1 a tool-less call carries the Ax signature's output schema and the caller reads the reply field", async () => {
    const inner = answering('{"reply":"The Atlantic Ocean."}');
    const model = sessionModel(inner);
    const result = await generateText({ model, prompt: "Which ocean is west of Portugal?", ...inSession("s1"), maxRetries: 0 });
    expect(replySignature.toString()).toBe(expectedSignature.toString());
    expect(constraintOf(inner.calls[0]!)).toEqual({ type: "json-schema", schema: outputSchema(expectedSignature) });
    expect(sessionOf(inner.calls[0]!.providerOptions)).toBe("s1");
    expect(result.text).toBe("The Atlantic Ocean.");
  });

  it("TY1.2 a streamed reply arrives as the sentence, even when the JSON is split across deltas", async () => {
    const inner = answering(['{"reply":"', 'The Atlantic Ocean."}']);
    const result = streamText({ model: sessionModel(inner), prompt: "Which ocean is west of Portugal?", maxRetries: 0 });
    expect(await result.text).toBe("The Atlantic Ocean.");
    expect(constraintOf(inner.calls[0]!)).toEqual({ type: "json-schema", schema: outputSchema(expectedSignature) });
  });

  it("TY1.3 a call that already has a constraint keeps it, and reply-shaped JSON stays as it was", async () => {
    const inner = answering('{"reply":"no"}');
    const model = sessionModel(inner);
    const regex = constrain({ type: "regex", pattern: "[a-z ]+" });
    const result = await generateText({ model, prompt: "hi", ...regex, maxRetries: 0 });
    expect(constraintOf(inner.calls[0]!)).toEqual({ type: "regex", pattern: "[a-z ]+" });
    expect(result.text).toBe('{"reply":"no"}');
    const formatted = answering('{"reply":"no"}');
    const seen = sessionModel(formatted);
    const generated = await seen.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      responseFormat: { type: "json", schema: { type: "object", properties: { kept: { type: "boolean" } } } },
    });
    expect(constraintOf(formatted.calls.at(-1)!)).toEqual({ type: "json-schema", schema: { type: "object", properties: { kept: { type: "boolean" } } } });
    expect(generated.content.map((part) => (part.type === "text" ? part.text : "")).join("")).toBe('{"reply":"no"}');
  });

  it("TY1.4 a call with tools is not given the reply schema", async () => {
    const inner = answering("sunny");
    const model = sessionModel(inner);
    const result = await generateText({
      model,
      prompt: "weather?",
      tools: { weather: tool({ inputSchema: z.object({ city: z.string() }) }) },
      maxRetries: 0,
    });
    expect(constraintOf(inner.calls[0]!)).toBeUndefined();
    expect(inner.calls[0]!.tools?.length).toBeGreaterThan(0);
    expect(result.text).toBe("sunny");
  });

  it("TY1.5 prose that is not the reply object is kept, so a model that cannot enforce the schema still answers", async () => {
    const inner = answering("The Atlantic Ocean.");
    const result = await generateText({ model: sessionModel(inner), prompt: "Which ocean is west of Portugal?", maxRetries: 0 });
    expect(constraintOf(inner.calls[0]!)?.type).toBe("json-schema");
    expect(result.text).toBe("The Atlantic Ocean.");
  });

  it("TY1.6 dialogue stays outside the reply schema, so a script answers with no model call and an unscripted turn is still typed", async () => {
    const book = {
      scripts: [
        {
          id: "order-status",
          intent: "The customer asks where their order is",
          patterns: ["where(?: is|'s) (?:my )?order (?<order_id>\\d+)"],
          slots: { order_id: { pattern: "\\d+" } },
          reply: ["Let me look up order ", { slot: "order_id" }, "."],
        },
      ],
    };
    const dialogue = new Dialogue({ settings, book });
    const inner = answering('{"reply":"I can help with that."}');
    const model = sessionModel(inner, dialogue);
    expect((await generateText({ model, prompt: "where is order 1234", ...inSession("s1"), maxRetries: 0 })).text).toBe("Let me look up order 1234.");
    expect(inner.calls).toEqual([]);
    expect((await generateText({ model, prompt: "tell me something else", ...inSession("s1"), maxRetries: 0 })).text).toBe("I can help with that.");
    expect(constraintOf(inner.calls[0]!)).toEqual({ type: "json-schema", schema: outputSchema(expectedSignature) });
    expect(inner.calls[0]!.providerOptions?.[HARNESS]).toMatchObject({ session: "s1" });
  });
});
