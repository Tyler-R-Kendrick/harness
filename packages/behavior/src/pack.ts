import { z } from "zod";
import { floats, toBase64 } from "./floats.ts";
import { BehaviorGraphSchema, lineage } from "./graph.ts";
import type { BehaviorGraph } from "./graph.ts";

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

declare const compiled: unique symbol;

/** A compiled graph: what the engine needs and nothing more. Made only by compilePack or parsePack. */
export interface BehaviorPack {
  readonly [compiled]: true;
  readonly graph: BehaviorGraph;
  readonly dims: number;
  readonly sense: readonly SensedFeature[];
  /** Per state: the summed steering of the state and its ancestors, or undefined for none. */
  readonly steering: Readonly<Record<string, Float32Array | undefined>>;
}

export function compilePack(graph: BehaviorGraph, sae: SaeRows): BehaviorPack {
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
  return seal({ graph, dims: sae.dims, sense, steering });
}

const seal = (pack: Omit<BehaviorPack, typeof compiled>) => pack as BehaviorPack;

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

const PackJson = z
  .strictObject({
    format: z.literal(FORMAT),
    graph: BehaviorGraphSchema,
    dims: z.int().positive(),
    sense: z.array(z.strictObject({ feature: z.string(), index: z.int().min(0), weights: floats, bias: z.number(), threshold: z.number() })),
    steering: z.record(z.string(), floats.nullable()),
  })
  .superRefine((p, ctx) => {
    const issue = (message: string, path: (string | number)[]) => ctx.addIssue({ code: "custom", message, path });
    const width = (v: Float32Array, path: (string | number)[]) => v.length !== p.dims && issue(`has ${v.length} values, expected ${p.dims}`, path);
    const sensed = new Set(Object.values(p.graph.sensors).map((s) => s.feature));
    if (p.sense.length !== sensed.size || !p.sense.every((s) => sensed.has(s.feature))) issue(`sense must carry exactly the sensed features: ${[...sensed].join(", ")}`, ["sense"]);
    p.sense.forEach((s, i) => width(s.weights, ["sense", i, "weights"]));
    for (const [state, v] of Object.entries(p.steering)) {
      if (!Object.hasOwn(p.graph.states, state)) issue(`steering for state ${state}, which is not in the graph`, ["steering", state]);
      else if (v) width(v, ["steering", state]);
    }
  });

/** Parse a serialized pack; anything wrong refuses the whole pack. */
export function parsePack(text: string): BehaviorPack {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("behavior pack is not valid JSON");
  }
  const result = PackJson.safeParse(raw);
  if (!result.success) throw new Error(`invalid behavior pack\n${z.prettifyError(result.error)}`);
  const { graph, dims, sense, steering } = result.data;
  return seal({ graph, dims, sense, steering: Object.fromEntries(Object.keys(graph.states).map((state) => [state, steering[state] ?? undefined])) });
}
