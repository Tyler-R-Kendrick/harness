import { z } from "zod";
import { LOCALITIES, PLATFORMS, PORT_KINDS, RUNTIMES, TASK_CATEGORIES, TASK_PORTS } from "./models.ts";
import type { ModelDescriptor, TaskCategory } from "./models.ts";

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
  files: z.array(z.strictObject({ path: id, bytes: z.int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(1),
});

const Model = z
  .strictObject({
    id,
    name: id,
    publisher: id,
    tasks: z.array(task).min(1),
    ports: z.array(z.enum(PORT_KINDS)).min(1),
    locality: z.enum(LOCALITIES),
    runtime: z.enum(RUNTIMES),
    platforms: z.array(z.enum(PLATFORMS)).min(1),
    license: id,
    /** Weight bytes a client downloads; 0 for hosted models. */
    downloadBytes: z.int().min(0),
    notes: z.string().exactOptional(),
    artifact: Artifact.exactOptional(),
  })
  .superRefine((m, ctx) => {
    for (const t of m.tasks) if (!TASK_PORTS[t].some((p) => m.ports.includes(p))) ctx.addIssue({ code: "custom", message: `no port of ${m.id} serves ${t}`, path: ["tasks"] });
    if (m.locality === "hosted" && (m.artifact || m.downloadBytes !== 0)) ctx.addIssue({ code: "custom", message: "a hosted model downloads nothing", path: ["artifact"] });
    if (m.locality === "local" && !m.artifact) ctx.addIssue({ code: "custom", message: "a local model pins its weights", path: ["artifact"] });
    if (m.artifact && m.downloadBytes !== m.artifact.files.reduce((sum, f) => sum + f.bytes, 0)) ctx.addIssue({ code: "custom", message: "downloadBytes is the sum of the artifact's files", path: ["downloadBytes"] });
  });

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
