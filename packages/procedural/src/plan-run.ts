/**
 * Running plans (ADR 0017, plan §7.6). `runPlan` executes a plan's task graph with the
 * task graph's own scheduler: the ready tasks, in order, within its joins and exclusions,
 * at most the settings' `plans.concurrency` at once. Each task runs through a port
 * (`PlanTask`) and is given the outputs of its data predecessors; one that fails (or
 * throws) fails, and the task graph skips what can no longer run. A run is resumable: its
 * state is the plan (statuses included) and each finished task's outcome, handed to
 * `save` after every change, and `parsePlanRun` restores it. A task restored as running
 * was interrupted, so it runs again: a task runs at least once, as the hook bus delivers.
 * A task that returns `{ awaiting: true }` is parked instead: it leaves the running slot
 * and its exclusive resources, stays unfinished, and the queue moves on. A further yield
 * from that parked task wakes the queue again. `answer` later resumes that task only.
 * Inputs are the graph's data edges at the call, so an edge added during the run counts.
 * A task restored as awaiting is not started over.
 */
import { z } from "zod";
import type { NodeStatus, TaskGraph, TaskGraphData } from "@harness/core";
import { parsePlan } from "./plan.ts";
import type { PlanPayload } from "./plan.ts";
import type { Settings } from "./settings.ts";

/** What a task ended with: its output (JSON, as it is saved), or why it failed. */
export const TaskOutcomeSchema = z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), output: z.unknown() }), z.strictObject({ ok: z.literal(false), error: z.string() })]);
export type TaskOutcome = z.output<typeof TaskOutcomeSchema>;

/** What a task is given: its id, its payload, and the outputs of the tasks it takes input from (its data predecessors), by id. `answer` is present only when this call continues a task that was awaiting a person. */
export interface PlanTaskInput {
  readonly id: string;
  readonly payload: PlanPayload;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly answer?: unknown;
}

/** A task is awaiting a person. The promise has resolved; the task has not finished. */
export type PlanTaskYield = { readonly awaiting: true };

/** What a task returns: a finished outcome, or a yield while it waits for a person. */
export type PlanTaskResult = TaskOutcome | PlanTaskYield;

/** Runs one task (`modelTask` by default on a host). A throw is the task's failure. */
export type PlanTask = (input: PlanTaskInput) => Promise<PlanTaskResult>;

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

/** A run under way. `answer` delivers a person's response to the task that asked. */
export interface PlanRun extends Promise<PlanRunResult> {
  answer(id: string, value: unknown): void;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function attempt(task: PlanTask, input: PlanTaskInput): Promise<PlanTaskResult> {
  try {
    return await task(input);
  } catch (e) {
    return { ok: false, error: messageOf(e) };
  }
}

const isYield = (result: PlanTaskResult): result is PlanTaskYield => !("ok" in result);

/** `answer` is set only for a continuation, including when the person answered `undefined`. */
function deliver(input: PlanTaskInput, value: unknown): PlanTaskInput {
  const delivered: PlanTaskInput = { id: input.id, payload: input.payload, inputs: input.inputs };
  return Object.assign(delivered, { answer: value });
}

/**
 * Run a plan to the end: every task runs, is skipped, or waits for a person. Resolves
 * with each task's outcome; rejects when `save` fails or a task that yielded cannot be
 * parked in the graph, and then starts nothing more (tasks already running finish
 * unsaved, and run again when the run is resumed from its last state). A task awaiting
 * a person does not hold a slot: the queue keeps going, and `answer` finishes that task later.
 */
export function runPlan(options: RunPlanOptions): PlanRun {
  const answers = new Map<string, { readonly value: unknown }>();
  const waiters = new Map<string, (value: unknown) => void>();
  const promise = drive(options, answers, waiters);
  return Object.assign(promise, {
    answer(id: string, value: unknown) {
      const waiter = waiters.get(id);
      if (waiter !== undefined) {
        waiters.delete(id);
        waiter(value);
        return;
      }
      if (!answers.has(id)) answers.set(id, { value });
    },
  });
}

async function drive(options: RunPlanOptions, answers: Map<string, { readonly value: unknown }>, waiters: Map<string, (value: unknown) => void>): Promise<PlanRunResult> {
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
  const inputsOf = (id: string): Record<string, unknown> => {
    const inputs: Record<string, unknown> = {};
    for (const e of plan.toJSON().edges) {
      const outcome = outcomes[e.from];
      if (e.kind === "data" && e.to === id && outcome?.ok === true) inputs[e.from] = outcome.output;
    }
    return inputs;
  };
  const inputOf = (id: string): PlanTaskInput => ({ id, payload: plan.payload(id)!, inputs: inputsOf(id) });
  const running = new Map<string, Promise<void>>();
  const parked = new Map<string, Promise<void>>();
  // A parked continuation that yields again does not settle its promise, so the loop also waits on a pulse it can poke.
  let resolvePulse: (() => void) | undefined;
  let pulse: Promise<void> | undefined;
  let pendingPoke = false;
  const poke = () => {
    if (resolvePulse !== undefined) {
      const resolve = resolvePulse;
      resolvePulse = undefined;
      pulse = undefined;
      resolve();
      return;
    }
    pendingPoke = true;
  };
  const nextPulse = (): Promise<void> => {
    if (pendingPoke) {
      pendingPoke = false;
      resolvePulse = undefined;
      pulse = undefined;
      return Promise.resolve();
    }
    pulse ??= new Promise<void>((resolve) => {
      resolvePulse = resolve;
    });
    return pulse;
  };
  const takeAnswer = (id: string): Promise<unknown> => {
    const queued = answers.get(id);
    if (queued !== undefined) {
      answers.delete(id);
      return Promise.resolve(queued.value);
    }
    return new Promise((resolve) => void waiters.set(id, resolve));
  };
  /** Wait for this task's answer and finish it, without taking a running slot. */
  const park = (id: string) => {
    const slot: { current?: Promise<void> } = {};
    const pending = (async () => {
      for (;;) {
        const value = await takeAnswer(id);
        const result = await attempt(task, deliver(inputOf(id), value));
        if (isYield(result)) {
          poke();
          continue;
        }
        outcomes[id] = result;
        plan.complete(id, result.ok ? "succeeded" : "failed");
        changed();
        return;
      }
    })().finally(() => {
      if (parked.get(id) === slot.current) parked.delete(id);
    });
    slot.current = pending;
    parked.set(id, pending);
  };
  const launch = (id: string) => {
    const done = attempt(task, inputOf(id)).then((result) => {
      if (isYield(result)) {
        const parkedNode = plan.background(id);
        if (!parkedNode.ok) throw new Error(parkedNode.error.message);
        park(id);
        running.delete(id);
        changed();
        return;
      }
      outcomes[id] = result;
      plan.complete(id, result.ok ? "succeeded" : "failed");
      running.delete(id);
      changed();
    });
    running.set(id, done);
  };
  // A task restored as running was interrupted: it runs again. One restored as awaiting keeps waiting for its answer.
  for (const n of plan.toJSON().nodes) {
    if (n.status === "running") launch(n.id);
    else if (n.status === "awaiting") park(n.id);
  }
  for (;;) {
    await saved();
    for (const id of plan.schedule(limit - running.size)) {
      plan.start(id);
      changed();
      launch(id);
    }
    if (running.size === 0 && parked.size === 0) break;
    await Promise.race([...running.values(), ...parked.values(), nextPulse()]);
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
