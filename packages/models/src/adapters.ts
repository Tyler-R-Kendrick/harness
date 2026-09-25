import type { EmbeddingModelV4, LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { ChatStreamParser, chunkTokens, compressWords, constraintOf, embeddingPrompt, embedInputs, StreamParts, truncateEmbedding, wordsFromTokens } from "@harness/cognitive";
import type { Compression, CompressionConfig, CompressRequest, Compressor, Constraint, EmbeddingConfig, ImageInput } from "@harness/cognitive";
import { localLanguageModel, templateOf } from "./local-model.ts";
import type { TemplateMessage, TemplateTool } from "./local-model.ts";

// ---- embedding models ----------------------------------------------------------------

/** Runs an embedding model on already-prompted texts; returns unit vectors of its native size. */
export interface EmbeddingBackend {
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/**
 * An embedding model, as an AI SDK embedding model, that is prompted per input kind
 * (query or document, from our embedding options) and truncates to the sizes it was
 * trained for, both from its catalog entry.
 */
export function promptedEmbeddingModel(backend: EmbeddingBackend, config: EmbeddingConfig, options: { readonly modelId: string; readonly batchSize?: number }): EmbeddingModelV4 {
  const native = config.dimensions[0]!;
  const batch = options.batchSize ?? 16;
  return {
    specificationVersion: "v4",
    provider: "harness.local",
    modelId: options.modelId,
    maxEmbeddingsPerCall: undefined,
    supportsParallelCalls: false,
    doEmbed: async ({ values, providerOptions }) => {
      const { inputs, dimensions: size = native } = embedInputs(values, providerOptions);
      if (!config.dimensions.includes(size)) throw new Error(`the model embeds in ${config.dimensions.join(", ")} dimensions, not ${size}`);
      const prompts = inputs.map((input) => embeddingPrompt(config, input));
      const out: Float32Array[] = [];
      for (let i = 0; i < prompts.length; i += batch) out.push(...(await backend.embed(prompts.slice(i, i + batch))));
      return { embeddings: out.map((v) => Array.from(size === native ? v : truncateEmbedding(v, size))), warnings: [] };
    },
  };
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

/** One generation: messages in the chat template's shape, images in order of their placeholders. */
export interface ChatBackendRequest {
  readonly messages: readonly TemplateMessage[];
  readonly images: readonly ImageInput[];
  readonly tools: readonly TemplateTool[];
  readonly maxTokens: number;
  readonly constraint?: Constraint;
}

export interface ChatBackend {
  /** Streams decoded text (special tokens included) to onText; stops early when shouldStop() turns true. */
  generate(request: ChatBackendRequest, onText: (delta: string) => void, shouldStop: () => boolean): Promise<{ hitLimit: boolean }>;
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

/**
 * A chat model with vision (in the browser and natively) as an AI SDK language model:
 * the chat template renders the prompt, the decoded text is parsed into reasoning,
 * text and tool calls, and a constrained call (ours or a JSON response format) is
 * decoded under its constraint. Document parsers are these too.
 */
export function visionChatModel(backend: ChatBackend, options: { readonly modelId: string; readonly maxTokens?: number }): LanguageModelV4 {
  return localLanguageModel({
    provider: "harness.local",
    modelId: options.modelId,
    async *run(call) {
      const { messages, images, tools } = templateOf(call);
      const constraint = constraintOf(call);
      const text = stream(backend, { messages, images, tools, maxTokens: call.maxOutputTokens ?? options.maxTokens ?? 512, ...(constraint ? { constraint } : {}) });
      const parser = new ChatStreamParser();
      const parts = new StreamParts();
      yield { type: "stream-start", warnings: [] } satisfies LanguageModelV4StreamPart;
      let result: IteratorResult<string, { hitLimit: boolean }>;
      try {
        while (!(result = await text.next()).done) for (const e of parser.push(result.value)) yield* parts.push(e);
      } finally {
        // Closing the inner stream tells the backend to stop when the consumer leaves early.
        await text.return({ hitLimit: false });
      }
      for (const e of parser.end()) yield* parts.push(e);
      yield* parts.end({ length: result.value.hitLimit });
    },
  });
}
