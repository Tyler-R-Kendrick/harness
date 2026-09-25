import { describe, expect, it } from "vitest";
import { streamText } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { collectParts, finishReason, HARNESS, stateOf, StreamParts, usage } from "@harness/cognitive";

describe("local model output as AI SDK stream parts", () => {
  it("SP1.1 text and reasoning open a block on their first delta and close it when something else comes", () => {
    const p = new StreamParts();
    expect([...p.push({ type: "reasoning", text: "hmm" }), ...p.push({ type: "reasoning", text: "!" }), ...p.push({ type: "text", text: "" }), ...p.push({ type: "text", text: "hi" }), ...p.end()]).toEqual([
      { type: "reasoning-start", id: "0" },
      { type: "reasoning-delta", id: "0", delta: "hmm" },
      { type: "reasoning-delta", id: "0", delta: "!" },
      { type: "reasoning-end", id: "0" },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "hi" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason: finishReason("stop"), usage: usage() },
    ]);
  });

  it("SP1.2 tool calls get ids in call order and the finish says tool-calls, unless the output was cut off", () => {
    const p = new StreamParts();
    const parts = [...p.push({ type: "text", text: "ok" }), ...p.push({ type: "tool-call", call: { name: "a", arguments: { x: 1 } } }), ...p.push({ type: "tool-call", call: { name: "b", arguments: {} } })];
    expect(parts).toEqual([
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "ok" },
      { type: "text-end", id: "0" },
      { type: "tool-call", toolCallId: "call_0", toolName: "a", input: '{"x":1}' },
      { type: "tool-call", toolCallId: "call_1", toolName: "b", input: "{}" },
    ]);
    expect(p.end({ usage: usage(3, 4), providerMetadata: { [HARNESS]: { confidence: 1 } } })).toEqual([{ type: "finish", finishReason: finishReason("tool-calls"), usage: usage(3, 4), providerMetadata: { [HARNESS]: { confidence: 1 } } }]);
    expect(new StreamParts().end({ length: true })).toEqual([{ type: "finish", finishReason: { unified: "length", raw: "length" }, usage: usage() }]);
    const cut = new StreamParts();
    cut.push({ type: "tool-call", call: { name: "a", arguments: {} } });
    expect(cut.end({ length: true })[0]).toMatchObject({ finishReason: { unified: "length" } });
  });

  it("SP1.3 a state change closes the open block and is custom content", () => {
    const p = new StreamParts();
    p.push({ type: "text", text: "a" });
    const parts = p.push({ type: "state", state: "calm", from: "tense" });
    expect(parts[0]).toEqual({ type: "text-end", id: "0" });
    expect(stateOf(parts[1]!)).toEqual({ state: "calm", from: "tense" });
    expect(p.push({ type: "text", text: "b" })[0]).toEqual({ type: "text-start", id: "1" });
  });

  it("SP1.4 parts collect into a generate result: blocks joined, calls and custom content kept, the finish's reason, usage and metadata", () => {
    const p = new StreamParts();
    const parts = [
      { type: "stream-start" as const, warnings: [] },
      ...p.push({ type: "reasoning", text: "a" }),
      ...p.push({ type: "reasoning", text: "b" }),
      ...p.push({ type: "text", text: "c" }),
      ...p.push({ type: "state", state: "s" }),
      ...p.push({ type: "tool-call", call: { name: "t", arguments: {} } }),
      ...p.end({ usage: usage(1, 2), providerMetadata: { [HARNESS]: { x: 1 } } }),
    ];
    const result = collectParts(parts);
    expect(result.content).toEqual([{ type: "reasoning", text: "ab" }, { type: "text", text: "c" }, parts[8], parts[9]]);
    expect(result).toMatchObject({ finishReason: finishReason("tool-calls"), usage: usage(1, 2), providerMetadata: { [HARNESS]: { x: 1 } }, warnings: [] });
    expect(collectParts([{ type: "finish", finishReason: finishReason("stop"), usage: usage() }])).not.toHaveProperty("providerMetadata");
  });

  it("SP1.5 a stream with an error part throws it, and one without a finish is refused", () => {
    const boom = new Error("boom");
    expect(() => collectParts([{ type: "error", error: boom }])).toThrow(boom);
    expect(() => collectParts([{ type: "text-start", id: "0" }])).toThrow("the stream ended without a finish part");
  });

  it("SP1.6 the parts are what streamText expects: text, reasoning and custom state parts come through", async () => {
    const p = new StreamParts();
    const parts = [...p.push({ type: "reasoning", text: "think" }), ...p.push({ type: "state", state: "cheerful" }), ...p.push({ type: "text", text: "hello" }), ...p.end()];
    const result = streamText({ model: new MockLanguageModelV4({ doStream: async () => ({ stream: convertArrayToReadableStream(parts) }) }), prompt: "p" });
    const states: unknown[] = [];
    for await (const part of result.fullStream) {
      const s = stateOf(part as never);
      if (s) states.push(s);
    }
    expect(await result.text).toBe("hello");
    expect(await result.reasoningText).toBe("think");
    expect(states).toEqual([{ state: "cheerful" }]);
  });
});
