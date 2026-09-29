import type { FailureClass } from "@harness/ir";

export interface HarborEvalStat {
  nTrials: number;
  nErrors: number;
  metrics: unknown;
}

export interface HarborJobView {
  id: string;
  evals: Record<string, HarborEvalStat>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function numberField(row: Record<string, unknown>, field: string): number {
  if (!Object.hasOwn(row, field)) throw new Error(`missing ${field}`);
  const value = row[field];
  if (typeof value !== "number") throw new Error(`missing ${field}`);
  return value;
}

/** A tolerant read of Harbor's job `result.json`. This does not run Harbor. */
export function parseHarborJob(input: unknown): HarborJobView {
  const row = object(input, "harbor job");
  const id = row["id"];
  if (typeof id !== "string" || id.length === 0) throw new Error("missing id");
  const stats = object(row["stats"], "stats");
  const evals = object(stats["evals"], "evals");
  const parsed: Record<string, HarborEvalStat> = {};
  for (const key of Object.keys(evals)) {
    const stat = object(evals[key], key);
    parsed[key] = { nTrials: numberField(stat, "n_trials"), nErrors: numberField(stat, "n_errors"), metrics: stat["metrics"] };
  }
  return { id, evals: parsed };
}

function exceptionName(row: Record<string, unknown>): string | undefined {
  const info = row["exception_info"];
  if (info === null || info === undefined) {
    return typeof row["exception"] === "string" ? row["exception"] : undefined;
  }
  const body = object(info, "exception_info");
  if (typeof body["exception_type"] === "string") return body["exception_type"];
  if (typeof body["exception_message"] === "string") return body["exception_message"];
  return undefined;
}

function refused(row: Record<string, unknown>): boolean {
  if (row["refused"] === true) return true;
  const agent = row["agent_result"];
  if (typeof agent !== "object" || agent === null) return false;
  const body = agent as Record<string, unknown>;
  if (body["refused"] === true) return true;
  const metadata = body["metadata"];
  return typeof metadata === "object" && metadata !== null && (metadata as Record<string, unknown>)["refused"] === true;
}

function rewardOf(row: Record<string, unknown>): number | undefined {
  if (typeof row["reward"] === "number") return row["reward"];
  const verifier = row["verifier_result"];
  if (typeof verifier !== "object" || verifier === null) return undefined;
  const rewards = (verifier as Record<string, unknown>)["rewards"];
  if (typeof rewards !== "object" || rewards === null) return undefined;
  const reward = (rewards as Record<string, unknown>)["reward"];
  return typeof reward === "number" ? reward : undefined;
}

/** Map a Harbor trial `result.json` onto a failure class. Reward 1 has none. */
export function failureClassFromHarbor(input: unknown): FailureClass | undefined {
  const row = object(input, "harbor trial");
  const exception = exceptionName(row);
  if (exception !== undefined) return exception.toLowerCase().includes("timeout") ? "timeout" : "harness";
  if (refused(row)) return "refusal";
  const reward = rewardOf(row);
  if (reward === 1) return undefined;
  if (reward === 0) return "genuine";
  throw new Error("missing reward");
}
