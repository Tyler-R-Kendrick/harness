import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { streamText } from "ai";
import { bytes, parseCatalog, route, sha256 } from "@harness/cognitive";
import type { ModelDescriptor, Runtime } from "@harness/cognitive";
import { MemoryByteCache } from "@harness/models";
import { buildBrowserEnsemble, CacheStorageByteCache } from "@harness/platform-browser";
import type { CacheStorageLike } from "@harness/platform-browser";
import { fakeTransformers } from "../../models/test/fake-transformers.ts";

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
});
