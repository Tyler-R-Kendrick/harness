import type { CactusModule } from "@harness/models";

export interface CactusReply {
  success?: boolean;
  error?: string | null;
  function_calls?: { name: string; arguments?: Record<string, unknown> }[];
  reasoning?: string;
  confidence?: number;
}

/**
 * Emulates a Cactus Emscripten module: a flat heap, a bump allocator and the engine's C
 * API under a prefix, reached through ccall (and the load export directly).
 */
export class FakeCactusModule implements CactusModule {
  readonly prefix: string;
  HEAPU8 = new Uint8Array(1 << 20);
  readonly log: string[] = [];
  loadResult = 0;
  initResult = 12;
  completeResult: number | undefined;
  dimensions = 4;
  reply: (input: string, tools: string) => CactusReply = () => ({ success: true, function_calls: [], reasoning: "", confidence: 1 });
  #next = 16;
  #tools = "";

  constructor(prefix = "engine") {
    this.prefix = prefix;
    Object.assign(this, {
      [`_${prefix}_load`]: (_ptr: number, n: bigint): number => {
        this.log.push(`load:${n}`);
        return this.loadResult;
      },
    });
  }

  _malloc(n: number): number {
    // Emscripten's malloc returns 8-byte (here 16-byte) aligned blocks.
    const p = this.#next;
    this.#next += Math.ceil((n + 8) / 16) * 16;
    return p;
  }
  _free(p: number): void {
    this.log.push(`free:${p}`);
  }
  UTF8ToString(ptr: number): string {
    let end = ptr;
    while (this.HEAPU8[end] !== 0) end++;
    return new TextDecoder().decode(this.HEAPU8.subarray(ptr, end));
  }
  ccall(name: string, _ret: "number" | null, _types: string[], args: unknown[]): number {
    switch (name.slice(this.prefix.length + 1)) {
      case "init":
        this.#tools = args[1] as string;
        this.log.push(`init:${args[0]}|${args[1]}`);
        return this.initResult;
      case "reset":
        this.log.push("reset");
        return 0;
      case "complete": {
        const [input, max, out, cap] = args as [string, number, number, number];
        this.log.push(`complete:${input}:${max}`);
        if (this.completeResult !== undefined) return this.completeResult;
        const text = new TextEncoder().encode(JSON.stringify({ type: "call", ...this.reply(input, this.#tools) }));
        if (text.length + 1 > cap) return -2;
        this.HEAPU8.set(text, out);
        this.HEAPU8[out + text.length] = 0;
        return 8;
      }
      case "embed": {
        const [input, out, cap] = args as [string, number, number];
        if (out === 0) return this.dimensions;
        this.log.push(`embed:${input}`);
        const v = new Float32Array(this.HEAPU8.buffer, out, cap);
        for (let i = 0; i < cap; i++) v[i] = i === input.length % cap ? 3 : 4 / cap;
        return cap;
      }
      default:
        throw new Error(`unexpected ccall ${name}`);
    }
  }
}
