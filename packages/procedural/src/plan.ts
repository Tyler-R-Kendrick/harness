/**
 * Plans from subgraphs (ADR 0016, plan §7.6): a procedural graph is the prior plans come
 * from, and a plan is one execution of part of it. `planFromSubgraph` turns the
 * subgraph between two nodes into core's `TaskGraph`: each ACTION node becomes a task
 * whose payload holds the node and its binding, and the graph's relations become the
 * task graph's dependencies (by default `PROVIDES_INPUT_FOR` is data, `LEADS_TO`,
 * `TRIGGERS` and `CONVERGES_TO` are control). Reasoning and status nodes run nothing, so
 * they contract away: a task depends on each task it reaches through them. A plan runs
 * each task once, so a cycle through a task is refused with a diagnostic, while a loop
 * among reasoning and status nodes alone contracts away with them.
 */
import { z } from "zod";
import { TaskGraph } from "@harness/core";
import type { DependencyKind } from "@harness/core";
import { BindingSchema, NodeNameSchema, NodeTypeNameSchema, nodeById } from "./graph.ts";
import type { Diagnostic, NodeName } from "./graph.ts";
import type { EffectiveEdge, EffectiveGraph } from "./overlay-types.ts";

/** A plan task: the ACTION node it stands for and what it runs (null: no binding). */
export const PlanPayloadSchema = z
  .strictObject({
    node: z.strictObject({ id: NodeNameSchema, type: NodeTypeNameSchema, description: z.string() }).readonly(),
    binding: BindingSchema.nullable(),
  })
  .readonly();
export type PlanPayload = z.output<typeof PlanPayloadSchema>;

/** Relations as task-graph dependencies; null is no dependency. */
export type PlanRelations = Readonly<Record<string, DependencyKind | null>>;

/** The paper's vocabulary as dependencies: data flows along `PROVIDES_INPUT_FOR`, the rest orders steps. */
export const PLAN_RELATIONS: PlanRelations = { PROVIDES_INPUT_FOR: "data", LEADS_TO: "control", TRIGGERS: "control", CONVERGES_TO: "control" };

export interface PlanOptions {
  /** Every relation the graph uses must be named; `PLAN_RELATIONS` when not given. */
  readonly relations?: PlanRelations;
}

export type PlanResult = { readonly ok: true; readonly plan: TaskGraph<PlanPayload> } | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** The task node type (the paper's only named type). */
const ACTION = "ACTION";

/** The kind of a dependency through several edges: theirs when they agree, else control. */
const combine = (a: DependencyKind, b: DependencyKind): DependencyKind => (a === b ? a : "control");

/** The nodes reachable from `start` along `next`, `start` included. */
function reach(start: string, next: (node: string) => readonly string[]): Set<string> {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    for (const n of next(stack.pop()!)) {
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(n);
    }
  }
  return seen;
}

/**
 * The plan for the subgraph from `from` to `to`: the nodes on some path from one to the
 * other, both included. Diagnostics: an endpoint not in the graph (`missing-endpoint`),
 * `to` not reachable from `from` (`unreachable`), an edge whose relation has no
 * dependency kind (`unknown-relation`), and a cycle through a task (`cycle`).
 */
export function planFromSubgraph(graph: EffectiveGraph, from: string, to: string, options: PlanOptions = {}): PlanResult {
  const relations = options.relations ?? PLAN_RELATIONS;
  const missing = (
    [
      ["from", from],
      ["to", to],
    ] as const
  ).flatMap(([at, id]): Diagnostic[] => (nodeById(graph, id) === undefined ? [{ code: "missing-endpoint", message: `node ${id} is not in the graph`, at }] : []));
  const unknown = graph.edges.flatMap((e, i): Diagnostic[] =>
    Object.hasOwn(relations, e.relation) ? [] : [{ code: "unknown-relation", message: `relation ${e.relation} has no dependency kind for plans`, at: `edges[${i}]` }],
  );
  const problems = [...missing, ...unknown];
  if (problems.length > 0) return { ok: false, diagnostics: problems };

  const kindOf = (e: EffectiveEdge): DependencyKind | null => relations[e.relation]!;
  const dependencies = graph.edges.filter((e) => kindOf(e) !== null);
  const ahead = reach(from, (n) => dependencies.filter((e) => e.from === n).map((e) => e.to));
  if (!ahead.has(to)) return { ok: false, diagnostics: [{ code: "unreachable", message: `${to} cannot be reached from ${from}` }] };
  const behind = reach(to, (n) => dependencies.filter((e) => e.to === n).map((e) => e.from));
  const inside = (n: string): boolean => ahead.has(n) && behind.has(n);
  const tasks = graph.nodes.filter((n) => n.type === ACTION && inside(n.id));
  const isTask = new Set<string>(tasks.map((n) => n.id));

  const plan = new TaskGraph<PlanPayload>();
  for (const n of tasks) plan.addNode(n.id, { payload: { node: { id: n.id, type: n.type, description: n.description }, binding: n.binding ?? null } });
  const diagnostics: Diagnostic[] = [];
  for (const task of tasks) {
    // Walk out of the task, nearest first, through non-task nodes, carrying the kind of the
    // way so far. A node the task reaches that does not lead to `to` leads to no task of the
    // plan (else it would be inside), so the walk need not keep to the subgraph.
    const seen = new Set<string>();
    const queue: [NodeName, DependencyKind][] = dependencies.filter((e) => e.from === task.id).map((e) => [e.to, kindOf(e)!]);
    while (queue.length > 0) {
      const [node, kind] = queue.shift()!;
      const key = `${kind}:${node}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!isTask.has(node)) {
        for (const e of dependencies.filter((x) => x.from === node)) queue.push([e.to, combine(kind, kindOf(e)!)]);
        continue;
      }
      const result = plan.addEdge(task.id, node, kind);
      if (!result.ok) diagnostics.push({ code: "cycle", message: `the plan would hold a cycle between ${task.id} and ${node}: ${result.error.message}` });
    }
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, plan };
}

/** A plan from its JSON (`plan.toJSON()`), every payload checked; throws on anything invalid. */
export const parsePlan = (data: unknown): TaskGraph<PlanPayload> =>
  TaskGraph.fromJSON(data, (raw) => {
    const parsed = PlanPayloadSchema.safeParse(raw);
    if (!parsed.success) throw new RangeError(z.prettifyError(parsed.error));
    return parsed.data;
  });
