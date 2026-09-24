import * as ort from "onnxruntime-node";
import { describe, expect, it } from "vitest";
import { makeSteerable, qwenTap } from "@harness/models";
import { encodeModel } from "./onnx-builder.ts";

/**
 * A two-token, four-wide model with the same fused op the Qwen3 exports use:
 * SkipSimplifiedLayerNormalization(x, skip, gamma) -> (normed, _, _, sum).
 */
function tinyModel(options: { sumOutput?: boolean } = {}): Uint8Array {
  return encodeModel({
    opsets: { "": 17, "com.microsoft": 1 },
    inputs: [
      { name: "x", elemType: 1, dims: [1, 2, 4] },
      { name: "skip", elemType: 1, dims: [1, 2, 4] },
    ],
    outputs: [{ name: "normed", elemType: 1, dims: [1, 2, 4] }],
    initializers: [{ name: "gamma", dims: [4], floats: [1, 1, 1, 1] }],
    nodes: [
      {
        name: "/model/layers.1/input_layernorm/SkipLayerNorm",
        opType: "SkipSimplifiedLayerNormalization",
        domain: "com.microsoft",
        inputs: ["x", "skip", "gamma"],
        outputs: options.sumOutput === false ? ["normed"] : ["normed", "", "", "sum"],
        floatAttributes: { epsilon: 1e-6 },
      },
    ],
  });
}

async function run(model: Uint8Array, feeds: Record<string, number[]>, shapes: Record<string, number[]>) {
  const session = await ort.InferenceSession.create(model);
  const tensors = Object.fromEntries(Object.entries(feeds).map(([k, v]) => [k, new ort.Tensor("float32", Float32Array.from(v), shapes[k]!)]));
  const out = await session.run(tensors);
  return Object.fromEntries(Object.entries(out).map(([k, t]) => [k, Array.from(t.data as Float32Array)]));
}

const x = [1, 2, 3, 4, 0, 1, 0, 1];
const skip = [0.5, 0.5, 0.5, 0.5, 1, 1, 1, 1];
const rms = (v: number[]) => {
  const out: number[] = [];
  for (let t = 0; t < v.length; t += 4) {
    const row = v.slice(t, t + 4);
    const s = Math.sqrt(row.reduce((a, b) => a + b * b, 0) / 4 + 1e-6);
    out.push(...row.map((y) => y / s));
  }
  return out;
};

describe("ONNX steering patch", () => {
  it("OS1.1 adds the residual as an output and a steering vector added into it as an input", async () => {
    const patched = makeSteerable(tinyModel(), { node: "/model/layers.1/input_layernorm/SkipLayerNorm", steerInput: 1, residOutput: 3, layer: 0, hidden: 4 });
    const steer = [10, 0, -10, 0];
    const out = await run(patched, { x, skip, "steer.0": steer }, { x: [1, 2, 4], skip: [1, 2, 4], "steer.0": [4] });
    const sum = x.map((v, i) => v + skip[i]! + steer[i % 4]!);
    expect(out["resid.0"]!.map((v) => +v.toFixed(4))).toEqual(sum);
    out["normed"]!.forEach((v, i) => expect(v).toBeCloseTo(rms(sum)[i]!, 4));
  });

  it("OS1.2 with zero steering the model's outputs are unchanged", async () => {
    const before = await run(tinyModel(), { x, skip }, { x: [1, 2, 4], skip: [1, 2, 4] });
    const patched = makeSteerable(tinyModel(), { node: "/model/layers.1/input_layernorm/SkipLayerNorm", steerInput: 1, residOutput: 3, layer: 0, hidden: 4 });
    const after = await run(patched, { x, skip, "steer.0": [0, 0, 0, 0] }, { x: [1, 2, 4], skip: [1, 2, 4], "steer.0": [4] });
    expect(after["normed"]).toEqual(before["normed"]);
  });

  it("OS1.3 a node that does not expose its sum gets that output added", async () => {
    const patched = makeSteerable(tinyModel({ sumOutput: false }), { node: "/model/layers.1/input_layernorm/SkipLayerNorm", steerInput: 1, residOutput: 3, layer: 0, hidden: 4 });
    const out = await run(patched, { x, skip, "steer.0": [0, 0, 0, 0] }, { x: [1, 2, 4], skip: [1, 2, 4], "steer.0": [4] });
    expect(out["resid.0"]!.map((v) => +v.toFixed(4))).toEqual(x.map((v, i) => v + skip[i]!));
  });

  it("OS1.4 a missing tap node, or a model that is already steerable, is refused", () => {
    expect(() => makeSteerable(tinyModel(), { node: "/nope", steerInput: 1, residOutput: 3, layer: 0, hidden: 4 })).toThrow(/no node \/nope/);
    const once = makeSteerable(tinyModel(), { node: "/model/layers.1/input_layernorm/SkipLayerNorm", steerInput: 1, residOutput: 3, layer: 0, hidden: 4 });
    expect(() => makeSteerable(once, { node: "/model/layers.1/input_layernorm/SkipLayerNorm", steerInput: 1, residOutput: 3, layer: 0, hidden: 4 })).toThrow(/already has an input steer.0/);
    expect(() => makeSteerable(new Uint8Array([1, 2, 3]), qwenTap(14, 2048))).toThrow();
  });

  it("OS1.5 the Qwen3 tap for layer L is layer L+1's input layernorm, steering its second input and reading its sum", () => {
    expect(qwenTap(14, 2048)).toEqual({ node: "/model/layers.15/input_layernorm/SkipLayerNorm", steerInput: 1, residOutput: 3, layer: 14, hidden: 2048 });
  });
});
