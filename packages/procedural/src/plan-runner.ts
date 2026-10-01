/**
 * Plan runs on a host (ADR 0017, plan §7.6): what the daemon's `procedural.run` runs a
 * plan with, and what a restarted daemon resumes. A run is kept in a `PlanRunStore` from
 * before its first task starts until it ends (its state after every change, as
 * `runPlan` saves it), so a host that stops mid-run resumes it from its last state
 * (`resume`). Each run's tasks come from the host's `task` port, given the graph's head
 * and effective graph (`modelTasks`: `modelTask` on a model, with the host's tools for
 * that graph). A run that ends is dropped and announced as `procedural.plan.completed`.
 */
import { z } from "zod";
import type { SnapshotStorage, TaskGraph } from "@harness/core";
import type { LanguageModel, ToolSet } from "ai";
import { GraphIdSchema } from "./graph.ts";
import type { GraphId, ProceduralGraph } from "./graph.ts";
import { readGraph } from "./import-export.ts";
import type { EffectiveGraph } from "./overlay-types.ts";
import type { PlanPayload } from "./plan.ts";
import { parsePlanRun, runPlan } from "./plan-run.ts";
import type { PlanRun, PlanRunState, PlanTask, PlanTaskReport } from "./plan-run.ts";
import { modelTask } from "./plan-task.ts";
import type { Settings } from "./settings.ts";
import type { ProceduralStore } from "./store.ts";

/** A run's id: 16 hex digits, from the host's entropy. */
export const PlanRunIdSchema = z.string().regex(/^[0-9a-f]{16}$/, "a plan run id is 16 lowercase hex digits").brand<"PlanRunId">();
export type PlanRunId = z.output<typeof PlanRunIdSchema>;

/** A run as kept: its id, its graph, and its state (`PlanRunState`, checked by `parsePlanRun` when it is resumed). */
export const PlanRunRecordSchema = z.strictObject({ id: PlanRunIdSchema, graph: GraphIdSchema, state: z.unknown() });
export type PlanRunRecord = z.output<typeof PlanRunRecordSchema>;

/** Where a host keeps the runs under way. */
export interface PlanRunStore {
  /** Every kept run, in the order first put. */
  list(): Promise<PlanRunRecord[]>;
  /** Keep a run, replacing its earlier state. */
  put(record: PlanRunRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

const PlanRunsDocumentSchema = z.strictObject({ runs: z.array(PlanRunRecordSchema) });

/**
 * Plan runs kept through a `SnapshotStorage` (a file beside the procedural store natively,
 * an IndexedDB key in a browser): the whole list, saved after every change, one change at
 * a time. A change whose save fails is rejected and forgotten. One process owns a storage.
 */
export class SnapshotPlanRuns implements PlanRunStore {
  readonly #storage: SnapshotStorage;
  #runs: Promise<Map<string, PlanRunRecord>> | undefined;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(storage: SnapshotStorage) {
    this.#storage = storage;
  }

  #load(): Promise<Map<string, PlanRunRecord>> {
    this.#runs ??= this.#storage.load().then((saved) => {
      if (saved === undefined) return new Map();
      const parsed = PlanRunsDocumentSchema.safeParse(saved);
      if (!parsed.success) throw new RangeError(`invalid plan runs\n${z.prettifyError(parsed.error)}`);
      return new Map(parsed.data.runs.map((r) => [r.id, r]));
    });
    return this.#runs;
  }

  /** Run `change` after every change issued before it, and save the list. */
  #change(change: (runs: Map<string, PlanRunRecord>) => void): Promise<void> {
    const done = this.#tail.then(async () => {
      const runs = await this.#load();
      change(runs);
      try {
        await this.#storage.save({ runs: [...runs.values()] });
      } catch (e) {
        // The list in memory is not what was saved: read it again on the next use.
        this.#runs = undefined;
        throw e;
      }
    });
    this.#tail = done.catch(() => {});
    return done;
  }

  async list(): Promise<PlanRunRecord[]> {
    await this.#tail;
    return [...(await this.#load()).values()];
  }

  put(record: PlanRunRecord): Promise<void> {
    return this.#change((runs) => void runs.set(record.id, record));
  }

  delete(id: string): Promise<void> {
    return this.#change((runs) => void runs.delete(id));
  }
}

/** What a run's tasks are given: the graph, and its head's core and effective graph when it has a head. */
export interface PlanTaskContext {
  readonly graph: GraphId;
  readonly view?: { readonly core: ProceduralGraph; readonly effective: EffectiveGraph };
}

/** A run that ended: every task's outcome, in plan order. */
export interface PlanRunOutcome {
  readonly run: PlanRunId;
  readonly graph: GraphId;
  readonly status: "succeeded" | "failed";
  readonly tasks: readonly PlanTaskReport[];
}

/** A kept run that could not be resumed, and was dropped. */
export interface InvalidPlanRun {
  readonly run: PlanRunId;
  readonly graph: GraphId;
  readonly status: "invalid";
  readonly reason: string;
}

/** A run's end, as announced on the hook bus. */
export interface PlanNotice {
  readonly type: "procedural.plan.completed";
  readonly payload: PlanRunOutcome;
}

export interface PlanRunnerOptions {
  /** The procedural store, whose graphs' heads the tasks read. */
  readonly store: ProceduralStore;
  readonly runs: PlanRunStore;
  readonly settings: Pick<Settings, "plans">;
  /** Run ids. */
  readonly entropy: { bytes(length: number): Uint8Array };
  /** The tasks of a run on a graph (`modelTasks`). */
  readonly task: (context: PlanTaskContext) => PlanTask | Promise<PlanTask>;
  readonly notify?: (notice: PlanNotice) => void | Promise<void>;
}

export interface PlanRunner {
  /** Run a plan on a graph to its end. Rejects only when a run could not be kept; it is then resumed by `resume`. */
  run(graph: GraphId, plan: TaskGraph<PlanPayload>): Promise<PlanRunOutcome>;
  /** Run every kept run to its end, one after another (a restarted host's). */
  resume(): Promise<(PlanRunOutcome | InvalidPlanRun)[]>;
  /**
   * Answer a task of a live run that waits for a person (the task parked as `awaiting`).
   * False when no such run is live; an unknown task id is kept as a pre-answer, as `runPlan` does.
   */
  answer(run: PlanRunId, task: string, value: unknown): boolean;
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function planRunner(options: PlanRunnerOptions): PlanRunner {
  const { store, runs, settings, entropy, notify } = options;
  const live = new Map<PlanRunId, PlanRun>();
  const contextOf = async (graph: GraphId): Promise<PlanTaskContext> => {
    const view = await readGraph({ store, graph });
    return view.status === "ok" ? { graph, view: { core: view.graph, effective: view.effective } } : { graph };
  };
  const execute = async (run: PlanRunId, graph: GraphId, restored: { plan: TaskGraph<PlanPayload>; outcomes?: PlanRunState["outcomes"] }): Promise<PlanRunOutcome> => {
    const task = await options.task(await contextOf(graph));
    const planRun = runPlan({ ...restored, task, settings, save: (state) => runs.put({ id: run, graph, state }) });
    live.set(run, planRun);
    try {
      const result = await planRun;
      await runs.delete(run);
      const outcome: PlanRunOutcome = { run, graph, status: result.status, tasks: result.tasks };
      await notify?.({ type: "procedural.plan.completed", payload: outcome });
      return outcome;
    } finally {
      live.delete(run);
    }
  };
  return {
    run: async (graph, plan) => {
      const run = PlanRunIdSchema.parse(hex(entropy.bytes(8)));
      await runs.put({ id: run, graph, state: { plan: plan.toJSON(), outcomes: {} } satisfies PlanRunState });
      return execute(run, graph, { plan });
    },
    resume: async () => {
      const outcomes: (PlanRunOutcome | InvalidPlanRun)[] = [];
      for (const record of await runs.list()) {
        let restored: ReturnType<typeof parsePlanRun>;
        try {
          restored = parsePlanRun(record.state);
        } catch (e) {
          await runs.delete(record.id);
          outcomes.push({ run: record.id, graph: record.graph, status: "invalid", reason: messageOf(e) });
          continue;
        }
        outcomes.push(await execute(record.id, record.graph, restored));
      }
      return outcomes;
    },
    answer: (run, task, value) => {
      const planRun = live.get(run);
      if (planRun === undefined) return false;
      planRun.answer(task, value);
      return true;
    },
  };
}

/**
 * `modelTask` for each run: on `model`, with the host's tools for the run's graph (given
 * once, or per graph: a session's base tools plus the workflows its head binds), guided by
 * the graph's effective graph.
 */
export function modelTasks(options: {
  readonly model: LanguageModel;
  readonly tools: ToolSet | ((context: PlanTaskContext) => ToolSet | Promise<ToolSet>);
  readonly settings: Pick<Settings, "prompts" | "decoding">;
}): (context: PlanTaskContext) => Promise<PlanTask> {
  const { model, tools, settings } = options;
  return async (context) => {
    const offered = typeof tools === "function" ? await tools(context) : tools;
    return modelTask({ model, tools: offered, settings, ...(context.view === undefined ? {} : { graph: context.view.effective }) });
  };
}
