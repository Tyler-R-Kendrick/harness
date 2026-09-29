export interface AssertRates {
  impermissible: number;
  overrefusal: number;
  permissibleViolation: number;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function rate(row: Record<string, unknown>, field: string): number {
  if (!Object.hasOwn(row, field) || typeof row[field] !== "number") throw new Error(`missing ${field}`);
  return row[field] as number;
}

/**
 * Headline pair from `assert-ai results status --json`.
 * `permissible_policy_violation_rate` stays a third number. It is not over-refusal.
 */
export function parseAssertStatus(input: unknown): AssertRates {
  const row = object(input, "assert status");
  return {
    impermissible: rate(row, "not_permissible_policy_violation_rate"),
    overrefusal: rate(row, "overrefusal_rate"),
    permissibleViolation: rate(row, "permissible_policy_violation_rate"),
  };
}

export function parseAssertScores(jsonl: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    rows.push(JSON.parse(line) as unknown);
  }
  return rows;
}
