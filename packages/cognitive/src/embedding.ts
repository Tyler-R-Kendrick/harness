/**
 * Embedding helpers for any embedding model. A model's catalog entry says how it wants
 * queries and documents written (prompt templates) and which sizes it can truncate to;
 * truncation keeps the leading components and renormalizes (Matryoshka-style).
 */
import { z } from "zod";
import type { EmbeddingConfig } from "./catalog.ts";

export const EmbedInputSchema = z.discriminatedUnion("kind", [
  /** A search query; `task` names what the query is for, when the model's template uses it. */
  z.object({ kind: z.literal("query"), text: z.string(), task: z.string().exactOptional() }),
  z.object({ kind: z.literal("document"), text: z.string(), title: z.string().exactOptional() }),
]);
export type EmbedInput = z.output<typeof EmbedInputSchema>;

/** Write an input the way the model was trained to see it: its template, with {text}, {task} and {title} filled in. */
export function embeddingPrompt(config: Pick<EmbeddingConfig, "query" | "document" | "defaults">, input: EmbedInput): string {
  const values: Record<string, string | undefined> = { ...config.defaults, ...input };
  return (input.kind === "query" ? config.query : config.document).replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
}

function magnitude(v: Float32Array): number {
  let sum = 0;
  for (const x of v) sum += x * x;
  return Math.sqrt(sum);
}

/** Keep the first `dimensions` components and rescale to unit length. */
export function truncateEmbedding(v: Float32Array, dimensions: number): Float32Array {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > v.length) {
    throw new Error(`dimensions must be an integer in [1, ${v.length}], got ${dimensions}`);
  }
  const head = v.slice(0, dimensions);
  const m = magnitude(head);
  if (m === 0) throw new Error("cannot normalize a zero vector");
  for (let i = 0; i < head.length; i++) head[i] = head[i]! / m;
  return head;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`);
  const ma = magnitude(a);
  const mb = magnitude(b);
  if (ma === 0 || mb === 0) throw new Error("cosine is undefined for a zero vector");
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot / (ma * mb);
}
