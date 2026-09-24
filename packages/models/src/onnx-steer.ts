/**
 * Make an ONNX decoder steerable by editing its protobuf directly: rewire one node so a
 * steering vector is added into the residual stream, and expose that residual as an
 * output. Only the tap node is decoded; weights and everything else are copied as
 * bytes, so a 1.4 GB model patches in one pass on any platform without Python.
 *
 * ONNX field numbers used (onnx.proto): ModelProto.graph=7; GraphProto.node=1,
 * input=11, output=12; NodeProto.input=1, output=2, name=3, op_type=4, domain=7;
 * ValueInfoProto.name=1, type=2; TypeProto.tensor_type=1; Tensor.elem_type=1, shape=2;
 * TensorShapeProto.dim=1; Dimension.dim_value=1, dim_param=2.
 */

export interface Tap {
  /** Name of the node whose summed residual is read and steered. */
  readonly node: string;
  /** Which of its inputs the steering vector is added to. */
  readonly steerInput: number;
  /** Which of its outputs is the residual sum. */
  readonly residOutput: number;
  readonly layer: number;
  readonly hidden: number;
  /** ONNX element type of the residual; inferred from the KV cache inputs when omitted. */
  readonly elemType?: number;
}

// ---- protobuf wire format ------------------------------------------------------------

const utf8 = new TextEncoder();
const text = new TextDecoder();

export function varint(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) + 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Uint8Array.from(out);
}

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let value = 0;
  let scale = 1;
  let p = pos;
  for (;;) {
    if (p >= buf.length) throw new Error("truncated protobuf varint");
    const b = buf[p++]!;
    value += (b & 0x7f) * scale;
    if (b < 0x80) return [value, p];
    scale *= 0x80;
  }
}

interface Field {
  readonly tag: number;
  readonly wire: number;
  /** Start of the field (its key). */
  readonly start: number;
  /** Payload bounds (for length-delimited fields). */
  readonly body: number;
  readonly end: number;
}

function* fields(buf: Uint8Array, start: number, end: number): Generator<Field> {
  let p = start;
  while (p < end) {
    const fieldStart = p;
    const [key, afterKey] = readVarint(buf, p);
    const tag = Math.floor(key / 8);
    const wire = key % 8;
    let body = afterKey;
    let fieldEnd: number;
    if (wire === 0) fieldEnd = readVarint(buf, afterKey)[1];
    else if (wire === 1) fieldEnd = afterKey + 8;
    else if (wire === 5) fieldEnd = afterKey + 4;
    else if (wire === 2) {
      const [len, afterLen] = readVarint(buf, afterKey);
      body = afterLen;
      fieldEnd = afterLen + len;
    } else throw new Error(`unsupported protobuf wire type ${wire}`);
    if (fieldEnd > end) throw new Error("truncated protobuf field");
    yield { tag, wire, start: fieldStart, body, end: fieldEnd };
    p = fieldEnd;
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function lengthDelimited(tag: number, payload: Uint8Array): Uint8Array {
  return concat([varint(tag * 8 + 2), varint(payload.length), payload]);
}
export const str = (tag: number, s: string) => lengthDelimited(tag, utf8.encode(s));
export const int = (tag: number, n: number) => concat([varint(tag * 8), varint(n)]);

export function encodeNode(n: { name: string; opType: string; domain?: string; inputs: readonly string[]; outputs: readonly string[]; attributes?: readonly Uint8Array[] }): Uint8Array {
  return concat([...n.inputs.map((i) => str(1, i)), ...n.outputs.map((o) => str(2, o)), str(3, n.name), str(4, n.opType), ...(n.attributes ?? []).map((a) => lengthDelimited(5, a)), ...(n.domain ? [str(7, n.domain)] : [])]);
}

export function encodeValueInfo(name: string, elemType: number, dims: readonly (number | string)[]): Uint8Array {
  const shape = concat(dims.map((d) => lengthDelimited(1, typeof d === "number" ? int(1, d) : str(2, d))));
  const tensor = concat([int(1, elemType), lengthDelimited(2, shape)]);
  return concat([str(1, name), lengthDelimited(2, lengthDelimited(1, tensor))]);
}

function strings(buf: Uint8Array, start: number, end: number, tag: number): string[] {
  return [...fields(buf, start, end)].filter((f) => f.tag === tag && f.wire === 2).map((f) => text.decode(buf.subarray(f.body, f.end)));
}

function elemTypeOf(buf: Uint8Array, valueInfo: Field): number | undefined {
  for (const t of fields(buf, valueInfo.body, valueInfo.end)) {
    if (t.tag !== 2) continue;
    for (const tt of fields(buf, t.body, t.end)) {
      if (tt.tag !== 1) continue;
      for (const e of fields(buf, tt.body, tt.end)) if (e.tag === 1 && e.wire === 0) return readVarint(buf, e.body)[0];
    }
  }
  return undefined;
}

export function makeSteerable(model: Uint8Array, tap: Tap): Uint8Array {
  const graph = [...fields(model, 0, model.length)].find((f) => f.tag === 7 && f.wire === 2);
  if (!graph) throw new Error("not an ONNX model: no graph");
  const steer = `steer.${tap.layer}`;
  const resid = `resid.${tap.layer}`;
  let elemType = tap.elemType;
  let target: Field | undefined;
  for (const f of fields(model, graph.body, graph.end)) {
    if (f.tag === 11 || f.tag === 12) {
      const [name] = strings(model, f.body, f.end, 1);
      if (name === steer) throw new Error(`model already has an input ${steer}`);
      if (f.tag === 11 && elemType === undefined && name?.startsWith("past_key_values.")) elemType = elemTypeOf(model, f);
    } else if (f.tag === 1 && strings(model, f.body, f.end, 3)[0] === tap.node) target = f;
  }
  if (!target) throw new Error(`no node ${tap.node} in the model`);
  const type = elemType ?? 1;

  // Rewrite the tap node: steer one input, make sure the sum output is named.
  const inputs = strings(model, target.body, target.end, 1);
  const outputs = strings(model, target.body, target.end, 2);
  const original = inputs[tap.steerInput];
  if (original === undefined) throw new Error(`${tap.node} has no input ${tap.steerInput}`);
  const steered = `/steer/layers.${tap.layer}/Add/output_0`;
  inputs[tap.steerInput] = steered;
  while (outputs.length <= tap.residOutput) outputs.push("");
  if (outputs[tap.residOutput] === "") outputs[tap.residOutput] = `${tap.node}/output_${tap.residOutput}`;
  const sum = outputs[tap.residOutput]!;
  const rest = [...fields(model, target.body, target.end)].filter((f) => f.tag !== 1 && f.tag !== 2).map((f) => model.subarray(f.start, f.end));
  const node = concat([...inputs.map((i) => str(1, i)), ...outputs.map((o) => str(2, o)), ...rest]);

  const parts: Uint8Array[] = [];
  for (const f of fields(model, graph.body, graph.end)) {
    if (f.start === target.start) {
      parts.push(lengthDelimited(1, encodeNode({ name: `/steer/layers.${tap.layer}/Add`, opType: "Add", inputs: [original, steer], outputs: [steered] })));
      parts.push(lengthDelimited(1, node));
    } else parts.push(model.subarray(f.start, f.end));
  }
  parts.push(lengthDelimited(1, encodeNode({ name: `/steer/layers.${tap.layer}/Resid`, opType: "Identity", inputs: [sum], outputs: [resid] })));
  parts.push(lengthDelimited(11, encodeValueInfo(steer, type, [tap.hidden])));
  parts.push(lengthDelimited(12, encodeValueInfo(resid, type, ["batch_size", "sequence_length", tap.hidden])));
  const body = concat(parts);
  return concat([model.subarray(0, graph.start), varint(7 * 8 + 2), varint(body.length), body, model.subarray(graph.end)]);
}
