import { z } from "zod";

const issue = (ctx: z.core.$RefinementCtx, message: string): void => {
  ctx.addIssue({ code: "custom", message });
};

export const FailureClassSchema = z.enum(["refusal", "harness", "timeout", "genuine"]);
export type FailureClass = z.output<typeof FailureClassSchema>;

export const CaseSourceSchema = z.enum(["local", "promptfoo", "skills", "adk", "harbor", "assert", "inspect"]);
export type CaseSource = z.output<typeof CaseSourceSchema>;

export const ToolMatchSchema = z.enum(["strict", "unordered", "subset", "superset"]);
export type ToolMatch = z.output<typeof ToolMatchSchema>;

export const ToolCallSchema = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).exactOptional(),
}).strict();
export type ToolCall = z.output<typeof ToolCallSchema>;

const PromptfooAssertSchema = z.object({
  type: z.string().min(1),
  value: z.unknown().exactOptional(),
}).strict();

const ExpectSchema = z.object({
  schema: z.unknown().exactOptional(),
  regex: z.string().exactOptional(),
  files: z.array(z.string()).exactOptional(),
  tools: z.array(ToolCallSchema).exactOptional(),
  toolMatch: ToolMatchSchema.exactOptional(),
  rubric: z.string().exactOptional(),
  promptfoo: z.array(PromptfooAssertSchema).exactOptional(),
}).strict();

export const CaseSchema = z.object({
  id: z.string().min(1),
  source: CaseSourceSchema,
  instruction: z.string(),
  permissible: z.boolean().exactOptional(),
  k: z.int().positive().exactOptional(),
  expect: ExpectSchema.exactOptional(),
}).strict();
export type Case = z.output<typeof CaseSchema>;

export const SplitSchema = z.object({
  train: z.array(z.string()),
  test: z.array(z.string()),
}).strict();
export type Split = z.output<typeof SplitSchema>;

function duplicates(ids: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return undefined;
}

export const SpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["policy", "capability"]),
  cases: z.array(CaseSchema),
  split: SplitSchema,
}).strict().superRefine((spec, ctx) => {
  const caseIds = spec.cases.map((item) => item.id);
  if (duplicates(caseIds) !== undefined) issue(ctx, "split case ids must be unique");
  const known = new Set(caseIds);
  const trainDup = duplicates(spec.split.train);
  if (trainDup !== undefined) issue(ctx, "split train ids must be unique");
  const testDup = duplicates(spec.split.test);
  if (testDup !== undefined) issue(ctx, "split test ids must be unique");
  for (const id of spec.split.train) {
    if (spec.split.test.includes(id)) issue(ctx, `split overlaps on ${id}`);
    if (!known.has(id)) issue(ctx, `split train id ${id} is unknown`);
  }
  for (const id of spec.split.test) {
    if (!known.has(id)) issue(ctx, `split test id ${id} is unknown`);
  }
  const placed = new Set([...spec.split.train, ...spec.split.test]);
  for (const id of known) {
    if (!placed.has(id)) issue(ctx, `split dropped case ${id}`);
  }
  if (spec.kind === "policy") {
    for (const item of spec.cases) {
      if (item.permissible === undefined) issue(ctx, `split case ${item.id} needs permissible`);
    }
  }
});
export type Spec = z.output<typeof SpecSchema>;

/** An IR mark from one grader. Cognitive `Score` is a different refined unit. */
export const ScoreSchema = z.object({
  grader: z.string().min(1),
  passed: z.boolean(),
  detail: z.string().exactOptional(),
}).strict();
export type Score = z.output<typeof ScoreSchema>;

export const TrialSchema = z.object({
  caseId: z.string().min(1),
  split: z.enum(["train", "test"]),
  index: z.int().nonnegative(),
  output: z.string(),
  tools: z.array(ToolCallSchema),
  files: z.array(z.string()),
  behavior: z.enum(["complied", "refused", "errored"]),
  failureClass: FailureClassSchema.exactOptional(),
  scores: z.array(ScoreSchema),
  passed: z.boolean(),
}).strict();
export type Trial = z.output<typeof TrialSchema>;

export const SplitRatesSchema = z.object({
  pass: z.boolean(),
  impermissible: z.number(),
  overrefusal: z.number(),
  passAtK: z.number(),
}).strict();
export type SplitRates = z.output<typeof SplitRatesSchema>;

export const ClimbRoundSchema = z.object({
  specId: z.string().min(1),
  patchId: z.string().min(1),
  frozen: SplitSchema,
  accepted: z.boolean(),
  reason: z.string().exactOptional(),
  train: SplitRatesSchema,
  test: SplitRatesSchema,
}).strict();
export type ClimbRound = z.output<typeof ClimbRoundSchema>;

function parsed<T>(result: z.ZodSafeParseResult<T>): T {
  if (!result.success) throw new Error(result.error.issues.map((item) => item.message).join("; "));
  return result.data;
}

export function parseSpec(input: unknown): Spec {
  return parsed(SpecSchema.safeParse(input));
}

export function parseTrials(input: unknown): Trial[] {
  return parsed(z.array(TrialSchema).safeParse(input));
}
