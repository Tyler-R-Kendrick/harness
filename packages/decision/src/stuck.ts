/**
 * Stuck detection: is an agent repeating itself, going round in a loop, or making no
 * progress? Code first: `detectStuck` is deterministic over the steps (exact repeats,
 * cycles, a progress measure that does not rise). The fork puts the detector at the rule
 * rung and as the floor, and asks a model only whether the agent is making progress when
 * the detector finds nothing.
 */
import { probability } from "@harness/cognitive";
import { z } from "zod";
import { scrubText } from "./scrub.ts";
import { forkId } from "./types.ts";
import type { Fork, Json, Verdict } from "./types.ts";

// ---- settings, as data -------------------------------------------------------------------------------

export const StuckSettingsSchema = z
  .strictObject({
    $schema: z.string().exactOptional(),
    /** Recorded with every decision. */
    version: z.string().min(1),
    /** The same (action, state) this many steps in a row. */
    repeat: z.strictObject({ times: z.int().min(2) }),
    /** A block of 2 to `maxPeriod` steps repeated this many times. */
    cycle: z.strictObject({ maxPeriod: z.int().min(2), repeats: z.int().min(2) }),
    /** No strict rise in progress over this many steps. */
    progress: z.strictObject({ window: z.int().min(2) }),
    /** At these counts (repeats, cycle repeats, steps since progress rose) a detection escalates instead of warning. */
    escalate: z.strictObject({ repeat: z.int().min(2), cycle: z.int().min(2), noProgress: z.int().min(2) }),
    /** How many of the latest steps a model is shown and records keep. */
    recent: z.int().min(1),
    /** Text in what a model is shown and records keep is cut to this many characters. */
    chars: z.int().min(1),
    question: z.strictObject({
      instructions: z.string().min(1),
      criteria: z.strictObject({ true: z.string().min(1).exactOptional(), false: z.string().min(1).exactOptional() }).exactOptional(),
    }),
  })
  .refine((s) => s.escalate.repeat >= s.repeat.times, { message: "escalation is at or above detection", path: ["escalate", "repeat"] })
  .refine((s) => s.escalate.cycle >= s.cycle.repeats, { message: "escalation is at or above detection", path: ["escalate", "cycle"] })
  .refine((s) => s.escalate.noProgress >= s.progress.window, { message: "escalation is at or above detection", path: ["escalate", "noProgress"] });
export type StuckSettings = z.output<typeof StuckSettingsSchema>;

/** Parse the stuck settings file (see data/stuck.json). */
export function parseStuckSettings(input: unknown): StuckSettings {
  const result = StuckSettingsSchema.safeParse(input);
  if (!result.success) throw new Error(`invalid stuck settings\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** JSON Schema for the settings file, for editors (data/stuck.schema.json). */
// Stryker disable next-line ObjectLiteral,StringLiteral: equivalent; this schema's input and output JSON Schemas are the same
export const stuckSettingsJsonSchema = (): object => z.toJSONSchema(StuckSettingsSchema, { io: "input" });

// ---- the detector ----------------------------------------------------------------------------------------

export interface StuckStep {
  readonly action: string;
  /** What the step left behind (an error, an output digest): same action and state again is a repeat. */
  readonly state?: string;
  /** A measure that should rise when the agent gets closer to done (tests passing, files migrated). */
  readonly progress?: number;
}

export type StuckKind = "none" | "repeat" | "cycle" | "no-progress";

export interface StuckReport {
  readonly stuck: boolean;
  readonly kind: StuckKind;
  readonly evidence: string;
  /** How far it has gone: steps in the repeat, repeats of the cycle, steps since progress rose. */
  readonly count: number;
}

const same = (a: StuckStep, b: StuckStep): boolean => a.action === b.action && a.state === b.state;
const named = (step: StuckStep): string => (step.state === undefined ? step.action : `${step.action} [${step.state}]`);

function repeat(steps: readonly StuckStep[], needed: number): StuckReport | undefined {
  // `last` is not read unless the run reaches `needed` (at least 2), which it cannot with no steps.
  const last = steps.at(-1)!;
  let run = 1;
  while (run < steps.length && same(steps[steps.length - 1 - run]!, last)) run += 1;
  if (run < needed) return undefined;
  return { stuck: true, kind: "repeat", evidence: `the last ${run} steps are all "${last.action}"${last.state === undefined ? "" : " with the same state"}`, count: run };
}

function cycle(steps: readonly StuckStep[], maxPeriod: number, needed: number): StuckReport | undefined {
  for (let period = 2; period <= maxPeriod; period++) {
    // The longest suffix in which every step equals the one a period before it.
    let run = 0;
    while (run < steps.length - period && same(steps[steps.length - 1 - run]!, steps[steps.length - 1 - run - period]!)) run += 1;
    const repeats = Math.floor(run / period) + 1;
    if (repeats < needed) continue;
    const block = steps.slice(steps.length - period * repeats, steps.length - period * repeats + period);
    if (block.every((step) => same(step, block[0]!))) continue; // one step repeated is a repeat, not a cycle
    return { stuck: true, kind: "cycle", evidence: `the last ${period * repeats} steps repeat a cycle of ${period} steps (${block.map(named).join(", ")}) ${repeats} times`, count: repeats };
  }
  return undefined;
}

function stalled(steps: readonly StuckStep[], window: number): StuckReport | undefined {
  let best: number | undefined;
  let baseline: number | undefined;
  let lastRise: number | undefined;
  let latest: number | undefined;
  let known = 0;
  // With fewer steps than the window this is negative, and the check below finds nothing stalled.
  const firstInWindow = steps.length - window;
  steps.forEach((step, i) => {
    if (step.progress === undefined) return;
    if (i >= firstInWindow) known += 1;
    latest = step.progress;
    if (best === undefined) baseline = i;
    else if (step.progress > best) lastRise = i;
    best = best === undefined ? step.progress : Math.max(best, step.progress);
  });
  if (known < 2 || (lastRise ?? -1) >= firstInWindow) return undefined;
  const since = steps.length - 1 - (lastRise ?? baseline!);
  return { stuck: true, kind: "no-progress", evidence: `progress has not risen in the last ${window} steps (it is ${latest})`, count: since };
}

/**
 * Whether the steps show an agent that is stuck, checked in this order: the same step
 * repeated at the end; a block of steps (a cycle, the shortest period first) repeated at
 * the end; a progress measure that has not risen (strictly, against the best so far) in
 * the last window of steps. The first found is reported.
 */
export function detectStuck(steps: readonly StuckStep[], settings: StuckSettings): StuckReport {
  return (
    repeat(steps, settings.repeat.times) ??
    cycle(steps, settings.cycle.maxPeriod, settings.cycle.repeats) ??
    stalled(steps, settings.progress.window) ?? { stuck: false, kind: "none", evidence: `no repeat, cycle or stall in ${steps.length} steps`, count: 0 }
  );
}

// ---- the fork ---------------------------------------------------------------------------------------------

export type StuckAction = "continue" | "warn" | "escalate";

export interface StuckInput {
  /** What the agent is trying to do. */
  readonly goal: string;
  /** What it has done, oldest first. */
  readonly steps: readonly StuckStep[];
}

const RESTRICTIVENESS: Readonly<Record<StuckAction, number>> = { continue: 0, warn: 1, escalate: 2 };

/**
 * The stuck fork. Rule and floor: the detector (warn, and escalate once a detection has
 * gone on for the settings' escalation counts). Otherwise a model is asked one boolean, "is
 * the agent making progress toward the goal?", over the recent steps: yes continues, no
 * warns. Records keep the goal and the recent steps, cut to length and with their secrets
 * removed (the detector sees them as they are).
 */
export function stuckFork(settings: StuckSettings): Fork<StuckInput, StuckAction> {
  /** Cut to length, with secrets removed: the goal is what the person said and an action is a tool's title, and either may carry one. */
  const cut = (text: string): string => scrubText(text, settings.chars);
  const describe = (input: StuckInput): { readonly goal: string; readonly steps: readonly { readonly [key: string]: Json }[] } => ({
    goal: cut(input.goal),
    steps: input.steps.slice(-settings.recent).map((step) => ({ action: cut(step.action), ...(step.state === undefined ? {} : { state: cut(step.state) }), ...(step.progress === undefined ? {} : { progress: step.progress }) })),
  });
  const detected = (input: StuckInput): StuckAction | undefined => {
    const found = detectStuck(input.steps, settings);
    if (!found.stuck) return undefined;
    const at = found.kind === "repeat" ? settings.escalate.repeat : found.kind === "cycle" ? settings.escalate.cycle : settings.escalate.noProgress;
    return found.count >= at ? "escalate" : "warn";
  };
  return {
    id: forkId("stuck"),
    version: settings.version,
    ask: (input) => ({
      state: describe(input),
      questions: { progress: { type: "boolean", instructions: settings.question.instructions, ...(settings.question.criteria === undefined ? {} : { criteria: settings.question.criteria }) } },
    }),
    interpret: (answers): Verdict<StuckAction> | undefined => {
      const answer = answers["progress"];
      if (answer?.type !== "boolean") return undefined;
      const p = answer.distribution["true"]!;
      return p >= 0.5 ? { action: "continue", confidence: p } : { action: "warn", confidence: probability(1 - p) };
    },
    describe,
    fallback: () => "warn",
    rule: detected,
    actions: () => ["continue", "warn", "escalate"],
    floor: detected,
    restrictiveness: (action) => RESTRICTIVENESS[action],
  };
}
