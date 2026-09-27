import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileByteCache, loadEmscriptenModule } from "@harness/platform-native";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "harness-models-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("native model cache", () => {
  it("MC1.1 stores and returns bytes by key, surviving a new instance", async () => {
    const dir = await tempDir();
    await new FileByteCache(dir).put("org/model@abc/onnx/model.onnx", new Uint8Array([1, 2, 3]));
    expect(await new FileByteCache(dir).get("org/model@abc/onnx/model.onnx")).toEqual(new Uint8Array([1, 2, 3]));
    expect(await new FileByteCache(dir).get("missing")).toBeUndefined();
  });

  it("MC1.2 keys cannot escape the cache directory and leave no temp files", async () => {
    const dir = await tempDir();
    const cache = new FileByteCache(dir);
    await cache.put("../../etc/passwd", new Uint8Array([7]));
    expect(await cache.get("../../etc/passwd")).toEqual(new Uint8Array([7]));
    const files = await readdir(dir, { recursive: true });
    expect(files.every((f) => !f.includes("..") && !f.includes(".tmp-"))).toBe(true);
  });

  it("MC2.1 loads an Emscripten factory from source with CommonJS globals and hands it the WASM bytes", async () => {
    const source = `
      var createEngine = (() => async function (moduleArg = {}) {
        const fs = require("node:fs");
        return { gotWasm: moduleArg.wasmBinary.length, hasFs: typeof fs.readFileSync, dir: typeof __dirname };
      })();
      if (typeof exports === "object" && typeof module === "object") { module.exports = createEngine; module.exports.default = createEngine; }
    `;
    const m = (await loadEmscriptenModule(new TextEncoder().encode(source), new Uint8Array(9))) as unknown as Record<string, unknown>;
    expect(m).toEqual({ gotWasm: 9, hasFs: "function", dir: "string" });
  });

  it("MC2.2 a source that exports no factory is refused", async () => {
    await expect(loadEmscriptenModule(new TextEncoder().encode("module.exports = 42;"), new Uint8Array(1))).rejects.toThrow(/factory/);
  });
});
