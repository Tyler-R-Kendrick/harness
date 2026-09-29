import { measure, score, tokens } from "@harness/evolution";
import type { Measurement, TaskRun } from "@harness/evolution";

/** Task runs from rewards per task (and the same token count on every trial, if given). */
export function runs(rewards: Readonly<Record<string, readonly number[]>>, cost?: number, groups: Readonly<Record<string, string>> = {}): TaskRun[] {
  return Object.entries(rewards).map(([task, rs]) => ({
    task,
    ...(groups[task] === undefined ? {} : { group: groups[task] }),
    trials: rs.map((r) => ({ reward: score(r), ...(cost === undefined ? {} : { tokens: tokens(cost) }) })),
  }));
}

/** A measurement of `n` tasks t0..t(n-1), each with rewards from `reward(task index, trial index)`. */
export function measured(n: number, k: number, reward: (i: number, j: number) => number, cost?: number): Measurement {
  const ids = Array.from({ length: n }, (_, i) => `t${i}`);
  return measure(runs(Object.fromEntries(ids.map((id, i) => [id, Array.from({ length: k }, (_, j) => reward(i, j))])), cost), ids, k);
}
