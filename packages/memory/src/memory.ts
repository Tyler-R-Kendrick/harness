import { count, create, insertMultiple, load, removeMultiple, save, search } from "@orama/orama";
import type { RawData } from "@orama/orama";
import { z } from "zod";
import { DimensionsSchema } from "@harness/cognitive";
import type { Dimensions, Embedder } from "@harness/cognitive";

/** Memory item ids: "m" and a number that is never reused. */
export const MemoryIdSchema = z.templateLiteral(["m", z.int().positive()]);
export type MemoryId = z.output<typeof MemoryIdSchema>;

/**
 * Memory the cognitive core can keep and search by meaning: text is embedded as a
 * document when remembered and as a query when recalled, and held in an Orama vector
 * index (pure JS, so the same on every platform). Items may belong to a session.
 */
export interface MemoryOptions {
  /** Embedding size of the index; every embedder that serves memory must produce it (see sharedEmbeddingSize). */
  readonly dimensions: Dimensions;
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
  /** Recall only items of these kinds. */
  readonly kinds?: readonly string[];
}

export interface Recollection {
  readonly id: MemoryId;
  readonly text: string;
  readonly score: number;
  readonly sessionId?: string;
  readonly kind?: string;
}

const FORMAT = "harness.memory/v1";
const Saved = z.object({ format: z.literal(FORMAT), dimensions: DimensionsSchema, next: z.int().positive(), index: z.custom<RawData>((v) => typeof v === "object" && v !== null) });

const index = (dimensions: number) =>
  create({ schema: { text: "string", sessionId: "enum", kind: "enum", embedding: `vector[${dimensions}]` as "vector[1]" } as const });

export class Memory {
  readonly #embedder: Pick<Embedder, "embed">;
  readonly #dimensions: Dimensions;
  readonly #index: ReturnType<typeof index>;
  readonly #onChange: ((memory: Memory) => void) | undefined;
  /** The next id's number: ids are never reused, even after forgetting. */
  #next = 1;

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
      this.#next = result.data.next;
    }
  }

  get size(): number {
    return count(this.#index);
  }

  async remember(items: readonly { readonly text: string; readonly sessionId?: string; readonly kind?: string }[]): Promise<MemoryId[]> {
    const vectors = await this.#embedder.embed(
      items.map((item) => ({ kind: "document", text: item.text })),
      { dimensions: this.#dimensions },
    );
    const docs = items.map((item, i) => ({ ...item, id: `m${this.#next + i}` as const, embedding: Array.from(vectors[i]!) }));
    this.#next += items.length;
    await insertMultiple(this.#index, docs);
    this.#onChange?.(this);
    return docs.map((d) => d.id);
  }

  /** Remove items by id; ids that are not there are ignored. */
  async forget(ids: readonly MemoryId[]): Promise<void> {
    await removeMultiple(this.#index, [...ids]);
    this.#onChange?.(this);
  }

  async recall(query: string, options: RecallOptions = {}): Promise<Recollection[]> {
    const [vector] = await this.#embedder.embed([{ kind: "query", text: query }], { dimensions: this.#dimensions });
    const session = options.sessionId !== undefined ? { sessionId: { eq: options.sessionId } } : options.excludeSession !== undefined ? { sessionId: { nin: [options.excludeSession] } } : {};
    const where = { ...session, ...(options.kinds ? { kind: { in: [...options.kinds] } } : {}) };
    const found = await search(this.#index, {
      mode: "vector",
      vector: { value: Array.from(vector!), property: "embedding" },
      similarity: options.minScore ?? 0.4,
      limit: options.limit ?? 5,
      includeVectors: false,
      ...(Object.keys(where).length > 0 ? { where } : {}),
    });
    return found.hits.map(({ id, score, document: d }) => ({ id: MemoryIdSchema.parse(id), text: d.text, score, ...(d.sessionId ? { sessionId: String(d.sessionId) } : {}), ...(d.kind ? { kind: String(d.kind) } : {}) }));
  }

  save(): unknown {
    return { format: FORMAT, dimensions: this.#dimensions, next: this.#next, index: save(this.#index) };
  }
}
