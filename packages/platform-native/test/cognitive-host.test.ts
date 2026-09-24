import { describe, expect, it } from "vitest";
import { invokeCognitive, rankForTask, TASK_CATEGORIES } from "@harness/cognitive";
import type { Runtime } from "@harness/cognitive";
import { buildNativeEnsemble, loadCatalog } from "@harness/platform-native";

const catalog = loadCatalog();
const native = catalog.models.filter((m) => m.platforms.includes("native"));
/** The catalog's first model on a runtime: tests pick models by how they run, never by name. */
const byRuntime = <R extends Runtime>(runtime: R) => catalog.models.find((m) => m.runtime === runtime) as Extract<(typeof catalog.models)[number], { runtime: R }>;

describe("native cognitive host", () => {
  it("CH1.1 registers every catalog model that runs natively, without loading any; embedders come only with memory", async () => {
    const { ensemble, close } = buildNativeEnsemble({ cacheDir: "/nonexistent/cache", llamaServer: "/usr/local/bin/llama-server" });
    expect(ensemble.members().map((m) => m.id)).toEqual(native.map((m) => m.id));
    expect(ensemble.members().every((m) => m.state === "offline")).toBe(true);
    expect(ensemble.candidates("text-embedding")).toEqual([]);
    await close();
  });

  it("CH1.2 llama.cpp-server models need a llama-server binary; hosted models can be turned off", async () => {
    const { ensemble, close } = buildNativeEnsemble({ cacheDir: "/nonexistent/cache", allowHosted: false });
    const expected = native.filter((m) => m.runtime !== "llama.cpp-server" && m.locality !== "hosted");
    expect(expected.length).toBeLessThan(native.length);
    expect(ensemble.members().map((m) => m.id)).toEqual(expected.map((m) => m.id));
    await close();
  });

  it("CH1.3 selection uses the catalog's benchmarks and preferences", async () => {
    const { ensemble, close } = buildNativeEnsemble({ cacheDir: "/nonexistent/cache", llamaServer: "/bin/llama-server" });
    for (const task of TASK_CATEGORIES) {
      const prefer = catalog.preferences[task];
      const expected = rankForTask(task, native, { platform: "native", allowHosted: true, ...(prefer ? { prefer } : {}) });
      expect(ensemble.candidates(task).map((c) => c.id), task).toEqual(expected.map((c) => c.id));
    }
    await close();
  });

  it("CH1.4 a model whose weights cannot be fetched fails to load and the next model takes over", async () => {
    const offline = (async () => new Response("offline", { status: 503 })) as typeof fetch;
    const router = byRuntime("cactus-wasm");
    const { ensemble, close } = buildNativeEnsemble({ cacheDir: "/nonexistent/cache", allowHosted: false, fetch: offline, only: [router.id] });
    await expect(ensemble.route({ input: "x", tools: [{ name: "t", description: "", parameters: {} }] })).rejects.toMatchObject({ code: "no_member" });
    expect(ensemble.members()[0]).toMatchObject({ state: "failed", reason: expect.stringMatching(/503/) });
    await close();
  });
});

// ---- loaders, driven against fakes -----------------------------------------------------------

import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { ModelDescriptor } from "@harness/cognitive";
import { fakeTransformers } from "../../models/test/fake-transformers.ts";
import { encodeModel } from "../../models/test/onnx-builder.ts";
import { compilePack, defineGraph } from "@harness/behavior";

const tmp: string[] = [];
afterEach(async () => {
  await Promise.all(tmp.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tempDir(prefix: string) {
  const d = await mkdtemp(join(tmpdir(), prefix));
  tmp.push(d);
  return d;
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const only = (...models: ModelDescriptor[]) => ({ models, preferences: {} });

/** Replace a catalog entry's weights with small files served by a fake Hugging Face, and its run settings to match. */
function withFakeFiles<M extends ModelDescriptor>(m: M, files: Record<string, Uint8Array>, run: M["run"]): M {
  return { ...m, run, artifact: { ...m.artifact!, files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) })) } };
}
function fakeHub(files: Record<string, Uint8Array>) {
  return (async (url: string | URL | Request) => {
    const path = Object.keys(files).find((p) => String(url).endsWith(`/${p}`));
    return path ? new Response(files[path] as Uint8Array<ArrayBuffer>) : new Response("missing", { status: 404 });
  }) as typeof fetch;
}

describe("native cognitive host loaders", () => {
  it("CH2.1 the transformers.js models load through their backends and serve their tasks", async () => {
    const { module } = fakeTransformers({ generated: ["Paris"] });
    const { ensemble, close } = buildNativeEnsemble({ cacheDir: await tempDir("cache-"), allowHosted: false, transformers: module, memory: {} });
    expect((await ensemble.embed([{ kind: "query", text: "x" }]))[0]).toBeInstanceOf(Float32Array);
    expect((await ensemble.compress({ text: "one two three four", rate: 1 })).text).toBe("one two three four");
    let reply = "";
    for await (const e of ensemble.generate({ messages: [{ role: "user", content: "capital?" }] })) if (e.type === "text") reply += e.text;
    expect(reply).toBe("Paris");
    const { pages } = await ensemble.parseDocument({ pages: [{ mediaType: "image/png", data: new Uint8Array([1]) }] }, "table-extraction");
    expect(pages[0]!.markdown).toBe("Paris");
    await close();
  });

  it("CH2.2 a hosted judge needs its gateway credential; a server judge must answer its health check, at the address its env names", async () => {
    const hosted = byRuntime("ai-gateway");
    const server = { ...byRuntime("typesafe-api"), run: { baseUrl: "http://127.0.0.1:1", model: "m", health: "/health", baseUrlEnv: "JUDGE_URL", apiKeyEnv: "JUDGE_KEY" } };
    const judges = { models: [hosted, server], preferences: { judgment: [hosted.id, server.id] } };
    const up = (async (url: string | URL | Request) => (String(url) === "http://judge.test/health" ? Response.json({ ok: true }) : Promise.reject(new Error("ECONNREFUSED")))) as typeof fetch;
    const withKey = buildNativeEnsemble({ cacheDir: await tempDir("cache-"), catalog: judges, env: { AI_GATEWAY_API_KEY: "k" }, fetch: up });
    expect((await withKey.ensemble.resolve("judgment", "judge")).id).toBe(hosted.id);
    const withServer = buildNativeEnsemble({ cacheDir: await tempDir("cache-"), catalog: judges, env: { JUDGE_URL: "http://judge.test/" }, fetch: up });
    expect((await withServer.ensemble.resolve("judgment", "judge")).id).toBe(server.id);
    expect(withServer.ensemble.members().find((m) => m.id === hosted.id)).toMatchObject({ state: "failed", reason: expect.stringMatching(/AI Gateway credential/) });
    const neither = buildNativeEnsemble({ cacheDir: await tempDir("cache-"), catalog: judges, env: {}, fetch: up });
    await expect(neither.ensemble.resolve("judgment", "judge")).rejects.toMatchObject({ code: "no_member" });
    expect(neither.ensemble.members().find((m) => m.id === server.id)).toMatchObject({ reason: `${server.name} is not answering at http://127.0.0.1:1; start its server or set JUDGE_URL` });
    await Promise.all([withKey.close(), withServer.close(), neither.close()]);
  });

  it("CH2.3 a Cactus WASM model loads from verified artifacts, under its C API prefix and environment, and routes", async () => {
    const loader = new TextEncoder().encode(`
      module.exports = async function (arg) {
        const heap = new Uint8Array(1 << 16); let next = 16; let out = 0;
        return {
          HEAPU8: heap,
          _malloc: (n) => { const p = next; next += Math.ceil((n + 8) / 16) * 16; return p; },
          _free: () => {},
          _tiny_load: () => (arg.wasmBinary.length > 0 ? 0 : -1),
          UTF8ToString: (p) => { let e = p; while (heap[e]) e++; return new TextDecoder().decode(heap.subarray(p, e)); },
          ccall: (name, _r, _t, args) => {
            if (name === "tiny_embed") return 2;
            if (name !== "tiny_complete") return 0;
            const reply = new TextEncoder().encode(JSON.stringify({ success: true, function_calls: [{ name: "t", arguments: {} }], confidence: 0.99, reasoning: "" }));
            heap.set(reply, args[2]); heap[args[2] + reply.length] = 0; return 1;
          },
        };
      };`);
    const files = { "engine.js": loader, "engine.wasm": new Uint8Array([0, 97, 115, 109]), "weights.bin": new Uint8Array([1, 2, 3]) };
    const router = withFakeFiles(byRuntime("cactus-wasm"), files, { loader: "engine.js", wasm: "engine.wasm", weights: "weights.bin", prefix: "tiny", env: { HARNESS_TEST_ENGINE: "on" } });
    const { ensemble, close } = buildNativeEnsemble({ cacheDir: await tempDir("cache-"), allowHosted: false, catalog: only(router), fetch: fakeHub(files) });
    expect((await ensemble.route({ input: "go", tools: [{ name: "t", description: "", parameters: {} }] })).calls).toEqual([{ name: "t", arguments: {} }]);
    expect(process.env["HARNESS_TEST_ENGINE"]).toBe("on");
    delete process.env["HARNESS_TEST_ENGINE"];
    await close();
  });

  it("CH2.4 llama.cpp-server models start a llama-server on their downloaded weights and stop it on close", async () => {
    const dir = await tempDir("llama-");
    const binary = join(dir, "llama-server");
    const argsFile = join(dir, "args.json");
    await writeFile(
      binary,
      `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
require("node:http").createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("{}"); return; }
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "# Page" } }] }));
}).listen(port, "127.0.0.1");`,
    );
    await chmod(binary, 0o755);
    const files = { "model.gguf": new Uint8Array([1, 2]), "mmproj.gguf": new Uint8Array([3]) };
    const parser = withFakeFiles(catalog.models.find((m) => m.runtime === "llama.cpp-server" && m.ports.includes("document-parser")) as ReturnType<typeof byRuntime<"llama.cpp-server">>, files, { model: "model.gguf", projector: "mmproj.gguf", args: ["--flag"] });
    const { ensemble, close } = buildNativeEnsemble({ cacheDir: await tempDir("cache-"), allowHosted: false, catalog: only(parser), fetch: fakeHub(files), llamaServer: binary });
    const { pages } = await ensemble.parseDocument({ pages: [{ mediaType: "image/png", data: new Uint8Array([9]) }] });
    expect(pages[0]!.markdown).toBe("# Page");
    const args = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(argsFile, "utf8"))) as string[];
    expect(args).toEqual(expect.arrayContaining(["--mmproj", "--flag"]));
    await close();
  });

  // ---- the steerable kernel ------------------------------------------------------------------
  /** A small decoder's run settings: the tap node, the layer it carries, and the shapes the fakes below produce. */
  const KERNEL = {
    model: "export/cpu/model.onnx",
    tap: { node: "/model/layers.3/input_layernorm/SkipLayerNorm", steerInput: 1, residOutput: 3, layer: 2 },
    decoder: { layers: 2, kvHeads: 1, headSize: 4, hidden: 4 },
    endTokens: ["<|im_end|>"],
    template: { enable_thinking: false },
  };
  const kernel = (files: Record<string, Uint8Array>) => withFakeFiles(byRuntime("onnxruntime"), files, KERNEL);
  /** A one-node model carrying the tap node. */
  const kernelOnnx = () =>
    encodeModel({
      opsets: { "": 17, "com.microsoft": 1 },
      inputs: [
        { name: "x", elemType: 1, dims: [1, 2, 4] },
        { name: "skip", elemType: 1, dims: [1, 2, 4] },
      ],
      outputs: [{ name: "normed", elemType: 1, dims: [1, 2, 4] }],
      initializers: [{ name: "gamma", dims: [4], floats: [1, 1, 1, 1] }],
      nodes: [{ name: KERNEL.tap.node, opType: "SkipSimplifiedLayerNormalization", domain: "com.microsoft", inputs: ["x", "skip", "gamma"], outputs: ["normed", "", "", "sum"] }],
    });
  /** A stand-in onnxruntime whose model answers token 1, then <|im_end|> (id 10 in the fake tokenizer). */
  function fakeOrt() {
    const created: string[] = [];
    const steers: number[][] = [];
    class Tensor {
      type: string;
      data: ArrayLike<number | bigint>;
      dims: number[];
      constructor(type: string, data: ArrayLike<number | bigint>, dims: number[]) {
        this.type = type;
        this.data = data;
        this.dims = dims;
      }
    }
    let step = 0;
    const session = {
      inputNames: ["input_ids", "steer.2"],
      run: async (feeds: Record<string, Tensor>) => {
        steers.push(Array.from(feeds["steer.2"]!.data as Float32Array).slice(0, 2));
        const n = feeds["input_ids"]!.dims[1]!;
        const logits = new Float32Array(n * 16);
        logits[(n - 1) * 16 + (step++ === 0 ? 1 : 10)] = 1;
        const out: Record<string, Tensor> = { logits: new Tensor("float32", logits, [1, n, 16]), "resid.2": new Tensor("float32", new Float32Array(n * 4), [1, n, 4]) };
        for (let l = 0; l < 2; l++) for (const k of ["key", "value"]) out[`present.${l}.${k}`] = new Tensor("float32", new Float32Array(0), [1, 1, 0, 4]);
        return out;
      },
    };
    return { runtime: { Tensor, InferenceSession: { create: async (path: string) => (created.push(path), session) } }, created, steers };
  }

  it("CH2.5 the steerable kernel patches its verified export once, and serves steered chat", async () => {
    const cacheDir = await tempDir("cache-");
    const files = { [KERNEL.model]: kernelOnnx() };
    const { module, log } = fakeTransformers();
    const ort = fakeOrt();
    const m = kernel(files);
    const { ensemble, close } = buildNativeEnsemble({ cacheDir, allowHosted: false, catalog: only(m), fetch: fakeHub(files), transformers: module, onnxruntime: ort.runtime });
    let reply = "";
    for await (const e of ensemble.generate({ messages: [{ role: "user", content: "hi" }] }, "steered-chat")) if (e.type === "text") reply += e.text;
    expect(reply).toBe("a");
    expect(ort.created).toHaveLength(1);
    expect(ort.created[0]!.startsWith(join(cacheDir, "steerable"))).toBe(true);
    // the tokenizer comes from the export's own folder, with the run's template options
    expect(log.find((l) => l.name === "tokenizer.load")!.args[1]).toMatchObject({ revision: m.artifact!.revision, subfolder: "export/cpu" });
    expect(log.find((l) => l.name === "chat-template")!.args[1]).toMatchObject({ enable_thinking: false });
    // no behavior pack: unsteered
    expect(ort.steers.every((v) => v.every((x) => x === 0))).toBe(true);
    await close();
  });

  it("CH2.6 with a behavior pack the kernel steers by the pack's current state", async () => {
    const graph = defineGraph({
      version: 1,
      id: "warm",
      model: { id: byRuntime("onnxruntime").id, layer: KERNEL.tap.layer },
      initial: "warm",
      features: { joy: 0 },
      sensors: {},
      states: { warm: { steer: { joy: 3 } } },
      transitions: [],
    });
    const unit = (i: number) => Float32Array.from({ length: KERNEL.decoder.hidden }, (_, j) => (j === i ? 1 : 0));
    const behavior = compilePack(graph, { dims: KERNEL.decoder.hidden, width: 1, encoder: (i) => ({ weights: unit(i), bias: 0, threshold: 0 }), decoder: unit });
    const files = { [KERNEL.model]: kernelOnnx() };
    const ort = fakeOrt();
    const { ensemble, close } = buildNativeEnsemble({
      cacheDir: await tempDir("cache-"),
      allowHosted: false,
      catalog: only(kernel(files)),
      fetch: fakeHub(files),
      transformers: fakeTransformers().module,
      onnxruntime: ort.runtime,
      behavior,
    });
    for await (const _ of ensemble.generate({ messages: [{ role: "user", content: "hi" }] }, "steered-chat"));
    expect(ort.steers[0]).toEqual([3, 0]);
    await close();
  });

  it("CH3.1 memory installs its embedding model through the transformers.js backend, persists every change and restores from it", async () => {
    const saves: unknown[] = [];
    const first = buildNativeEnsemble({ cacheDir: await tempDir("cache-"), allowHosted: false, only: [], transformers: fakeTransformers({ embeddingWidth: 768 }).module, memory: { dimensions: 128, persist: (s) => saves.push(s) } });
    expect(first.ensemble.extensions()).toEqual(["memory"]);
    await invokeCognitive(first.ensemble, "memory.remember", { items: [{ text: "kept" }] });
    expect(saves).toHaveLength(1);
    const second = buildNativeEnsemble({ cacheDir: await tempDir("cache-"), allowHosted: false, only: [], transformers: fakeTransformers({ embeddingWidth: 768 }).module, memory: { dimensions: 128, saved: saves[0] } });
    expect(second.memory!.size).toBe(1);
    await Promise.all([first.close(), second.close()]);
  });

  it("CH3.2 memory's index size defaults to the largest size its embedding models share", async () => {
    const [embedder] = loadCatalog({ package: "@harness/memory" }).models;
    const host = buildNativeEnsemble({ cacheDir: await tempDir("cache-"), allowHosted: false, only: [], transformers: fakeTransformers({ embeddingWidth: embedder!.embedding!.dimensions[0]! }).module, memory: {} });
    expect(host.memory!.save()).toMatchObject({ dimensions: embedder!.embedding!.dimensions[0] });
    await host.close();
  });
});
