/**
 * Running plans (ADR 0017, plan §7.6). `runPlan` executes a plan's task graph with the
 * task graph's own scheduler: the ready tasks, in order, within its joins and exclusions,
 * at most the settings' `plans.concurrency` at once. Each task runs through a port
 * (`PlanTask`) and is given the outputs of its data predecessors; one that fails (or
 * throws) fails, and the task graph skips what can no longer run. A run is resumable: its
 * state is the plan (statuses included) and each finished task's outcome, handed to
 * `save` after every change, and `parsePlanRun` restores it. A task restored as running
 * was interrupted, so it runs again: a task runs at least once, as the hook bus delivers.
 */
import { z } from "zod";
import type { NodeStatus, TaskGraph, TaskGraphData } from "@harness/core";
import { parsePlan } from "./plan.ts";
import type { PlanPayload } from "./plan.ts";
import type { Settings } from "./settings.ts";

/** What a task ended with: its output (JSON, as it is saved), or why it failed. */
export const TaskOutcomeSchema = z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), output: z.unknown() }), z.strictObject({ ok: z.literal(false), error: z.string() })]);
export type TaskOutcome = z.output<typeof TaskOutcomeSchema>;

/** What a task is given: its id, its payload, and the outputs of the tasks it takes input from (its data predecessors), by id. */
export interface PlanTaskInput {
  readonly id: string;
  readonly payload: PlanPayload;
  readonly inputs: Readonly<Record<string, unknown>>;
}

/** Runs one task (`modelTask` by default on a host). A throw is the task's failure. */
export type PlanTask = (input: PlanTaskInput) => Promise<TaskOutcome>;

/** A run as it is saved: the plan with its statuses, and each finished task's outcome. */
export interface PlanRunState {
  readonly plan: TaskGraphData<PlanPayload>;
  readonly outcomes: Readonly<Record<string, TaskOutcome>>;
}

/** A run restored from its state (`parsePlanRun`), for `runPlan` to continue. */
export interface RestoredPlanRun {
  readonly plan: TaskGraph<PlanPayload>;
  readonly outcomes: Readonly<Record<string, TaskOutcome>>;
}

const PlanRunStateSchema = z.strictObject({ plan: z.unknown(), outcomes: z.record(z.string(), TaskOutcomeSchema) });

/**
 * A run from its saved state. The plan is checked as `parsePlan` checks it, and the
 * outcomes against its statuses: a succeeded task has a success, a failed one a failure,
 * and no other task has one. Throws on anything invalid.
 */
export function parsePlanRun(data: unknown): RestoredPlanRun {
  const parsed = PlanRunStateSchema.safeParse(data);
  if (!parsed.success) throw new RangeError(`invalid plan run\n${z.prettifyError(parsed.error)}`);
  const plan = parsePlan(parsed.data.plan);
  const { outcomes } = parsed.data;
  const statuses = new Map(plan.toJSON().nodes.map((n) => [n.id, n.status]));
  for (const id of Object.keys(outcomes)) if (!statuses.has(id)) throw new RangeError(`task ${id} is not in the plan`);
  for (const [id, status] of statuses) {
    const outcome = outcomes[id];
    if (status === "succeeded" || status === "failed") {
      if (outcome === undefined) throw new RangeError(`task ${id} ${status} but has no outcome`);
      if (outcome.ok !== (status === "succeeded")) throw new RangeError(`task ${id} ${status} but its outcome is a ${outcome.ok ? "success" : "failure"}`);
    } else if (outcome !== undefined) throw new RangeError(`task ${id} is ${status} but has an outcome`);
  }
  return { plan, outcomes };
}

export interface RunPlanOptions {
  /** A new plan, or one restored (`parsePlan`, or `parsePlanRun` with its outcomes). */
  readonly plan: TaskGraph<PlanPayload>;
  /** Finished tasks' outcomes, when the plan is restored: their outputs feed their dependents. */
  readonly outcomes?: Readonly<Record<string, TaskOutcome>>;
  readonly task: PlanTask;
  /** `plans.concurrency`: at most this many tasks run at once. */
  readonly settings: Pick<Settings, "plans">;
  /** Keeps the run's state after each change (a task started, a task finished), one at a time and in order. */
  readonly save?: (state: PlanRunState) => Promise<void>;
}

/** A task as a run reports it: its status, and its output or error once it ran. */
export type PlanTaskReport = { readonly id: string; readonly status: NodeStatus; readonly output?: unknown; readonly error?: string };

export interface PlanRunResult {
  /** `succeeded` when every task did. */
  readonly status: "succeeded" | "failed";
  /** Every task, in plan order. */
  readonly tasks: readonly PlanTaskReport[];
  readonly state: PlanRunState;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function attempt(task: PlanTask, input: PlanTaskInput): Promise<TaskOutcome> {
  try {
    return await task(input);
  } catch (e) {
    return { ok: false, error: messageOf(e) };
  }
}

/**
 * Run a plan to the end: every task runs or is skipped. Resolves with each task's
 * outcome; rejects only when `save` fails, and then starts nothing more (tasks already
 * running finish unsaved, and run again when the run is resumed from its last state).
 */
export async function runPlan(options: RunPlanOptions): Promise<PlanRunResult> {
  const { plan, task, save } = options;
  const limit = options.settings.plans.concurrency;
  const outcomes: Record<string, TaskOutcome> = { ...options.outcomes };
  const state = (): PlanRunState => ({ plan: plan.toJSON(), outcomes: { ...outcomes } });
  // Saves go one at a time, each with the state as it was at its change; the first that fails stops the run.
  let saving: Promise<void> = Promise.resolve();
  let failure: { readonly error: unknown } | undefined;
  const changed = () => {
    if (save === undefined) return;
    const now = state();
    saving = saving
      .then(async () => {
        if (failure === undefined) await save(now);
      })
      .catch((error: unknown) => void (failure ??= { error }));
  };
  /** Wait for the saves so far; a failed one ends the run. */
  const saved = async () => {
    await saving;
    if (failure !== undefined) throw failure.error;
  };
  const edges = plan.toJSON().edges;
  const inputsOf = (id: string): Record<string, unknown> => {
    const inputs: Record<string, unknown> = {};
    for (const e of edges) {
      const outcome = outcomes[e.from];
      if (e.kind === "data" && e.to === id && outcome?.ok === true) inputs[e.from] = outcome.output;
    }
    return inputs;
  };
  const running = new Map<string, Promise<void>>();
  const launch = (id: string) => {
    const done = attempt(task, { id, payload: plan.payload(id)!, inputs: inputsOf(id) }).then((outcome) => {
      outcomes[id] = outcome;
      plan.complete(id, outcome.ok ? "succeeded" : "failed");
      running.delete(id);
      changed();
    });
    running.set(id, done);
  };
  // A task restored as running was interrupted: it runs again.
  for (const n of plan.toJSON().nodes) if (n.status === "running") launch(n.id);
  for (;;) {
    await saved();
    for (const id of plan.schedule(limit - running.size)) {
      plan.start(id);
      changed();
      launch(id);
    }
    if (running.size === 0) break;
    await Promise.race(running.values());
  }
  await saved();
  const final = state();
  const tasks = final.plan.nodes.map((n): PlanTaskReport => {
    const outcome = outcomes[n.id];
    if (outcome === undefined) return { id: n.id, status: n.status };
    return outcome.ok ? { id: n.id, status: n.status, output: outcome.output } : { id: n.id, status: n.status, error: outcome.error };
  });
  return { status: tasks.every((t) => t.status === "succeeded") ? "succeeded" : "failed", tasks, state: final };
}
