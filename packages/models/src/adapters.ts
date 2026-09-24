import { ChatStreamParser, chunkTokens, compressWords, embeddingPrompt, parseChatOutput, truncateEmbedding, wordsFromTokens } from "@harness/cognitive";
import type {
  ChatMessage,
  Compression,
  CompressionConfig,
  CompressRequest,
  Compressor,
  DocumentParser,
  Embedder,
  EmbeddingConfig,
  EmbedInput,
  GenerateRequest,
  GenerationEvent,
  Generator,
  ImageInput,
  ParsedPage,
  ParseRequest,
  ToolSpec,
} from "@harness/cognitive";

// ---- embedding models ----------------------------------------------------------------

/** Runs an embedding model on already-prompted texts; returns unit vectors of its native size. */
export interface EmbeddingBackend {
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/**
 * An embedding model that is prompted per input kind (query or document) and truncates
 * to the sizes it was trained for, both from its catalog entry.
 */
export class PromptedEmbedder implements Embedder {
  readonly dimensions: number;
  readonly #backend: EmbeddingBackend;
  readonly #config: EmbeddingConfig;
  readonly #batchSize: number;

  constructor(backend: EmbeddingBackend, config: EmbeddingConfig, options: { batchSize?: number } = {}) {
    this.#backend = backend;
    this.#config = config;
    this.dimensions = config.dimensions[0]!;
    this.#batchSize = options.batchSize ?? 16;
  }

  async embed(inputs: readonly EmbedInput[], options: { readonly dimensions?: number } = {}): Promise<Float32Array[]> {
    const size = options.dimensions ?? this.dimensions;
    if (!this.#config.dimensions.includes(size)) throw new Error(`the model embeds in ${this.#config.dimensions.join(", ")} dimensions, not ${size}`);
    const prompts = inputs.map((input) => embeddingPrompt(this.#config, input));
    const out: Float32Array[] = [];
    for (let i = 0; i < prompts.length; i += this.#batchSize) out.push(...(await this.#backend.embed(prompts.slice(i, i + this.#batchSize))));
    return size === this.dimensions ? out : out.map((v) => truncateEmbedding(v, size));
  }
}

// ---- token-classification compressors ------------------------------------------------

/** The token classifier: subword tokens of a text, and P(keep) for each token in a window. */
export interface TokenClassifierBackend {
  tokenize(text: string): readonly string[];
  keepProbabilities(tokens: readonly string[]): Promise<readonly number[]>;
}

/**
 * Prompt compression by a token classifier: it scores every token, windows (the model's
 * context, from its catalog entry) are thresholded separately, and the surviving words
 * are joined in order.
 */
export class TokenClassifierCompressor implements Compressor {
  readonly #backend: TokenClassifierBackend;
  readonly #config: CompressionConfig;
  readonly #keepDigits: boolean;

  constructor(backend: TokenClassifierBackend, config: CompressionConfig, options: { keepDigits?: boolean } = {}) {
    this.#backend = backend;
    this.#config = config;
    this.#keepDigits = options.keepDigits ?? false;
  }

  async compress(request: CompressRequest): Promise<Compression> {
    const tokens = this.#backend.tokenize(request.text);
    const kept: string[] = [];
    let compressedTokens = 0;
    for (const [start, end] of chunkTokens(tokens, this.#config.window)) {
      const window = tokens.slice(start, end);
      const probs = await this.#backend.keepProbabilities(window);
      const words = wordsFromTokens(
        window.map((text, i) => ({ text, keep: probs[i]!, special: false })),
        this.#config.subwords,
      );
      for (const w of compressWords(words, { rate: request.rate, keepDigits: this.#keepDigits, ...(request.forceTokens ? { forceTokens: request.forceTokens } : {}) })) {
        kept.push(w.text);
        compressedTokens += w.tokens;
      }
    }
    return { text: kept.join(" "), originalTokens: tokens.length, compressedTokens };
  }
}

// ---- vision chat models on transformers.js ---------------------------------------------

export type TemplatePart = { readonly type: "text"; readonly text: string } | { readonly type: "image" };

export interface TemplateMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: readonly TemplatePart[];
  readonly name?: string;
  readonly tool_calls?: readonly { readonly type: "function"; readonly function: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> } }[];
}

/** One generation: messages in the chat template's shape, images in order of their placeholders. */
export interface ChatBackendRequest {
  readonly messages: readonly TemplateMessage[];
  readonly images: readonly ImageInput[];
  readonly tools: readonly ToolSpec[];
  readonly maxTokens: number;
}

export interface ChatBackend {
  /** Streams decoded text (special tokens included) to onText; stops early when shouldStop() turns true. */
  generate(request: ChatBackendRequest, onText: (delta: string) => void, shouldStop: () => boolean): Promise<{ hitLimit: boolean }>;
}

function toTemplate(messages: readonly ChatMessage[]): { messages: TemplateMessage[]; images: ImageInput[] } {
  const images: ImageInput[] = [];
  const text = (t: string): TemplatePart[] => [{ type: "text", text: t }];
  const out = messages.map((m): TemplateMessage => {
    switch (m.role) {
      case "system":
        return { role: "system", content: text(m.content) };
      case "user":
        return {
          role: "user",
          content:
            typeof m.content === "string"
              ? text(m.content)
              : m.content.map((p): TemplatePart => {
                  if (p.type === "text") return p;
                  images.push(p.image);
                  return { type: "image" };
                }),
        };
      case "assistant":
        return {
          role: "assistant",
          content: text(m.content),
          ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ type: "function" as const, function: { name: c.name, arguments: c.arguments } })) } : {}),
        };
      case "tool":
        return { role: "tool", name: m.name, content: text(m.content) };
    }
  });
  return { messages: out, images };
}

/** Bridge a callback-style backend into an async iterator, stopping the backend if the consumer leaves. */
async function* stream(backend: ChatBackend, request: ChatBackendRequest): AsyncGenerator<string, { hitLimit: boolean }> {
  const pending: string[] = [];
  let wake: (() => void) | undefined;
  let stop = false;
  let settled: { ok: true; value: { hitLimit: boolean } } | { ok: false; error: unknown } | undefined;
  void backend.generate(
    request,
    (delta) => {
      pending.push(delta);
      wake?.();
    },
    () => stop,
  ).then(
    (value) => ((settled = { ok: true, value }), wake?.()),
    (error: unknown) => ((settled = { ok: false, error }), wake?.()),
  );
  try {
    for (;;) {
      while (pending.length > 0) yield pending.shift()!;
      if (settled) break;
      await new Promise<void>((resolve) => (wake = resolve));
      wake = undefined;
    }
    if (!settled.ok) throw settled.error;
    return settled.value;
  } finally {
    stop = true;
  }
}

/** A chat model with vision, in the browser and natively, as a cognitive Generator. */
export class VisionChatGenerator implements Generator {
  readonly #backend: ChatBackend;
  readonly #maxTokens: number;

  constructor(backend: ChatBackend, options: { maxTokens?: number } = {}) {
    this.#backend = backend;
    this.#maxTokens = options.maxTokens ?? 512;
  }

  async *generate(request: GenerateRequest): AsyncIterable<GenerationEvent> {
    const { messages, images } = toTemplate(request.messages);
    const text = stream(this.#backend, { messages, images, tools: request.tools ?? [], maxTokens: request.maxTokens ?? this.#maxTokens });
    const parser = new ChatStreamParser();
    let calls = 0;
    let result: IteratorResult<string, { hitLimit: boolean }>;
    try {
      while (!(result = await text.next()).done) {
        for (const e of parser.push(result.value)) {
          if (e.type === "tool-call") calls++;
          yield e;
        }
      }
    } finally {
      // Closing the inner stream tells the backend to stop when the consumer leaves early.
      await text.return({ hitLimit: false });
    }
    for (const e of parser.end()) {
      if (e.type === "tool-call") calls++;
      yield e;
    }
    yield { type: "finish", reason: calls > 0 ? "tool-calls" : result.value.hitLimit ? "length" : "stop" };
  }
}

/** A page-to-Markdown vision model as a cognitive DocumentParser: one page per generation. */
export class VisionChatDocumentParser implements DocumentParser {
  readonly #backend: ChatBackend;
  readonly #maxTokens: number;

  constructor(backend: ChatBackend, options: { maxTokens?: number } = {}) {
    this.#backend = backend;
    this.#maxTokens = options.maxTokens ?? 4096;
  }

  async parse(request: ParseRequest): Promise<{ readonly pages: readonly ParsedPage[] }> {
    const pages: ParsedPage[] = [];
    for (const page of request.pages) {
      const content: TemplatePart[] = [{ type: "image" }, ...(request.instruction ? [{ type: "text" as const, text: request.instruction }] : [])];
      let raw = "";
      await this.#backend.generate({ messages: [{ role: "user", content }], images: [page], tools: [], maxTokens: this.#maxTokens }, (d) => (raw += d), () => false);
      pages.push({ markdown: parseChatOutput(raw).text, raw });
    }
    return { pages };
  }
}
