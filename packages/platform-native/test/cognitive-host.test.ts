import { describe, expect, it } from "vitest";
import { buildNativeEnsemble } from "@harness/platform-native";

describe("native cognitive host", () => {
  it("CH1.1 registers every catalog model that runs natively, without loading any", async () => {
    const { ensemble, close } = buildNativeEnsemble({ cacheDir: "/nonexistent/cache", llamaServer: "/usr/local/bin/llama-server" });
    expect(ensemble.members().map((m) => m.id).sort()).toEqual([
      "ATH-MaaS/OvisOCR2",
      "Cactus-Compute/needle3",
      "Qwen/Qwen3.5-0.8B",
      "google/embeddinggemma-300m",
      "lightonai/LightOnOCR-2-1B",
      "microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank",
      "ornith-ai/Ornith-1.5-9B",
      "typesafe-ai/jev",
    ]);
    expect(ensemble.members().every((m) => m.state === "offline")).toBe(true);
    await close();
  });

  it("CH1.2 llama.cpp models need a llama-server binary; hosted models can be turned off", async () => {
    const { ensemble, close } = buildNativeEnsemble({ cacheDir: "/nonexistent/cache", allowHosted: false });
    const ids = ensemble.members().map((m) => m.id);
    expect(ids).not.toContain("ornith-ai/Ornith-1.5-9B");
    expect(ids).not.toContain("ATH-MaaS/OvisOCR2");
    expect(ids).not.toContain("typesafe-ai/jev");
    expect(ensemble.candidates("chat").map((c) => c.id)).toEqual(["Qwen/Qwen3.5-0.8B"]);
    await close();
  });

  it("CH1.3 selection uses the catalog's benchmarks and preferences", async () => {
    const { ensemble, close } = buildNativeEnsemble({ cacheDir: "/nonexistent/cache", llamaServer: "/bin/llama-server" });
    expect(ensemble.candidates("document-parsing")[0]!.id).toBe("ATH-MaaS/OvisOCR2");
    expect(ensemble.candidates("tool-calling")[0]!.id).toBe("Cactus-Compute/needle3");
    expect(ensemble.candidates("coding")[0]!.id).toBe("ornith-ai/Ornith-1.5-9B");
    await close();
  });

  it("CH1.4 a model whose weights cannot be fetched fails to load and the next model takes over", async () => {
    const offline = (async () => new Response("offline", { status: 503 })) as typeof fetch;
    const { ensemble, close } = buildNativeEnsemble({ cacheDir: "/nonexistent/cache", allowHosted: false, fetch: offline, only: ["Cactus-Compute/needle3"] });
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
import { MODEL_CATALOG } from "@harness/cognitive";
import type { ModelDescriptor } from "@harness/cognitive";
import { fakeTransformers } from "../../models/test/fake-transformers.ts";

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
const entry = (id: string) => MODEL_CATALOG.find((m) => m.id === id)!;

/** Replace a catalog entry's weights with small files served by a fake Hugging Face. */
function withFakeFiles(m: ModelDescriptor, files: Record<string, Uint8Array>): ModelDescriptor {
  return { ...m, artifact: { ...m.artifact!, files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) })) } };
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
    const { ensemble, close } = buildNativeEnsemble({ cacheDir: await tempDir("cache-"), allowHosted: false, transformers: module });
    expect((await ensemble.embed([{ kind: "query", text: "x" }]))[0]).toBeInstanceOf(Float32Array);
    expect((await ensemble.compress({ text: "one two three four", rate: 1 })).text).toBe("one two three four");
    let reply = "";
    for await (const e of ensemble.generate({ messages: [{ role: "user", content: "capital?" }] })) if (e.type === "text") reply += e.text;
    expect(reply).toBe("Paris");
    const { pages } = await ensemble.parseDocument({ pages: [{ mediaType: "image/png", data: new Uint8Array([1]) }] }, "table-extraction");
    expect(pages[0]!.markdown).toBe("Paris");
    await close();
  });

  it("CH2.2 the Jev judge is constructed for the hosted judgment task", async () => {
    const { ensemble, close } = buildNativeEnsemble({ cacheDir: await tempDir("cache-") });
    expect((await ensemble.resolve("judgment", "judge")).id).toBe("typesafe-ai/jev");
    await close();
  });

  it("CH2.3 Needle loads from verified artifacts and routes", async () => {
    const needleJs = new TextEncoder().encode(`
      module.exports = async function (arg) {
        const heap = new Uint8Array(1 << 16); let next = 16; let out = 0;
        return {
          HEAPU8: heap,
          _malloc: (n) => { const p = next; next += Math.ceil((n + 8) / 16) * 16; return p; },
          _free: () => {},
          _needle_load: () => (arg.wasmBinary.length > 0 ? 0 : -1),
          UTF8ToString: (p) => { let e = p; while (heap[e]) e++; return new TextDecoder().decode(heap.subarray(p, e)); },
          ccall: (name, _r, _t, args) => {
            if (name === "needle_embed") return 2;
            if (name !== "needle_complete") return 0;
            const reply = new TextEncoder().encode(JSON.stringify({ success: true, function_calls: [{ name: "t", arguments: {} }], confidence: 0.99, reasoning: "" }));
            heap.set(reply, args[2]); heap[args[2] + reply.length] = 0; return 1;
          },
        };
      };`);
    const files = { "wasm/needle.js": needleJs, "wasm/needle.wasm": new Uint8Array([0, 97, 115, 109]), "needle3.cact": new Uint8Array([1, 2, 3]) };
    const needle = withFakeFiles(entry("Cactus-Compute/needle3"), files);
    const { ensemble, close } = buildNativeEnsemble({ cacheDir: await tempDir("cache-"), allowHosted: false, catalog: [needle], fetch: fakeHub(files) });
    expect((await ensemble.route({ input: "go", tools: [{ name: "t", description: "", parameters: {} }] })).calls).toEqual([{ name: "t", arguments: {} }]);
    await close();
  });

  it("CH2.4 GGUF models start a llama-server on their downloaded weights and stop it on close", async () => {
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
    const files = { "ovis.gguf": new Uint8Array([1, 2]), "mmproj.gguf": new Uint8Array([3]) };
    const ovis = withFakeFiles(entry("ATH-MaaS/OvisOCR2"), files);
    const { ensemble, close } = buildNativeEnsemble({ cacheDir: await tempDir("cache-"), allowHosted: false, catalog: [ovis], fetch: fakeHub(files), llamaServer: binary });
    const { pages } = await ensemble.parseDocument({ pages: [{ mediaType: "image/png", data: new Uint8Array([9]) }] });
    expect(pages[0]!.markdown).toBe("# Page");
    const args = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(argsFile, "utf8"))) as string[];
    expect(args).toEqual(expect.arrayContaining(["--mmproj"]));
    await close();
  });
});
