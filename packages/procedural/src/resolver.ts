/**
 * The graph resolver (plan §5.1, §8.1): configuration, not architecture. It maps what a
 * session carries (its opaque `sessionMeta`, its `cwd`, its owner principal) to a
 * `GraphId`, or to no graph. Rules are data (data/resolver.json, with a JSON Schema
 * generated from this parser); the first rule whose conditions all hold decides. Nothing
 * here knows what a user, team, repository or project is (I7): a deployment says so by
 * the rules it writes.
 *
 * A rule may also route: it names candidate graphs and a minimum confidence, and the
 * cognitive router (a `GraphRouter`, `modelGraphRouter` on the ensemble's router) chooses
 * among them by the session's first prompt. A choice below the minimum, no choice, no
 * prompt yet, or no router at all resolves to no graph. A session already pinned to one
 * of the candidates keeps it, so a session is routed once.
 */
import { z } from "zod";
import { ProbabilitySchema } from "@harness/cognitive";
import type { Probability } from "@harness/cognitive";
import { GraphIdSchema } from "./graph.ts";
import type { GraphId } from "./graph.ts";

/** What the resolver (and the access policy) can see of a session. */
export interface ResolveContext {
  /** The session's `_meta.harness.session` record, uninterpreted by core. */
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly cwd?: string;
  /** The owner principal the daemon records. */
  readonly principal?: string;
  /** The session's first prompt, which a route rule's router reads. */
  readonly prompt?: string;
  /** The graph the session is pinned to; a route rule keeps it when it is a candidate. */
  readonly pinned?: GraphId;
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

/** A graph a route rule may choose: its id, or its id and what it is for (the router reads it). */
const CandidateSchema = z.union([GraphIdSchema, z.strictObject({ graph: GraphIdSchema, description: z.string().min(1) })]);

const candidateId = (c: z.output<typeof CandidateSchema>): GraphId => (typeof c === "string" ? c : c.graph);

/** Candidate graphs, each named once, and the confidence the router's choice needs. */
export const RouteSchema = z.strictObject({
  candidates: z
    .array(CandidateSchema)
    .min(1)
    .superRefine((candidates, ctx) => {
      const seen = new Set<string>();
      for (const c of candidates) {
        const graph = candidateId(c);
        if (seen.has(graph)) ctx.addIssue(`candidate ${graph} is named twice`);
        seen.add(graph);
      }
    }),
  minConfidence: ProbabilitySchema,
});
export type Route = z.output<typeof RouteSchema>;

/** A rule names a graph (a template, or null for none) or routes among graphs; one of the two. */
const RuleSchema = z
  .strictObject({
    when: WhenSchema,
    /** A template with `${meta.x}`, `${principal}` and `${cwd}`, or null for no graph. */
    graph: TemplateSchema.nullable().exactOptional(),
    /** Candidate graphs the router chooses among by the session's first prompt. */
    route: RouteSchema.exactOptional(),
  })
  .superRefine((rule, ctx) => {
    if (("graph" in rule) === ("route" in rule)) ctx.addIssue("a rule names either a graph or a route");
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

/** A graph the router may choose, as it is asked. */
export interface RouteCandidate {
  readonly graph: GraphId;
  readonly description?: string;
}

export interface RouteRequest {
  /** The session's first prompt. */
  readonly prompt: string;
  readonly candidates: readonly RouteCandidate[];
}

/** The router's choice (none: undefined) and its calibrated confidence. */
export interface RouteAnswer {
  readonly graph: GraphId | undefined;
  readonly confidence: Probability;
}

/** Chooses a graph among candidates for a prompt: the cognitive router (see `modelGraphRouter`). */
export type GraphRouter = (request: RouteRequest) => Promise<RouteAnswer>;

/** A resolution, or the route the deciding rule asks the router for. */
type Decision = { readonly resolution: Resolution } | { readonly rule: number; readonly route: Route };

function decide(resolver: Resolver, context: ResolveContext): Decision {
  const index = resolver.rules.findIndex((r) => matches(r.when, context));
  if (index === -1) return { resolution: { graph: undefined, rule: undefined, reason: "no rule matches" } };
  const rule = resolver.rules[index]!;
  if (rule.route !== undefined) {
    const kept = rule.route.candidates.map(candidateId).find((graph) => graph === context.pinned);
    if (kept !== undefined) return { resolution: { graph: kept, rule: index, reason: `rule ${index} keeps the session's routed graph ${kept}` } };
    return { rule: index, route: rule.route };
  }
  return { resolution: fill(index, rule.graph ?? null, context) };
}

/**
 * Resolve a session without routing, saying why. The first matching rule decides, even
 * when its template gives no valid graph id: a result is parsed as a `GraphId`, and an
 * invalid one resolves to no graph rather than falling through to a later rule. A route
 * rule gives the session's pinned graph when it is a candidate, and otherwise no graph
 * (routing needs `explainRoute` and a router).
 */
export function explainResolve(resolver: Resolver, context: ResolveContext): Resolution {
  const decision = decide(resolver, context);
  if ("resolution" in decision) return decision.resolution;
  return { graph: undefined, rule: decision.rule, reason: `rule ${decision.rule} routes among graphs, which needs the router` };
}

/**
 * Resolve a session, routing when the deciding rule routes: the router is asked with the
 * session's first prompt and the candidates, and its choice is the graph when it is a
 * candidate chosen at `minConfidence` or above. Otherwise, as for a template, the rule
 * still decides: no graph, with the reason. A router that throws is no graph too.
 */
export async function explainRoute(resolver: Resolver, context: ResolveContext, router?: GraphRouter): Promise<Resolution> {
  const decision = decide(resolver, context);
  if ("resolution" in decision) return decision.resolution;
  const { rule, route } = decision;
  const none = (reason: string): Resolution => ({ graph: undefined, rule, reason });
  if (router === undefined) return none(`rule ${rule} routes among graphs, and there is no router`);
  const prompt = context.prompt?.trim() ?? "";
  if (prompt === "") return none(`rule ${rule} routes by the session's first prompt, which it does not have`);
  const candidates = route.candidates.map((c): RouteCandidate => (typeof c === "string" ? { graph: c } : c));
  let answer: RouteAnswer;
  try {
    answer = await router({ prompt: context.prompt!, candidates });
  } catch (e) {
    return none(`rule ${rule} could not route: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { graph, confidence } = answer;
  if (graph === undefined) return none(`rule ${rule}: the router chose no graph (confidence ${confidence})`);
  if (!candidates.some((c) => c.graph === graph)) return none(`rule ${rule}: the router chose graph ${graph}, which is not a candidate`);
  if (confidence < route.minConfidence) return none(`rule ${rule}: the router chose graph ${graph} at confidence ${confidence}, below ${route.minConfidence}`);
  return { graph, rule, reason: `rule ${rule} routes to graph ${graph} at confidence ${confidence}` };
}

/** Whether the rule that decides for this session routes (so resolving it reads the prompt and the pin). */
export const routes = (resolver: Resolver, context: ResolveContext): boolean => resolver.rules.find((r) => matches(r.when, context))?.route !== undefined;

/** The graph a session resolves to, routing when its rule routes (see `explainRoute` for why). */
export const routeGraph = async (resolver: Resolver, context: ResolveContext, router?: GraphRouter): Promise<GraphId | undefined> => (await explainRoute(resolver, context, router)).graph;

/** A template rule's resolution. */
function fill(index: number, template: string | null, context: ResolveContext): Resolution {
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
