import { lineage } from "./graph.ts";
import type { BehaviorGraph } from "./graph.ts";
import { validateGraph } from "./validate.ts";

/**
 * The rows of an SAE a graph needs. JumpReLU/ReLU SAEs compute each feature from its
 * own encoder row, so a pack carries only the features its graph uses. For TopK SAEs
 * the threshold is calibrated offline to approximate "among the top k".
 */
export interface SaeRows {
  readonly dims: number;
  /** Number of features in the full SAE. */
  readonly width: number;
  encoder(index: number): { readonly weights: Float32Array; readonly bias: number; readonly threshold: number };
  decoder(index: number): Float32Array;
}

export interface SensedFeature {
  readonly feature: string;
  readonly index: number;
  readonly weights: Float32Array;
  readonly bias: number;
  readonly threshold: number;
}

/** A compiled graph: what the engine needs and nothing more. */
export interface BehaviorPack {
  readonly graph: BehaviorGraph;
  readonly dims: number;
  readonly sense: readonly SensedFeature[];
  /** Per state: the summed steering of the state and its ancestors, or undefined for none. */
  readonly steering: Readonly<Record<string, Float32Array | undefined>>;
}

function refuse(graph: BehaviorGraph): void {
  const v = validateGraph(graph);
  if (!v.ok) throw new Error(`invalid behavior graph: ${v.problems.join("; ")}`);
}

export function compilePack(graph: BehaviorGraph, sae: SaeRows): BehaviorPack {
  refuse(graph);
  for (const [name, index] of Object.entries(graph.features)) {
    if (index >= sae.width) throw new Error(`feature ${name} has index ${index}, beyond the SAE's width ${sae.width}`);
  }
  const sensedNames = [...new Set(Object.values(graph.sensors).map((s) => s.feature))];
  const sense = sensedNames.map((feature) => {
    const index = graph.features[feature]!;
    const row = sae.encoder(index);
    if (row.weights.length !== sae.dims) throw new Error(`encoder row ${index} has ${row.weights.length} values, expected ${sae.dims}`);
    return { feature, index, weights: Float32Array.from(row.weights), bias: row.bias, threshold: row.threshold };
  });
  const decoders = new Map<string, Float32Array>();
  const decoder = (feature: string) => {
    let row = decoders.get(feature);
    if (!row) {
      row = sae.decoder(graph.features[feature]!);
      if (row.length !== sae.dims) throw new Error(`decoder row for ${feature} has ${row.length} values, expected ${sae.dims}`);
      decoders.set(feature, row);
    }
    return row;
  };
  const steering: Record<string, Float32Array | undefined> = {};
  for (const state of Object.keys(graph.states)) {
    const v = new Float32Array(sae.dims);
    let any = false;
    for (const s of lineage(graph, state)) {
      for (const [feature, strength] of Object.entries(graph.states[s]!.steer ?? {})) {
        const row = decoder(feature);
        for (let i = 0; i < v.length; i++) v[i]! += strength * row[i]!;
        any = true;
      }
    }
    steering[state] = any ? v : undefined;
  }
  return { graph, dims: sae.dims, sense, steering };
}

// ---- JSON serialization (floats as base64 little-endian float32) ---------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(v: Float32Array): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 4) / 3));
    for (let c = 0; c < 4; c++) out += c < chars ? B64[(n >> (18 - 6 * c)) & 63] : "=";
  }
  return out;
}

function fromBase64(text: string, dims: number, what: string): Float32Array {
  const clean = text.replace(/=+$/, "");
  if (/[^A-Za-z0-9+/]/.test(clean)) throw new Error(`${what} is not valid base64`);
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (const ch of clean) {
    value = ((value << 6) | B64.indexOf(ch)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[o++] = (value >> bits) & 0xff;
    }
  }
  if (bytes.length !== dims * 4) throw new Error(`${what} has ${bytes.length / 4} values, expected ${dims}`);
  const v = new Float32Array(bytes.buffer);
  if (!v.every(Number.isFinite)) throw new Error(`${what} has non-finite values`);
  return v;
}

const FORMAT = "harness.behavior-pack/v1";

export function serializePack(pack: BehaviorPack): string {
  return JSON.stringify({
    format: FORMAT,
    graph: pack.graph,
    dims: pack.dims,
    sense: pack.sense.map((s) => ({ feature: s.feature, index: s.index, weights: toBase64(s.weights), bias: s.bias, threshold: s.threshold })),
    steering: Object.fromEntries(Object.entries(pack.steering).map(([k, v]) => [k, v === undefined ? null : toBase64(v)])),
  });
}

/** Parse and check a pack completely; anything wrong refuses the whole pack. */
export function parsePack(text: string): BehaviorPack {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("behavior pack is not valid JSON");
  }
  if (raw["format"] !== FORMAT) throw new Error(`behavior pack format must be ${FORMAT}`);
  const graph = raw["graph"] as BehaviorGraph;
  refuse(graph);
  const dims = raw["dims"];
  if (!Number.isInteger(dims) || (dims as number) < 1) throw new Error("behavior pack dims must be a positive integer");
  const d = dims as number;
  const sense = (raw["sense"] as Record<string, unknown>[]).map((s, i) => {
    if (!Number.isFinite(s["bias"]) || !Number.isFinite(s["threshold"])) throw new Error(`sensed feature ${i}: bias and threshold must be finite`);
    return {
      feature: String(s["feature"]),
      index: s["index"] as number,
      weights: fromBase64(String(s["weights"]), d, `encoder row for ${String(s["feature"])} (width)`),
      bias: s["bias"] as number,
      threshold: s["threshold"] as number,
    };
  });
  const steering: Record<string, Float32Array | undefined> = {};
  for (const state of Object.keys(graph.states)) {
    const v = (raw["steering"] as Record<string, unknown>)[state];
    steering[state] = v === null || v === undefined ? undefined : fromBase64(String(v), d, `steering for ${state}`);
  }
  return { graph, dims: d, sense, steering };
}
