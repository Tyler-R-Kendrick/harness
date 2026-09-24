import { describe, expect, it } from "vitest";
import { OnnxSteerableSession } from "@harness/models";

interface T {
  type: string;
  data: ArrayLike<number | bigint>;
  dims: number[];
}

/** A stand-in onnxruntime: 2 layers, 1 kv head, head size 2, hidden 3, vocab 4. */
function fakeRuntime() {
  const runs: Record<string, T>[] = [];
  const Tensor = class {
    type: string;
    data: ArrayLike<number | bigint>;
    dims: number[];
    constructor(type: string, data: ArrayLike<number | bigint>, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  };
  const session = {
    inputNames: ["input_ids", "attention_mask", "past_key_values.0.key", "past_key_values.0.value", "past_key_values.1.key", "past_key_values.1.value", "steer.5"],
    run: async (feeds: Record<string, T>) => {
      runs.push(feeds);
      const n = feeds["input_ids"]!.dims[1]!;
      const past = feeds["past_key_values.0.key"]!.dims[2]!;
      const kv = (seq: number) => new Tensor("float32", new Float32Array(seq * 2), [1, 1, seq, 2]);
      const out: Record<string, T> = {
        logits: new Tensor("float32", Float32Array.from({ length: n * 4 }, (_, i) => i), [1, n, 4]),
        "resid.5": new Tensor("float32", Float32Array.from({ length: n * 3 }, (_, i) => i * 10), [1, n, 3]),
      };
      for (const l of [0, 1]) for (const kind of ["key", "value"]) out[`present.${l}.${kind}`] = kv(past + n);
      return out;
    },
  };
  return { runtime: { Tensor, InferenceSession: { create: async () => session } }, runs };
}

const config = { layers: 2, kvHeads: 1, headSize: 2, hidden: 3 };

describe("onnxruntime steerable session", () => {
  it("OR1.1 returns the last position's logits and tapped residual", async () => {
    const { runtime } = fakeRuntime();
    const s = await OnnxSteerableSession.create({ model: new Uint8Array(1), layer: 5, config, runtime });
    const { logits, residual } = await s.forward([7, 8], undefined);
    expect(Array.from(logits)).toEqual([4, 5, 6, 7]);
    expect(Array.from(residual)).toEqual([30, 40, 50]);
    expect(s.dims).toBe(3);
    expect(s.layer).toBe(5);
  });

  it("OR1.2 threads the KV cache: the next call passes the presents as past and a mask covering past + new tokens", async () => {
    const { runtime, runs } = fakeRuntime();
    const s = await OnnxSteerableSession.create({ model: new Uint8Array(1), layer: 5, config, runtime });
    await s.forward([1, 2, 3], undefined);
    await s.forward([4], undefined);
    expect(runs[0]!["past_key_values.0.key"]!.dims).toEqual([1, 1, 0, 2]);
    expect(runs[1]!["past_key_values.1.value"]!.dims).toEqual([1, 1, 3, 2]);
    expect(runs[1]!["attention_mask"]!.dims).toEqual([1, 4]);
    expect(Array.from(runs[1]!["input_ids"]!.data, Number)).toEqual([4]);
    expect(runs[1]!["input_ids"]!.type).toBe("int64");
  });

  it("OR1.3 steering defaults to zeros and is passed as the steer input; reset starts a new sequence", async () => {
    const { runtime, runs } = fakeRuntime();
    const s = await OnnxSteerableSession.create({ model: new Uint8Array(1), layer: 5, config, runtime });
    await s.forward([1], undefined);
    await s.forward([2], Float32Array.from([1, 2, 3]));
    expect(Array.from(runs[0]!["steer.5"]!.data as Float32Array)).toEqual([0, 0, 0]);
    expect(Array.from(runs[1]!["steer.5"]!.data as Float32Array)).toEqual([1, 2, 3]);
    s.reset();
    await s.forward([3], undefined);
    expect(runs[2]!["past_key_values.0.key"]!.dims).toEqual([1, 1, 0, 2]);
    expect(runs[2]!["attention_mask"]!.dims).toEqual([1, 1]);
  });

  it("OR1.4 a model without the steer input for the layer is refused", async () => {
    const { runtime } = fakeRuntime();
    await expect(OnnxSteerableSession.create({ model: new Uint8Array(1), layer: 9, config, runtime })).rejects.toThrow(/steer.9/);
  });
});
