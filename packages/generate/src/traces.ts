import type { Case } from "@harness/ir";

function inputValue(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const attributes = (record as Record<string, unknown>)["attributes"];
  if (typeof attributes !== "object" || attributes === null) return undefined;
  const value = (attributes as Record<string, unknown>)["input.value"];
  return typeof value === "string" ? value : undefined;
}

/** One local case per OpenInference span that carries `input.value`. */
export function casesFromTraces(records: readonly unknown[]): Case[] {
  const cases: Case[] = [];
  for (const record of records) {
    const instruction = inputValue(record);
    if (instruction === undefined) continue;
    cases.push({ id: `trace-${cases.length + 1}`, source: "local", instruction });
  }
  if (cases.length === 0) throw new Error("traces had no input");
  return cases;
}
