import { z } from "zod";
import { score, ScoreSchema, tokens, TokensSchema } from "./units.ts";
import type { Score, Tokens } from "./units.ts";

/** One trial of a harness on a task: the verifier's reward, the policy tokens it spent, and what the verifier said. */
export interface Trial {
  readonly reward: Score;
  readonly tokens?: Tokens;
  readonly feedback?: string;
}

/**
 * A harness's trials on one task. Fewer than k trials means the rest are missing (a crash,
 * a timeout, lost infrastructure). `weight` scales the task's share of the score (Harvey
 * LAB weighs a task by its number of rubric criteria); `group` names the cluster it was
 * drawn with (a practice area, a repository), which is what resampling treats as the unit
 * of generalization.
 */
export interface TaskRun {
  readonly task: string;
  readonly group?: string;
  readonly weight?: number;
  readonly trials: readonly Trial[];
}

export const TaskMeasureSchema = z.strictObject({
  task: z.string().min(1),
  group: z.string().min(1),
  weight: z.number().positive(),
  /** k rewards, missing trials as 0. */
  rewards: z.array(z.number().min(0).max(1)).readonly(),
  tokens: z.array(z.number().min(0)).readonly(),
  missing: z.int().min(0),
  mean: z.number().min(0).max(1),
  feedback: z.string().exactOptional(),
});
export type TaskMeasure = z.output<typeof TaskMeasureSchema>;

export const MeasurementSchema = z.strictObject({
  k: z.int().positive(),
  /** By task id. */
  tasks: z.array(TaskMeasureSchema).readonly(),
  score: ScoreSchema,
  cost: TokensSchema.exactOptional(),
  missing: z.int().min(0),
  expected: z.int().positive(),
});
/** Evaluate(H, D, k): a harness's score and cost on a task set (Eq. 3), with every task's trials kept for paired comparison. */
export type Measurement = z.output<typeof MeasurementSchema>;

function summarize(k: number, tasks: readonly TaskMeasure[]): Measurement {
  let num = 0;
  let den = 0;
  const spent: number[] = [];
  for (const t of tasks) {
    num += t.weight * t.rewards.reduce((s, r) => s + r, 0);
    den += t.weight * t.rewards.length;
    spent.push(...t.tokens.filter((x) => x > 0));
  }
  const missing = tasks.reduce((s, t) => s + t.missing, 0);
  return {
    k,
    tasks,
    score: score(num / den),
    ...(spent.length ? { cost: tokens(spent.reduce((s, x) => s + x, 0) / spent.length) } : {}),
    missing,
    expected: tasks.reduce((s, t) => s + t.rewards.length, 0),
  };
}

/**
 * The score and cost of Eq. (3): S = sum_x w_x sum_j r_xj / sum_x w_x k, and C the mean
 * tokens of the trials that report any. A missing trial counts 0 with the full
 * denominator, never as an absent slot, so a candidate cannot look better by destroying
 * the trials it finds hard.
 */
export function measure(runs: readonly TaskRun[], tasks: readonly string[], k: number): Measurement {
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`k must be a positive integer, not ${k}`);
  if (tasks.length === 0) throw new RangeError("no tasks to measure");
  const asked = new Set(tasks);
  const byTask = new Map<string, TaskRun>();
  for (const run of runs) {
    if (!asked.has(run.task)) throw new RangeError(`a run of ${run.task} was not asked for`);
    if (byTask.has(run.task)) throw new RangeError(`${run.task} twice in one evaluation`);
    if (run.trials.length > k) throw new RangeError(`${run.trials.length} trials of ${run.task}, more than k = ${k}`);
    if (run.weight !== undefined && !(run.weight > 0 && Number.isFinite(run.weight))) throw new RangeError(`the weight of ${run.task} must be positive, not ${run.weight}`);
    byTask.set(run.task, run);
  }
  const measures = [...asked].sort().map((task): TaskMeasure => {
    const run = byTask.get(task);
    const trials = run?.trials ?? [];
    const rewards: number[] = Array.from({ length: k }, (_, j) => trials[j]?.reward ?? 0);
    const worst = trials.reduce<Trial | undefined>((w, t) => (w === undefined || t.reward < w.reward ? t : w), undefined);
    return {
      task,
      group: run?.group ?? task,
      weight: run?.weight ?? 1,
      rewards,
      tokens: trials.flatMap((t) => (t.tokens === undefined ? [] : [t.tokens])),
      missing: k - trials.length,
      mean: rewards.reduce((s, r) => s + r, 0) / k,
      ...(worst?.feedback === undefined ? {} : { feedback: worst.feedback }),
    };
  });
  return summarize(k, measures);
}

/** Measurements of the same harness on the same tasks, as one with all their trials. */
export function pool(measurements: readonly Measurement[]): Measurement {
  const [first, ...rest] = measurements;
  if (!first) throw new RangeError("nothing to pool");
  if (rest.length === 0) return first;
  const ids = first.tasks.map((t) => t.task).join("\n");
  if (rest.some((m) => m.tasks.map((t) => t.task).join("\n") !== ids)) throw new RangeError("measurements of different tasks do not pool");
  const tasks = first.tasks.map((t, i): TaskMeasure => {
    const all = measurements.map((m) => m.tasks[i]!);
    const rewards = all.flatMap((x) => x.rewards);
    return {
      ...t,
      rewards,
      tokens: all.flatMap((x) => x.tokens),
      missing: all.reduce((s, x) => s + x.missing, 0),
      mean: rewards.reduce((s, r) => s + r, 0) / rewards.length,
    };
  });
  return summarize(
    measurements.reduce((s, m) => s + m.k, 0),
    tasks,
  );
}
