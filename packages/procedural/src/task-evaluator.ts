/**
 * A generic `Evaluator` over a task suite (plan §10): each task runs through a session
 * agent (`sessionAgent` of `@harness/workers`) pinned to the candidate graph, so the
 * graph guides it step by step exactly as it would guide a live session, and its final
 * answer is scored by the suite's metric or by a judge (the judge's probability that the
 * answer is right is the score). Training rollouts return each task's query and steps
 * for the refiner.
 *
 * Each evaluation holds the candidate as the only head of a store of its own, so it
 * never touches the host's graphs, and runs the tasks one after another, in order.
 */
import { experimental_evaluate } from "ai";
import type { Experimental_EvaluationModel as EvaluationModel, LanguageModel, ModelMessage, ToolSet } from "ai";
import { sessionAgent } from "@harness/workers";
import type { RolloutResult } from "./dream.ts";
import type { Evaluator } from "./dream-runner.ts";
import { GraphIdSchema } from "./graph.ts";
import type { ProceduralGraph } from "./graph.ts";
import { importGraph } from "./import-export.ts";
import { MemoryProceduralStore } from "./memory-store.ts";
import { parseResolver } from "./resolver.ts";
import { presetOf } from "./settings.ts";
import type { Settings } from "./settings.ts";
import { proceduralStep, trajectorySteps } from "./step.ts";
import { scoreAnswer } from "./task-suite.ts";
import type { SuiteTask, TaskSuite } from "./task-suite.ts";

/** The graph id a candidate is held under while it is evaluated. */
const CANDIDATE = GraphIdSchema.parse("candidate");
const RESOLVER = parseResolver({ rules: [{ when: {}, graph: CANDIDATE }] });

export interface TaskSuiteEvaluatorOptions {
  readonly suite: TaskSuite;
  /** Procedural settings: the preset's guidance, and the `taskJudge` prompt when the suite has no judge instructions. */
  readonly settings: Settings;
  /** The preset guidance follows; `harness` when not given. */
  readonly preset?: string;
  /** The solver's model. */
  readonly model: LanguageModel;
  /** The guidance model; the solver's when not given. */
  readonly guidance?: LanguageModel;
  /** The judge, for the `judge` scorer (asked once per evaluation, so a host can resolve it lazily). */
  readonly judge?: () => EvaluationModel | Promise<EvaluationModel>;
  /** The host's tools the suite may name, or a function giving them anew. */
  readonly tools?: ToolSet | (() => ToolSet | Promise<ToolSet>);
  /** Stamps the candidate's record and its pins. */
  readonly clock: { now(): number };
  /** Draws the pins' exposure salts. */
  readonly entropy: { bytes(length: number): Uint8Array };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The suite's tools out of the host's, each with the description the suite gives it. */
function suiteTools(suite: TaskSuite, host: ToolSet): ToolSet {
  const wanted = suite.tools ?? [];
  const missing = wanted.filter((t) => !Object.hasOwn(host, t.name)).map((t) => t.name);
  if (missing.length > 0) throw new RangeError(`the task suite names tools this host does not offer: ${missing.join(", ")}`);
  const chosen: ToolSet = {};
  for (const t of wanted) chosen[t.name] = t.description === undefined ? host[t.name]! : ({ ...host[t.name]!, description: t.description } as ToolSet[string]);
  return chosen;
}

/**
 * An `Evaluator` that runs a task suite. It refuses, when built, a `judge` scorer with no
 * judge or no question to ask; a suite naming tools the host does not offer is refused
 * when it runs.
 */
export function taskSuiteEvaluator(options: TaskSuiteEvaluatorOptions): Evaluator {
  const { suite, settings, model, clock, entropy } = options;
  const preset = presetOf(settings, options.preset ?? "harness");
  const question = suite.judge?.instructions ?? settings.prompts.taskJudge;
  if (suite.scorer === "judge" && options.judge === undefined) throw new RangeError("the task suite's judge scorer needs a judge");
  if (suite.scorer === "judge" && question === undefined) throw new RangeError("the task suite's judge scorer needs a question: the suite's judge.instructions or the settings' taskJudge prompt");

  const tasksOf = (split: "train" | "validation"): readonly SuiteTask[] => suite.tasks.filter((t) => t.split === split);

  async function score(task: SuiteTask, answer: string, judge: EvaluationModel | undefined): Promise<number> {
    if (suite.scorer !== "judge") return scoreAnswer(suite.scorer, answer, task.expected!);
    const state = { task: task.prompt, ...(task.expected === undefined ? {} : { expected: task.expected }), answer };
    const result = await experimental_evaluate({ model: judge!, state, questions: { correct: { type: "boolean", instructions: question! } } });
    // The SDK checks the answer is the boolean asked for, with a probability in [0, 1].
    return result.answers.correct.probability;
  }

  return {
    async tasks(split) {
      return tasksOf(split).map((t) => t.id);
    },

    async evaluate(graph: ProceduralGraph, split, batch) {
      const all = tasksOf(split);
      const tasks = batch === undefined ? all : batch.map((id) => all.find((t) => t.id === id) ?? unknownTask(split, id));
      const store = new MemoryProceduralStore();
      const held = await importGraph({ store, graph: CANDIDATE, document: graph, clock, cycles: preset.dream.cycles });
      if (held.status === "invalid") throw new Error(`the candidate graph cannot be evaluated: ${held.diagnostics.map((d) => d.message).join("; ")}`);
      const host = typeof options.tools === "function" ? await options.tools() : (options.tools ?? {});
      const tools = suiteTools(suite, host);
      const step = proceduralStep({ store, resolver: RESOLVER, settings, clock, entropy, preset: options.preset ?? "harness", ...(options.guidance === undefined ? {} : { model: options.guidance }) });
      const agent = sessionAgent({ model, step, tools, ...(suite.instructions === undefined ? {} : { instructions: suite.instructions }) });
      const judge = suite.scorer === "judge" ? await options.judge!() : undefined;
      const results: RolloutResult[] = [];
      for (const task of tasks) {
        const run = await agent.generate({ prompt: task.prompt, options: { sessionId: `task-${task.id}` } }).catch((e: unknown) => {
          throw new Error(`task ${task.id} failed: ${messageOf(e)}`);
        });
        const value = await score(task, run.text, judge);
        if (split === "validation") results.push({ task: task.id, score: value });
        else {
          // Each step's response holds the messages that step added.
          const messages: ModelMessage[] = [{ role: "user", content: task.prompt }, ...run.steps.flatMap((s) => s.response.messages)];
          results.push({ task: task.id, score: value, query: task.prompt, steps: trajectorySteps(messages) });
        }
      }
      return results;
    },
  };
}

const unknownTask = (split: string, id: string): never => {
  throw new RangeError(`no ${split} task ${id}`);
};
