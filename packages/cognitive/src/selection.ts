import type { BenchmarkResult, ModelDescriptor, Platform, TaskCategory } from "./models.ts";

export interface SelectionOptions {
  readonly platform: Platform;
  /** Hosted models are allowed unless this is false. */
  readonly allowHosted?: boolean;
  readonly maxDownloadBytes?: number;
  /** Tie-break order when benchmarks do not separate models. */
  readonly prefer?: readonly string[];
  /** Put this model first when it is eligible. */
  readonly pin?: string;
}

export interface Evidence {
  readonly against: string;
  readonly benchmark: string;
  readonly metric: string;
  readonly setting: string | undefined;
  readonly ours: number;
  readonly theirs: number;
  readonly source: string;
}

export interface Ranked {
  readonly id: string;
  readonly descriptor: ModelDescriptor;
  /** Head-to-head record: pairs won and lost on shared benchmarks for the task. */
  readonly wins: number;
  readonly losses: number;
  readonly evidence: readonly Evidence[];
}

const key = (b: BenchmarkResult) => `${b.benchmark}\u0000${b.metric}\u0000${b.setting ?? ""}`;

export function eligible(task: TaskCategory, m: ModelDescriptor, options: SelectionOptions): boolean {
  return (
    m.tasks.includes(task) &&
    m.platforms.includes(options.platform) &&
    (options.allowHosted !== false || m.locality !== "hosted") &&
    (options.maxDownloadBytes === undefined || m.downloadBytes <= options.maxDownloadBytes)
  );
}

/**
 * Rank the models that can do `task` here. Scores are only compared on a benchmark
 * both models report with the same metric and setting; numbers from different
 * benchmarks are never compared. Each pair is won by whoever wins more shared
 * benchmarks, and models are ordered by pairs won minus pairs lost. Ties fall back
 * to the curated preference list (numbers from different benchmarks cannot rank
 * models, so a person decides), then the amount of evidence for the task, local
 * before hosted, the smaller download, then input order.
 */
export function rankForTask(task: TaskCategory, models: readonly ModelDescriptor[], options: SelectionOptions): Ranked[] {
  const candidates = models.filter((m) => eligible(task, m, options));
  const results = new Map(candidates.map((m) => [m.id, new Map(m.benchmarks.filter((b) => b.task === task).map((b) => [key(b), b]))]));
  const records = candidates.map((m) => ({ id: m.id, descriptor: m, wins: 0, losses: 0, evidence: [] as Evidence[] }));
  for (const a of records)
    for (const b of records) {
      if (a === b) continue;
      let net = 0;
      for (const [k, ours] of results.get(a.id)!) {
        const theirs = results.get(b.id)!.get(k);
        if (!theirs) continue;
        a.evidence.push({ against: b.id, benchmark: ours.benchmark, metric: ours.metric, setting: ours.setting, ours: ours.score, theirs: theirs.score, source: ours.source });
        const diff = ours.higherIsBetter ? ours.score - theirs.score : theirs.score - ours.score;
        net += Math.sign(diff);
      }
      if (net > 0) a.wins++;
      else if (net < 0) a.losses++;
    }
  const preference = (id: string) => {
    const i = options.prefer?.indexOf(id) ?? -1;
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };
  const order = new Map(candidates.map((m, i) => [m.id, i]));
  return records.sort(
    (x, y) =>
      Number(y.id === options.pin) - Number(x.id === options.pin) ||
      y.wins - y.losses - (x.wins - x.losses) ||
      preference(x.id) - preference(y.id) ||
      results.get(y.id)!.size - results.get(x.id)!.size ||
      Number(x.descriptor.locality === "hosted") - Number(y.descriptor.locality === "hosted") ||
      x.descriptor.downloadBytes - y.descriptor.downloadBytes ||
      order.get(x.id)! - order.get(y.id)!,
  );
}
