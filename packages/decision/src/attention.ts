/**
 * Attention: what a person should look at first across their sessions. `rankInbox` is
 * pure arithmetic over the inbox (kind, how long it has waited, whether a session is
 * blocked on it, and an urgency a model may have given); `attentionFork` asks a model how
 * urgently a person should look, with floors that a permission is never below "high"
 * and a failure never below "normal".
 */
import { probability } from "@harness/cognitive";
import { z } from "zod";
import { ConditionSchema, evaluateCondition } from "./condition.ts";
import { forkId } from "./types.ts";
import type { Fork, Json, Verdict } from "./types.ts";

export const ATTENTION_KINDS = ["permission", "review", "question", "failure", "idle"] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** How urgently a person should look, least first. */
export const ATTENTION_LEVELS = ["low", "normal", "high", "urgent"] as const;
export type AttentionLevel = (typeof ATTENTION_LEVELS)[number];

const weight = z.number().finite().min(0);

export const AttentionSettingsSchema = z.strictObject({
  $schema: z.string().exactOptional(),
  /** Recorded with every decision. */
  version: z.string().min(1),
  weights: z.strictObject({
    kind: z.strictObject({ permission: weight, review: weight, question: weight, failure: weight, idle: weight }),
    /** What a full (saturated) wait adds. */
    age: weight,
    /** What being blocked adds. */
    blocked: weight,
    /** What an urgency of 1 adds. */
    urgency: weight,
  }),
  /** Waiting adds in proportion to the wait up to this many ms, and nothing more after. */
  age: z.strictObject({ saturatesAfterMs: z.number().finite().positive() }),
  /** Text in what a model is shown and records keep is cut to this many characters. */
  chars: z.int().min(1),
  question: z.strictObject({
    instructions: z.string().min(1),
    /** What each level means, low first: one for each of the four labels. */
    levels: z.array(z.string().min(1)).length(ATTENTION_LEVELS.length),
  }),
  /** Items (tested over `describe(item)`) that are at least this urgent, whatever a model says. */
  floors: z.array(z.strictObject({ when: ConditionSchema, atLeast: z.enum(ATTENTION_LEVELS), reason: z.string().min(1).exactOptional() })),
});
export type AttentionSettings = z.output<typeof AttentionSettingsSchema>;

/** Parse the attention settings file (see data/attention.json). */
export function parseAttentionSettings(input: unknown): AttentionSettings {
  const result = AttentionSettingsSchema.safeParse(input);
  if (!result.success) throw new Error(`invalid attention settings\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** JSON Schema for the settings file, for editors (data/attention.schema.json). */
// Stryker disable next-line ObjectLiteral,StringLiteral: equivalent; this schema's input and output JSON Schemas are the same
export const attentionSettingsJsonSchema = (): object => z.toJSONSchema(AttentionSettingsSchema, { io: "input" });

// ---- the inbox ------------------------------------------------------------------------------------

/** Something in a person's inbox that wants a look. */
export const AttentionItemSchema = z.strictObject({
  id: z.string().min(1),
  session: z.string(),
  kind: z.enum(ATTENTION_KINDS),
  /** When it started waiting (ms). */
  since: z.number().finite().min(0),
  /** Whether a session cannot go on until a person looks. */
  blocked: z.boolean(),
  /** How urgent a model thinks it is, from 0 to 1 (optional). */
  urgency: z.number().min(0).max(1).exactOptional(),
  text: z.string().exactOptional(),
});
export type AttentionItem = z.output<typeof AttentionItemSchema>;

export interface RankedItem {
  readonly item: AttentionItem;
  readonly priority: number;
  /** Where the priority came from, part by part. */
  readonly reasons: readonly string[];
}

const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The inbox, most in need of a person first. Priority is the sum of the kind's weight,
 * the wait (in proportion, up to a cap), the blocked bonus, and the urgency's share.
 * Equal priorities go to the item waiting longest, then by id, session, kind and text, so
 * the order does not depend on the order of the input.
 */
export function rankInbox(items: readonly AttentionItem[], settings: AttentionSettings, now: number): RankedItem[] {
  if (!Number.isFinite(now)) throw new RangeError("now must be a finite time in ms");
  const w = settings.weights;
  const ranked = items.map((given): RankedItem => {
    const parsed = AttentionItemSchema.safeParse(given);
    if (!parsed.success) throw new RangeError(`invalid attention item\n${z.prettifyError(parsed.error)}`);
    const it = parsed.data;
    const waited = Math.max(0, now - it.since);
    const ageShare = Math.min(1, waited / settings.age.saturatesAfterMs);
    const parts: { readonly reason: string; readonly points: number }[] = [{ reason: it.kind, points: w.kind[it.kind] }];
    if (waited > 0) parts.push({ reason: `waiting ${fmt(waited / 60_000)} min`, points: w.age * ageShare });
    if (it.blocked) parts.push({ reason: "blocked", points: w.blocked });
    const urgency = it.urgency ?? 0;
    if (urgency > 0) parts.push({ reason: `urgency ${fmt(urgency)}`, points: w.urgency * urgency });
    return { item: given, priority: parts.reduce((sum, p) => sum + p.points, 0), reasons: parts.map((p) => `${p.reason}: ${fmt(p.points)}`) };
  });
  return ranked.sort(
    (a, b) =>
      b.priority - a.priority ||
      a.item.since - b.item.since ||
      order(a.item.id, b.item.id) ||
      order(a.item.session, b.item.session) ||
      order(a.item.kind, b.item.kind) ||
      order(a.item.text ?? "", b.item.text ?? ""),
  );
}

// ---- the fork ---------------------------------------------------------------------------------------

/**
 * The attention fork: one score question with a level for each label. The expected level,
 * rounded, is the label; the confidence is the probability the model put on that level.
 * Floors from the settings keep a permission at least high and a failure at least normal.
 */
export function attentionFork(settings: AttentionSettings): Fork<AttentionItem, AttentionLevel> {
  const cut = (text: string): string => text.slice(0, settings.chars);
  const describe = (item: AttentionItem): Json => ({
    id: item.id,
    session: item.session,
    kind: item.kind,
    since: item.since,
    blocked: item.blocked,
    ...(item.urgency === undefined ? {} : { urgency: item.urgency }),
    ...(item.text === undefined ? {} : { text: cut(item.text) }),
  });
  return {
    id: forkId("attention"),
    version: settings.version,
    ask: (item) => ({
      state: { kind: item.kind, blocked: item.blocked, ...(item.text === undefined ? {} : { text: cut(item.text) }) },
      questions: { urgency: { type: "score", instructions: settings.question.instructions, criteria: settings.question.levels } },
    }),
    interpret: (answers): Verdict<AttentionLevel> | undefined => {
      const answer = answers["urgency"];
      if (answer?.type !== "score") return undefined;
      const keys = Object.keys(answer.distribution);
      if (keys.length !== ATTENTION_LEVELS.length || !ATTENTION_LEVELS.every((_, i) => keys.includes(String(i)))) return undefined;
      const expected = keys.reduce((sum, k) => sum + Number(k) * answer.distribution[k]!, 0);
      const level = Math.round(expected);
      return { action: ATTENTION_LEVELS[level]!, confidence: probability(answer.distribution[String(level)]!) };
    },
    describe,
    fallback: () => "normal",
    actions: () => ATTENTION_LEVELS,
    floor: (item) => {
      const facts = describe(item);
      const matched = settings.floors.filter((f) => evaluateCondition(f.when, facts)).map((f) => ATTENTION_LEVELS.indexOf(f.atLeast));
      return ATTENTION_LEVELS[Math.max(-1, ...matched)]; // no match: index -1, which is no level
    },
    restrictiveness: (level) => ATTENTION_LEVELS.indexOf(level),
  };
}
