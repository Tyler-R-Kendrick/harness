import { describe, expect, it } from "vitest";
import { behaviorHook, SteeredGenerator } from "@harness/models";
import type { SteerableSession, SteeringHook, TokenizerLike } from "@harness/models";
import { BehaviorEngine, compilePack } from "@harness/behavior";
import type { BehaviorGraph } from "@harness/behavior";
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
 * reports the residual as [token count, steering[0]], and records the steering it got.
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
    const logits = new Float32Array(VOCAB.length).fill(-10);
    logits[next] = 10;
    return { logits, residual: Float32Array.from([this.#produced, steer?.[0] ?? 0]) };
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

  it("SG1.3 the hook sees the tapped layer's residual after every forward pass and its steering goes into the next pass", async () => {
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
    await collect(new SteeredGenerator({ session, tokenizer, hook }).generate({ messages: [{ role: "user", content: "a" }] }));
    expect(session.calls.map((c) => c.steer)).toEqual([[7, 0], [10, 0], [20, 0]]);
    expect(seen).toEqual([
      [1, 7],
      [2, 10],
      [3, 20],
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
    const events = await collect(new SteeredGenerator({ session: new FakeSession([1, 2, 0]), tokenizer, hook }).generate({ messages: [{ role: "user", content: "a" }] }));
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

  it("SG1.7 sampling with a temperature uses the injected random source", async () => {
    const session = new FakeSession([1, 0]);
    const events = await collect(new SteeredGenerator({ session, tokenizer, temperature: 1, random: () => 0 }).generate({ messages: [{ role: "user", content: "a" }], maxTokens: 1 }));
    // random() = 0 picks the first token with any mass after sorting by probability: the scripted one
    expect(text(events)).toBe("a");
  });
});

describe("behavior hook", () => {
  const graph: BehaviorGraph = {
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
  };
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
