import { describe, expect, it } from "vitest";
import { embedMany, generateText, jsonSchema, Output, streamText, wrapLanguageModel } from "ai";
import type { TextStreamPart, ToolSet } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { constrain, dimensions, embedding, toolSet } from "@harness/cognitive";
import { pageInstruction, promptedEmbeddingModel, TokenClassifierCompressor, visionChatModel } from "@harness/models";
import type { ChatBackend, ChatBackendRequest, EmbeddingBackend, TokenClassifierBackend } from "@harness/models";
import type { CompressionConfig, EmbeddingConfig } from "@harness/cognitive";
import { compressorContract, documentParserContract, embedderContract, generatorContract, hashEmbeddingModel } from "@harness/testkit";

/** An embedding model's catalog settings: prompts per input kind and the sizes it truncates to. */
const EMBEDDING: EmbeddingConfig = { query: "Q({task}) {text}", document: "D({title}) {text}", defaults: { task: "search", title: "none" }, dimensions: [96, 64, 32].map(dimensions) };

class RecordingEmbeddingBackend implements EmbeddingBackend {
  readonly batches: string[][] = [];
  readonly #inner = hashEmbeddingModel(96);
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.batches.push([...texts]);
    const { embeddings } = await this.#inner.doEmbed({ values: texts.map((text) => text.replace(/^[QD]\([^)]*\) /, "")) });
    // Real embedding vectors are dense; add a small floor so every prefix is non-zero.
    return embeddings.map((v) => {
      const dense = v.map((x) => x + 0.01);
      const n = Math.hypot(...dense);
      return Float32Array.from(dense, (x) => x / n);
    });
  }
}

describe("prompted embedding model", () => {
  it("EA1.1 prompts queries and documents as the model's catalog entry says, and batches requests", async () => {
    const backend = new RecordingEmbeddingBackend();
    const model = promptedEmbeddingModel(backend, EMBEDDING, { modelId: "embedder", batchSize: 2 });
    expect([model.provider, model.modelId]).toEqual(["harness.local", "embedder"]);
    await embedMany({ model, values: ["red planet?", "blue planet?", "green planet?"], maxRetries: 0, ...embedding({ kind: "query" }) });
    await embedMany({ model, values: ["Mars."], maxRetries: 0, ...embedding({ kind: "document", title: "Planets" }) });
    await embedMany({ model, values: ["code"], maxRetries: 0, ...embedding({ kind: "query", task: "code retrieval" }) });
    // without our options, texts are documents
    await embedMany({ model, values: ["plain"], maxRetries: 0 });
    expect(backend.batches).toEqual([["Q(search) red planet?", "Q(search) blue planet?"], ["Q(search) green planet?"], ["D(Planets) Mars."], ["Q(code retrieval) code"], ["D(none) plain"]]);
  });

  it("EA1.3 without a batch size, the backend is sent sixteen texts at a time", async () => {
    const backend = new RecordingEmbeddingBackend();
    const { embeddings } = await embedMany({ model: promptedEmbeddingModel(backend, EMBEDDING, { modelId: "embedder" }), values: Array.from({ length: 17 }, (_, i) => `text ${i}`), maxRetries: 0 });
    expect(embeddings).toHaveLength(17);
    expect(backend.batches.map((b) => b.length)).toEqual([16, 1]);
  });

  it("EA1.2 truncates to a Matryoshka size and rejects sizes the model was not trained for", async () => {
    const model = promptedEmbeddingModel(new RecordingEmbeddingBackend(), EMBEDDING, { modelId: "embedder" });
    const { embeddings: [native] } = await embedMany({ model, values: ["hello"], maxRetries: 0 });
    expect(native!.length).toBe(96);
    const { embeddings: [v] } = await embedMany({ model, values: ["hello"], maxRetries: 0, ...embedding({ kind: "document", dimensions: dimensions(32) }) });
    expect(v!.length).toBe(32);
    expect(Math.hypot(...v!)).toBeCloseTo(1, 5);
    await expect(embedMany({ model, values: ["hello"], maxRetries: 0, ...embedding({ kind: "document", dimensions: dimensions(50) }) })).rejects.toThrow("the model embeds in 96, 64, 32 dimensions, not 50");
  });
});

embedderContract("prompted embedding model over a hashing backend", () => promptedEmbeddingModel(new RecordingEmbeddingBackend(), EMBEDDING, { modelId: "embedder" }), { size: 96, sizes: [64, 32] });

/** A WordPiece-ish tokenizer with a classifier that scores stopwords low. */
class FakeClassifier implements TokenClassifierBackend {
  readonly chunks: number[] = [];
  tokenize(text: string): string[] {
    return text.split(/\s+/).filter(Boolean).flatMap((w) => (w.length > 6 ? [w.slice(0, 4), `##${w.slice(4)}`] : [w]));
  }
  async keepProbabilities(tokens: readonly string[]): Promise<number[]> {
    this.chunks.push(tokens.length);
    return tokens.map((t) => (/^(the|and|is|for|in|at|to|be|on|of|a)$/i.test(t) ? 0.05 : t.startsWith("##") ? 0.7 : 0.8));
  }
}

const COMPRESSION: CompressionConfig = { window: 510, subwords: "wordpiece", keepLabel: 1 };

describe("token-classifier compressor", () => {
  it("LA1.1 scores tokens, rebuilds words and keeps the ones above the rate's threshold", async () => {
    const c = new TokenClassifierCompressor(new FakeClassifier(), COMPRESSION);
    // 14 tokens, 5 of them stopwords: keeping 70% drops exactly the stopwords.
    const r = await c.compress({ text: "Meeting is scheduled for Thursday at noon in the boardroom", rate: 0.7 });
    expect(r.text).toBe("Meeting scheduled Thursday noon boardroom");
    expect(r.originalTokens).toBe(14);
    expect(r.compressedTokens).toBeLessThan(r.originalTokens);
  });

  it("LA1.3 subwords join by the tokenizer's style from the catalog", async () => {
    const pieces: TokenClassifierBackend = { tokenize: () => ["▁Meet", "ing", "▁the", "▁board"], keepProbabilities: async (t) => t.map((x) => (x === "▁the" ? 0.05 : 0.9)) };
    const r = await new TokenClassifierCompressor(pieces, { ...COMPRESSION, subwords: "sentencepiece" }).compress({ text: "-", rate: 0.75 });
    expect(r.text).toBe("Meeting board");
  });

  it("LA1.2 long inputs are classified in windows the encoder can take", async () => {
    const classifier = new FakeClassifier();
    const c = new TokenClassifierCompressor(classifier, { ...COMPRESSION, window: 4 });
    await c.compress({ text: "one two three . four five six seven . eight", rate: 0.5 });
    expect(classifier.chunks).toEqual([4, 4, 2]);
  });
});

compressorContract("token-classifier compressor over a fake classifier", () => new TokenClassifierCompressor(new FakeClassifier(), COMPRESSION));


class ScriptedChatBackend implements ChatBackend {
  readonly requests: ChatBackendRequest[] = [];
  stopped = 0;
  readonly reply: (r: ChatBackendRequest) => { text: string; hitLimit?: boolean };
  /** Decoding takes real time per chunk (a macrotask) instead of finishing within one turn. */
  readonly slow: boolean;
  constructor(reply: (r: ChatBackendRequest) => { text: string; hitLimit?: boolean }, options: { slow?: boolean } = {}) {
    this.reply = reply;
    this.slow = options.slow ?? false;
  }
  async generate(request: ChatBackendRequest, onText: (delta: string) => void, shouldStop: () => boolean): Promise<{ hitLimit: boolean }> {
    this.requests.push(request);
    const { text, hitLimit = false } = this.reply(request);
    for (let i = 0; i < text.length; i += 4) {
      if (shouldStop()) {
        this.stopped++;
        return { hitLimit: false };
      }
      onText(text.slice(i, i + 4));
      await (this.slow ? new Promise((r) => setTimeout(r, 1)) : Promise.resolve());
    }
    return { hitLimit };
  }
}

/** Stream a call through a model and collect what a consumer reads: reasoning, text, tool calls and the finish reason. */
async function events(result: { fullStream: AsyncIterable<TextStreamPart<ToolSet>> }) {
  const out: unknown[] = [];
  for await (const p of result.fullStream) {
    if (p.type === "text-delta" || p.type === "reasoning-delta") out.push({ type: p.type === "text-delta" ? "text" : "reasoning", text: p.text });
    else if (p.type === "tool-call") out.push({ type: "tool-call", name: p.toolName, input: p.input });
    else if (p.type === "finish") out.push({ type: "finish", reason: p.finishReason });
    else if (p.type === "error") throw p.error;
  }
  return out;
}
const joined = (es: readonly unknown[], type: "text" | "reasoning") => es.map((e) => ((e as { type: string }).type === type ? (e as { text: string }).text : "")).join("");

describe("vision chat model on transformers.js", () => {
  it("VG1.1 converts messages and images for the chat template and streams parsed parts", async () => {
    const backend = new ScriptedChatBackend(() => ({ text: "<think>look</think>A cat.<|im_end|>" }));
    const model = visionChatModel(backend, { modelId: "vision", maxTokens: 64 });
    expect([model.provider, model.modelId]).toEqual(["harness.local", "vision"]);
    const png = new Uint8Array([1]);
    const out = await events(
      streamText({
        model,
        maxRetries: 0,
        system: "Be brief.",
        messages: [{ role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image", image: png, mediaType: "image/png" }] }],
      }),
    );
    expect(backend.requests[0]).toEqual({
      messages: [
        { role: "system", content: [{ type: "text", text: "Be brief." }] },
        { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image" }] },
      ],
      images: [{ mediaType: "image/png", data: png }],
      tools: [],
      maxTokens: 64,
    });
    expect(out[0]).toEqual({ type: "reasoning", text: "look" });
    expect(joined(out, "reasoning")).toBe("look");
    expect(joined(out, "text")).toBe("A cat.");
    expect(out.at(-1)).toEqual({ type: "finish", reason: "stop" });
  });

  it("VG1.2 tool calls in the output finish the turn as tool-calls; hitting the token limit finishes as length", async () => {
    const tools = toolSet([{ name: "get_weather", description: "w", parameters: {} }]);
    const withCall = visionChatModel(new ScriptedChatBackend(() => ({ text: "<tool_call>\n<function=get_weather>\n<parameter=city>\nLagos\n</parameter>\n</function>\n</tool_call>" })), { modelId: "vision" });
    expect(await events(streamText({ model: withCall, prompt: "weather?", tools, maxRetries: 0 }))).toEqual([
      { type: "tool-call", name: "get_weather", input: { city: "Lagos" } },
      { type: "finish", reason: "tool-calls" },
    ]);
    const cut = visionChatModel(new ScriptedChatBackend(() => ({ text: "one two", hitLimit: true })), { modelId: "vision" });
    expect((await events(streamText({ model: cut, prompt: "count", maxRetries: 0 }))).at(-1)).toEqual({ type: "finish", reason: "length" });
  });

  it("VG1.3 the offered tools, assistant tool calls and tool results are passed to the template", async () => {
    const backend = new ScriptedChatBackend(() => ({ text: "It is sunny." }));
    const { text } = await generateText({
      model: visionChatModel(backend, { modelId: "vision" }),
      maxRetries: 0,
      tools: toolSet([{ name: "get_weather", description: "w", parameters: { type: "object" } }]),
      messages: [
        { role: "user", content: "weather in Lagos?" },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "get_weather", input: { city: "Lagos" } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "get_weather", output: { type: "json", value: { sky: "clear" } } }] },
      ],
    });
    expect(text).toBe("It is sunny.");
    expect(backend.requests[0]!.messages.slice(1)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "" }], tool_calls: [{ type: "function", function: { name: "get_weather", arguments: { city: "Lagos" } } }] },
      { role: "tool", name: "get_weather", content: [{ type: "text", text: '{"sky":"clear"}' }] },
    ]);
    expect(backend.requests[0]!.tools).toEqual([{ name: "get_weather", description: "w", parameters: expect.objectContaining({ type: "object" }) }]);
  });

  it("VG1.4 aborting the call stops generation", async () => {
    const backend = new ScriptedChatBackend(() => ({ text: "a long long long long long long long long long long long reply" }), { slow: true });
    const abort = new AbortController();
    const result = streamText({ model: visionChatModel(backend, { modelId: "vision" }), prompt: "go", abortSignal: abort.signal, maxRetries: 0 });
    for await (const _ of result.textStream) break;
    abort.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(backend.stopped).toBe(1);
  });

  it("VG1.5 a backend failure surfaces as an error from the stream and from generate", async () => {
    const backend: ChatBackend = { generate: async () => Promise.reject(new Error("onnx session crashed")) };
    const model = visionChatModel(backend, { modelId: "vision" });
    await expect(events(streamText({ model, prompt: "x", maxRetries: 0, onError: () => {} }))).rejects.toThrow(/onnx session crashed/);
    await expect(generateText({ model, prompt: "x", maxRetries: 0 })).rejects.toThrow(/onnx session crashed/);
  });

  it("VG1.6 a constrained call is decoded under its constraint: ours from provider options, or a JSON response format", async () => {
    const backend = new ScriptedChatBackend(() => ({ text: '{"n":4}' }));
    const model = visionChatModel(backend, { modelId: "vision" });
    await generateText({ model, prompt: "a", maxRetries: 0, ...constrain({ type: "regex", pattern: "[0-9]+" }) });
    expect(backend.requests[0]!.constraint).toEqual({ type: "regex", pattern: "[0-9]+" });
    const { output } = await generateText({ model, prompt: "a", maxRetries: 0, output: Output.object({ schema: jsonSchema<{ n: number }>({ type: "object", properties: { n: { type: "integer" } } }) }) });
    expect(output).toEqual({ n: 4 });
    expect(backend.requests[1]!.constraint).toMatchObject({ type: "json-schema", schema: { type: "object", properties: { n: { type: "integer" } } } });
    await generateText({ model, prompt: "a", maxRetries: 0 });
    expect(backend.requests[2]).not.toHaveProperty("constraint");
  });

  it("VG1.7 the call's token budget overrides the model's, which defaults to 512", async () => {
    const backend = new ScriptedChatBackend(() => ({ text: "ok" }));
    await generateText({ model: visionChatModel(backend, { modelId: "vision", maxTokens: 64 }), prompt: "a", maxOutputTokens: 8, maxRetries: 0 });
    await generateText({ model: visionChatModel(backend, { modelId: "vision" }), prompt: "a", maxRetries: 0 });
    expect(backend.requests.map((r) => r.maxTokens)).toEqual([8, 512]);
  });
});

generatorContract("vision chat model over a scripted backend", () =>
  visionChatModel(new ScriptedChatBackend((r) => ({ text: r.tools.length ? '<tool_call>{"name":"get_weather","arguments":{"city":"Lagos"}}</tool_call>' : "Paris" })), { modelId: "vision" }),
);

const page = (n: number) => ({ mediaType: "image/png", data: new Uint8Array(n) });
const parse = (model: LanguageModelV4, p: { mediaType: string; data: Uint8Array }) => generateText({ model, maxRetries: 0, messages: [{ role: "user", content: [{ type: "file", data: p.data, mediaType: p.mediaType }] }] });

describe("vision chat model as a document parser", () => {
  it("VD1.1 sends each page image alone, with the catalog's instruction when given, and returns its Markdown", async () => {
    const backend = new ScriptedChatBackend((r) => ({ text: `# Page with ${r.images[0]!.data.length} bytes<|im_end|>` }));
    const model = visionChatModel(backend, { modelId: "ocr", maxTokens: 1024 });
    expect((await parse(model, page(3))).text).toBe("# Page with 3 bytes");
    expect((await parse(model, page(5))).text).toBe("# Page with 5 bytes");
    expect(backend.requests[0]).toEqual({ messages: [{ role: "user", content: [{ type: "image" }] }], images: [page(3)], tools: [], maxTokens: 1024 });
    await parse(wrapLanguageModel({ model, middleware: pageInstruction("Extract the tables.") }), page(1));
    expect(backend.requests[2]!.messages[0]!.content).toEqual([{ type: "image" }, { type: "text", text: "Extract the tables." }]);
  });
});

documentParserContract("vision chat model over a scripted backend", () => visionChatModel(new ScriptedChatBackend((r) => ({ text: `# ${r.images.length} page` })), { modelId: "ocr" }), async () => page(4));
