import type { PromptfooSuite } from "@harness/adapters";

export interface PortResult {
  passed: boolean;
  detail?: string;
}

type Evaluate = (suite: PromptfooSuite, options: { cache: boolean; maxConcurrency: number }) => Promise<unknown>;

function failuresOf(summary: unknown): number {
  if (typeof summary !== "object" || summary === null) throw new Error("promptfoo results missing");
  const stats = (summary as Record<string, unknown>)["stats"];
  if (typeof stats !== "object" || stats === null) throw new Error("promptfoo stats missing");
  const failures = (stats as Record<string, unknown>)["failures"];
  if (typeof failures !== "number") throw new Error("promptfoo failures missing");
  return failures;
}

/** `evaluate()` returns an Eval record. Stats live on `toEvaluateSummary()`. */
async function summaryOf(record: unknown): Promise<unknown> {
  if (typeof record !== "object" || record === null) return record;
  const summarize = (record as Record<string, unknown>)["toEvaluateSummary"];
  if (typeof summarize !== "function") return record;
  return await summarize.call(record);
}

export async function promptfooEvaluate(suite: PromptfooSuite, evaluate?: Evaluate): Promise<PortResult> {
  const run = evaluate ?? await defaultEvaluate();
  return { passed: failuresOf(await summaryOf(await run(suite, { cache: false, maxConcurrency: 1 }))) === 0 };
}

async function defaultEvaluate(): Promise<Evaluate> {
  process.env["PROMPTFOO_DISABLE_TELEMETRY"] = "1";
  const loaded = await import("promptfoo");
  return (suite, options) => loaded.evaluate(suite as Parameters<typeof loaded.evaluate>[0], options);
}
