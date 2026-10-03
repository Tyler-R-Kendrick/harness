/**
 * Loop B, dispatch: whether to switch a session to a cheaper model tier for a stretch of
 * routine work, and back. Whether switching pays is arithmetic, done in code from the
 * tiers' prices (data, named by role, never by model), the size of the context, and the
 * expected length of the stretch. The model is asked only what code cannot know: how many
 * of the next steps are routine.
 *
 * Cost model (prices are per million tokens; a stretch is `S` tokens of routine output in
 * steps of `O` tokens, so `n = S / O` steps, over a context of `C` tokens):
 *
 * - staying on tier F: n cached reads of C, S output tokens and their cache write, and the
 *   cached read of C + S at the first call after the stretch;
 * - switching to tier T and back: the first read on T is uncached and written to its cache
 *   (the priming: input + cacheWrite, in place of one cached read), n cached reads of C,
 *   S output tokens and their cache write, and the return, which reads all of C + S
 *   uncached on F and writes it to F's cache (input + cacheWrite). `cacheWrite` is the
 *   price of writing to the cache on top of the input price.
 *
 * Both are linear in S, so the savings are `S * a - b` and the break-even is `b / a`.
 * Growth of the context within the stretch is charged where it matters, at the return;
 * its cached reads are not (they are cheap).
 */
import { probability } from "@harness/cognitive";
import { z } from "zod";
import { ConditionSchema, evaluateCondition } from "./condition.ts";
import { SCAN_LIMIT, scrubJson, scrubText } from "./scrub.ts";
import { CostSchema, cost, forkId } from "./types.ts";
import type { Cost, Fork, Json, Verdict } from "./types.ts";

// ---- prices and settings, as data -------------------------------------------------------------------

/** What one tier charges, per million tokens. */
export const TierPricesSchema = z
  .strictObject({
    /** Input read fresh, not from the cache. */
    input: CostSchema,
    /** Input read from the cache. */
    cachedInput: CostSchema,
    /** The extra price of writing input into the cache, on top of `input`. */
    cacheWrite: CostSchema,
    output: CostSchema,
  })
  .refine((p) => p.cachedInput <= p.input, "cached input must not cost more than uncached input");
export type TierPrices = z.output<typeof TierPricesSchema>;

/** Prices by tier name (the tier's role). */
export type Prices = Readonly<Record<string, TierPrices>>;

export const DispatchSettingsSchema = z
  .strictObject({
    $schema: z.string().exactOptional(),
    /** Recorded with every decision: changes whenever these settings change what the fork asks or decides. */
    version: z.string().min(1),
    prices: z.strictObject({ small: TierPricesSchema, large: TierPricesSchema }),
    /** Switching needs savings above this share of what staying costs, so that the fork does not flap. */
    hysteresis: z.number().min(0).lt(1),
    /** Tokens one step of routine work generates. */
    stepTokens: z.number().finite().positive(),
    routine: z.strictObject({
      instructions: z.string().min(1),
      /** What each level of the score means, from none of the next steps routine upward. */
      levels: z.array(z.string().min(1)).min(2),
    }),
    /** The expected tokens of routine work at each level, in level order. */
    stretch: z.array(z.number().finite().min(0)),
    /** Inputs (tested over `describe(input)`, so `facts.…`) that must not be moved to the small tier. */
    protect: ConditionSchema,
    /**
     * How a host fills `facts` from the tool calls of the step just taken: each fact is true when a word of a
     * tool's name (or of its command) is one of the words listed for it. Conservative on purpose (a fact is a
     * reason to stay on the large tier), and the words are the settings', never the code's.
     */
    derive: z.record(z.string().min(1), z.array(z.string().regex(/^[a-z0-9]+$/, "a word is lowercase letters and digits")).min(1)).exactOptional(),
  })
  .refine((s) => s.stretch.length === s.routine.levels.length, { message: "one stretch per level", path: ["stretch"] })
  .refine((s) => s.stretch.every((tokens, i) => i === 0 || tokens >= s.stretch[i - 1]!), { message: "stretch must not shrink as levels rise", path: ["stretch"] });
export type DispatchSettings = z.output<typeof DispatchSettingsSchema>;

/** Parse the dispatch settings file (see data/dispatch.json). */
export function parseDispatchSettings(input: unknown): DispatchSettings {
  const result = DispatchSettingsSchema.safeParse(input);
  if (!result.success) throw new Error(`invalid dispatch settings\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** JSON Schema for the settings file, for editors (data/dispatch.schema.json). */
// Stryker disable next-line ObjectLiteral,StringLiteral: equivalent; this schema's input and output JSON Schemas are the same
export const dispatchSettingsJsonSchema = (): object => z.toJSONSchema(DispatchSettingsSchema, { io: "input" });

// ---- the switching plan ---------------------------------------------------------------------------------

export interface SwitchRequest {
  /** Tokens in the current model's context (cached on the current tier). */
  readonly context: number;
  /** Tokens one step of the stretch generates. */
  readonly newOutput: number;
  /** Expected tokens of routine work before the stretch ends and the work returns to `from`. */
  readonly expectedStretch: number;
  readonly from: string;
  readonly to: string;
  readonly prices: Prices;
  /** Savings must exceed this share (0 up to, not including, 1) of the cost of staying. */
  readonly hysteresis: number;
}

export interface SwitchPlan {
  readonly switch: boolean;
  /** Cost of staying on `from` for the stretch (and the read after it). */
  readonly stayCost: Cost;
  /** Cost of the stretch on `to` and the return to `from`. */
  readonly switchCost: Cost;
  /** Switching pays for stretches longer than this (with the hysteresis); Infinity when it never does. */
  readonly breakEvenStretch: number;
}

const PER = 1e6;

function nonNegative(name: string, value: number): void {
  if (!(Number.isFinite(value) && value >= 0)) throw new RangeError(`${name} must be a finite number of tokens, 0 or more, got ${value}`);
}

function tierOf(prices: Prices, name: string): TierPrices {
  const found = Object.hasOwn(prices, name) ? prices[name] : undefined;
  if (found === undefined) throw new RangeError(`no prices for tier "${name}"`);
  return found;
}

/** Whether switching down for a stretch pays, from the prices and the expected length of the stretch. */
export function switchPlan(request: SwitchRequest): SwitchPlan {
  const { context: c, newOutput: o, expectedStretch: s, hysteresis: h } = request;
  nonNegative("context", c);
  nonNegative("expectedStretch", s);
  if (!(Number.isFinite(o) && o > 0)) throw new RangeError(`newOutput must be a positive, finite number of tokens, got ${o}`);
  if (!(h >= 0 && h < 1)) throw new RangeError(`hysteresis must be at least 0 and below 1, got ${h}`);
  const from = tierOf(request.prices, request.from);
  const to = tierOf(request.prices, request.to);

  // Stay: stayCost = s1 * S + s0. Switch: switchCost = t1 * S + t0. Prices are per million tokens.
  const s1 = ((c / o) * from.cachedInput + from.output + from.cacheWrite + from.cachedInput) / PER;
  const s0 = (c * from.cachedInput) / PER;
  const t1 = ((c / o) * to.cachedInput + to.output + to.cacheWrite + from.input + from.cacheWrite) / PER;
  const t0 = (c * (to.input + to.cacheWrite - to.cachedInput + from.input + from.cacheWrite)) / PER;
  const stayCost = cost(s1 * s + s0);
  if (request.from === request.to) return { switch: false, stayCost, switchCost: stayCost, breakEvenStretch: Infinity };
  const switchCost = cost(t1 * s + t0);

  // Switch when stay - switch > h * stay, that is S * (s1 - t1 - h*s1) > t0 - s0 + h*s0.
  const gain = s1 - t1 - h * s1;
  const overhead = t0 - s0 + h * s0;
  const breakEvenStretch = gain > 0 ? Math.max(0, overhead / gain) : Infinity;
  return { switch: stayCost - switchCost > h * stayCost, stayCost, switchCost, breakEvenStretch };
}

// ---- the facts of a step --------------------------------------------------------------------------------

/** The words of a name or a command: lowercase letters and digits, split at anything else and at camelCase humps (`deleteFile`, `rm -rf` and `drop_table` have two words or one). */
export function wordsOfName(text: string): string[] {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Characters of a command looked at for words. */
const COMMAND_CHARS = 1000;

/** What of a tool call is read for words: its name, and its `command` when it has one. */
export interface DispatchToolCall {
  readonly toolName: string;
  readonly input?: unknown;
}

/**
 * The facts of a step from the tool calls it just made, for the settings' `protect` condition: a
 * fact of `derive` is true when a word of a call's name, or of the `command` it was given, is
 * one of the words listed for it. Nothing when no fact holds (or `derive` is absent), so a step that
 * does nothing risky has no facts.
 */
export function deriveFacts(derive: DispatchSettings["derive"], calls: readonly DispatchToolCall[]): { readonly [key: string]: Json } | undefined {
  if (derive === undefined) return undefined;
  const seen = new Set<string>();
  for (const call of calls) {
    for (const word of wordsOfName(call.toolName)) seen.add(word);
    const input = call.input;
    const command = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as { command?: unknown }).command : undefined;
    if (typeof command === "string") for (const word of wordsOfName(command.slice(0, COMMAND_CHARS))) seen.add(word);
  }
  const facts = Object.entries(derive).filter(([, words]) => words.some((word) => seen.has(word)));
  return facts.length === 0 ? undefined : Object.fromEntries(facts.map(([fact]) => [fact, true]));
}

// ---- the fork -----------------------------------------------------------------------------------------------

export type DispatchTier = "small" | "large";
/** Stay on the current tier, or move to the small or the large one. */
export type DispatchAction = "stay" | "small" | "large";

export interface DispatchInput {
  /** Tokens in the current context. */
  readonly context: number;
  /** The tier the session is on now. */
  readonly current: DispatchTier;
  /** What the agent has done and what comes next, as the model should see it (`describe` removes the secrets it carries before records keep it). */
  readonly task: string;
  /** Facts the settings' `protect` condition tests, e.g. `irreversible` (a host derives them from the step's tool calls: see `deriveFacts`). */
  readonly facts?: { readonly [key: string]: Json };
}

const RESTRICTIVENESS: Readonly<Record<DispatchAction, number>> = { small: 0, stay: 1, large: 2 };

/**
 * The dispatch fork. It asks how routine the next steps are (a score), maps the expected
 * level to an expected stretch of tokens, and lets `switchPlan` decide. On the large tier
 * it moves down only when savings clear the hysteresis margin; on the small tier it moves
 * back only when being small would not pay at all, so a stretch in between changes nothing.
 * Being on the large tier is the safe action: the floor keeps protected inputs there.
 */
export function dispatchFork(settings: DispatchSettings): Fork<DispatchInput, DispatchAction> {
  const levels = settings.routine.levels.length;
  const describe = (input: DispatchInput): Json => ({
    task: scrubText(input.task, SCAN_LIMIT),
    context: input.context,
    current: input.current,
    ...(input.facts === undefined ? {} : { facts: scrubJson(input.facts, SCAN_LIMIT) }),
  });

  /** The expected stretch at an expected level (from 0 to the last level), interpolating between levels. */
  const stretchAt = (level: number): number => {
    const low = Math.floor(level);
    const share = level - low;
    return settings.stretch[low]! * (1 - share) + settings.stretch[Math.min(levels - 1, low + 1)]! * share;
  };

  const choose = (input: DispatchInput, stretch: number): DispatchAction => {
    const onLarge = input.current === "large";
    const down = switchPlan({ context: input.context, newOutput: settings.stepTokens, expectedStretch: stretch, from: "large", to: "small", prices: settings.prices, hysteresis: onLarge ? settings.hysteresis : 0 });
    if (onLarge) return down.switch ? "small" : "stay";
    return down.switch ? "stay" : "large";
  };

  return {
    id: forkId("dispatch"),
    version: settings.version,
    ask: (input) => ({
      state: describe(input) as { readonly [key: string]: Json },
      questions: { routine: { type: "score", instructions: settings.routine.instructions, criteria: settings.routine.levels } },
    }),
    interpret: (answers, input): Verdict<DispatchAction> | undefined => {
      const answer = answers["routine"];
      if (answer?.type !== "score") return undefined;
      const keys = Object.keys(answer.distribution);
      if (keys.length !== levels || !Array.from({ length: levels }, (_, i) => String(i)).every((k) => keys.includes(k))) return undefined;
      const expected = keys.reduce((sum, k) => sum + Number(k) * answer.distribution[k]!, 0);
      const action = choose(input, stretchAt(expected));
      const agreeing = keys.reduce((sum, k) => sum + (choose(input, settings.stretch[Number(k)]!) === action ? answer.distribution[k]! : 0), 0);
      return { action, confidence: probability(Math.min(1, Math.max(0, agreeing))) };
    },
    describe,
    fallback: () => "stay",
    actions: (input) => (input.current === "large" ? ["stay", "small"] : ["stay", "large"]),
    floor: (input) => (evaluateCondition(settings.protect, describe(input)) ? (input.current === "large" ? "stay" : "large") : undefined),
    restrictiveness: (action) => RESTRICTIVENESS[action],
  };
}
