import { describe, expect, it } from "vitest";
import { CognitiveError, Ensemble, mirrorCapabilities } from "@harness/cognitive";
import type { BenchmarkResult, Embedder, GenerationEvent, Generator, Judge, ModelDescriptor, Ports, TaskCategory } from "@harness/cognitive";

function descriptor(id: string, tasks: readonly TaskCategory[], ports: ModelDescriptor["ports"], extra: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return { id, name: id, publisher: "t", tasks, ports, locality: "local", runtime: "transformers.js", platforms: ["native", "browser"], license: "MIT", downloadBytes: 1, benchmarks: [], ...extra };
}
const win = (benchmark: string, score: number, task: TaskCategory = "text-embedding"): BenchmarkResult => ({ benchmark, task, metric: "m", score, higherIsBetter: true, source: "https://example.test" });

const embedder = (tag: number): Embedder => ({ dimensions: 1, embed: async (inputs) => inputs.map(() => new Float32Array([tag])) });
const judge: Judge = { evaluate: async () => ({ ok: { type: "boolean", probability: 0.9 } }) };
const generator = (text: string): Generator => ({
  async *generate(): AsyncIterable<GenerationEvent> {
    yield { type: "text", text };
    yield { type: "finish", reason: "stop" };
  },
});

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
    const [a, b] = await Promise.all([e.embed([{ kind: "query", text: "x" }]), e.embed([{ kind: "query", text: "y" }])]);
    expect(Array.from(a[0]!)).toEqual([7]);
    expect(Array.from(b[0]!)).toEqual([7]);
    expect(loads).toBe(1);
    expect(states).toEqual(["emb:loading", "emb:ready"]);
  });

  it("EN1.3 the best-ranked member serves the task; a member that fails to load is skipped and marked failed", async () => {
    const e = new Ensemble({ platform: "native" });
    e.register(descriptor("weak", ["text-embedding"], ["embedder"], { benchmarks: [win("MTEB", 50)] }), async () => ({ embedder: embedder(1) }));
    e.register(descriptor("strong", ["text-embedding"], ["embedder"], { benchmarks: [win("MTEB", 60)] }), async () => {
      throw new Error("weights missing");
    });
    const [v] = await e.embed([{ kind: "document", text: "d" }]);
    expect(Array.from(v!)).toEqual([1]);
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
    expect(Array.from((await e.embed([{ kind: "query", text: "q" }]))[0]!)).toEqual([1]);
    e.revoke("a", "webgpu lost");
    expect(e.state("a")).toBe("revoked");
    expect(Array.from((await e.embed([{ kind: "query", text: "q" }]))[0]!)).toEqual([2]);
    e.restore("a");
    expect(e.state("a")).toBe("offline");
    expect(Array.from((await e.embed([{ kind: "query", text: "q" }]))[0]!)).toEqual([1]);
    expect(events).toContain("a:revoked(webgpu lost)");
  });

  it("EN1.5 a member revoked while loading does not become ready", async () => {
    const e = new Ensemble({ platform: "native" });
    const gate = deferred<Ports>();
    e.register(descriptor("slow", ["text-embedding"], ["embedder"]), () => gate.promise);
    const pending = e.embed([{ kind: "query", text: "q" }]);
    await Promise.resolve();
    e.revoke("slow", "platform withdrew it");
    gate.resolve({ embedder: embedder(1) });
    await expect(pending).rejects.toMatchObject({ code: "no_member" });
    expect(e.state("slow")).toBe("revoked");
  });

  it("EN1.6 no member for a task is a no_member error naming the task and platform", async () => {
    const e = new Ensemble({ platform: "browser" });
    const error = await e.judge({ state: "s", questions: {} }).catch((x: unknown) => x);
    expect(error).toBeInstanceOf(CognitiveError);
    expect(error).toMatchObject({ code: "no_member", message: expect.stringMatching(/judgment.*browser/) });
  });

  it("EN1.7 a member whose adapter lacks the port it declared is marked failed", async () => {
    const e = new Ensemble({ platform: "native" });
    e.register(descriptor("liar", ["judgment"], ["judge"]), async () => ({}));
    await expect(e.judge({ state: "s", questions: {} })).rejects.toMatchObject({ code: "no_member" });
    expect(e.members()[0]).toMatchObject({ state: "failed", reason: expect.stringMatching(/judge/) });
  });

  it("EN1.8 generate streams the chosen member's events for the requested task", async () => {
    const e = new Ensemble({ platform: "native" });
    e.register(descriptor("chatty", ["chat"], ["generator"]), async () => ({ generator: generator("hi") }));
    e.register(descriptor("seer", ["vision-qa"], ["generator"]), async () => ({ generator: generator("a cat") }));
    const collect = async (it: AsyncIterable<GenerationEvent>) => {
      const out: GenerationEvent[] = [];
      for await (const ev of it) out.push(ev);
      return out;
    };
    expect(await collect(e.generate({ messages: [{ role: "user", content: "hello" }] }))).toEqual([{ type: "text", text: "hi" }, { type: "finish", reason: "stop" }]);
    expect((await collect(e.generate({ messages: [{ role: "user", content: "what is this?" }] }, "vision-qa")))[0]).toEqual({ type: "text", text: "a cat" });
    await expect(collect(e.generate({ messages: [] }, "judgment"))).rejects.toThrow(/generator/);
  });

  it("EN1.9 judge, route and compress delegate to members serving those tasks", async () => {
    const e = new Ensemble({ platform: "native" });
    e.register(descriptor("jev", ["judgment"], ["judge"], { locality: "hosted" }), async () => ({ judge }));
    e.register(descriptor("needle", ["tool-calling"], ["router"]), async () => ({
      router: { route: async (r) => ({ calls: [{ name: r.tools[0]!.name, arguments: {} }], confidence: 1, reasoning: "" }) },
    }));
    e.register(descriptor("lingua", ["prompt-compression"], ["compressor"]), async () => ({
      compressor: { compress: async (r) => ({ text: r.text.slice(0, 2), originalTokens: 4, compressedTokens: 2 }) },
    }));
    expect(await e.judge({ state: "s", questions: { ok: { type: "boolean", instructions: "?" } } })).toEqual({ ok: { type: "boolean", probability: 0.9 } });
    expect((await e.route({ input: "go", tools: [{ name: "t", description: "", parameters: {} }] })).calls).toEqual([{ name: "t", arguments: {} }]);
    expect((await e.compress({ text: "abcd", rate: 0.5 })).text).toBe("ab");
    expect(e.candidates("judgment").map((c) => c.id)).toEqual(["jev"]);
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
  const memory = { id: "memory", models: [{ descriptor: descriptor("gemma", ["text-embedding"], ["embedder"]), load: async () => ({ embedder: embedder(7) }) }] };

  it("EN2.1 an extension brings its models at runtime, and takes them away again; capabilities follow", async () => {
    const e = new Ensemble({ platform: "native" });
    const offered = new Set<string>();
    mirrorCapabilities(e, { offer: (n) => offered.add(n), withdraw: (n) => offered.delete(n) });
    const events: string[] = [];
    e.onChange((ev) => events.push(`${ev.id}:${ev.state}`));
    expect(offered.has("cognitive.text-embedding")).toBe(false);
    const uninstall = e.install(memory);
    expect(offered.has("cognitive.text-embedding")).toBe(true);
    expect(Array.from((await e.embed([{ kind: "query", text: "x" }]))[0]!)).toEqual([7]);
    uninstall();
    expect(offered.has("cognitive.text-embedding")).toBe(false);
    expect(e.members()).toEqual([]);
    expect(events).toContain("gemma:removed");
    await expect(e.embed([{ kind: "query", text: "x" }])).rejects.toMatchObject({ code: "no_member" });
    uninstall();
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
    e.revoke("gemma", "no memory to spare");
    expect(offered.has("memory")).toBe(false);
    e.restore("gemma");
    expect(offered.has("memory")).toBe(true);
    uninstall();
    expect(offered.has("memory")).toBe(false);
  });
});

describe("failover on calls", () => {
  const failing = (error: unknown): Judge => ({ evaluate: async () => Promise.reject(error) });
  const answering: Judge = { evaluate: async () => ({ ok: { type: "boolean", probability: 0.9 } }) };
  const request = { state: "s", questions: { ok: { type: "boolean" as const, instructions: "?" } } };
  const setup = (first: Judge) => {
    const e = new Ensemble({ platform: "native", preferences: { judgment: ["jev", "clm"] } });
    e.register(descriptor("jev", ["judgment"], ["judge"], { locality: "hosted" }), async () => ({ judge: first }));
    e.register(descriptor("clm", ["judgment"], ["judge"]), async () => ({ judge: answering }));
    return e;
  };

  it("EN3.1 a member whose service is unavailable (out of budget, unauthorized, down) is taken out and the next one answers", async () => {
    for (const error of [Object.assign(new Error("Payment Required"), { statusCode: 402 }), Object.assign(new Error("fetch failed"), { isRetryable: true }), Object.assign(new Error("Bad Gateway"), { statusCode: 502 })]) {
      const e = setup(failing(error));
      expect(await e.judge(request)).toEqual({ ok: { type: "boolean", probability: 0.9 } });
      expect(e.members().find((m) => m.id === "jev")).toMatchObject({ state: "failed", reason: error.message });
    }
  });

  it("EN3.2 a request the service rejects, or a plain error, is the caller's to see: no failover", async () => {
    for (const error of [Object.assign(new Error("invalid questions"), { statusCode: 422 }), Object.assign(new Error("bad request"), { statusCode: 400 }), new Error("bug")]) {
      const e = setup(failing(error));
      await expect(e.judge(request)).rejects.toBe(error);
      expect(e.state("jev")).toBe("ready");
    }
  });

  it("EN3.3 when every member is unavailable the last service error is reported", async () => {
    const e = new Ensemble({ platform: "native" });
    const down = Object.assign(new Error("Service Unavailable"), { statusCode: 503 });
    e.register(descriptor("jev", ["judgment"], ["judge"]), async () => ({ judge: failing(down) }));
    await expect(e.judge(request)).rejects.toBe(down);
    await expect(e.judge(request)).rejects.toMatchObject({ code: "no_member" });
  });
});

