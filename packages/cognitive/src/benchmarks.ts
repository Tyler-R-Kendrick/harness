import { z } from "zod";
import { TASK_CATEGORIES } from "./models.ts";
import type { BenchmarkResult } from "./models.ts";

export interface BenchmarkRow extends BenchmarkResult {
  readonly model: string;
}

const field = z.string().min(1);
const Row = z.object({
  model: field,
  task: z.enum(TASK_CATEGORIES),
  benchmark: field,
  metric: field,
  score: z.string().regex(/^<?\d+(\.\d+)?$/, "score is a number, written <n when lower is better"),
  setting: field.optional(),
  extra: z.array(z.string()).max(0, "too many fields"),
});

/**
 * Parse a benchmark table: one result per line, `model|task|benchmark|metric|score|setting`
 * (setting optional). A score written `<0.03` is lower-is-better. Blank lines and lines
 * starting with # are skipped. Results are compared only within the same benchmark, metric
 * and setting.
 */
export function parseBenchmarks(table: string): BenchmarkRow[] {
  return table.split("\n").flatMap((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return [];
    const [model, task, benchmark, metric, score, setting, ...extra] = line.split("|").map((f) => f.trim());
    const parsed = Row.safeParse({ model, task, benchmark, metric, score, setting: setting || undefined, extra });
    if (!parsed.success) throw new Error(`benchmark line ${i + 1}\n${z.prettifyError(parsed.error)}`);
    const r = parsed.data;
    return [{ model: r.model, task: r.task, benchmark: r.benchmark, metric: r.metric, score: Number(r.score.replace("<", "")), higherIsBetter: !r.score.startsWith("<"), ...(r.setting ? { setting: r.setting } : {}) }];
  });
}

/** The rows for one model, as the model's own benchmark list. */
export const benchmarksOf = (rows: readonly BenchmarkRow[], model: string): BenchmarkResult[] => rows.filter((r) => r.model === model).map(({ model: _, ...result }) => result);
