/**
 * The graph resolver (plan §5.1, §8.1): configuration, not architecture. It maps what a
 * session carries (its opaque `sessionMeta`, its `cwd`, its owner principal) to a
 * `GraphId`, or to no graph. Rules are data (data/resolver.json, with a JSON Schema
 * generated from this parser); the first rule whose conditions all hold decides. Nothing
 * here knows what a user, team, repository or project is (I7): a deployment says so by
 * the rules it writes.
 */
import { z } from "zod";
import { GraphIdSchema } from "./graph.ts";
import type { GraphId } from "./graph.ts";

/** What the resolver (and the access policy) can see of a session. */
export interface ResolveContext {
  /** The session's `_meta.harness.session` record, uninterpreted by core. */
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly cwd?: string;
  /** The owner principal the daemon records. */
  readonly principal?: string;
}

/** A variable a template may name: `meta.<key>`, `principal` or `cwd`. */
const VARIABLE = /^(?:principal|cwd|meta\..+)$/;
const SLOT = /\$\{([^}]*)\}/g;
/** A `${` with no closing brace after it. */
const UNTERMINATED = /\$\{[^}]*$/;

/** Problems with a graph template, as messages; empty when it is well formed. */
function templateProblems(template: string): string[] {
  const problems: string[] = [];
  for (const [, name] of template.matchAll(SLOT)) {
    if (!VARIABLE.test(name!)) problems.push(`unknown template variable \${${name!}}`);
  }
  if (UNTERMINATED.test(template)) problems.push("an unterminated template variable");
  return problems;
}

const TemplateSchema = z.string().superRefine((template, ctx) => {
  for (const message of templateProblems(template)) ctx.addIssue(message);
});

/**
 * A rule's conditions; each one given must hold, and `{}` matches every session.
 * `meta` maps a (dotted) key to the value it must have as a string, or to `"*"` for any
 * present value. `cwdUnder` matches that directory and everything below it. `principal`
 * is one principal, or `"*"` for any.
 */
export const WhenSchema = z.strictObject({
  meta: z.record(z.string(), z.string()).exactOptional(),
  cwdUnder: z.string().min(1).exactOptional(),
  principal: z.string().min(1).exactOptional(),
});
export type When = z.output<typeof WhenSchema>;

const RuleSchema = z.strictObject({
  when: WhenSchema,
  /** A template with `${meta.x}`, `${principal}` and `${cwd}`, or null for no graph. */
  graph: TemplateSchema.nullable(),
});

/** Resolver rules, in order; the first match wins. Made only by `parseResolver`. */
export const ResolverSchema = z
  .strictObject({
    $schema: z.string().exactOptional(),
    rules: z.array(RuleSchema),
  })
  .brand<"Resolver">();
export type Resolver = z.output<typeof ResolverSchema>;

/** Parse a resolver (see data/resolver.json); any problem refuses it whole, naming where. */
export function parseResolver(input: unknown): Resolver {
  const result = ResolverSchema.safeParse(input);
  if (!result.success) throw new RangeError(`invalid procedural resolver\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** JSON Schema for the resolver file, for editors (data/resolver.schema.json). */
export const resolverJsonSchema = (): object => z.toJSONSchema(ResolverSchema);

/**
 * A (dotted) key in session meta: the flat key when present, else a path through nested
 * records, trying the shortest head first.
 */
function lookup(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, key)) return record[key];
  for (let dot = key.indexOf("."); dot !== -1; dot = key.indexOf(".", dot + 1)) {
    const head = key.slice(0, dot);
    if (!Object.hasOwn(record, head)) continue;
    const found = lookup(record[head], key.slice(dot + 1));
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A scalar as the string a rule compares and a template fills; undefined for anything else. */
const scalar = (value: unknown): string | undefined =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;

const present = (value: unknown): boolean => value !== undefined && value !== null;

const SEPARATOR = /[/\\]/;

/** Whether `cwd` is `dir` or below it, on a path boundary. */
function under(cwd: string, dir: string): boolean {
  let prefix = dir;
  while (prefix.length > 1 && SEPARATOR.test(prefix.at(-1)!)) prefix = prefix.slice(0, -1);
  if (cwd === prefix) return true;
  if (!cwd.startsWith(prefix)) return false;
  return SEPARATOR.test(prefix.at(-1)!) || SEPARATOR.test(cwd.charAt(prefix.length));
}

/** Whether every condition of `when` holds for the session. */
export function matches(when: When, context: ResolveContext): boolean {
  for (const [key, want] of Object.entries(when.meta ?? {})) {
    const value = lookup(context.meta, key);
    if (want === "*" ? !present(value) : scalar(value) !== want) return false;
  }
  if (when.cwdUnder !== undefined && (context.cwd === undefined || !under(context.cwd, when.cwdUnder))) return false;
  if (when.principal !== undefined && (context.principal === undefined || (when.principal !== "*" && when.principal !== context.principal))) return false;
  return true;
}

/** The value a template variable names, or undefined when the session lacks it. */
function variable(name: string, context: ResolveContext): string | undefined {
  if (name === "principal") return context.principal;
  if (name === "cwd") return context.cwd;
  return scalar(lookup(context.meta, name.slice("meta.".length)));
}

/** How a session resolved: the graph, the rule that decided, and why. */
export interface Resolution {
  readonly graph: GraphId | undefined;
  /** The index of the deciding rule; undefined when none matched. */
  readonly rule: number | undefined;
  readonly reason: string;
}

/**
 * Resolve a session, saying why. The first matching rule decides, even when its
 * template gives no valid graph id: a result is parsed as a `GraphId`, and an invalid
 * one resolves to no graph rather than falling through to a later rule.
 */
export function explainResolve(resolver: Resolver, context: ResolveContext): Resolution {
  const index = resolver.rules.findIndex((r) => matches(r.when, context));
  if (index === -1) return { graph: undefined, rule: undefined, reason: "no rule matches" };
  const template = resolver.rules[index]!.graph;
  if (template === null) return { graph: undefined, rule: index, reason: `rule ${index} names no graph` };
  const missing = Array.from(template.matchAll(SLOT), ([, name]) => name!).find((name) => variable(name, context) === undefined);
  if (missing !== undefined) return { graph: undefined, rule: index, reason: `rule ${index} needs ${missing}, which the session does not have` };
  const text = template.replace(SLOT, (_slot, name: string) => variable(name, context)!);
  const parsed = GraphIdSchema.safeParse(text);
  if (!parsed.success) return { graph: undefined, rule: index, reason: `rule ${index} gives ${JSON.stringify(text)}, which is not a graph id` };
  return { graph: parsed.data, rule: index, reason: `rule ${index} names graph ${parsed.data}` };
}

/** The graph a session resolves to, or undefined for none (see `explainResolve` for why). */
export const resolveGraph = (resolver: Resolver, context: ResolveContext): GraphId | undefined => explainResolve(resolver, context).graph;
