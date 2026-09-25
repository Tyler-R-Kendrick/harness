import { describe, expect, it } from "vitest";
import { createProviderRegistry, embed, experimental_evaluate, generateText, jsonSchema, Output, streamText } from "ai";
import { convertArrayToReadableStream, Experimental_EvaluationMockModelV4, MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { bytes, CognitiveError, constrain, Ensemble, MODEL_HEADER, mirrorCapabilities, usage } from "@harness/cognitive";
import type { BenchmarkResult, EmbeddingModelV4, EvaluationModelV4, LanguageModelV4, ModelDescriptor, Ports, TaskCategory } from "@harness/cognitive";

function descriptor(id: string, tasks: readonly TaskCategory[], ports: ModelDescriptor["ports"], extra: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return { id, name: id, publisher: "t", tasks, ports, locality: "local", runtime: "transformers.js", run: { dtype: "q4" }, platforms: ["native", "browser"], license: "MIT", downloadBytes: bytes(1), benchmarks: [], ...extra } as ModelDescriptor;
}
const win = (benchmark: string, score: number, task: TaskCategory = "text-embedding"): BenchmarkResult => ({ benchmark, task, metric: "m", score, higherIsBetter: true });

const embedder = (tag: number): EmbeddingModelV4 => new MockEmbeddingModelV4({ doEmbed: async ({ values }) => ({ embeddings: values.map(() => [tag]), warnings: [] }) });
const judge: EvaluationModelV4 = new Experimental_EvaluationMockModelV4({ doEvaluate: async () => ({ answers: { ok: { type: "boolean", probability: 0.9 } }, warnings: [] }) });
const generator = (text: string): LanguageModelV4 =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: text },
        { type: "text-end", id: "0" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage() },
      ]),
    }),
    doGenerate: async () => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: undefined }, usage: usage(), warnings: [] }),
  });
const vector = async (e: Ensemble, value = "x") => (await embed({ model: e.embeddingModel(), value, maxRetries: 0 })).embedding;
const ask = (e: Ensemble, questions: Record<string, { type: "boolean"; instructions: string }> = { ok: { type: "boolean", instructions: "?" } }) => experimental_evaluate({ model: e.evaluationModel(), state: "s", questions, maxRetries: 0 });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe("Ensemble", () => {
  it("EN1.1 members for another platform are refused; duplicate ids are refused", () => {
    const e = new Ensemble({ platform: "browser" });
    expect(() => e.register(descriptor("n", ["chat"], ["generator"], { platforms: ["native"] }), async () => ({}))).toThrow(/browser/);
    e.register(descriptor("a", ["chat"], ["generator"]), async () => ({}));
    expect(() => e.register(descriptor("a", ["chat"], ["generator"]), async () => ({}))).toThrow(/already/);
  });

  it("EN1.2 a member loads on first use, once, and reports offline -> loading -> ready", async () => {
    const e = new Ensemble({ platform: "native" });
    const states: string[] = [];
    e.onChange((ev) => states.push(`${ev.id}:${ev.state}`));
    let loads = 0;
    e.register(descriptor("emb", ["text-embedding"], ["embedder"]), async () => (loads++, { embedder: embedder(7) }));
    expect(e.state("emb")).toBe("offline");
    const [a, b] = await Promise.all([vector(e, "x"), vector(e, "y")]);
    expect(a).toEqual([7]);
    expect(b).toEqual([7]);
    expect(loads).toBe(1);
    expect(states).toEqual(["emb:loading", "emb:ready"]);
  });

  it("EN1.3 the best-ranked member serves the task; a member that fails to load is skipped and marked failed", async () => {
    const e = new Ensemble({ platform: "native" });
    e.register(descriptor("weak", ["text-embedding"], ["embedder"], { benchmarks: [win("MTEB", 50)] }), async () => ({ embedder: embedder(1) }));
    e.register(descriptor("strong", ["text-embedding"], ["embedder"], { benchmarks: [win("MTEB", 60)] }), async () => {
      throw new Error("weights missing");
    });
    expect(await vector(e, "d")).toEqual([1]);
    expect(e.state("strong")).toBe("failed");
    expect(e.members().find((m) => m.id === "strong")!.reason).toMatch(/weights missing/);
    e.reset("strong");
    expect(e.state("strong")).toBe("offline");
  });

  it("EN1.4 revoking takes a member out of service at once; restoring brings it back", async () => {
    const e = new Ensemble({ platform: "native" });
    const events: string[] = [];
    e.onChange((ev) => events.push(`${ev.id}:${ev.state}${ev.reason ? `(${ev.reason})` : ""}`));
    e.register(descriptor("a", ["text-embedding"], ["embedder"], { benchmarks: [win("MTEB", 60)] }), async () => ({ embedder: embedder(1) }));
    e.register(descriptor("b", ["text-embedding"], ["embedder"], { benchmarks: [win("MTEB", 50)] }), async () => ({ embedder: embedder(2) }));
    expect(await vector(e)).toEqual([1]);
    e.revoke("a", "webgpu lost");
    expect(e.state("a")).toBe("revoked");
    expect(await vector(e)).toEqual([2]);
    e.restore("a");
    expect(e.state("a")).toBe("offline");
    expect(await vector(e)).toEqual([1]);
    expect(events).toContain("a:revoked(webgpu lost)");
  });

  it("EN1.5 a member revoked while loading does not become ready", async () => {
    const e = new Ensemble({ platform: "native" });
    const gate = deferred<Ports>();
    e.register(descriptor("slow", ["text-embedding"], ["embedder"]), () => gate.promise);
    const pending = vector(e);
    await Promise.resolve();
    e.revoke("slow", "platform withdrew it");
    gate.resolve({ embedder: embedder(1) });
    await expect(pending).rejects.toMatchObject({ code: "no_member" });
    expect(e.state("slow")).toBe("revoked");
  });

  it("EN1.6 no member for a task is a no_member error naming the task and platform", async () => {
    const e = new Ensemble({ platform: "browser" });
    const error = await ask(e).catch((x: unknown) => x);
    expect(error).toBeInstanceOf(CognitiveError);
    expect(error).toMatchObject({ code: "no_member", message: expect.stringMatching(/judgment.*browser/) });
  });

  it("EN1.7 a member whose adapter lacks the port it declared is marked failed", async () => {
    const e = new Ensemble({ platform: "native" });
    e.register(descriptor("liar", ["judgment"], ["judge"]), async () => ({}));
    await expect(ask(e)).rejects.toMatchObject({ code: "no_member" });
    expect(e.members()[0]).toMatchObject({ state: "failed", reason: expect.stringMatching(/judge/) });
  });

  it("EN1.8 the ensemble is an AI SDK language model per task: calls stream the chosen member's output", async () => {
    const e = new Ensemble({ platform: "native" });
    e.register(descriptor("chatty", ["chat"], ["generator"]), async () => ({ generator: generator("hi") }));
    e.register(descriptor("seer", ["vision-qa"], ["generator"]), async () => ({ generator: generator("a cat") }));
    const chat = streamText({ model: e.languageModel(), prompt: "hello", maxRetries: 0 });
    expect(await chat.text).toBe("hi");
    expect((await chat.response).headers?.[MODEL_HEADER]).toBe("chatty");
    expect((await generateText({ model: e.languageModel("vision-qa"), prompt: "what is this?", maxRetries: 0 })).text).toBe("a cat");
    await expect(generateText({ model: e.languageModel("judgment"), prompt: "?", maxRetries: 0 })).rejects.toThrow(/generator/);
    expect(e.languageModel("tool-calling", "router").modelId).toBe("tool-calling/router");
  });

  it("EN1.9 judge and compress delegate to members serving those tasks, naming the member", async () => {
    const e = new Ensemble({ platform: "native" });
    e.register(descriptor("judge-a", ["judgment"], ["judge"], { locality: "hosted" }), async () => ({ judge }));
    e.register(descriptor("compressor-a", ["prompt-compression"], ["compressor"]), async () => ({
      compressor: { compress: async (r) => ({ text: r.text.slice(0, 2), originalTokens: 4, compressedTokens: 2 }) },
    }));
    const verdict = await ask(e, { ok: { type: "boolean", instructions: "?" } });
    expect(verdict.answers).toEqual({ ok: { type: "boolean", probability: 0.9 } });
    expect(verdict.response.headers?.[MODEL_HEADER]).toBe("judge-a");
    expect(await e.compress({ text: "abcd", rate: 0.5 })).toEqual({ text: "ab", originalTokens: 4, compressedTokens: 2, model: "compressor-a" });
    expect(e.candidates("judgment").map((c) => c.id)).toEqual(["judge-a"]);
    expect(e.serves("judgment", "judge")).toBe(true);
    expect(e.serves("judgment", "generator")).toBe(false);
  });

  it("EN1.12 a constrained call goes first to members whose catalog entry says they enforce that kind", async () => {
    const e = new Ensemble({ platform: "native", preferences: { chat: ["loose", "strict"] } });
    e.register(descriptor("loose", ["chat"], ["generator"]), async () => ({ generator: generator("free text") }));
    e.register(descriptor("strict", ["chat"], ["generator"], { constraints: ["json-schema", "template"] }), async () => ({ generator: generator('{"a":1}') }));
    expect((await generateText({ model: e.languageModel(), prompt: "p", maxRetries: 0 })).text).toBe("free text");
    const json = await generateText({ model: e.languageModel(), prompt: "p", maxRetries: 0, output: Output.object({ schema: jsonSchema<{ a: number }>({ type: "object" }) }) });
    expect(json.output).toEqual({ a: 1 });
    const templated = await generateText({ model: e.languageModel(), prompt: "p", maxRetries: 0, ...constrain({ type: "template", parts: ["x", { hole: "y" }] }) });
    expect(templated.response.headers?.[MODEL_HEADER]).toBe("strict");
    const grammar = await generateText({ model: e.languageModel(), prompt: "p", maxRetries: 0, ...constrain({ type: "grammar", ebnf: 'root ::= "a"' }) });
    expect(grammar.response.headers?.[MODEL_HEADER]).toBe("loose");
  });

  it("EN1.13 as an AI SDK provider, model ids are tasks, optionally with the port kind", async () => {
    const e = new Ensemble({ platform: "native" });
    e.register(descriptor("chatty", ["chat"], ["generator"]), async () => ({ generator: generator("hi") }));
    e.register(descriptor("emb", ["text-embedding"], ["embedder"]), async () => ({ embedder: embedder(3) }));
    e.register(descriptor("judge-a", ["judgment"], ["judge"]), async () => ({ judge }));
    const registry = createProviderRegistry({ harness: e.provider() });
    expect((await generateText({ model: registry.languageModel("harness:chat"), prompt: "p", maxRetries: 0 })).text).toBe("hi");
    expect((await embed({ model: registry.embeddingModel("harness:text-embedding"), value: "v", maxRetries: 0 })).embedding).toEqual([3]);
    const provider = e.provider();
    expect(provider.languageModel("tool-calling/router").modelId).toBe("tool-calling/router");
    expect(provider.evaluationModel("judgment").modelId).toBe("judgment");
    for (const bad of ["dancing", "chat/judge", "chat/router/x"]) expect(() => provider.languageModel(bad)).toThrow(/No such languageModel/);
    expect(() => provider.embeddingModel("nope")).toThrow(/No such embeddingModel/);
    expect(() => provider.imageModel("chat")).toThrow(/No such imageModel/);
  });

  it("EN1.11 per-task preferences break ties that benchmarks cannot", () => {
    const e = new Ensemble({ platform: "native", preferences: { chat: ["b"] } });
    e.register(descriptor("a", ["chat"], ["generator"]), async () => ({}));
    e.register(descriptor("b", ["chat"], ["generator"]), async () => ({}));
    expect(e.candidates("chat").map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("EN1.10 hosted members are skipped when the policy is local-only; a pin wins when eligible", async () => {
    const e = new Ensemble({ platform: "native", selection: { allowHosted: false }, pins: { "text-embedding": "b" } });
    e.register(descriptor("h", ["judgment"], ["judge"], { locality: "hosted" }), async () => ({ judge }));
    e.register(descriptor("a", ["text-embedding"], ["embedder"], { benchmarks: [win("MTEB", 60)] }), async () => ({ embedder: embedder(1) }));
    e.register(descriptor("b", ["text-embedding"], ["embedder"], { benchmarks: [win("MTEB", 50)] }), async () => ({ embedder: embedder(2) }));
    expect(e.candidates("judgment")).toEqual([]);
    expect(e.candidates("text-embedding").map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("extensions", () => {
  const memory = { id: "memory", models: [{ descriptor: descriptor("embedder-a", ["text-embedding"], ["embedder"]), load: async () => ({ embedder: embedder(7) }) }] };

  it("EN2.1 an extension brings its models at runtime, and takes them away again; capabilities follow", async () => {
    const e = new Ensemble({ platform: "native" });
    const offered = new Set<string>();
    mirrorCapabilities(e, { offer: (n) => offered.add(n), withdraw: (n) => offered.delete(n) });
    const events: string[] = [];
    e.onChange((ev) => events.push(`${ev.id}:${ev.state}`));
    expect(offered.has("cognitive.text-embedding")).toBe(false);
    const uninstall = e.install(memory);
    expect(offered.has("cognitive.text-embedding")).toBe(true);
    expect(await vector(e)).toEqual([7]);
    uninstall();
    expect(offered.has("cognitive.text-embedding")).toBe(false);
    expect(e.members()).toEqual([]);
    expect(events).toEqual(["embedder-a:offline", "memory:installed", "embedder-a:loading", "embedder-a:ready", "embedder-a:removed", "memory:uninstalled"]);
    await expect(vector(e)).rejects.toMatchObject({ code: "no_member" });
    uninstall();
    expect(events).toHaveLength(6);
    expect(e.install(memory)).toBeTypeOf("function");
  });

  it("EN2.2 an extension whose model is already there is refused whole", () => {
    const e = new Ensemble({ platform: "native" });
    e.register(descriptor("other", ["judgment"], ["judge"]), async () => ({}));
    const clash = { id: "clash", models: [{ descriptor: descriptor("fresh", ["chat"], ["generator"]), load: async () => ({}) }, { descriptor: descriptor("other", ["judgment"], ["judge"]), load: async () => ({}) }] };
    expect(() => e.install(clash)).toThrow(/other is already registered/);
    expect(e.members().map((m) => m.id)).toEqual(["other"]);
    const browserOnly = { id: "web", models: [{ descriptor: descriptor("fresh", ["chat"], ["generator"]), load: async () => ({}) }, { descriptor: descriptor("webgpu", ["chat"], ["generator"], { platforms: ["browser"] }), load: async () => ({}) }] };
    expect(() => e.install(browserOnly)).toThrow(/does not run on native/);
    expect(e.members().map((m) => m.id)).toEqual(["other"]);
  });

  it("EN2.3 an extension's operations are served under its name while it is installed", async () => {
    const e = new Ensemble({ platform: "native" });
    const ext = { ...memory, operations: { recall: async (input: unknown) => ({ echoed: input }) } };
    expect(e.operation("memory.recall")).toBeUndefined();
    const uninstall = e.install(ext);
    expect(await e.operation("memory.recall")!({ q: 1 })).toEqual({ echoed: { q: 1 } });
    expect(e.operation("memory.forget")).toBeUndefined();
    expect(e.operation("other.recall")).toBeUndefined();
    expect(e.extensions()).toEqual(["memory"]);
    uninstall();
    expect(e.operation("memory.recall")).toBeUndefined();
    expect(e.extensions()).toEqual([]);
  });

  it("EN2.4 the extension's capability is offered while one of its models is in service", async () => {
    const e = new Ensemble({ platform: "native" });
    const offered = new Set<string>();
    mirrorCapabilities(e, { offer: (n) => offered.add(n), withdraw: (n) => offered.delete(n) });
    const uninstall = e.install(memory);
    expect(offered.has("memory")).toBe(true);
    e.revoke("embedder-a", "no memory to spare");
    expect(offered.has("memory")).toBe(false);
    e.restore("embedder-a");
    expect(offered.has("memory")).toBe(true);
    uninstall();
    expect(offered.has("memory")).toBe(false);
  });

  it("EN2.5 an extension that requires another installs only after it, and serves while it serves", () => {
    const e = new Ensemble({ platform: "native" });
    const offered = new Set<string>();
    mirrorCapabilities(e, { offer: (n) => offered.add(n), withdraw: (n) => offered.delete(n) });
    const learning = { id: "learning", requires: ["memory"], models: [] };
    expect(() => e.install(learning)).toThrow("extension learning requires memory, which is not installed");
    e.install(memory);
    e.install(learning);
    expect([...offered].sort()).toEqual(["cognitive.text-embedding", "learning", "memory"]);
    e.revoke("embedder-a", "no memory to spare");
    expect(offered.has("learning")).toBe(false);
    e.restore("embedder-a");
    expect(e.extensions()).toEqual(["memory", "learning"]);
  });

  it("EN2.6 an extension others require cannot be uninstalled before them; a second install of one id is refused", () => {
    const e = new Ensemble({ platform: "native" });
    const uninstallMemory = e.install(memory);
    const uninstallLearning = e.install({ id: "learning", requires: ["memory"], models: [] });
    expect(() => uninstallMemory()).toThrow("extension memory is required by learning; uninstall it first");
    expect(e.extensions()).toEqual(["memory", "learning"]);
    expect(() => e.install({ id: "learning", models: [] })).toThrow("extension learning is already installed");
    uninstallLearning();
    uninstallMemory();
    expect(e.extensions()).toEqual([]);
  });
});

describe("failover on calls", () => {
  const failing = (error: unknown): EvaluationModelV4 => new Experimental_EvaluationMockModelV4({ doEvaluate: async () => Promise.reject(error) });
  const setup = (first: EvaluationModelV4) => {
    const e = new Ensemble({ platform: "native", preferences: { judgment: ["judge-a", "judge-b"] } });
    e.register(descriptor("judge-a", ["judgment"], ["judge"], { locality: "hosted" }), async () => ({ judge: first }));
    e.register(descriptor("judge-b", ["judgment"], ["judge"]), async () => ({ judge }));
    return e;
  };
  const questions = { ok: { type: "boolean" as const, instructions: "?" } };

  it("EN3.1 a member whose service is unavailable (out of budget, unauthorized, down) is taken out and the next one answers", async () => {
    for (const error of [Object.assign(new Error("Payment Required"), { statusCode: 402 }), Object.assign(new Error("fetch failed"), { isRetryable: true }), Object.assign(new Error("Bad Gateway"), { statusCode: 502 })]) {
      const e = setup(failing(error));
      const verdict = await ask(e, questions);
      expect(verdict.answers).toEqual({ ok: { type: "boolean", probability: 0.9 } });
      expect(verdict.response.headers?.[MODEL_HEADER]).toBe("judge-b");
      expect(e.members().find((m) => m.id === "judge-a")).toMatchObject({ state: "failed", reason: error.message });
    }
  });

  it("EN3.2 a request the service rejects, or a plain error, is the caller's to see: no failover", async () => {
    for (const error of [Object.assign(new Error("invalid questions"), { statusCode: 422 }), Object.assign(new Error("bad request"), { statusCode: 400 }), new Error("bug")]) {
      const e = setup(failing(error));
      await expect(ask(e, questions)).rejects.toBe(error);
      expect(e.state("judge-a")).toBe("ready");
    }
  });

  it("EN3.3 when every member is unavailable the last service error is reported", async () => {
    const e = new Ensemble({ platform: "native" });
    const down = Object.assign(new Error("Service Unavailable"), { statusCode: 503 });
    e.register(descriptor("judge-a", ["judgment"], ["judge"]), async () => ({ judge: failing(down) }));
    await expect(ask(e, questions)).rejects.toBe(down);
    await expect(ask(e, questions)).rejects.toMatchObject({ code: "no_member" });
  });

  it("EN3.4 streams and embeddings fail over the same way when a member cannot start the call", async () => {
    const e = new Ensemble({ platform: "native", preferences: { chat: ["down", "up"], "text-embedding": ["down-emb", "up-emb"] } });
    const outage = Object.assign(new Error("Service Unavailable"), { statusCode: 503 });
    e.register(descriptor("down", ["chat"], ["generator"]), async () => ({ generator: new MockLanguageModelV4({ doStream: async () => Promise.reject(outage) }) }));
    e.register(descriptor("up", ["chat"], ["generator"]), async () => ({ generator: generator("still here") }));
    e.register(descriptor("down-emb", ["text-embedding"], ["embedder"]), async () => ({ embedder: new MockEmbeddingModelV4({ doEmbed: async () => Promise.reject(outage) }) }));
    e.register(descriptor("up-emb", ["text-embedding"], ["embedder"]), async () => ({ embedder: embedder(5) }));
    const chat = streamText({ model: e.languageModel(), prompt: "p", maxRetries: 0 });
    expect(await chat.text).toBe("still here");
    expect(e.state("down")).toBe("failed");
    expect(await vector(e)).toEqual([5]);
    expect(e.state("down-emb")).toBe("failed");
  });
});
