import { describe, expect, it } from "vitest";
import { behaviorHook, SteeredGenerator } from "@harness/models";
import type { SteerableSession, SteeringHook, TokenizerLike } from "@harness/models";
import { BehaviorEngine, compilePack, defineGraph } from "@harness/behavior";
import type { GenerationEvent } from "@harness/cognitive";

/** Token ids are characters of a tiny vocabulary; id 0 ends the turn. */
const VOCAB = ["<end>", "a", "b", "c", " "];
const tokenizer: TokenizerLike = {
  encodeChat: (messages) => [...messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("")].map((ch) => Math.max(1, VOCAB.indexOf(ch))),
  decode: (ids) => ids.map((i) => VOCAB[i] ?? "?").join(""),
  endTokens: [0],
};

/**
 * A fake steerable model over a 2-d residual: it emits a scripted token sequence,
 * reports each position's residual as [token id, steering[0]], and records the steering it got.
 */
class FakeSession implements SteerableSession {
  readonly dims = 2;
  readonly layer = 5;
  readonly calls: { ids: number[]; steer: number[] | undefined }[] = [];
  readonly script: number[];
  #produced = 0;
  constructor(script: number[]) {
    this.script = script;
  }
  async forward(ids: readonly number[], steer: Float32Array | undefined) {
    this.calls.push({ ids: [...ids], steer: steer ? Array.from(steer) : undefined });
    const next = this.script[this.#produced++] ?? 0;
    const logits = new Float32Array(8).fill(-10);
    logits[next] = 10;
    return { logits, residuals: ids.map((id) => Float32Array.from([id, steer?.[0] ?? 0])) };
  }
  reset() {
    this.#produced = 0;
  }
}

async function collect(stream: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const out: GenerationEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}
const text = (events: readonly GenerationEvent[]) => events.map((e) => (e.type === "text" ? e.text : "")).join("");

describe("steered generation (the local kernel's decode loop)", () => {
  it("SG1.1 prefills the prompt, then feeds one token at a time until an end token, streaming the text", async () => {
    const session = new FakeSession([1, 2, 3, 0]);
    const events = await collect(new SteeredGenerator({ session, tokenizer }).generate({ messages: [{ role: "user", content: "ab" }] }));
    expect(text(events)).toBe("abc");
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(session.calls.map((c) => c.ids)).toEqual([[1, 2], [1], [2], [3]]);
  });

  it("SG1.2 stops at the token budget with reason length", async () => {
    const session = new FakeSession([1, 1, 1, 1, 1]);
    const events = await collect(new SteeredGenerator({ session, tokenizer }).generate({ messages: [{ role: "user", content: "a" }], maxTokens: 3 }));
    expect(text(events)).toBe("aaa");
    expect(events.at(-1)).toEqual({ type: "finish", reason: "length" });
  });

  it("SG1.3 the hook sees the tapped layer's residual at every new position and its steering goes into the next pass", async () => {
    const seen: number[][] = [];
    const hook: SteeringHook = {
      layer: 5,
      initial: () => Float32Array.from([7, 0]),
      at: (residual) => {
        seen.push(Array.from(residual));
        return { steering: Float32Array.from([seen.length * 10, 0]) };
      },
    };
    const session = new FakeSession([1, 2, 0]);
    await collect(new SteeredGenerator({ session, tokenizer, hook }).generate({ messages: [{ role: "user", content: "ab" }] }));
    expect(session.calls.map((c) => c.steer)).toEqual([[7, 0], [10, 0], [20, 0]]);
    // the prompt's first position is never sensed; then b (prompt), a and b (generated)
    expect(seen).toEqual([
      [2, 7],
      [1, 10],
      [2, 20],
    ]);
  });

  it("SG1.4 a hook for a different layer than the session taps is refused", () => {
    const hook: SteeringHook = { layer: 9, initial: () => undefined, at: () => ({ steering: undefined }) };
    expect(() => new SteeredGenerator({ session: new FakeSession([0]), tokenizer, hook })).toThrow(/layer 9.*5/);
  });

  it("SG1.5 state changes stream as state events before the text they affect", async () => {
    let n = 0;
    const hook: SteeringHook = {
      layer: 5,
      initial: () => undefined,
      at: () => (++n === 2 ? { steering: undefined, state: { state: "guarded", from: "calm", cause: "sensor threat on" } } : { steering: undefined }),
    };
    const events = await collect(new SteeredGenerator({ session: new FakeSession([1, 2, 0]), tokenizer, hook }).generate({ messages: [{ role: "user", content: "ab" }] }));
    expect(events.map((e) => e.type)).toEqual(["text", "state", "text", "finish"]);
    expect(events[1]).toEqual({ type: "state", state: "guarded", from: "calm", cause: "sensor threat on" });
  });

  it("SG1.6 each request starts from a fresh session state; breaking out stops the loop", async () => {
    const session = new FakeSession([1, 1, 1, 1, 1, 1, 1, 0]);
    const g = new SteeredGenerator({ session, tokenizer });
    for await (const _ of g.generate({ messages: [{ role: "user", content: "a" }] })) break;
    const calls = session.calls.length;
    expect(calls).toBeLessThanOrEqual(2);
    session.script.splice(0, session.script.length, 2, 0);
    expect(text(await collect(g.generate({ messages: [{ role: "user", content: "a" }] })))).toBe("b");
  });

  it("SG1.8 the whole prompt is sensed, in order, skipping only the attention-sink first position; a prompt state change streams before any text", async () => {
    const seen: number[] = [];
    const hook: SteeringHook = {
      layer: 5,
      initial: () => undefined,
      at: (residual) => {
        seen.push(residual[0]!);
        return residual[0] === 3 ? { steering: Float32Array.from([5, 0]), state: { state: "alert", from: "calm" } } : { steering: undefined };
      },
    };
    const session = new FakeSession([1, 0]);
    const events = await collect(new SteeredGenerator({ session, tokenizer, hook }).generate({ messages: [{ role: "user", content: "abcb" }] }));
    expect(seen).toEqual([2, 3, 2, 1]);
    expect(events.map((e) => e.type)).toEqual(["state", "text", "finish"]);
    // steering is whatever the last sensed position chose: b after c cleared it
    expect(session.calls[1]!.steer).toBeUndefined();
  });

  it("SG1.9 generations on one session take turns instead of interleaving the KV cache", async () => {
    const session = new FakeSession([1, 0, 2, 0]);
    const g = new SteeredGenerator({ session, tokenizer });
    const [first, second] = await Promise.all([collect(g.generate({ messages: [{ role: "user", content: "c" }] })), collect(g.generate({ messages: [{ role: "user", content: "cc" }] }))]);
    expect(text(first)).toBe("a");
    expect(text(second)).toBe("a");
    expect(session.calls.map((c) => c.ids)).toEqual([[3], [1], [3, 3], [1]]);
  });

  it("SG1.10 a character split across tokens streams whole: text is held while it ends mid-character, and flushed at the end", async () => {
    // ids 5 and 6 are the two byte-halves of one emoji; 5 alone decodes to U+FFFD
    const split: TokenizerLike = {
      ...tokenizer,
      decode: (ids) => ids.map((id, i) => (id === 5 ? (ids[i + 1] === 6 ? "😊" : "\uFFFD") : id === 6 ? "" : (VOCAB[id] ?? "?"))).join(""),
    };
    const whole = await collect(new SteeredGenerator({ session: new FakeSession([1, 5, 6, 0]), tokenizer: split }).generate({ messages: [{ role: "user", content: "a" }] }));
    expect(whole.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : ""))).toEqual(["a", "😊"]);
    const cut = await collect(new SteeredGenerator({ session: new FakeSession([1, 5, 0]), tokenizer: split }).generate({ messages: [{ role: "user", content: "a" }] }));
    expect(text(cut)).toBe("a\uFFFD");
  });

  it("SG1.7 sampling with a temperature uses the injected random source", async () => {
    const session = new FakeSession([1, 0]);
    const events = await collect(new SteeredGenerator({ session, tokenizer, temperature: 1, random: () => 0 }).generate({ messages: [{ role: "user", content: "a" }], maxTokens: 1 }));
    // random() = 0 picks the first token with any mass after sorting by probability: the scripted one
    expect(text(events)).toBe("a");
  });
});

describe("behavior hook", () => {
  const graph = defineGraph({
    version: 1,
    id: "g",
    model: { id: "m", layer: 5 },
    initial: "calm",
    features: { threat: 0, warmth: 1 },
    sensors: { threat: { feature: "threat", on: 2, off: 1 } },
    states: { calm: { steer: { warmth: 1 } }, guarded: { steer: { warmth: -2 } } },
    transitions: [
      { from: "calm", to: "guarded", when: { sensor: "threat", is: "on" } },
      { from: "guarded", to: "calm", when: { sensor: "threat", is: "off" } },
    ],
  });
  const unit = (i: number) => Float32Array.from([0, 1].map((j) => (j === i ? 1 : 0)));
  const pack = compilePack(graph, { dims: 2, width: 4, encoder: (i) => ({ weights: unit(i), bias: 0, threshold: 0 }), decoder: unit });

  it("BH1.1 steers with the current state's vector and reports transitions as state changes", () => {
    const hook = behaviorHook(new BehaviorEngine(pack));
    expect(hook.layer).toBe(5);
    expect(Array.from(hook.initial()!)).toEqual([0, 1]);
    expect(hook.at(Float32Array.from([0.5, 0]))).toEqual({ steering: Float32Array.from([0, 1]) });
    expect(hook.at(Float32Array.from([3, 0]))).toEqual({ steering: Float32Array.from([0, -2]), state: { state: "guarded", from: "calm", cause: "sensor threat on" } });
  });
});

describe("constrained steered generation", () => {
  /** A fake constraint: allows only the ids in `allow` at each step, forces text after the first token, and is done after `doneAfter` tokens. */
  function constraint(steps: number[][], forced: Record<number, string> = {}) {
    const accepted: number[] = [];
    return {
      accepted,
      tc: {
        mask(logits: Float32Array) {
          const allow = steps[accepted.length] ?? [0];
          for (let i = 0; i < logits.length; i++) if (!allow.includes(i)) logits[i] = -Infinity;
        },
        accept(token: number) {
          if (!(steps[accepted.length] ?? [0]).includes(token)) return false;
          accepted.push(token);
          return true;
        },
        forced: () => forced[accepted.length] ?? "",
        get done() {
          return accepted.at(-1) === 0;
        },
        dispose() {},
      },
    };
  }
  const withText: TokenizerLike = { ...tokenizer, encodeText: (t) => [...t].map((ch) => VOCAB.indexOf(ch)) };

  it("SG2.1 a constrained request masks each step's logits and accepts every token it samples", async () => {
    const c = constraint([[2], [3], [0]]);
    const session = new FakeSession([1, 1, 1, 1]);
    const g = new SteeredGenerator({ session, tokenizer: withText, constrain: async () => c.tc });
    const events = await collect(g.generate({ messages: [{ role: "user", content: "a" }], constraint: { type: "regex", pattern: "bc" } }));
    expect(text(events)).toBe("bc");
    expect(c.accepted).toEqual([2, 3, 0]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
  });

  it("SG2.2 text the constraint forces is fed in one pass instead of sampled token by token", async () => {
    const c = constraint([[1], [2], [3], [4], [0]], { 1: "bc" });
    const session = new FakeSession([1, 4, 0]);
    const g = new SteeredGenerator({ session, tokenizer: withText, constrain: async () => c.tc });
    const events = await collect(g.generate({ messages: [{ role: "user", content: "a" }], constraint: { type: "regex", pattern: "abc ?" } }));
    expect(text(events)).toBe("abc ");
    expect(session.calls.map((call) => call.ids)).toEqual([[1], [1, 2, 3], [4]]);
    expect(c.accepted).toEqual([1, 2, 3, 4, 0]);
  });

  it("SG2.3 forced text is fed only as far as the constraint takes it, and a generator without an engine ignores constraints", async () => {
    const c = constraint([[1], [2], [0]], { 1: "bc" });
    const session = new FakeSession([1, 0]);
    const events = await collect(new SteeredGenerator({ session, tokenizer: withText, constrain: async () => c.tc }).generate({ messages: [{ role: "user", content: "a" }], constraint: { type: "regex", pattern: "ab" } }));
    expect(text(events)).toBe("ab");
    expect(session.calls[1]!.ids).toEqual([1, 2]);
    const plain = new FakeSession([3, 0]);
    expect(text(await collect(new SteeredGenerator({ session: plain, tokenizer }).generate({ messages: [{ role: "user", content: "a" }], constraint: { type: "regex", pattern: "b" } })))).toBe("c");
  });
});

