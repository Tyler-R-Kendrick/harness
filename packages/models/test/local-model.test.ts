import { describe, expect, it } from "vitest";
import { generateText, streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { localLanguageModel, pageInstruction, templateOf } from "@harness/models";
import { usage } from "@harness/cognitive";

const finish: LanguageModelV4StreamPart = { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() };

describe("prompts as chat-template messages", () => {
  it("LM1.1 system and user messages become template messages, with each image a placeholder and its bytes in order", () => {
    const { messages, images, tools } = templateOf({
      prompt: [
        { role: "system", content: "Be brief." },
        {
          role: "user",
          content: [
            { type: "text", text: "Compare " },
            { type: "file", mediaType: "image/png", data: { type: "data", data: new Uint8Array([1, 2]) } },
            { type: "text", text: " with " },
            { type: "file", mediaType: "image/jpeg", data: { type: "data", data: "aGk=" } },
          ],
        },
      ],
    });
    expect(messages).toEqual([
      { role: "system", content: [{ type: "text", text: "Be brief." }] },
      { role: "user", content: [{ type: "text", text: "Compare " }, { type: "image" }, { type: "text", text: " with " }, { type: "image" }] },
    ]);
    // base64 image data is decoded to bytes
    expect(images).toEqual([
      { mediaType: "image/png", data: new Uint8Array([1, 2]) },
      { mediaType: "image/jpeg", data: new Uint8Array([104, 105]) },
    ]);
    expect(tools).toEqual([]);
  });

  it("LM1.2 an assistant message keeps its text and its tool calls with parsed arguments; one without calls has none", () => {
    const { messages } = templateOf({
      prompt: [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "thinking" },
            { type: "text", text: "Checking " },
            { type: "text", text: "both." },
            { type: "tool-call", toolCallId: "a", toolName: "get_weather", input: '{"city":"Lagos"}' },
            { type: "tool-call", toolCallId: "b", toolName: "set_timer", input: { minutes: 5 } },
            { type: "tool-call", toolCallId: "c", toolName: "ping", input: undefined },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
      ],
    });
    expect(messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Checking both." }],
        tool_calls: [
          { type: "function", function: { name: "get_weather", arguments: { city: "Lagos" } } },
          { type: "function", function: { name: "set_timer", arguments: { minutes: 5 } } },
          { type: "function", function: { name: "ping", arguments: {} } },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ]);
    expect(messages[1]).not.toHaveProperty("tool_calls");
  });

  it("LM1.3 each tool result becomes a tool message named by its tool, whatever the output's type", () => {
    const result = (toolName: string, output: unknown) => ({ type: "tool-result" as const, toolCallId: toolName, toolName, output: output as never });
    const { messages } = templateOf({
      prompt: [
        {
          role: "tool",
          content: [
            result("text", { type: "text", value: "plain" }),
            result("error-text", { type: "error-text", value: "failed" }),
            result("json", { type: "json", value: { sky: "clear" } }),
            result("error-json", { type: "error-json", value: { code: 5 } }),
            result("denied", { type: "execution-denied" }),
            result("denied-why", { type: "execution-denied", reason: "not allowed" }),
            result("content", { type: "content", value: [{ type: "text", text: "see " }, { type: "file", mediaType: "image/png", data: { type: "data", data: new Uint8Array([1]) } }, { type: "text", text: "above" }] }),
            { type: "tool-approval-response", approvalId: "x", approved: true },
          ],
        },
      ],
    });
    expect(messages.map((m) => [m.role, m.name, m.content])).toEqual([
      ["tool", "text", [{ type: "text", text: "plain" }]],
      ["tool", "error-text", [{ type: "text", text: "failed" }]],
      ["tool", "json", [{ type: "text", text: '{"sky":"clear"}' }]],
      ["tool", "error-json", [{ type: "text", text: '{"code":5}' }]],
      ["tool", "denied", [{ type: "text", text: "denied" }]],
      ["tool", "denied-why", [{ type: "text", text: "denied: not allowed" }]],
      ["tool", "content", [{ type: "text", text: "see above" }]],
    ]);
  });

  it("LM1.4 function tools are offered as template tools; provider tools are not", () => {
    const { tools } = templateOf({
      prompt: [],
      tools: [
        { type: "function", name: "search", description: "find", inputSchema: { type: "object" } },
        { type: "function", name: "bare", inputSchema: {} },
        { type: "provider", id: "acme.web", name: "web", args: {} },
      ],
    });
    expect(tools).toEqual([
      { name: "search", description: "find", parameters: { type: "object" } },
      { name: "bare", description: "", parameters: {} },
    ]);
  });

  it("LM1.5 files that are not images, and images by URL, reference or inline text, are refused", () => {
    const user = (part: unknown): LanguageModelV4Prompt => [{ role: "user", content: [part as never] }];
    expect(() => templateOf({ prompt: user({ type: "file", mediaType: "application/pdf", data: { type: "data", data: new Uint8Array([1]) } }) })).toThrow("this model reads images, not application/pdf");
    expect(() => templateOf({ prompt: user({ type: "file", mediaType: "image/png", data: { type: "url", url: new URL("https://example.com/a.png") } }) })).toThrow("this model needs image bytes, not a reference");
    expect(() => templateOf({ prompt: user({ type: "file", mediaType: "image/png", data: { type: "reference", reference: { acme: "file-1" } } }) })).toThrow(/image bytes/);
    expect(() => templateOf({ prompt: user({ type: "file", mediaType: "image/png", data: { type: "text", text: "not pixels" } }) })).toThrow(/image bytes/);
  });
});

/** A decoder that yields scripted parts, recording what happened to it. */
function decoder(script: (log: string[], options: LanguageModelV4CallOptions) => AsyncGenerator<LanguageModelV4StreamPart>) {
  const log: string[] = [];
  const model = localLanguageModel({ provider: "harness.local", modelId: "decoder", run: (options) => script(log, options) });
  return { model, log };
}

async function* counting(log: string[], _options: LanguageModelV4CallOptions, n = 50): AsyncGenerator<LanguageModelV4StreamPart> {
  try {
    yield { type: "stream-start", warnings: [] };
    yield { type: "text-start", id: "0" };
    for (let i = 0; i < n; i++) {
      await new Promise((r) => setTimeout(r, 1));
      log.push(`token ${i}`);
      yield { type: "text-delta", id: "0", delta: "x" };
    }
    yield { type: "text-end", id: "0" };
    yield finish;
  } finally {
    log.push("stopped");
  }
}

describe("local language models", () => {
  it("LM2.1 a decoder's parts stream as they come, and are collected into a generate result", async () => {
    const { model } = decoder(async function* () {
      yield { type: "stream-start", warnings: [] };
      yield { type: "reasoning-start", id: "0" };
      yield { type: "reasoning-delta", id: "0", delta: "hm" };
      yield { type: "reasoning-end", id: "0" };
      yield { type: "text-start", id: "1" };
      yield { type: "text-delta", id: "1", delta: "Hel" };
      yield { type: "text-delta", id: "1", delta: "lo" };
      yield { type: "text-end", id: "1" };
      yield { type: "tool-call", toolCallId: "call_0", toolName: "t", input: "{}" };
      yield { ...finish, finishReason: { unified: "tool-calls", raw: "tool-calls" } };
    });
    expect([model.specificationVersion, model.provider, model.modelId]).toEqual(["v4", "harness.local", "decoder"]);
    // image URLs are downloaded by the AI SDK: these models take bytes
    expect(model.supportedUrls).toEqual({});
    const streamed = streamText({ model, prompt: "hi", maxRetries: 0 });
    const deltas: string[] = [];
    for await (const d of streamed.textStream) deltas.push(d);
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(await streamed.reasoningText).toBe("hm");
    const generated = await generateText({ model, prompt: "hi", maxRetries: 0 });
    expect(generated.text).toBe("Hello");
    expect(generated.reasoningText).toBe("hm");
    expect(generated.toolCalls.map((c) => c.toolName)).toEqual(["t"]);
    expect(generated.finishReason).toBe("tool-calls");
  });

  it("LM2.2 the call's options reach the decoder", async () => {
    const seen: LanguageModelV4CallOptions[] = [];
    const { model } = decoder(async function* (_log, options) {
      seen.push(options);
      yield finish;
    });
    await generateText({ model, prompt: "hi", maxOutputTokens: 7, temperature: 0.5, maxRetries: 0 });
    expect(seen[0]).toMatchObject({ maxOutputTokens: 7, temperature: 0.5, prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  });

  it("LM2.3 cancelling the stream stops the decoder", async () => {
    const { model, log } = decoder(counting);
    const { stream } = await model.doStream({ prompt: [] });
    const reader = stream.getReader();
    await reader.read();
    await reader.read();
    await reader.read();
    await reader.cancel();
    const decoded = log.filter((l) => l.startsWith("token")).length;
    expect(log.at(-1)).toBe("stopped");
    await new Promise((r) => setTimeout(r, 20));
    expect(log.filter((l) => l.startsWith("token")).length).toBe(decoded);
  });

  it("LM2.4 aborting a streamed call stops the decoder", async () => {
    const { model, log } = decoder(counting);
    const abort = new AbortController();
    const result = streamText({ model, prompt: "hi", abortSignal: abort.signal, maxRetries: 0 });
    for await (const _ of result.textStream) break;
    abort.abort();
    await new Promise((r) => setTimeout(r, 40));
    expect(log).toContain("stopped");
    expect(log.filter((l) => l.startsWith("token")).length).toBeLessThan(50);
  });

  it("LM2.5 aborting a generate call stops the decoder", async () => {
    const { model, log } = decoder(counting);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 5);
    await expect(generateText({ model, prompt: "hi", abortSignal: abort.signal, maxRetries: 0 })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 40));
    expect(log).toContain("stopped");
    expect(log.filter((l) => l.startsWith("token")).length).toBeLessThan(50);
  });

  it("LM2.6 a decoder's failure is an error part in the stream, and rejects a generate call", async () => {
    const { model } = decoder(async function* () {
      yield { type: "stream-start", warnings: [] };
      throw new Error("decoder crashed");
    });
    const { stream } = await model.doStream({ prompt: [] });
    const parts: LanguageModelV4StreamPart[] = [];
    for await (const p of stream) parts.push(p);
    expect(parts).toEqual([{ type: "stream-start", warnings: [] }, { type: "error", error: new Error("decoder crashed") }]);
    await expect(generateText({ model, prompt: "hi", maxRetries: 0 })).rejects.toThrow("decoder crashed");
  });
});

describe("the page instruction", () => {
  /** A model that records the prompt it is sent. */
  function recording() {
    const prompts: LanguageModelV4Prompt[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(options.prompt);
        return { content: [{ type: "text", text: "# Page" }], finishReason: { unified: "stop", raw: "stop" }, usage: usage(), warnings: [] };
      },
    });
    return { model: wrapLanguageModel({ model, middleware: pageInstruction("Convert the page to Markdown.") }), prompts };
  }
  const png = { type: "file" as const, data: new Uint8Array([1]), mediaType: "image/png" };

  it("LM3.1 is added to a user message that sends a page with no words of its own", async () => {
    const { model, prompts } = recording();
    await generateText({ model, maxRetries: 0, messages: [{ role: "user", content: [png] }] });
    await generateText({ model, maxRetries: 0, messages: [{ role: "user", content: [png, { type: "text", text: "  " }] }] });
    expect(prompts[0]![0]).toMatchObject({ role: "user", content: [{ type: "file" }, { type: "text", text: "Convert the page to Markdown." }] });
    expect(prompts[1]![0]!.content).toHaveLength(3);
    expect(prompts[1]![0]).toMatchObject({ content: [{ type: "file" }, { type: "text", text: "  " }, { type: "text", text: "Convert the page to Markdown." }] });
  });

  it("LM3.2 leaves alone a page sent with words, a message without a file, and every other role", async () => {
    const { model, prompts } = recording();
    await generateText({
      model,
      maxRetries: 0,
      system: "You read documents.",
      messages: [
        { role: "user", content: [png, { type: "text", text: "Extract the tables." }] },
        { role: "assistant", content: "Done." },
        { role: "user", content: "Thanks." },
      ],
    });
    expect(prompts[0]).toMatchObject([
      { role: "system", content: "You read documents." },
      { role: "user", content: [{ type: "file" }, { type: "text", text: "Extract the tables." }] },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
      { role: "user", content: [{ type: "text", text: "Thanks." }] },
    ]);
    expect(prompts[0]![1]!.content).toHaveLength(2);
    expect(prompts[0]![3]!.content).toHaveLength(1);
  });
});
