import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { experimental_evaluate, streamText } from "ai";
import * as ortNode from "onnxruntime-node";
import { bytes, constrain, parseCatalog, route, sha256 } from "@harness/cognitive";
import type { ModelDescriptor, Runtime } from "@harness/cognitive";
import { MemoryByteCache } from "@harness/models";
import { buildBrowserEnsemble, CacheStorageByteCache, xgrammarFromSource } from "@harness/platform-browser";
import type { CacheStorageLike } from "@harness/platform-browser";
import { fakeTransformers } from "../../models/test/fake-transformers.ts";
import { decisionFiles } from "../../models/test/decision-fixture.ts";
import { loadXGrammar } from "../../constrained/test/xgrammar.ts";

const data = (file: string) => JSON.parse(readFileSync(new URL(`../../cognitive/data/${file}`, import.meta.url), "utf8")) as unknown;
const catalog = parseCatalog(data("catalog.json"), data("benchmarks.json"));
/** The catalog's first browser model on a runtime: tests pick models by how they run, never by name. */
const byRuntime = <R extends Runtime>(runtime: R) => catalog.models.find((m) => m.runtime === runtime && m.platforms.includes("browser")) as Extract<ModelDescriptor, { runtime: R }>;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The Cache API as a browser has it, in memory. */
function fakeCaches(): CacheStorageLike & { opened: string[] } {
  const stores = new Map<string, Map<string, Uint8Array>>();
  const opened: string[] = [];
  return {
    opened,
    async open(name) {
      opened.push(name);
      const store = stores.get(name) ?? new Map<string, Uint8Array>();
      stores.set(name, store);
      return {
        match: async (url) => (store.has(url) ? new Response(store.get(url)! as Uint8Array<ArrayBuffer>) : undefined),
        put: async (url, response) => void store.set(url, new Uint8Array(await response.arrayBuffer())),
      };
    },
  };
}

/** A Cactus WASM engine small enough to write here: it loads when given WASM and routes to tool t. */
const engine = new TextEncoder().encode(`
  module.exports = async function (arg) {
    const heap = new Uint8Array(1 << 16); let next = 16;
    return {
      HEAPU8: heap,
      _malloc: (n) => { const p = next; next += Math.ceil((n + 8) / 16) * 16; return p; },
      _free: () => {},
      _tiny_load: () => (arg.wasmBinary.length > 0 ? 0 : -1),
      UTF8ToString: (p) => { let e = p; while (heap[e]) e++; return new TextDecoder().decode(heap.subarray(p, e)); },
      ccall: (name, _r, _t, args) => {
        if (name === "tiny_embed") return 2;
        if (name !== "tiny_complete") return 0;
        const reply = new TextEncoder().encode(JSON.stringify({ success: true, function_calls: [{ name: "t", arguments: {} }], confidence: 0.9, reasoning: "" }));
        heap.set(reply, args[2]); heap[args[2] + reply.length] = 0; return 1;
      },
    };
  };`);
const files = { "engine.js": engine, "engine.wasm": new Uint8Array([0, 97, 115, 109]), "weights.bin": new Uint8Array([1, 2, 3]) };
const cactus = (): Extract<ModelDescriptor, { runtime: "cactus-wasm" }> => {
  const m = byRuntime("cactus-wasm");
  return { ...m, run: { loader: "engine.js", wasm: "engine.wasm", weights: "weights.bin", prefix: "tiny" }, artifact: { ...m.artifact!, files: Object.entries(files).map(([path, b]) => ({ path, bytes: bytes(b.length), sha256: sha256(sha(b)) })) } };
};
function hub() {
  const asked: string[] = [];
  const serve = (async (url: string | URL | Request) => {
    asked.push(String(url));
    const path = Object.keys(files).find((p) => String(url).endsWith(`/${p}`));
    return path ? new Response(files[path as keyof typeof files] as Uint8Array<ArrayBuffer>) : new Response("missing", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch: serve, asked };
}

describe("the browser host's cognitive core", () => {
  it("BE1.1 every catalog model that runs in a browser is registered with its runtime's loader, and none is loaded yet", () => {
    const ensemble = buildBrowserEnsemble({ catalog, cache: new MemoryByteCache(), allowHosted: false });
    const expected = catalog.models.filter((m) => m.platforms.includes("browser") && m.locality !== "hosted").map((m) => m.id);
    expect(expected.length).toBeGreaterThan(0);
    expect(ensemble.members().map((m) => m.id).sort()).toEqual([...expected].sort());
    expect(ensemble.members().every((m) => m.state === "offline")).toBe(true);
    // runtimes a browser cannot run (llama-server, the steerable kernel) are not there
    expect(catalog.models.filter((m) => !m.platforms.includes("browser")).some((m) => ensemble.members().some((x) => x.id === m.id))).toBe(false);
  });

  it("BE1.2 transformers.js models load through their backends on the device asked for, and serve their tasks", async () => {
    const { module, log } = fakeTransformers({ generated: ["Paris"] });
    const ensemble = buildBrowserEnsemble({ catalog, cache: new MemoryByteCache(), allowHosted: false, transformers: module, device: "webgpu" });
    const chat = streamText({ model: ensemble.languageModel(), prompt: "capital?", maxRetries: 0 });
    expect(await chat.text).toBe("Paris");
    expect(JSON.stringify(log)).toContain('"device":"webgpu"');
  });

  it("BE1.3 a Cactus WASM model loads from verified files kept in the byte cache, and routes; the next host finds them there", async () => {
    const cache = new MemoryByteCache();
    const first = hub();
    const one = buildBrowserEnsemble({ catalog: { models: [cactus()], preferences: {} }, cache, fetch: first.fetch });
    expect(await route(one.languageModel("tool-calling", "router"), { input: "go", tools: [{ name: "t", description: "", parameters: {} }] })).toMatchObject({ valid: [{ name: "t", arguments: {} }] });
    expect(first.asked).toHaveLength(3);
    const second = hub();
    const two = buildBrowserEnsemble({ catalog: { models: [cactus()], preferences: {} }, cache, fetch: second.fetch, hub: "https://mirror.test" });
    await route(two.languageModel("tool-calling", "router"), { input: "go", tools: [{ name: "t", description: "", parameters: {} }] });
    expect(second.asked).toEqual([]);
  });

  it("BE1.4 an Emscripten loader that asks for a host module fails to load, and says which", async () => {
    const needy = new TextEncoder().encode(`require("fs"); module.exports = async () => ({});`);
    const m = cactus();
    const served = { ...files, "engine.js": needy };
    const model = { ...m, artifact: { ...m.artifact!, files: Object.entries(served).map(([path, b]) => ({ path, bytes: bytes(b.length), sha256: sha256(sha(b)) })) } };
    const serve = (async (url: string | URL | Request) => new Response(served[Object.keys(served).find((p) => String(url).endsWith(`/${p}`)) as keyof typeof served] as Uint8Array<ArrayBuffer>)) as typeof globalThis.fetch;
    const ensemble = buildBrowserEnsemble({ catalog: { models: [model], preferences: {} }, cache: new MemoryByteCache(), fetch: serve });
    await expect(route(ensemble.languageModel("tool-calling", "router"), { input: "go", tools: [{ name: "t", description: "", parameters: {} }] })).rejects.toMatchObject({ code: "no_member" });
    expect(ensemble.members()[0]).toMatchObject({ state: "failed", reason: expect.stringMatching(/engine\.js asked for fs, which this host does not provide/) });
  });

  it("BE1.5 a model that enforces constraints keeps that claim only with an XGrammar loader", () => {
    const constrained = catalog.models.filter((m) => m.platforms.includes("browser") && m.runtime === "transformers.js" && m.constraints && m.run.vocab);
    expect(constrained.length).toBeGreaterThan(0);
    const without = buildBrowserEnsemble({ catalog, cache: new MemoryByteCache(), allowHosted: false });
    const withIt = buildBrowserEnsemble({ catalog, cache: new MemoryByteCache(), allowHosted: false, xgrammar: async () => ({}) as never });
    for (const m of constrained) {
      expect(without.members().find((x) => x.id === m.id)?.descriptor.constraints).toBeUndefined();
      expect(withIt.members().find((x) => x.id === m.id)?.descriptor.constraints).toEqual(m.constraints);
    }
  });

  it("BE1.6 hosted models are registered when allowed, and need their credential from the environment given", async () => {
    const hosted = byRuntime("ai-gateway");
    const judges = { models: [hosted], preferences: {} };
    const noKey = buildBrowserEnsemble({ catalog: judges, cache: new MemoryByteCache() });
    await expect(noKey.resolve("judgment", "judge")).rejects.toMatchObject({ code: "no_member" });
    expect(noKey.members()[0]).toMatchObject({ reason: expect.stringMatching(/AI Gateway credential/) });
    expect((await buildBrowserEnsemble({ catalog: judges, cache: new MemoryByteCache(), env: { AI_GATEWAY_API_KEY: "k" } }).resolve("judgment", "judge")).id).toBe(hosted.id);
    expect(buildBrowserEnsemble({ catalog: judges, cache: new MemoryByteCache(), allowHosted: false }).members()).toEqual([]);
  });

  it("BE1.7 only the ids asked for are registered", () => {
    const [first] = catalog.models.filter((m) => m.platforms.includes("browser"));
    expect(buildBrowserEnsemble({ catalog, cache: new MemoryByteCache(), only: [first!.id] }).members().map((m) => m.id)).toEqual([first!.id]);
  });

  it("BE1.8 the Cache API byte cache keeps each key's bytes under a URL of its own, in the cache named", async () => {
    const caches = fakeCaches();
    const cache = new CacheStorageByteCache({ caches, name: "models-test" });
    expect(await cache.get("repo@rev/a.bin")).toBeUndefined();
    await cache.put("repo@rev/a.bin", new Uint8Array([1, 2]));
    await cache.put("repo@rev/../a.bin", new Uint8Array([9]));
    expect(await cache.get("repo@rev/a.bin")).toEqual(new Uint8Array([1, 2]));
    expect(await new CacheStorageByteCache({ caches, name: "models-test" }).get("repo@rev/../a.bin")).toEqual(new Uint8Array([9]));
    expect(caches.opened).toEqual(["models-test", "models-test"]);
    const byDefault = fakeCaches();
    Object.assign(globalThis, { caches: byDefault });
    try {
      await new CacheStorageByteCache().put("k", new Uint8Array([3]));
      expect(byDefault.opened).toEqual(["harness-models"]);
    } finally {
      delete (globalThis as { caches?: unknown }).caches;
    }
  });

  it("BE1.9 without the Cache API (an insecure page), the byte cache is still made and says why it cannot keep files", async () => {
    const cache = new CacheStorageByteCache();
    await expect(cache.get("k")).rejects.toThrow(/the Cache API is not available here \(it needs a secure context\); pass a cache/);
    await expect(cache.put("k", new Uint8Array([1]))).rejects.toThrow(/secure context/);
    expect(() => buildBrowserEnsemble({ catalog, allowHosted: false })).not.toThrow();
  });

  it("BE1.10 with an XGrammar loader, a constrained request to a transformers.js model is decoded under its constraint", async () => {
    // the fake model takes the best logit at each step: unconstrained, all are equal and token 0 wins
    const { module, log } = fakeTransformers({ generated: ["a", "b", ""] });
    // its tokenizer's vocabulary is plain letters, so the model's tokens are read as raw text
    const generator = catalog.models.find((m) => m.platforms.includes("browser") && m.runtime === "transformers.js" && m.constraints && m.ports.includes("generator")) as Extract<ModelDescriptor, { runtime: "transformers.js" }>;
    const raw = { models: [{ ...generator, run: { ...generator.run, vocab: "raw" as const } }], preferences: {} };
    const ensemble = buildBrowserEnsemble({ catalog: raw, cache: new MemoryByteCache(), transformers: module, xgrammar: async () => loadXGrammar() });
    const steps = () => log.filter((l) => l.name === "step").map((l) => l.args[1]);
    await streamText({ model: ensemble.languageModel(), prompt: "go", maxRetries: 0 }).text;
    expect(steps()).toEqual([0, 0, 0]);
    const held = streamText({ model: ensemble.languageModel(), prompt: "go", maxRetries: 0, ...constrain({ type: "regex", pattern: "ab" }) });
    expect(await held.text).toBe("ab");
    // masked by the constraint: a, then b, then only the end token
    expect(steps().slice(3)).toEqual([1, 2, 0]);
  });

  /** The catalog's decision model on tiny files (its weights as a separate file), and onnxruntime-web stood in for by onnxruntime-node, recording how sessions are made. */
  function decider() {
    const base = byRuntime("onnxruntime-decision");
    const run = { ...base.run, data: "weights.data" };
    const served: Record<string, Uint8Array> = { ...decisionFiles(run), "weights.data": new Uint8Array([1, 2, 3]) };
    const m = { ...base, run, artifact: { ...base.artifact!, files: Object.entries(served).map(([path, b]) => ({ path, bytes: bytes(b.length), sha256: sha256(sha(b)) })) } };
    const created: { model: unknown; options: unknown }[] = [];
    const runtime = {
      ...ortNode,
      env: { wasm: {} as { wasmPaths?: string } },
      InferenceSession: { create: async (model: Uint8Array, options?: object) => (created.push({ model, options }), ortNode.InferenceSession.create(model)) },
    };
    const fetch = (async (url: string | URL | Request) => {
      const path = Object.keys(served).find((p) => String(url).endsWith(`/${p}`));
      return path ? new Response(served[path] as Uint8Array<ArrayBuffer>) : new Response("missing", { status: 404 });
    }) as typeof globalThis.fetch;
    return { m, run, served, created, runtime, fetch };
  }
  const classify = (ensemble: ReturnType<typeof buildBrowserEnsemble>) =>
    experimental_evaluate({ model: ensemble.evaluationModel("classification"), maxRetries: 0, state: "a b", questions: { pick: { type: "choice", instructions: "which?", criteria: { first: "a", last: "b" } } } });

  it("BE1.12 a decision model loads its verified files, its weights as external data, onto onnxruntime-web on WebGPU (then WebAssembly), and classifies", async () => {
    const d = decider();
    const ensemble = buildBrowserEnsemble({ catalog: { models: [d.m], preferences: {} }, cache: new MemoryByteCache(), fetch: d.fetch, device: "webgpu", onnxruntime: d.runtime, onnxWasm: "https://cdn.example/ort/" });
    expect((await classify(ensemble)).answers.pick.choice).toBe("last");
    expect(d.created).toEqual([{ model: d.served[d.run.model], options: { executionProviders: ["webgpu", "wasm"], externalData: [{ path: "weights.data", data: d.served["weights.data"] }] } }]);
    expect(d.runtime.env.wasm.wasmPaths).toBe("https://cdn.example/ort/");
  });

  it("BE1.13 on WebAssembly when asked, or when the page has no WebGPU; a model with no weights file gets no external data", async () => {
    const d = decider();
    const plain = { ...d.m, run: (({ data: _, ...rest }) => rest)(d.run) };
    await classify(buildBrowserEnsemble({ catalog: { models: [plain], preferences: {} }, cache: new MemoryByteCache(), fetch: d.fetch, device: "wasm", onnxruntime: d.runtime }));
    expect(d.created.at(-1)!.options).toEqual({ executionProviders: ["wasm"] });
    // No device asked for: WebGPU if the page has it (Node has no navigator.gpu).
    await classify(buildBrowserEnsemble({ catalog: { models: [plain], preferences: {} }, cache: new MemoryByteCache(), fetch: d.fetch, onnxruntime: d.runtime }));
    expect(d.created.at(-1)!.options).toEqual({ executionProviders: ["wasm"] });
    expect(d.runtime.env.wasm.wasmPaths).toBeUndefined();
  });

  it("BE1.14 a model loads when the cache cannot keep its files (a storage quota), and the page hears why", async () => {
    const d = decider();
    const problems: string[] = [];
    const full = { get: async () => undefined, put: async () => Promise.reject(new Error("QuotaExceededError")) };
    const ensemble = buildBrowserEnsemble({ catalog: { models: [d.m], preferences: {} }, cache: full, fetch: d.fetch, device: "wasm", onnxruntime: d.runtime, onCacheProblem: (key, e) => problems.push(`${key.split("/").at(-1)}: ${String(e)}`) });
    expect((await classify(ensemble)).answers.pick.choice).toBe("last");
    expect(problems.sort()).toEqual(Object.keys(d.served).map((p) => `${p}: Error: QuotaExceededError`).sort());
  });

  it("BE1.11 an XGrammar loader from source evaluates it once, and again only when asked for a fresh instance", async () => {
    const load = xgrammarFromSource("module.exports = { instance: Symbol('xgrammar') };");
    const first = await load(false);
    expect(await load(false)).toBe(first);
    const fresh = await load(true);
    expect(fresh).not.toBe(first);
    expect(await load(false)).toBe(fresh);
  });
});
