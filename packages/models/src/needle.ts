import type { Embedder, EmbedInput, RouteRequest, Routing, ToolRouter } from "@harness/cognitive";

/** The parts of the Emscripten module in Needle 3's wasm/needle.js that the adapter uses. */
export interface NeedleModule {
  readonly HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _needle_load(ptr: number, bytes: bigint): number;
  UTF8ToString(ptr: number): string;
  ccall(name: string, returnType: "number" | null, argTypes: string[], args: unknown[]): number;
}

const OUT_CAPACITY = 1 << 16;
const MAX_NEW_TOKENS = 256;

interface NeedleReply {
  readonly success?: unknown;
  readonly error?: unknown;
  readonly function_calls?: unknown;
  readonly reasoning?: unknown;
  readonly confidence?: unknown;
}

/**
 * Needle 3 (Cactus Compute): tool routing with a calibrated confidence, and text
 * embeddings, from one ~35 MB model running in WebAssembly in Node and browsers.
 * The engine is a single global, non-thread-safe instance that remembers the
 * conversation, so every request resets it: requests are independent. Calls into
 * the module are synchronous, so requests cannot interleave.
 */
export class NeedleEngine implements ToolRouter, Embedder {
  readonly #m: NeedleModule;
  readonly #out: number;
  readonly dimensions: number;
  #tools: string | undefined;

  private constructor(m: NeedleModule) {
    this.#m = m;
    this.#out = m._malloc(OUT_CAPACITY);
    this.dimensions = m.ccall("needle_embed", "number", ["string", "number", "number"], ["", 0, 0]);
  }

  static async create(module: NeedleModule, weights: Uint8Array): Promise<NeedleEngine> {
    const ptr = module._malloc(weights.length);
    module.HEAPU8.set(weights, ptr);
    const status = module._needle_load(ptr, BigInt(weights.length));
    if (status !== 0) throw new Error(`needle_load failed with status ${status}`);
    return new NeedleEngine(module);
  }

  async route(request: RouteRequest): Promise<Routing> {
    if (request.tools.length === 0) return { calls: [], confidence: 1, reasoning: "no tools offered" };
    const tools = JSON.stringify(request.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })));
    if (tools !== this.#tools) {
      const status = this.#m.ccall("needle_init", "number", ["string", "string", "string"], ["", tools, ""]);
      if (status < 0) throw new Error(`needle_init failed with status ${status} (tool schemas may not fit the context)`);
      this.#tools = tools;
    }
    this.#m.ccall("needle_reset", null, [], []);
    const status = this.#m.ccall("needle_complete", "number", ["string", "number", "number", "number"], [request.input, MAX_NEW_TOKENS, this.#out, OUT_CAPACITY]);
    if (status < 0) throw new Error(`needle_complete failed with status ${status}`);
    return parseReply(this.#m.UTF8ToString(this.#out));
  }

  async embed(inputs: readonly EmbedInput[]): Promise<Float32Array[]> {
    const ptr = this.#m._malloc(this.dimensions * 4);
    try {
      return inputs.map((input) => {
        const n = this.#m.ccall("needle_embed", "number", ["string", "number", "number"], [input.text, ptr, this.dimensions]);
        if (n !== this.dimensions) throw new Error(`needle_embed returned ${n}, expected ${this.dimensions}`);
        // Copy out before viewing as floats: the heap may grow (new buffer) on the next call.
        const v = new Float32Array(this.#m.HEAPU8.slice(ptr, ptr + this.dimensions * 4).buffer);
        const norm = Math.hypot(...v);
        return norm === 0 ? v : v.map((x) => x / norm);
      });
    } finally {
      this.#m._free(ptr);
    }
  }
}

function parseReply(text: string): Routing {
  const reply = JSON.parse(text) as NeedleReply;
  if (reply.success !== true) throw new Error(`Needle could not route: ${typeof reply.error === "string" ? reply.error : text}`);
  const confidence = reply.confidence;
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) throw new Error(`Needle returned an invalid confidence: ${String(confidence)}`);
  const calls = Array.isArray(reply.function_calls) ? reply.function_calls : [];
  return {
    calls: calls.map((c: { name: string; arguments?: Record<string, unknown> }) => ({ name: c.name, arguments: c.arguments ?? {} })),
    confidence,
    reasoning: typeof reply.reasoning === "string" ? reply.reasoning : "",
  };
}
