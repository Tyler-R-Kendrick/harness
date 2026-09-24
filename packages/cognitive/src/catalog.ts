import { z } from "zod";
import { LOCALITIES, PLATFORMS, PORT_KINDS, TASK_CATEGORIES, TASK_PORTS } from "./models.ts";
import type { BenchmarkResult, RUNTIMES, TaskCategory } from "./models.ts";

/** A catalog model with its benchmark results attached. */
export type ModelDescriptor = ModelEntry & { readonly benchmarks: readonly BenchmarkResult[] };

/**
 * Catalog data is not code: models, task preferences and benchmark results live in JSON
 * files (packages/cognitive/data, and one set per extension) that we edit by hand. Each
 * file names a JSON Schema generated from these schemas, so editors check it as it is
 * written; the host loads the files at runtime and parses them here.
 */

const id = z.string().min(1);
const task = z.enum(TASK_CATEGORIES);

const Artifact = z.strictObject({
  repo: id,
  revision: z.string().regex(/^[0-9a-f]{40}$/, "a pinned commit, never a branch"),
  files: z.array(z.strictObject({ path: id, bytes: z.int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(1).readonly(),
});

/** Chat-template options passed through to the model's template (e.g. turning thinking off). */
const template = z.record(z.string(), z.unknown());
const env = z.record(z.string(), z.string());

/** How each runtime runs a model; file names refer to the model's artifact. */
const RUN = {
  /** A model on the Vercel AI Gateway, by its gateway id. */
  "ai-gateway": z.strictObject({ model: id }),
  /** A server speaking TypeSafe's evaluation API; env names override the address and key. */
  "typesafe-api": z.strictObject({ baseUrl: z.url(), model: id, health: id.exactOptional(), baseUrlEnv: id.exactOptional(), apiKeyEnv: id.exactOptional() }),
  /**
   * Cactus's WASM engine: an Emscripten loader, its WASM and the weights. `prefix` names
   * the engine's C API (`<prefix>_load`, `_init`, `_reset`, `_complete`, `_embed`); `env`
   * is set before loading (e.g. to turn telemetry off).
   */
  "cactus-wasm": z.strictObject({ loader: id, wasm: id, weights: id, prefix: z.string().regex(/^[a-z_][a-z0-9_]*$/), env: env.exactOptional() }),
  /** A transformers.js model at the artifact's repo and revision. */
  "transformers.js": z.strictObject({
    dtype: z.union([id, z.record(z.string(), id)]),
    /** The transformers.js class of a generator or document parser (image-text-to-text). */
    modelClass: id.exactOptional(),
    /** Processors that take (images, text) rather than (text, images). */
    imagesFirst: z.boolean().exactOptional(),
    template: template.exactOptional(),
  }),
  /** llama.cpp's llama-server on a GGUF file (and its multimodal projector). */
  "llama.cpp-server": z.strictObject({ model: id, projector: id.exactOptional(), args: z.array(z.string()).exactOptional() }),
  /**
   * An ONNX decoder patched with a steering tap (see makeSteerable): the node whose summed
   * residual is read and steered, and the layer whose SAE features it carries. Its
   * tokenizer and chat template come from the model file's folder in the artifact.
   */
  onnxruntime: z.strictObject({
    model: id,
    tap: z.strictObject({ node: id, steerInput: z.int().min(0), residOutput: z.int().min(0), layer: z.int().min(0) }),
    decoder: z.strictObject({ layers: z.int().positive(), kvHeads: z.int().positive(), headSize: z.int().positive(), hidden: z.int().positive() }),
    endTokens: z.array(id).min(1),
    template: template.exactOptional(),
  }),
} satisfies Record<(typeof RUNTIMES)[number], z.ZodType>;

/** What an embedding model expects: prompt templates ({text}, and optional {task}/{title}) and the sizes it can truncate to (native first). */
const Embedding = z.strictObject({ query: id, document: id, defaults: z.record(z.string(), z.string()).exactOptional(), dimensions: z.array(z.int().positive()).min(1).readonly() });
/** A token-classification compressor: its window and how its tokenizer marks subwords. */
const Compression = z.strictObject({ window: z.int().positive(), subwords: z.enum(["wordpiece", "sentencepiece"]), keepLabel: z.int().min(0) });

const Base = z.strictObject({
  id,
  name: id,
  publisher: id,
  tasks: z.array(task).min(1).readonly(),
  ports: z.array(z.enum(PORT_KINDS)).min(1).readonly(),
  locality: z.enum(LOCALITIES),
  platforms: z.array(z.enum(PLATFORMS)).min(1).readonly(),
  license: id,
  /** Weight bytes a client downloads; 0 for hosted models. */
  downloadBytes: z.int().min(0),
  notes: z.string().exactOptional(),
  artifact: Artifact.exactOptional(),
  embedding: Embedding.exactOptional(),
  compression: Compression.exactOptional(),
});

const Model = z
  .discriminatedUnion("runtime", [
    Base.extend({ runtime: z.literal("ai-gateway"), run: RUN["ai-gateway"] }),
    Base.extend({ runtime: z.literal("typesafe-api"), run: RUN["typesafe-api"] }),
    Base.extend({ runtime: z.literal("cactus-wasm"), run: RUN["cactus-wasm"] }),
    Base.extend({ runtime: z.literal("transformers.js"), run: RUN["transformers.js"] }),
    Base.extend({ runtime: z.literal("llama.cpp-server"), run: RUN["llama.cpp-server"] }),
    Base.extend({ runtime: z.literal("onnxruntime"), run: RUN.onnxruntime }),
  ])
  .superRefine((m, ctx) => {
    const issue = (message: string, ...path: string[]) => ctx.addIssue({ code: "custom", message, path });
    for (const t of m.tasks) if (!TASK_PORTS[t].some((p) => m.ports.includes(p))) issue(`no port of ${m.id} serves ${t}`, "tasks");
    if (m.locality === "hosted" && (m.artifact || m.downloadBytes !== 0)) issue("a hosted model downloads nothing", "artifact");
    if (m.locality === "local" && !m.artifact) issue("a local model pins its weights", "artifact");
    if (m.artifact && m.downloadBytes !== m.artifact.files.reduce((sum, f) => sum + f.bytes, 0)) issue("downloadBytes is the sum of the artifact's files", "downloadBytes");
    // A category's settings come exactly with its port, so a host can read the port from them.
    if (m.ports.includes("embedder") !== (m.embedding !== undefined)) issue("an embedder, and only an embedder, says how it is prompted and which sizes it has", "embedding");
    if (m.ports.includes("compressor") !== (m.compression !== undefined)) issue("a compressor, and only a compressor, gives its window and subword style", "compression");
    if (m.runtime === "transformers.js" && (m.ports.includes("generator") || m.ports.includes("document-parser")) !== (m.run.modelClass !== undefined)) {
      issue("a transformers.js generator or document parser, and only those, names its model class", "run", "modelClass");
    }
    const files = new Set(m.artifact?.files.map((f) => f.path));
    for (const key of ["loader", "wasm", "weights", "model", "projector"] as const) {
      const file = (m.run as Record<string, unknown>)[key];
      if (typeof file === "string" && m.runtime !== "ai-gateway" && m.runtime !== "typesafe-api" && !files.has(file)) issue(`${file} is not a file of the artifact`, "run", key);
    }
  });

export type ModelEntry = z.output<typeof Model>;
export type EmbeddingConfig = z.output<typeof Embedding>;
export type CompressionConfig = z.output<typeof Compression>;

export const CatalogFileSchema = z
  .strictObject({
    $schema: z.string().optional(),
    models: z.array(Model),
    /** Per task, model ids in the order to prefer them when benchmarks cannot separate them. */
    preferences: z.partialRecord(task, z.array(id)),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.models.forEach((m, i) => {
      if (seen.has(m.id)) ctx.addIssue({ code: "custom", message: `model ${m.id} is listed twice`, path: ["models", i, "id"] });
      seen.add(m.id);
    });
    for (const [t, ids] of Object.entries(c.preferences)) {
      for (const pref of ids ?? []) {
        if (!c.models.some((m) => m.id === pref && m.tasks.includes(t as TaskCategory))) ctx.addIssue({ code: "custom", message: `${pref} does not serve ${t}`, path: ["preferences", t] });
      }
    }
  });

/** One result per row: model, task, benchmark, metric, score, which way is better, and the setting it depends on (optional). */
export const BenchmarksFileSchema = z.strictObject({
  $schema: z.string().optional(),
  rows: z.array(z.tuple([id, task, id, id, z.number(), z.enum(["higher", "lower"])], id).check(z.maxLength(7, "a row has at most 7 fields"))),
});

export interface Catalog {
  readonly models: readonly ModelDescriptor[];
  readonly preferences: Partial<Record<TaskCategory, readonly string[]>>;
}

function parse<T>(schema: z.ZodType<T>, what: string, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(`invalid ${what}\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** Parse a catalog file and its benchmarks file; every benchmark row must name a model of the catalog and a task that model serves. */
export function parseCatalog(catalog: unknown, benchmarks: unknown): Catalog {
  const { models, preferences } = parse(CatalogFileSchema, "catalog", catalog);
  const { rows } = parse(BenchmarksFileSchema, "benchmarks", benchmarks);
  rows.forEach(([model, t], i) => {
    if (!models.some((m) => m.id === model && m.tasks.includes(t))) throw new Error(`invalid benchmarks\n✖ ${model} is not a catalog model serving ${t}\n  → at rows[${i}]`);
  });
  return {
    preferences,
    models: models.map((m) => ({
      ...m,
      benchmarks: rows
        .filter((r) => r[0] === m.id)
        .map(([, t, benchmark, metric, score, better, setting]) => ({ benchmark, task: t, metric, score, higherIsBetter: better === "higher", ...(setting ? { setting } : {}) })),
    })),
  };
}

/** JSON Schemas for the data files, for editors (see data/*.schema.json). */
export const catalogJsonSchemas = (): { catalog: object; benchmarks: object } => ({
  catalog: z.toJSONSchema(CatalogFileSchema, { io: "input" }),
  benchmarks: z.toJSONSchema(BenchmarksFileSchema, { io: "input" }),
});
