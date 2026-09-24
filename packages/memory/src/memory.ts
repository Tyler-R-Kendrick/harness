import { count, create, insertMultiple, load, save, search } from "@orama/orama";
import type { RawData } from "@orama/orama";
import { z } from "zod";
import type { Embedder } from "@harness/cognitive";

/**
 * Memory the cognitive core can keep and search by meaning: text is embedded as a
 * document when remembered and as a query when recalled, and held in an Orama vector
 * index (pure JS, so the same on every platform). Items may belong to a session.
 */
export interface MemoryOptions {
  /** Embedding size of the index; every embedder that serves memory must produce it (see sharedEmbeddingSize). */
  readonly dimensions: number;
  /** A previous `save()`, to continue from. */
  readonly saved?: unknown;
  /** Called after every change, e.g. to persist `save()`. */
  readonly onChange?: (memory: Memory) => void;
}

export interface RecallOptions {
  readonly limit?: number;
  /** Cosine similarity below which nothing is recalled (default 0.4). */
  readonly minScore?: number;
  /** Recall only this session's items... */
  readonly sessionId?: string;
  /** ...or everything but this session's. */
  readonly excludeSession?: string;
}

export interface Recollection {
  readonly id: string;
  readonly text: string;
  readonly score: number;
  readonly sessionId?: string;
  readonly kind?: string;
}

const FORMAT = "harness.memory/v1";
const Saved = z.object({ format: z.literal(FORMAT), dimensions: z.int().positive(), index: z.custom<RawData>((v) => typeof v === "object" && v !== null) });

const index = (dimensions: number) =>
  create({ schema: { text: "string", sessionId: "enum", kind: "enum", embedding: `vector[${dimensions}]` as "vector[1]" } as const });

export class Memory {
  readonly #embedder: Pick<Embedder, "embed">;
  readonly #dimensions: number;
  readonly #index: ReturnType<typeof index>;
  readonly #onChange: ((memory: Memory) => void) | undefined;

  constructor(embedder: Pick<Embedder, "embed">, options: MemoryOptions) {
    this.#embedder = embedder;
    this.#dimensions = options.dimensions;
    this.#index = index(this.#dimensions);
    this.#onChange = options.onChange;
    if (options.saved !== undefined) {
      const result = Saved.safeParse(options.saved);
      if (!result.success) throw new Error(`invalid saved memory\n${z.prettifyError(result.error)}`);
      if (result.data.dimensions !== this.#dimensions) throw new Error(`saved memory has ${result.data.dimensions} dimensions, this memory ${this.#dimensions}`);
      load(this.#index, result.data.index);
    }
  }

  get size(): number {
    return count(this.#index);
  }

  async remember(items: readonly { readonly text: string; readonly sessionId?: string; readonly kind?: string }[]): Promise<string[]> {
    const vectors = await this.#embedder.embed(
      items.map((item) => ({ kind: "document", text: item.text })),
      { dimensions: this.#dimensions },
    );
    const first = this.size + 1;
    const docs = items.map((item, i) => ({ ...item, id: `m${first + i}`, embedding: Array.from(vectors[i]!) }));
    const ids = await insertMultiple(this.#index, docs);
    this.#onChange?.(this);
    return ids;
  }

  async recall(query: string, options: RecallOptions = {}): Promise<Recollection[]> {
    const [vector] = await this.#embedder.embed([{ kind: "query", text: query }], { dimensions: this.#dimensions });
    const where = options.sessionId !== undefined ? { sessionId: { eq: options.sessionId } } : options.excludeSession !== undefined ? { sessionId: { nin: [options.excludeSession] } } : undefined;
    const found = await search(this.#index, {
      mode: "vector",
      vector: { value: Array.from(vector!), property: "embedding" },
      similarity: options.minScore ?? 0.4,
      limit: options.limit ?? 5,
      includeVectors: false,
      ...(where ? { where } : {}),
    });
    return found.hits.map(({ id, score, document: d }) => ({ id, text: d.text, score, ...(d.sessionId ? { sessionId: String(d.sessionId) } : {}), ...(d.kind ? { kind: String(d.kind) } : {}) }));
  }

  save(): unknown {
    return { format: FORMAT, dimensions: this.#dimensions, index: save(this.#index) };
  }
}
