import type { EmbeddingModelV4, LanguageModelV4 } from "@ai-sdk/provider";
import { dimensions, HARNESS, ProbabilitySchema, StreamParts } from "@harness/cognitive";
import type { Dimensions, Probability, ToolCall } from "@harness/cognitive";
import { localLanguageModel, templateOf } from "./local-model.ts";

/** The parts of a Cactus Emscripten module the engine uses; the C API is reached by name through ccall. */
export interface CactusModule {
  readonly HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  UTF8ToString(ptr: number): string;
  ccall(name: string, returnType: "number" | null, argTypes: string[], args: unknown[]): number;
}

const OUT_CAPACITY = 1 << 16;
const MAX_NEW_TOKENS = 256;

interface CactusReply {
  readonly success?: unknown;
  readonly error?: unknown;
  readonly function_calls?: unknown;
  readonly reasoning?: unknown;
  readonly confidence?: unknown;
}

/**
 * A tool-calling model on Cactus's WebAssembly engine, in Node and browsers: tool routing
 * with a calibrated confidence, and text embeddings. The engine's C API is named by a
 * prefix (`<prefix>_load`, `_init`, `_reset`, `_complete`, `_embed`) from the catalog.
 * The engine is a single global, non-thread-safe instance that remembers the
 * conversation, so every request resets it: requests are independent. Calls into the
 * module are synchronous, so requests cannot interleave.
 */
export class CactusWasmEngine {
  readonly #m: CactusModule;
  readonly #api: (name: string) => string;
  readonly #out: number;
  readonly dimensions: Dimensions;
  #tools: string | undefined;

  private constructor(m: CactusModule, prefix: string) {
    this.#m = m;
    this.#api = (name) => `${prefix}_${name}`;
    this.#out = m._malloc(OUT_CAPACITY);
    this.dimensions = dimensions(m.ccall(this.#api("embed"), "number", ["string", "number", "number"], ["", 0, 0]));
  }

  static async create(module: CactusModule, weights: Uint8Array, prefix: string): Promise<CactusWasmEngine> {
    // Loading takes a 64-bit length, which ccall cannot pass: call the export directly.
    const load = (module as unknown as Record<string, unknown>)[`_${prefix}_load`];
    if (typeof load !== "function") throw new Error(`the module exports no _${prefix}_load`);
    const ptr = module._malloc(weights.length);
    module.HEAPU8.set(weights, ptr);
    const status = (load as (ptr: number, bytes: bigint) => number).call(module, ptr, BigInt(weights.length));
    if (status !== 0) throw new Error(`${prefix}_load failed with status ${status}`);
    return new CactusWasmEngine(module, prefix);
  }

  /** The last user message's text routed over `tools`: calls, calibrated confidence and reasoning. */
  #route(input: string, tools: readonly { name: string; description: string; parameters: unknown }[]): { calls: ToolCall[]; confidence: Probability; reasoning: string } {
    if (tools.length === 0) return { calls: [], confidence: ProbabilitySchema.parse(1), reasoning: "no tools offered" };
    const json = JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })));
    if (json !== this.#tools) {
      const status = this.#m.ccall(this.#api("init"), "number", ["string", "string", "string"], ["", json, ""]);
      if (status < 0) throw new Error(`${this.#api("init")} failed with status ${status} (tool schemas may not fit the context)`);
      this.#tools = json;
    }
    this.#m.ccall(this.#api("reset"), null, [], []);
    const status = this.#m.ccall(this.#api("complete"), "number", ["string", "number", "number", "number"], [input, MAX_NEW_TOKENS, this.#out, OUT_CAPACITY]);
    if (status < 0) throw new Error(`${this.#api("complete")} failed with status ${status}`);
    return parseReply(this.#m.UTF8ToString(this.#out));
  }

  #embed(texts: readonly string[]): number[][] {
    const ptr = this.#m._malloc(this.dimensions * 4);
    try {
      return texts.map((text) => {
        const n = this.#m.ccall(this.#api("embed"), "number", ["string", "number", "number"], [text, ptr, this.dimensions]);
        if (n !== this.dimensions) throw new Error(`${this.#api("embed")} returned ${n}, expected ${this.dimensions}`);
        // Copy out before viewing as floats: the heap may grow (new buffer) on the next call.
        const v = new Float32Array(this.#m.HEAPU8.slice(ptr, ptr + this.dimensions * 4).buffer);
        const norm = Math.hypot(...v);
        return Array.from(norm === 0 ? v : v.map((x) => x / norm));
      });
    } finally {
      this.#m._free(ptr);
    }
  }

  /**
   * The engine as an AI SDK language model that routes: the last user message over the
   * call's tools, answered with tool calls, its reasoning, and the calibrated confidence
   * as provider metadata (`harness.confidence`).
   */
  router(modelId: string): LanguageModelV4 {
    const route = (options: Parameters<LanguageModelV4["doGenerate"]>[0]) => {
      const { messages, tools } = templateOf(options);
      const last = [...messages].reverse().find((m) => m.role === "user");
      return this.#route(last ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("") : "", tools);
    };
    return localLanguageModel({
      provider: "harness.local",
      modelId,
      async *run(options) {
        const r = route(options);
        const parts = new StreamParts();
        yield { type: "stream-start", warnings: [] };
        yield* parts.push({ type: "reasoning", text: r.reasoning });
        for (const call of r.calls) yield* parts.push({ type: "tool-call", call });
        yield* parts.end({ providerMetadata: { [HARNESS]: { confidence: r.confidence } } });
      },
    });
  }

  /** The engine as an AI SDK embedding model (it embeds text as given; its size is fixed). */
  embedder(modelId: string): EmbeddingModelV4 {
    return {
      specificationVersion: "v4",
      provider: "harness.local",
      modelId,
      maxEmbeddingsPerCall: undefined,
      supportsParallelCalls: false,
      doEmbed: async ({ values }) => ({ embeddings: this.#embed(values), warnings: [] }),
    };
  }
}

function parseReply(text: string): { calls: ToolCall[]; confidence: Probability; reasoning: string } {
  const reply = JSON.parse(text) as CactusReply;
  if (reply.success !== true) throw new Error(`the model could not route: ${typeof reply.error === "string" ? reply.error : text}`);
  const confidence = ProbabilitySchema.safeParse(reply.confidence);
  if (!confidence.success) throw new Error(`the model returned an invalid confidence: ${String(reply.confidence)}`);
  const calls = Array.isArray(reply.function_calls) ? reply.function_calls : [];
  return {
    calls: calls.map((c: { name: string; arguments?: Record<string, unknown> }) => ({ name: c.name, arguments: c.arguments ?? {} })),
    confidence: confidence.data,
    reasoning: typeof reply.reasoning === "string" ? reply.reasoning : "",
  };
}
