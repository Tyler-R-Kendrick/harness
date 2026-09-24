import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Tap } from "@harness/models";
import { steerableModel } from "@harness/platform-native";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
/** A tap at layer L of an onnxruntime-genai decoder export (layer L+1's fused input layernorm). */
const tap = (layer: number): Tap => ({ node: `/model/layers.${layer + 1}/input_layernorm/SkipLayerNorm`, steerInput: 1, residOutput: 3, layer, hidden: 2048 });
async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), "harness-steer-"));
  dirs.push(d);
  return d;
}

describe("steerable model files (patched once, cached on disk)", () => {
  it("SK1.1 patches the source on first use and reuses the patched file after", async () => {
    const dir = await tempDir();
    const source = join(dir, "model.onnx");
    await writeFile(source, "weights");
    const calls: Tap[] = [];
    const patch = (bytes: Uint8Array, tap: Tap) => (calls.push(tap), new TextEncoder().encode(`${new TextDecoder().decode(bytes)}+steer.${tap.layer}`));
    const first = await steerableModel({ source, tap: tap(14), dir: join(dir, "steerable"), patch });
    const second = await steerableModel({ source, tap: tap(14), dir: join(dir, "steerable"), patch });
    expect(first).toBe(second);
    expect(calls).toHaveLength(1);
    expect(await readFile(first, "utf8")).toBe("weights+steer.14");
    // another layer is another file
    const other = await steerableModel({ source, tap: tap(20), dir: join(dir, "steerable"), patch });
    expect(other).not.toBe(first);
    expect(await readFile(other, "utf8")).toBe("weights+steer.20");
  });

  it("SK1.2 a patch that fails leaves nothing behind", async () => {
    const dir = await tempDir();
    const source = join(dir, "model.onnx");
    await writeFile(source, "weights");
    const patch = () => {
      throw new Error("no node /model/layers.15/input_layernorm/SkipLayerNorm");
    };
    await expect(steerableModel({ source, tap: tap(14), dir: join(dir, "steerable"), patch })).rejects.toThrow(/no node/);
    expect(await readdir(join(dir, "steerable")).catch(() => [])).toEqual([]);
  });

  it("SK1.3 a write that cannot land removes its temp file", async () => {
    const dir = await tempDir();
    const source = join(dir, "model.onnx");
    await writeFile(source, "weights");
    const patch = (bytes: Uint8Array) => bytes;
    const target = await steerableModel({ source, tap: tap(14), dir: join(dir, "steerable"), patch });
    // something that is not a file now sits where the patched model goes
    await rm(target);
    await mkdir(join(target, "blocker"), { recursive: true });
    await expect(steerableModel({ source, tap: tap(14), dir: join(dir, "steerable"), patch })).rejects.toThrow();
    expect(await readdir(join(dir, "steerable"))).toEqual([target.split("/").at(-1)]);
  });
});
