/**
 * Embedding helpers. EmbeddingGemma expects a task prefix on every input and
 * supports Matryoshka truncation: the leading components of a vector form a
 * smaller embedding once renormalized.
 */
import { z } from "zod";

export const EMBEDDING_TASKS = ["search result", "question answering", "fact checking", "classification", "clustering", "sentence similarity", "code retrieval"] as const;
export type EmbeddingTask = (typeof EMBEDDING_TASKS)[number];

export const EmbedInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("query"), text: z.string(), task: z.enum(EMBEDDING_TASKS).exactOptional() }),
  z.object({ kind: z.literal("document"), text: z.string(), title: z.string().exactOptional() }),
]);
export type EmbedInput = z.output<typeof EmbedInputSchema>;

/** Sizes EmbeddingGemma-300m was trained to truncate to. */
export const EMBEDDING_GEMMA_DIMENSIONS: readonly number[] = [768, 512, 256, 128];

/** The prompt EmbeddingGemma was trained on for this kind of input. */
export function embeddingGemmaPrompt(input: EmbedInput): string {
  return input.kind === "query"
    ? `task: ${input.task ?? "search result"} | query: ${input.text}`
    : `title: ${input.title ?? "none"} | text: ${input.text}`;
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
