import { z } from "zod";
import { JsonSchema } from "./types.ts";
import type { Json } from "./types.ts";

/**
 * A rule's condition, as data: tests over facts (a JSON value) by dot path, combined
 * with all, any and not. There is no code and no pattern language in a condition, so
 * evaluating one is bounded and cannot be made to run long: a condition has at most
 * `MAX_NODES` parts, nested at most `MAX_DEPTH` deep.
 */
export type Condition =
  | { readonly all: readonly Condition[] }
  | { readonly any: readonly Condition[] }
  | { readonly not: Condition }
  | { readonly eq: readonly [string, Json] }
  | { readonly in: readonly [string, readonly Json[]] }
  | { readonly gte: readonly [string, number] }
  | { readonly lte: readonly [string, number] }
  | { readonly prefix: readonly [string, string] }
  | { readonly suffix: readonly [string, string] }
  | { readonly contains: readonly [string, string] }
  | { readonly exists: string };

export const MAX_DEPTH = 8;
export const MAX_NODES = 64;

const path = z.string().min(1);

const Structure: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(Structure) }),
    z.strictObject({ any: z.array(Structure) }),
    z.strictObject({ not: Structure }),
    z.strictObject({ eq: z.tuple([path, JsonSchema]) }),
    z.strictObject({ in: z.tuple([path, z.array(JsonSchema)]) }),
    z.strictObject({ gte: z.tuple([path, z.number().finite()]) }),
    z.strictObject({ lte: z.tuple([path, z.number().finite()]) }),
    z.strictObject({ prefix: z.tuple([path, z.string()]) }),
    z.strictObject({ suffix: z.tuple([path, z.string()]) }),
    z.strictObject({ contains: z.tuple([path, z.string()]) }),
    z.strictObject({ exists: path }),
  ]),
);

function measure(c: Condition): { depth: number; nodes: number } {
  const parts = "all" in c ? c.all : "any" in c ? c.any : "not" in c ? [c.not] : undefined;
  if (parts === undefined) return { depth: 0, nodes: 1 };
  const inner = parts.map(measure);
  return { depth: 1 + Math.max(0, ...inner.map((m) => m.depth)), nodes: 1 + inner.reduce((sum, m) => sum + m.nodes, 0) };
}

export const ConditionSchema: z.ZodType<Condition> = Structure.superRefine((c, ctx) => {
  const { depth, nodes } = measure(c);
  if (depth > MAX_DEPTH) ctx.addIssue({ code: "custom", message: `a condition nests at most ${MAX_DEPTH} deep` });
  if (nodes > MAX_NODES) ctx.addIssue({ code: "custom", message: `a condition has at most ${MAX_NODES} parts` });
});

/** The value at a dot path: own properties of objects and canonical indexes of arrays only; undefined when there is none. */
export function getPath(facts: Json, dotted: string): Json | undefined {
  let current: Json | undefined = facts;
  for (const segment of dotted.split(".")) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) && String(index) === segment ? (current as readonly Json[])[index] : undefined;
    } else if (typeof current === "object" && current !== null && Object.hasOwn(current, segment)) current = (current as { readonly [key: string]: Json })[segment];
    else return undefined;
  }
  return current;
}

function equal(a: Json | undefined, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && equal((a as { readonly [key: string]: Json })[k]!, (b as { readonly [key: string]: Json })[k]!));
}

/** Whether the facts satisfy the condition. Tests on a missing or wrongly typed value are false, never errors. */
export function evaluateCondition(c: Condition, facts: Json): boolean {
  if ("all" in c) return c.all.every((x) => evaluateCondition(x, facts));
  if ("any" in c) return c.any.some((x) => evaluateCondition(x, facts));
  if ("not" in c) return !evaluateCondition(c.not, facts);
  if ("exists" in c) return getPath(facts, c.exists) !== undefined;
  if ("eq" in c) return equal(getPath(facts, c.eq[0]), c.eq[1]);
  if ("in" in c) {
    const value = getPath(facts, c.in[0]);
    return c.in[1].some((candidate) => equal(value, candidate));
  }
  if ("gte" in c) {
    const value = getPath(facts, c.gte[0]);
    return typeof value === "number" && value >= c.gte[1];
  }
  if ("lte" in c) {
    const value = getPath(facts, c.lte[0]);
    return typeof value === "number" && value <= c.lte[1];
  }
  const [where, needle] = "prefix" in c ? c.prefix : "suffix" in c ? c.suffix : c.contains;
  const value = getPath(facts, where);
  if ("contains" in c && Array.isArray(value)) return value.includes(needle);
  if (typeof value !== "string") return false;
  return "prefix" in c ? value.startsWith(needle) : "suffix" in c ? value.endsWith(needle) : value.includes(needle);
}
