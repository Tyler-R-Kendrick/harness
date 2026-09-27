import { encodeNode, encodeValueInfo, int, lengthDelimited, str } from "@harness/models";

/** Encode a small ONNX model for tests (only what the steering patch and onnxruntime need). */
export function encodeModel(m: {
  opsets: Record<string, number>;
  inputs: { name: string; elemType: number; dims: number[] }[];
  outputs: { name: string; elemType: number; dims: number[] }[];
  initializers: { name: string; dims: number[]; floats: number[] }[];
  nodes: { name: string; opType: string; domain?: string; inputs: string[]; outputs: string[]; floatAttributes?: Record<string, number> }[];
}): Uint8Array {
  const cat = (xs: Uint8Array[]) => {
    const out = new Uint8Array(xs.reduce((s, x) => s + x.length, 0));
    let o = 0;
    for (const x of xs) {
      out.set(x, o);
      o += x.length;
    }
    return out;
  };
  const fixed32 = (tag: number, f: number) => {
    const b = new Uint8Array(5);
    b[0] = tag * 8 + 5;
    new DataView(b.buffer).setFloat32(1, f, true);
    return b;
  };
  const tensor = (t: { name: string; dims: number[]; floats: number[] }) => {
    const raw = new Uint8Array(Float32Array.from(t.floats).buffer);
    return cat([...t.dims.map((d) => int(1, d)), int(2, 1), str(8, t.name), lengthDelimited(9, raw)]);
  };
  const graph = cat([
    ...m.nodes.map((n) =>
      lengthDelimited(
        1,
        encodeNode({
          ...n,
          attributes: Object.entries(n.floatAttributes ?? {}).map(([k, v]) => cat([str(1, k), fixed32(2, v), int(20, 1)])),
        }),
      ),
    ),
    str(2, "test"),
    ...m.initializers.map((t) => lengthDelimited(5, tensor(t))),
    ...m.inputs.map((i) => lengthDelimited(11, encodeValueInfo(i.name, i.elemType, i.dims))),
    ...m.outputs.map((o) => lengthDelimited(12, encodeValueInfo(o.name, o.elemType, o.dims))),
  ]);
  return cat([int(1, 8), ...Object.entries(m.opsets).map(([domain, version]) => lengthDelimited(8, cat([str(1, domain), int(2, version)]))), lengthDelimited(7, graph)]);
}
