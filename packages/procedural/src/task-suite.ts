/**
 * Task suites (plan §10): a user's replayable tasks, as data, for dream's evaluator. A
 * task file (JSON with a `$schema` generated from `TaskSuiteSchema`) holds tasks
 * `{id, prompt, expected?, split}`, the scorer that turns an answer into a score in
 * [0, 1] (`exact`, `normalized-exact`, `f1`, or `judge`: the judge's probability that the
 * answer is right), and optionally the host tools a solver may call. The metrics are
 * here; `taskSuiteEvaluator` runs the tasks.
 */
import { z } from "zod";

/** How an answer is scored: a metric against the expected answer, or a judge's probability. */
export const TASK_SCORERS = ["exact", "normalized-exact", "f1", "judge"] as const;
export type TaskScorer = (typeof TASK_SCORERS)[number];
export type TaskMetric = Exclude<TaskScorer, "judge">;

const text = z.string().min(1);

export const SuiteTaskSchema = z.strictObject({
  id: text,
  /** What the solver is asked. */
  prompt: text,
  /** The right answer, which the metrics compare with and a judge is shown. */
  expected: z.string().exactOptional(),
  /** Training tasks are rolled out for the refiner; validation tasks gate candidates. */
  split: z.enum(["train", "validation"]),
});
export type SuiteTask = z.output<typeof SuiteTaskSchema>;

/** A host tool the solver may call, by its name among the host's tools, with the description the solver sees. */
const SuiteToolSchema = z.strictObject({ name: text, description: text.exactOptional() });

export const TaskSuiteSchema = z
  .strictObject({
    $schema: z.string().exactOptional(),
    /** What the tasks are about: the refiner's `{task_description}`. */
    description: text.exactOptional(),
    /** The solver's instructions. */
    instructions: text.exactOptional(),
    scorer: z.enum(TASK_SCORERS),
    /** The judge's question, for the `judge` scorer; the settings' `taskJudge` prompt when absent. */
    judge: z.strictObject({ instructions: text }).exactOptional(),
    /** Host tools the solver may call (the host decides which of its tools it offers; they run where it runs them). */
    tools: z.array(SuiteToolSchema).exactOptional(),
    tasks: z.array(SuiteTaskSchema).min(1),
  })
  .superRefine((suite, ctx) => {
    const ids = new Set<string>();
    suite.tasks.forEach((task, i) => {
      if (ids.has(task.id)) ctx.addIssue({ code: "custom", message: `task id ${task.id} is used twice`, path: ["tasks", i, "id"] });
      ids.add(task.id);
      if (suite.scorer !== "judge" && task.expected === undefined) ctx.addIssue({ code: "custom", message: `the ${suite.scorer} scorer compares with an expected answer`, path: ["tasks", i, "expected"] });
    });
    if (!suite.tasks.some((t) => t.split === "validation")) ctx.addIssue({ code: "custom", message: "a task suite needs at least one validation task", path: ["tasks"] });
    const names = new Set<string>();
    (suite.tools ?? []).forEach((tool, i) => {
      if (names.has(tool.name)) ctx.addIssue({ code: "custom", message: `tool ${tool.name} is named twice`, path: ["tools", i, "name"] });
      names.add(tool.name);
    });
  })
  .brand<"TaskSuite">();
export type TaskSuite = z.output<typeof TaskSuiteSchema>;

/** Parse a task file; any problem refuses it whole, naming where. */
export function parseTaskSuite(input: unknown): TaskSuite {
  const result = TaskSuiteSchema.safeParse(input);
  if (!result.success) throw new RangeError(`invalid task suite\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** JSON Schema for task files, for editors (data/task-suite.schema.json). */
export const taskSuiteJsonSchema = (): object => z.toJSONSchema(TaskSuiteSchema, { io: "input" });

const ARTICLES = new Set(["a", "an", "the"]);

/** An answer as the metrics compare it (SQuAD's normalization): lower case, without punctuation, articles or extra spaces. */
export function normalizeAnswer(answer: string): string {
  return tokensOf(answer).join(" ");
}

function tokensOf(answer: string): string[] {
  return answer
    .toLowerCase()
    .replace(/\p{P}/gu, "")
    .split(/\s+/)
    .filter((token) => token !== "" && !ARTICLES.has(token));
}

/** Token F1 of an answer against the expected one, over normalized tokens (repeats count); two empty answers agree. */
export function f1Score(answer: string, expected: string): number {
  const said = tokensOf(answer);
  const wanted = tokensOf(expected);
  if (said.length === 0 || wanted.length === 0) return Number(said.length === wanted.length);
  const left = new Map<string, number>();
  for (const token of wanted) left.set(token, (left.get(token) ?? 0) + 1);
  let common = 0;
  for (const token of said) {
    const n = left.get(token) ?? 0;
    if (n > 0) {
      common += 1;
      left.set(token, n - 1);
    }
  }
  if (common === 0) return 0;
  const precision = common / said.length;
  const recall = common / wanted.length;
  return (2 * precision * recall) / (precision + recall);
}

/** An answer's score in [0, 1] under a metric. */
export function scoreAnswer(metric: TaskMetric, answer: string, expected: string): number {
  if (metric === "exact") return Number(answer.trim() === expected.trim());
  if (metric === "normalized-exact") return Number(normalizeAnswer(answer) === normalizeAnswer(expected));
  return f1Score(answer, expected);
}
