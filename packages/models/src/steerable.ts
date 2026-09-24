import { Mutex } from "async-mutex";
import { ChatStreamParser } from "@harness/cognitive";
import type { ChatMessage, Constraint, GenerateRequest, GenerationEvent, Generator, TokenConstraint, ToolSpec } from "@harness/cognitive";
import type { BehaviorEngine } from "@harness/behavior";

/**
 * The local kernel's decode loop. A steerable session is a model exported with two
 * extra connections at one layer: the residual stream as an output and a steering
 * vector added into it as an input. Each forward pass returns the next-token logits
 * and that layer's residual at every position it was fed; the hook reads each residual
 * in order (the prompt is perceived token by token, like the reply) and chooses the
 * steering for the next pass.
 */
export interface SteerableSession {
  readonly dims: number;
  /** The layer whose residual stream is tapped. */
  readonly layer: number;
  /** Next-token logits for the last position, and the tapped residual at each of `ids`. */
  forward(ids: readonly number[], steer: Float32Array | undefined): Promise<{ logits: Float32Array; residuals: Float32Array[] }>;
  /** Forget the KV cache: the next forward starts a new sequence. */
  reset(): void;
}

export interface TokenizerLike {
  encodeChat(messages: readonly ChatMessage[], tools?: readonly ToolSpec[]): number[];
  /** Plain text to tokens (no special tokens); needed to feed text a constraint forces. */
  encodeText?(text: string): number[];
  /** Every token in id order; needed to build constraints for this tokenizer. */
  vocabulary?(): readonly string[];
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
  /** A hook shared by every generation, or a factory that gives each generation its own (its own behavior state). */
  readonly hook?: SteeringHook | (() => SteeringHook);
  readonly temperature?: number;
  readonly topP?: number;
  readonly random?: () => number;
  readonly maxTokens?: number;
  /** Constrained decoding (see @harness/constrained): a constrained request is decoded under its constraint. */
  readonly constrain?: (constraint: Constraint) => Promise<TokenConstraint>;
}

export class SteeredGenerator implements Generator {
  readonly #o: SteeredGeneratorOptions;
  /** One session holds one KV cache, so generations take turns. */
  readonly #turn = new Mutex();

  constructor(options: SteeredGeneratorOptions) {
    if (options.hook && typeof options.hook !== "function" && options.hook.layer !== options.session.layer) {
      throw new Error(`the hook reads layer ${options.hook.layer} but the session taps layer ${options.session.layer}`);
    }
    this.#o = options;
  }

  async *generate(request: GenerateRequest): AsyncIterable<GenerationEvent> {
    const release = await this.#turn.acquire();
    try {
      yield* this.#run(request);
    } finally {
      release();
    }
  }

  async *#run(request: GenerateRequest): AsyncIterable<GenerationEvent> {
    const max = request.maxTokens ?? this.#o.maxTokens ?? 256;
    const constraint = request.constraint && this.#o.constrain ? await this.#o.constrain(request.constraint) : undefined;
    try {
      yield* this.#decode(request, max, constraint);
    } finally {
      constraint?.dispose();
    }
  }

  async *#decode(request: GenerateRequest, max: number, constraint: TokenConstraint | undefined): AsyncIterable<GenerationEvent> {
    const { session, tokenizer } = this.#o;
    const hook = typeof this.#o.hook === "function" ? this.#o.hook() : this.#o.hook;
    if (hook && hook.layer !== session.layer) throw new Error(`the hook reads layer ${hook.layer} but the session taps layer ${session.layer}`);
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
    // Position 0 is the attention sink in these models: its residual has a massive norm
    // unrelated to content, so no sensor ever reads it.
    let sink = true;
    for (;;) {
      const { logits, residuals } = await session.forward(input, steer);
      for (const residual of hook ? residuals.slice(sink ? 1 : 0) : []) {
        const r = hook!.at(residual);
        if (r.state) yield { type: "state", ...r.state };
        steer = r.steering;
      }
      sink = false;
      constraint?.mask(logits);
      const next = sample(logits, this.#o.temperature ?? 0, this.#o.topP ?? 1, this.#o.random ?? Math.random);
      constraint?.accept(next);
      if (tokenizer.endTokens.includes(next) || constraint?.done) break;
      generated.push(next);
      // Jump forward: text the constraint forces is fed with this token in one pass, never sampled.
      const taken: number[] = [];
      if (constraint && tokenizer.encodeText) {
        for (const id of tokenizer.encodeText(constraint.forced())) {
          if (!constraint.accept(id)) break;
          taken.push(id);
        }
      }
      generated.push(...taken);
      const text = tokenizer.decode(generated);
      // A byte-level token can end mid-character (decoded as U+FFFD); wait for the rest.
      if (!text.endsWith("\uFFFD")) {
        const delta = text.slice(emitted.length);
        emitted = text;
        if (delta) yield* emit(parser.push(delta));
      }
      if (generated.length >= max) break;
      input = [next, ...taken];
    }
    const rest = tokenizer.decode(generated).slice(emitted.length);
    if (rest) yield* emit(parser.push(rest));
    yield* emit(parser.end());
    yield { type: "finish", reason: calls > 0 ? "tool-calls" : generated.length >= max ? "length" : "stop" };
  }
}
