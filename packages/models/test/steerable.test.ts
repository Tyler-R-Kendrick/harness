import { describe, expect, it } from "vitest";
import { generateText, streamText } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { behaviorHook, sessionHooks, steeredModel } from "@harness/models";
import type { SteerableSession, SteeringHook, TokenizerLike } from "@harness/models";
import { BehaviorEngine, compilePack, defineGraph } from "@harness/behavior";
import { inSession, constrain, stateOf, toolSet } from "@harness/cognitive";
import { generatorContract } from "@harness/testkit";

/** Token ids are characters of a tiny vocabulary; id 0 ends the turn. */
const VOCAB = ["<end>", "a", "b", "c", " "];
const tokenizer: TokenizerLike = {
  encodeChat: (messages) => [...messages.map((m) => m.content.map((p) => (p.type === "text" ? p.text : "")).join("")).join("")].map((ch) => Math.max(1, VOCAB.indexOf(ch))),
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
  onForward: (() => void) | undefined;
  #produced = 0;
  constructor(script: number[]) {
    this.script = script;
  }
  async forward(ids: readonly number[], steer: Float32Array | undefined) {
    this.calls.push({ ids: [...ids], steer: steer ? Array.from(steer) : undefined });
    this.onForward?.();
    const next = this.script[this.#produced++] ?? 0;
    const logits = new Float32Array(8).fill(-10);
    logits[next] = 10;
    return { logits, residuals: ids.map((id) => Float32Array.from([id, steer?.[0] ?? 0])) };
  }
  reset() {
    this.#produced = 0;
  }
}

/** Stream a prompt through a model and collect what a consumer reads: text deltas, state changes and the finish reason. */
async function run(model: LanguageModelV4, prompt: string, settings: Pick<Parameters<typeof streamText>[0], "maxOutputTokens" | "temperature" | "topP" | "abortSignal" | "providerOptions"> = {}) {
  const result = streamText({ model, prompt, maxRetries: 0, ...settings });
  const events: ({ type: "text"; text: string } | { type: "state"; state: unknown } | { type: "finish"; reason: string })[] = [];
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") events.push({ type: "text", text: part.text });
    else if (part.type === "custom") events.push({ type: "state", state: stateOf(part) });
    else if (part.type === "finish") events.push({ type: "finish", reason: part.finishReason });
    else if (part.type === "error") throw part.error;
  }
  return events;
}
const text = (events: readonly { type: string; text?: string }[]) => events.map((e) => (e.type === "text" ? e.text : "")).join("");

describe("steered generation (the local kernel's decode loop)", () => {
  it("SG1.1 prefills the prompt, then feeds one token at a time until an end token, streaming the text", async () => {
    const session = new FakeSession([1, 2, 3, 0]);
    const model = steeredModel({ modelId: "kernel", session, tokenizer });
    expect([model.provider, model.modelId]).toEqual(["harness.local", "kernel"]);
    const events = await run(model, "ab");
    expect(text(events)).toBe("abc");
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(session.calls.map((c) => c.ids)).toEqual([[1, 2], [1], [2], [3]]);
  });

  it("SG1.2 stops at the token budget with reason length", async () => {
    const session = new FakeSession([1, 1, 1, 1, 1]);
    const events = await run(steeredModel({ modelId: "kernel", session, tokenizer }), "a", { maxOutputTokens: 3 });
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
    await run(steeredModel({ modelId: "kernel", session, tokenizer, hook }), "ab");
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
    expect(() => steeredModel({ modelId: "kernel", session: new FakeSession([0]), tokenizer, hook })).toThrow(/layer 9.*5/);
  });

  it("SG1.5 state changes stream as custom parts before the text they affect", async () => {
    let n = 0;
    const hook: SteeringHook = {
      layer: 5,
      initial: () => undefined,
      at: () => (++n === 2 ? { steering: undefined, state: { state: "guarded", from: "calm", cause: "sensor threat on" } } : { steering: undefined }),
    };
    const events = await run(steeredModel({ modelId: "kernel", session: new FakeSession([1, 2, 0]), tokenizer, hook }), "ab");
    expect(events.map((e) => e.type)).toEqual(["text", "state", "text", "finish"]);
    expect(events[1]).toEqual({ type: "state", state: { state: "guarded", from: "calm", cause: "sensor threat on" } });
  });

  it("SG1.6 each request starts from a fresh session state; aborting the call stops the loop", async () => {
    const session = new FakeSession([1, 1, 1, 1, 1, 1, 1, 0]);
    const model = steeredModel({ modelId: "kernel", session, tokenizer });
    const abort = new AbortController();
    session.onForward = () => session.calls.length === 2 && abort.abort();
    await run(model, "a", { abortSignal: abort.signal }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 10));
    expect(session.calls.length).toBeLessThanOrEqual(3);
    session.onForward = undefined;
    session.script.splice(0, session.script.length, 2, 0);
    expect(text(await run(model, "a"))).toBe("b");
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
    const events = await run(steeredModel({ modelId: "kernel", session, tokenizer, hook }), "abcb");
    expect(seen).toEqual([2, 3, 2, 1]);
    expect(events.map((e) => e.type)).toEqual(["state", "text", "finish"]);
    // steering is whatever the last sensed position chose: b after c cleared it
    expect(session.calls[1]!.steer).toBeUndefined();
  });

  it("SG1.9 generations on one session take turns instead of interleaving the KV cache", async () => {
    const session = new FakeSession([1, 0, 2, 0]);
    const model = steeredModel({ modelId: "kernel", session, tokenizer });
    const [first, second] = await Promise.all([run(model, "c"), run(model, "cc")]);
    expect(text(first)).toBe("a");
    expect(text(second)).toBe("a");
    expect(session.calls.map((c) => c.ids)).toEqual([[3], [1], [3, 3], [1]]);
  });

  it("SG1.10 a character split across tokens streams whole: text is held while it ends mid-character, and flushed at the end", async () => {
    // ids 5 and 6 are the two byte-halves of one emoji; 5 alone decodes to U+FFFD
    const split: TokenizerLike = {
      ...tokenizer,
      decode: (ids) => ids.map((id, i) => (id === 5 ? (ids[i + 1] === 6 ? "😊" : "�") : id === 6 ? "" : (VOCAB[id] ?? "?"))).join(""),
    };
    const whole = await run(steeredModel({ modelId: "kernel", session: new FakeSession([1, 5, 6, 0]), tokenizer: split }), "a");
    expect(whole.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : ""))).toEqual(["a", "😊"]);
    const cut = await run(steeredModel({ modelId: "kernel", session: new FakeSession([1, 5, 0]), tokenizer: split }), "a");
    expect(text(cut)).toBe("a�");
  });

  it("SG1.7 sampling with a temperature uses the injected random source", async () => {
    const session = new FakeSession([1, 0]);
    const events = await run(steeredModel({ modelId: "kernel", session, tokenizer, temperature: 1, random: () => 0 }), "a", { maxOutputTokens: 1 });
    // random() = 0 picks the first token with any mass after sorting by probability: the scripted one
    expect(text(events)).toBe("a");
  });

  it("SG1.11 the call's temperature, top-p and token budget override the model's defaults", async () => {
    /** Every step: a slightly likelier than b, the end token impossible. */
    const close: SteerableSession = {
      dims: 2,
      layer: 5,
      reset() {},
      forward: async () => ({ logits: Float32Array.from([-100, 1, 0.9, -100, -100]), residuals: [] }),
    };
    // defaults: sampled at temperature 1 with every token kept, random near 1 picks the less likely b; three tokens
    const model = steeredModel({ modelId: "kernel", session: close, tokenizer, temperature: 1, topP: 1, random: () => 0.99, maxTokens: 3 });
    expect(text(await run(model, "a"))).toBe("bbb");
    expect(text(await run(model, "a", { temperature: 0 }))).toBe("aaa");
    expect(text(await run(model, "a", { topP: 0.5 }))).toBe("aaa");
    const cut = await run(model, "a", { maxOutputTokens: 1 });
    expect(text(cut)).toBe("b");
    expect(cut.at(-1)).toEqual({ type: "finish", reason: "length" });
    // without defaults the kernel is greedy
    expect(text(await run(steeredModel({ modelId: "kernel", session: close, tokenizer, maxTokens: 2 }), "a"))).toBe("aa");
  });

  it("SG1.12 the kernel is text only: an image in the prompt is refused", async () => {
    const model = steeredModel({ modelId: "kernel", session: new FakeSession([1, 0]), tokenizer });
    await expect(generateText({ model, maxRetries: 0, messages: [{ role: "user", content: [{ type: "image", image: new Uint8Array([1]), mediaType: "image/png" }] }] })).rejects.toThrow(/text only/);
  });

  it("SG1.13 the tools offered are templated with the conversation; generate collects text, state changes and the finish", async () => {
    const offered: unknown[] = [];
    const recording: TokenizerLike = {
      ...tokenizer,
      encodeChat: (messages, tools) => (offered.push(tools), tokenizer.encodeChat(messages, tools)),
    };
    let n = 0;
    const hook: SteeringHook = { layer: 5, initial: () => undefined, at: () => (++n === 1 ? { steering: undefined, state: { state: "alert" } } : { steering: undefined }) };
    const result = await generateText({
      model: steeredModel({ modelId: "kernel", session: new FakeSession([1, 2, 0]), tokenizer: recording, hook }),
      prompt: "cab",
      tools: toolSet([{ name: "search", description: "find", parameters: { type: "object" } }]),
      maxRetries: 0,
    });
    expect(offered).toEqual([[{ name: "search", description: "find", parameters: expect.objectContaining({ type: "object" }) }]]);
    expect(result.text).toBe("ab");
    expect(result.finishReason).toBe("stop");
    expect(result.content.flatMap((p) => (p.type === "custom" ? [stateOf(p)] : []))).toEqual([{ state: "alert" }]);
  });
});

generatorContract("steered kernel over a fake session", () => steeredModel({ modelId: "kernel", session: new FakeSession([1, 2, 3, 0]), tokenizer }));

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
      { from: "guarded", to: "calm", when: { event: "reassured" } },
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

  it("BH1.2 a host event takes the graph's transition for it and reports the state change; an event with no transition changes nothing", () => {
    const hook = behaviorHook(new BehaviorEngine(pack));
    expect(hook.event!("reassured")).toBeUndefined();
    hook.at(Float32Array.from([3, 0]));
    expect(hook.event!("unknown")).toBeUndefined();
    expect(hook.event!("reassured")).toEqual({ state: "calm", from: "guarded", cause: "event reassured" });
    expect(Array.from(hook.initial()!)).toEqual([0, 1]);
  });
});

describe("constrained steered generation", () => {
  /** A fake constraint: allows only the ids in `allow` at each step, forces text after the first token, and is done after `doneAfter` tokens. */
  function constraint(steps: number[][], forced: Record<number, string> = {}) {
    const accepted: number[] = [];
    let disposed = 0;
    return {
      accepted,
      disposed: () => disposed,
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
        dispose() {
          disposed++;
        },
      },
    };
  }
  const withText: TokenizerLike = { ...tokenizer, encodeText: (t) => [...t].map((ch) => VOCAB.indexOf(ch)) };

  it("SG2.1 a constrained request masks each step's logits and accepts every token it samples", async () => {
    const c = constraint([[2], [3], [0]]);
    const asked: unknown[] = [];
    const session = new FakeSession([1, 1, 1, 1]);
    const model = steeredModel({ modelId: "kernel", session, tokenizer: withText, constrain: async (x) => (asked.push(x), c.tc) });
    const events = await run(model, "a", constrain({ type: "regex", pattern: "bc" }));
    expect(asked).toEqual([{ type: "regex", pattern: "bc" }]);
    expect(text(events)).toBe("bc");
    expect(c.accepted).toEqual([2, 3, 0]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(c.disposed()).toBe(1);
  });

  it("SG2.2 text the constraint forces is fed in one pass instead of sampled token by token", async () => {
    const c = constraint([[1], [2], [3], [4], [0]], { 1: "bc" });
    const session = new FakeSession([1, 4, 0]);
    const model = steeredModel({ modelId: "kernel", session, tokenizer: withText, constrain: async () => c.tc });
    const events = await run(model, "a", constrain({ type: "regex", pattern: "abc ?" }));
    expect(text(events)).toBe("abc ");
    expect(session.calls.map((call) => call.ids)).toEqual([[1], [1, 2, 3], [4]]);
    expect(c.accepted).toEqual([1, 2, 3, 4, 0]);
  });

  it("SG2.3 forced text is fed only as far as the constraint takes it, and a model without an engine ignores constraints", async () => {
    const c = constraint([[1], [2], [0]], { 1: "bc" });
    const session = new FakeSession([1, 0]);
    const events = await run(steeredModel({ modelId: "kernel", session, tokenizer: withText, constrain: async () => c.tc }), "a", constrain({ type: "regex", pattern: "ab" }));
    expect(text(events)).toBe("ab");
    expect(session.calls[1]!.ids).toEqual([1, 2]);
    const plain = new FakeSession([3, 0]);
    expect(text(await run(steeredModel({ modelId: "kernel", session: plain, tokenizer }), "a", constrain({ type: "regex", pattern: "b" })))).toBe("c");
  });

  it("SG2.4 a hook factory gives every generation its own behavior state, so one conversation's state does not leak into the next", async () => {
    let made = 0;
    const hook = (): SteeringHook => {
      const id = ++made;
      return { layer: 5, initial: () => Float32Array.from([id, 0]), at: () => ({ steering: Float32Array.from([id, 0]) }) };
    };
    const session = new FakeSession([1, 0, 1, 0]);
    const model = steeredModel({ modelId: "kernel", session, tokenizer, hook });
    await run(model, "a");
    await run(model, "a");
    expect(made).toBe(2);
    expect(session.calls.map((c) => c.steer?.[0])).toEqual([1, 1, 2, 2]);
    const wrong = steeredModel({ modelId: "kernel", session, tokenizer, hook: () => ({ ...hook(), layer: 9 }) });
    await expect(generateText({ model: wrong, prompt: "a", maxRetries: 0 })).rejects.toThrow("the hook reads layer 9 but the session taps layer 5");
  });

  it("SG2.6 the hook factory is asked for each generation's hook with the daemon session the call names", async () => {
    const asked: (string | undefined)[] = [];
    const hook = (session?: string): SteeringHook => (asked.push(session), { layer: 5, initial: () => undefined, at: () => ({ steering: undefined }) });
    const model = steeredModel({ modelId: "kernel", session: new FakeSession([0, 0]), tokenizer, hook });
    await run(model, "a", inSession("s1"));
    await run(model, "a");
    expect(asked).toEqual(["s1", undefined]);
  });

  it("SG2.7 session hooks: a session's behavior state carries from one generation to the next; other sessions, and calls outside any, have their own", async () => {
    let made = 0;
    const hooks = sessionHooks(() => {
      made++;
      let steps = 0;
      return { layer: 5, initial: () => Float32Array.from([steps, 0]), at: () => ({ steering: Float32Array.from([++steps, 0]) }) };
    });
    const session = new FakeSession([1, 0, 1, 0, 1, 0, 1, 0]);
    const model = steeredModel({ modelId: "kernel", session, tokenizer, hook: hooks.hookFor });
    await run(model, "a", inSession("s1"));
    await run(model, "a", inSession("s1"));
    await run(model, "a", inSession("s2"));
    await run(model, "a");
    expect(made).toBe(3);
    // s1's second generation starts steering from where its first left off; s2 starts afresh
    expect(session.calls[2]!.steer![0]).toBeGreaterThan(0);
    expect(session.calls[4]!.steer![0]).toBe(0);
  });

  it("SG2.8 session hooks are kept for a bounded number of sessions, forgetting the least recently used", () => {
    const made: number[] = [];
    const hooks = sessionHooks(() => (made.push(made.length), { layer: 5, initial: () => undefined, at: () => ({ steering: undefined }) }), { limit: 2 });
    const seen = ["a", "b", "a", "c", "a", "b"].map((s) => hooks.hookFor(s));
    expect(made).toHaveLength(4);
    expect(seen[2]).toBe(seen[0]);
    expect(seen[4]).toBe(seen[0]);
    expect(seen[5]).not.toBe(seen[1]);
  });

  it("SG2.9 a host event raised for a session reaches that session's behavior and reports the change it caused", () => {
    const events: string[] = [];
    const hooks = sessionHooks(() => ({ layer: 5, initial: () => undefined, at: () => ({ steering: undefined }), event: (name) => (events.push(name), name === "praise" ? { state: "cheerful", from: "neutral", cause: `event ${name}` } : undefined) }));
    expect(hooks.raise("s1", "praise")).toEqual({ state: "cheerful", from: "neutral", cause: "event praise" });
    expect(hooks.raise("s1", "nothing")).toBeUndefined();
    expect(events).toEqual(["praise", "nothing"]);
    const plain = sessionHooks(() => ({ layer: 5, initial: () => undefined, at: () => ({ steering: undefined }) }));
    expect(plain.raise("s1", "praise")).toBeUndefined();
  });

  it("SG2.5 a JSON response format is decoded under a JSON Schema constraint", async () => {
    const c = constraint([[1], [0]]);
    const asked: unknown[] = [];
    const model = steeredModel({ modelId: "kernel", session: new FakeSession([1, 0]), tokenizer: withText, constrain: async (x) => (asked.push(x), c.tc) });
    await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "a" }] }], responseFormat: { type: "json", schema: { type: "integer" } } });
    expect(asked).toEqual([{ type: "json-schema", schema: { type: "integer" } }]);
  });
});
