import { z } from "zod";
import { ConditionSchema, evaluateCondition } from "./condition.ts";
import type { Json } from "./types.ts";

/** What an authority lets through, least restrictive first. */
export const EFFECTS = ["allow", "escalate", "deny"] as const;
export type Effect = (typeof EFFECTS)[number];

export const RuleSchema = z.strictObject({
  id: z.string().min(1),
  /** `forbid` denies, `escalate` sends to a person, `permit` allows. */
  effect: z.enum(["permit", "escalate", "forbid"]),
  when: ConditionSchema,
  reason: z.string().min(1).exactOptional(),
});
export type Rule = z.output<typeof RuleSchema>;

/**
 * A deterministic authority, as data (Cedar's shape: forbid wins over everything, the
 * default is stated, and the order of rules never matters). A learned verdict may
 * tighten what the authority says (`tighten`) and never relax it, so a model cannot
 * approve what the authority does not allow.
 */
export const AuthoritySchema = z
  .strictObject({
    $schema: z.string().exactOptional(),
    /** Recorded with decisions that lean on this authority. */
    version: z.string().min(1),
    /** What applies when no rule matches. */
    default: z.enum(EFFECTS),
    rules: z.array(RuleSchema),
  })
  .refine((a) => new Set(a.rules.map((r) => r.id)).size === a.rules.length, "rule ids are unique");
export type Authority = z.output<typeof AuthoritySchema>;

export interface AuthorityResult {
  readonly effect: Effect;
  /** The ids of every rule that matched (in the authority's order). */
  readonly matched: readonly string[];
  /** The reasons of the matched rules that gave one. */
  readonly reasons: readonly string[];
}

const RANK: Readonly<Record<Effect, number>> = { allow: 0, escalate: 1, deny: 2 };
const OF_RULE = { permit: "allow", escalate: "escalate", forbid: "deny" } as const;

/** The more restrictive of two effects. */
// Stryker disable next-line EqualityOperator: equivalent; equal ranks are the same effect
export const tighten = (a: Effect, b: Effect): Effect => (RANK[a] >= RANK[b] ? a : b);

/** The authority's effect on these facts: the most restrictive matched rule's, else the default. */
export function evaluateAuthority(authority: Authority, facts: Json): AuthorityResult {
  const hits = authority.rules.filter((rule) => evaluateCondition(rule.when, facts));
  const effect = hits.length === 0 ? authority.default : hits.map((rule) => OF_RULE[rule.effect]).reduce(tighten);
  return { effect, matched: hits.map((r) => r.id), reasons: hits.flatMap((r) => (r.reason === undefined ? [] : [r.reason])) };
}

/** JSON Schema for authority files, for editors (data/authority.schema.json). */
// Stryker disable next-line ObjectLiteral,StringLiteral: equivalent; this schema's input and output JSON Schemas are the same
export const authorityJsonSchema = (): object => z.toJSONSchema(AuthoritySchema, { io: "input" });
