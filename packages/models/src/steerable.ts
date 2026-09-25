import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { Mutex } from "async-mutex";
import { ChatStreamParser, constraintOf, StreamParts } from "@harness/cognitive";
import type { Constraint, StateChange, TokenConstraint } from "@harness/cognitive";
import type { BehaviorEngine } from "@harness/behavior";
import { localLanguageModel, templateOf } from "./local-model.ts";
import type { TemplateMessage, TemplateTool } from "./local-model.ts";

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
  encodeChat(messages: readonly TemplateMessage[], tools?: readonly TemplateTool[]): number[];
  /** Plain text to tokens (no special tokens); needed to feed text a constraint forces. */
  encodeText?(text: string): number[];
  /** Every token in id order; needed to build constraints for this tokenizer. */
  vocabulary?(): readonly string[];
  decode(ids: readonly number[]): string;
  readonly endTokens: readonly number[];
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

export interface SteeredModelOptions {
  readonly modelId: string;
  readonly session: SteerableSession;
  readonly tokenizer: TokenizerLike;
  /** A hook shared by every generation, or a factory that gives each generation its own (its own behavior state). */
  readonly hook?: SteeringHook | (() => SteeringHook);
  /** Defaults for calls that do not set them. */
  readonly temperature?: number;
  readonly topP?: number;
  readonly random?: () => number;
  readonly maxTokens?: number;
  /** Constrained decoding (see @harness/constrained): a constrained call is decoded under its constraint. */
  readonly constrain?: (constraint: Constraint) => Promise<TokenConstraint>;
}

/**
 * The steerable kernel as an AI SDK language model. Behavior state changes come out as
 * custom content parts of kind `harness.state` (read them with `stateOf`), in order
 * with the text they shaped. One session holds one KV cache, so calls take turns.
 */
export function steeredModel(options: SteeredModelOptions): LanguageModelV4 {
  const o = options;
  if (o.hook && typeof o.hook !== "function" && o.hook.layer !== o.session.layer) {
    throw new Error(`the hook reads layer ${o.hook.layer} but the session taps layer ${o.session.layer}`);
  }
  const turn = new Mutex();

  async function* decode(call: LanguageModelV4CallOptions, constraint: TokenConstraint | undefined): AsyncIterable<LanguageModelV4StreamPart> {
    const { session, tokenizer } = o;
    const max = call.maxOutputTokens ?? o.maxTokens ?? 256;
    const hook = typeof o.hook === "function" ? o.hook() : o.hook;
    if (hook && hook.layer !== session.layer) throw new Error(`the hook reads layer ${hook.layer} but the session taps layer ${session.layer}`);
    session.reset();
    const { messages, images, tools } = templateOf(call);
    if (images.length > 0) throw new Error("the steered kernel is text only; send images to a vision model");
    let input = tokenizer.encodeChat(messages, tools);
    let steer = hook?.initial();
    const generated: number[] = [];
    const parser = new ChatStreamParser();
    const parts = new StreamParts();
    let emitted = "";
    yield { type: "stream-start", warnings: [] };
    // Position 0 is the attention sink in these models: its residual has a massive norm
    // unrelated to content, so no sensor ever reads it.
    let sink = true;
    for (;;) {
      if (call.abortSignal?.aborted) break;
      const { logits, residuals } = await session.forward(input, steer);
      for (const residual of hook ? residuals.slice(sink ? 1 : 0) : []) {
        const r = hook!.at(residual);
        if (r.state) yield* parts.push({ type: "state", ...r.state });
        steer = r.steering;
      }
      sink = false;
      constraint?.mask(logits);
      const next = sample(logits, call.temperature ?? o.temperature ?? 0, call.topP ?? o.topP ?? 1, o.random ?? Math.random);
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
        if (delta) for (const e of parser.push(delta)) yield* parts.push(e);
      }
      if (generated.length >= max) break;
      input = [next, ...taken];
    }
    const rest = tokenizer.decode(generated).slice(emitted.length);
    if (rest) for (const e of parser.push(rest)) yield* parts.push(e);
    for (const e of parser.end()) yield* parts.push(e);
    yield* parts.end({ length: generated.length >= max });
  }

  return localLanguageModel({
    provider: "harness.local",
    modelId: o.modelId,
    async *run(call) {
      const release = await turn.acquire();
      try {
        const c = constraintOf(call);
        const constraint = c && o.constrain ? await o.constrain(c) : undefined;
        try {
          yield* decode(call, constraint);
        } finally {
          constraint?.dispose();
        }
      } finally {
        release();
      }
    },
  });
}
