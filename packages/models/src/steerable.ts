import { ChatStreamParser } from "@harness/cognitive";
import type { ChatMessage, GenerateRequest, GenerationEvent, Generator, ToolSpec } from "@harness/cognitive";
import type { BehaviorEngine } from "@harness/behavior";

/**
 * The local kernel's decode loop. A steerable session is a model exported with two
 * extra connections at one layer: the residual stream as an output and a steering
 * vector added into it as an input. Each forward pass returns the next-token logits
 * and that layer's residual for the last position; the hook reads the residual and
 * chooses the steering for the next pass.
 */
export interface SteerableSession {
  readonly dims: number;
  /** The layer whose residual stream is tapped. */
  readonly layer: number;
  forward(ids: readonly number[], steer: Float32Array | undefined): Promise<{ logits: Float32Array; residual: Float32Array }>;
  /** Forget the KV cache: the next forward starts a new sequence. */
  reset(): void;
}

export interface TokenizerLike {
  encodeChat(messages: readonly ChatMessage[], tools?: readonly ToolSpec[]): number[];
  decode(ids: readonly number[]): string;
  readonly endTokens: readonly number[];
}

export interface StateChange {
  readonly state: string;
  readonly from?: string;
  readonly cause?: string;
}

export interface SteeringHook {
  readonly layer: number;
  /** Steering for the first forward pass. */
  initial(): Float32Array | undefined;
  /** The tapped residual after a forward pass; returns steering for the next pass. */
  at(residual: Float32Array): { steering: Float32Array | undefined; state?: StateChange };
}

/** Drive a behavior engine from the kernel: sense each token, steer the next. */
export function behaviorHook(engine: BehaviorEngine, layer: number = engine.layer): SteeringHook {
  return {
    layer,
    initial: () => engine.steering(),
    at: (residual) => {
      const r = engine.step(residual);
      return { steering: r.steering, ...(r.transition ? { state: { state: r.state, from: r.transition.from, cause: r.transition.cause } } : {}) };
    },
  };
}

function sample(logits: Float32Array, temperature: number, topP: number, random: () => number): number {
  if (temperature <= 0) {
    let best = 0;
    for (let i = 1; i < logits.length; i++) if (logits[i]! > logits[best]!) best = i;
    return best;
  }
  let max = -Infinity;
  for (const l of logits) max = Math.max(max, l);
  const probs = Array.from(logits, (l, i) => ({ i, p: Math.exp((l - max) / temperature) })).sort((a, b) => b.p - a.p);
  const total = probs.reduce((s, x) => s + x.p, 0);
  const kept: typeof probs = [];
  let mass = 0;
  for (const x of probs) {
    kept.push(x);
    mass += x.p / total;
    if (mass >= topP) break;
  }
  const keptTotal = kept.reduce((s, x) => s + x.p, 0);
  let r = random() * keptTotal;
  for (const x of kept) {
    r -= x.p;
    if (r <= 0) return x.i;
  }
  return kept.at(-1)!.i;
}

export interface SteeredGeneratorOptions {
  readonly session: SteerableSession;
  readonly tokenizer: TokenizerLike;
  readonly hook?: SteeringHook;
  readonly temperature?: number;
  readonly topP?: number;
  readonly random?: () => number;
  readonly maxTokens?: number;
}

export class SteeredGenerator implements Generator {
  readonly #o: SteeredGeneratorOptions;

  constructor(options: SteeredGeneratorOptions) {
    if (options.hook && options.hook.layer !== options.session.layer) {
      throw new Error(`the hook reads layer ${options.hook.layer} but the session taps layer ${options.session.layer}`);
    }
    this.#o = options;
  }

  async *generate(request: GenerateRequest): AsyncIterable<GenerationEvent> {
    const { session, tokenizer, hook } = this.#o;
    const max = request.maxTokens ?? this.#o.maxTokens ?? 256;
    session.reset();
    let input = tokenizer.encodeChat(request.messages, request.tools);
    let steer = hook?.initial();
    const generated: number[] = [];
    const parser = new ChatStreamParser();
    let emitted = "";
    let calls = 0;
    const emit = function* (events: Iterable<GenerationEvent>) {
      for (const e of events) {
        if (e.type === "tool-call") calls++;
        yield e;
      }
    };
    for (;;) {
      const { logits, residual } = await session.forward(input, steer);
      const r = hook?.at(residual);
      if (r?.state) yield { type: "state", ...r.state };
      steer = r ? r.steering : steer;
      const next = sample(logits, this.#o.temperature ?? 0, this.#o.topP ?? 1, this.#o.random ?? Math.random);
      if (tokenizer.endTokens.includes(next)) break;
      generated.push(next);
      const text = tokenizer.decode(generated);
      const delta = text.slice(emitted.length);
      emitted = text;
      if (delta) yield* emit(parser.push(delta));
      if (generated.length >= max) {
        yield* emit(parser.end());
        yield { type: "finish", reason: calls > 0 ? "tool-calls" : "length" };
        return;
      }
      input = [next];
    }
    yield* emit(parser.end());
    yield { type: "finish", reason: calls > 0 ? "tool-calls" : "stop" };
  }
}
