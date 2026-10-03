/**
 * Thresholds, rotation, exploration and mode per fork, as data (`data/policy.json`, whose
 * JSON Schema is generated from the parser here). A file gives a default and the fork ids
 * that differ from it, field by field; `policyFor` resolves one fork's policy.
 */
import { z } from "zod";
import { DecisionError, ForkPolicySchema, PolicySchema } from "./types.ts";
import type { ForkId, ForkPolicy, Policy } from "./types.ts";

const defined = (override: object | undefined): object => Object.fromEntries(Object.entries(override ?? {}).filter(([, value]) => value !== undefined));

/** The policy of one fork: the default with the fork's overrides on top (a field an override leaves out, or leaves undefined, keeps the default). */
export function policyFor(policy: Policy, fork: ForkId): ForkPolicy {
  return { ...policy.default, ...defined(policy.forks[fork]) };
}

/**
 * A policy from JSON, refused with a DecisionError (code `invalid`) that names where the
 * file is wrong. Every fork's overrides are checked merged over the default, so a fork
 * that raises `verify` above the default `act`, or lowers `act` below the default
 * `verify`, is caught here and not at the first decision.
 */
export function parsePolicy(json: unknown): Policy {
  const parsed = PolicySchema.safeParse(json);
  if (!parsed.success) throw new DecisionError("invalid", `invalid decision policy:\n${z.prettifyError(parsed.error)}`);
  const policy = parsed.data;
  for (const fork of Object.keys(policy.forks) as ForkId[]) {
    const merged = ForkPolicySchema.safeParse(policyFor(policy, fork));
    if (!merged.success) throw new DecisionError("invalid", `invalid decision policy:\nforks.${fork}: ${z.prettifyError(merged.error)}`);
  }
  return policy;
}

/** JSON Schema for policy files, for editors (data/policy.schema.json). */
// Stryker disable next-line ObjectLiteral,StringLiteral: equivalent; this schema's input and output JSON Schemas are the same
export const policyJsonSchema = (): object => z.toJSONSchema(PolicySchema, { io: "input" });
