import { describe, expect, it } from "vitest";
import { EmbeddingGemmaEmbedder, LinguaCompressor, VisionChatDocumentParser, VisionChatGenerator } from "@harness/models";
import type { ChatBackend, ChatBackendRequest, EmbeddingBackend, TokenClassifierBackend } from "@harness/models";
import type { GenerationEvent } from "@harness/cognitive";
import { compressorContract, embedderContract, generatorContract, HashEmbedder } from "@harness/testkit";

async function collect(stream: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const out: GenerationEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

class RecordingEmbeddingBackend implements EmbeddingBackend {
  readonly batches: string[][] = [];
  readonly #inner = new HashEmbedder(768);
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.batches.push([...texts]);
    const sparse = await this.#inner.embed(texts.map((text) => ({ kind: "document" as const, text: text.replace(/^(task: [^|]+\| query: |title: [^|]+\| text: )/, "") })));
    // Real EmbeddingGemma vectors are dense; add a small floor so every prefix is non-zero.
    return sparse.map((v) => {
      const dense = v.map((x) => x + 0.01);
      const n = Math.hypot(...dense);
      return dense.map((x) => x / n);
    });
  }
}

describe("EmbeddingGemma adapter", () => {
  it("EA1.1 prefixes queries and documents as EmbeddingGemma was trained, and batches requests", async () => {
    const backend = new RecordingEmbeddingBackend();
    const e = new EmbeddingGemmaEmbedder(backend, { batchSize: 2 });
    await e.embed([
      { kind: "query", text: "red planet?" },
      { kind: "document", text: "Mars.", title: "Planets" },
      { kind: "query", text: "code", task: "code retrieval" },
    ]);
    expect(backend.batches).toEqual([["task: search result | query: red planet?", "title: Planets | text: Mars."], ["task: code retrieval | query: code"]]);
  });

  it("EA1.2 truncates to a Matryoshka size and rejects sizes the model was not trained for", async () => {
    const e = new EmbeddingGemmaEmbedder(new RecordingEmbeddingBackend());
    const [v] = await e.embed([{ kind: "document", text: "hello" }], { dimensions: 256 });
    expect(v!.length).toBe(256);
    expect(Math.hypot(...v!)).toBeCloseTo(1, 5);
    await expect(e.embed([{ kind: "document", text: "hello" }], { dimensions: 300 })).rejects.toThrow(/768, 512, 256, 128/);
  });
});

embedderContract("EmbeddingGemma adapter over a hashing backend", () => new EmbeddingGemmaEmbedder(new RecordingEmbeddingBackend()), { sizes: [512, 128] });

/** A WordPiece-ish tokenizer with a classifier that scores stopwords low. */
class FakeClassifier implements TokenClassifierBackend {
  readonly style = "wordpiece" as const;
  readonly chunks: number[] = [];
  tokenize(text: string): string[] {
    return text.split(/\s+/).filter(Boolean).flatMap((w) => (w.length > 6 ? [w.slice(0, 4), `##${w.slice(4)}`] : [w]));
  }
  async keepProbabilities(tokens: readonly string[]): Promise<number[]> {
    this.chunks.push(tokens.length);
    return tokens.map((t) => (/^(the|and|is|for|in|at|to|be|on|of|a)$/i.test(t) ? 0.05 : t.startsWith("##") ? 0.7 : 0.8));
  }
}

describe("LLMLingua-2 adapter", () => {
  it("LA1.1 scores tokens, rebuilds words and keeps the ones above the rate's threshold", async () => {
    const c = new LinguaCompressor(new FakeClassifier());
    // 14 tokens, 5 of them stopwords: keeping 70% drops exactly the stopwords.
    const r = await c.compress({ text: "Meeting is scheduled for Thursday at noon in the boardroom", rate: 0.7 });
    expect(r.text).toBe("Meeting scheduled Thursday noon boardroom");
    expect(r.originalTokens).toBe(14);
    expect(r.compressedTokens).toBeLessThan(r.originalTokens);
  });

  it("LA1.2 long inputs are classified in windows the encoder can take", async () => {
    const classifier = new FakeClassifier();
    const c = new LinguaCompressor(classifier, { window: 4 });
    await c.compress({ text: "one two three . four five six seven . eight", rate: 0.5 });
    expect(classifier.chunks).toEqual([4, 4, 2]);
  });
});

compressorContract("LLMLingua-2 adapter over a fake classifier", () => new LinguaCompressor(new FakeClassifier()));

class ScriptedChatBackend implements ChatBackend {
  readonly requests: ChatBackendRequest[] = [];
  stopped = 0;
  readonly reply: (r: ChatBackendRequest) => { text: string; hitLimit?: boolean };
  constructor(reply: (r: ChatBackendRequest) => { text: string; hitLimit?: boolean }) {
    this.reply = reply;
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
      await Promise.resolve();
    }
    return { hitLimit };
  }
}

describe("vision chat generator (Qwen3.5 on transformers.js)", () => {
  it("VG1.1 converts messages and images for the chat template and streams parsed events", async () => {
    const backend = new ScriptedChatBackend(() => ({ text: "<think>look</think>A cat.<|im_end|>" }));
    const g = new VisionChatGenerator(backend, { maxTokens: 64 });
    const image = { mediaType: "image/png", data: new Uint8Array([1]) };
    const events = await collect(
      g.generate({
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image", image }] },
        ],
      }),
    );
    expect(backend.requests[0]).toEqual({
      messages: [
        { role: "system", content: [{ type: "text", text: "Be brief." }] },
        { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image" }] },
      ],
      images: [image],
      tools: [],
      maxTokens: 64,
    });
    expect(events[0]).toEqual({ type: "reasoning", text: "look" });
    expect(events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : "")).join("")).toBe("A cat.");
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
  });

  it("VG1.2 tool calls in the output finish the turn as tool-calls; hitting the token limit finishes as length", async () => {
    const tools = [{ name: "get_weather", description: "w", parameters: {} }];
    const withCall = new VisionChatGenerator(new ScriptedChatBackend(() => ({ text: "<tool_call>\n<function=get_weather>\n<parameter=city>\nLagos\n</parameter>\n</function>\n</tool_call>" })));
    const events = await collect(withCall.generate({ messages: [{ role: "user", content: "weather?" }], tools }));
    expect(events).toEqual([{ type: "tool-call", call: { name: "get_weather", arguments: { city: "Lagos" } } }, { type: "finish", reason: "tool-calls" }]);
    const cut = new VisionChatGenerator(new ScriptedChatBackend(() => ({ text: "one two", hitLimit: true })));
    expect((await collect(cut.generate({ messages: [{ role: "user", content: "count" }] }))).at(-1)).toEqual({ type: "finish", reason: "length" });
  });

  it("VG1.3 assistant tool calls and tool results are passed back to the template", async () => {
    const backend = new ScriptedChatBackend(() => ({ text: "It is sunny." }));
    await collect(
      new VisionChatGenerator(backend).generate({
        messages: [
          { role: "user", content: "weather in Lagos?" },
          { role: "assistant", content: "", toolCalls: [{ name: "get_weather", arguments: { city: "Lagos" } }] },
          { role: "tool", name: "get_weather", content: '{"sky":"clear"}' },
        ],
      }),
    );
    expect(backend.requests[0]!.messages.slice(1)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "" }], tool_calls: [{ type: "function", function: { name: "get_weather", arguments: { city: "Lagos" } } }] },
      { role: "tool", name: "get_weather", content: [{ type: "text", text: '{"sky":"clear"}' }] },
    ]);
  });

  it("VG1.4 breaking out of the stream stops generation", async () => {
    const backend = new ScriptedChatBackend(() => ({ text: "a long long long long long reply" }));
    for await (const _ of new VisionChatGenerator(backend).generate({ messages: [{ role: "user", content: "go" }] })) break;
    await new Promise((r) => setTimeout(r, 10));
    expect(backend.stopped).toBe(1);
  });

  it("VG1.5 a backend failure surfaces as an error from the stream", async () => {
    const backend: ChatBackend = { generate: async () => Promise.reject(new Error("onnx session crashed")) };
    await expect(collect(new VisionChatGenerator(backend).generate({ messages: [{ role: "user", content: "x" }] }))).rejects.toThrow(/onnx session crashed/);
  });
});

generatorContract("vision chat generator over a scripted backend", () =>
  new VisionChatGenerator(new ScriptedChatBackend((r) => ({ text: r.tools.length ? "<tool_call>{\"name\":\"get_weather\",\"arguments\":{\"city\":\"Lagos\"}}</tool_call>" : "Paris" }))),
);

describe("vision chat document parser (LightOnOCR-2 on transformers.js)", () => {
  it("VD1.1 sends each page image alone, with the instruction when given, and returns its Markdown", async () => {
    const backend = new ScriptedChatBackend((r) => ({ text: `# Page with ${r.images[0]!.data.length} bytes<|im_end|>` }));
    const parser = new VisionChatDocumentParser(backend, { maxTokens: 1024 });
    const page = (n: number) => ({ mediaType: "image/png", data: new Uint8Array(n) });
    const result = await parser.parse({ pages: [page(3), page(5)] });
    expect(result.pages.map((p) => p.markdown)).toEqual(["# Page with 3 bytes", "# Page with 5 bytes"]);
    expect(backend.requests[0]).toEqual({ messages: [{ role: "user", content: [{ type: "image" }] }], images: [page(3)], tools: [], maxTokens: 1024 });
    await parser.parse({ pages: [page(1)], instruction: "Extract the tables." });
    expect(backend.requests[2]!.messages[0]!.content).toEqual([{ type: "image" }, { type: "text", text: "Extract the tables." }]);
  });
});
