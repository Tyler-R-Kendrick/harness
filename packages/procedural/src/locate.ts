/**
 * Localization (arXiv:2609.09153 §3.2, eq. 2; plan §5.2): where on the graph the agent
 * is, and what lies ahead of it. `match` resolves the last action to a node (`a₀ =
 * Start`); `neighborhood` is `N_h(u)`, the node and the outgoing transitions reached in
 * up to `h` hops, grouped by hop as the paper's serializer prints them.
 */
import { acceptsArguments, NodeNameSchema, nodeById, outgoing, START } from "./graph.ts";
import type { ArgumentPredicate, NodeName } from "./graph.ts";
import type { EffectiveEdge, EffectiveGraph, EffectiveNode } from "./overlay-types.ts";

/**
 * How an action is compared with the graph (the preset's `match`): with node ids and
 * binding names (`exact`, `case-insensitive`), or as a state tracker, which also reads the
 * node the tool's result declared and the call's arguments.
 */
export type MatchMode = "exact" | "case-insensitive" | "state-tracker";

/**
 * An action as a state tracker observes it: the tool called, the call's arguments, and
 * the node the tool's result declared active (`_meta.harness.procedural.node`), if any.
 */
export interface ObservedAction {
  readonly name: string;
  readonly arguments?: unknown;
  readonly declared?: string;
}

// Stryker disable next-line ConditionalExpression: equivalent; a string or an array has no `_meta` key either
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const field = (v: unknown, key: string): unknown => (isRecord(v) ? v[key] : undefined);

/** The node a tool's result declares active: its `_meta.harness.procedural.node`, when that is a string. */
export function declaredNode(result: unknown): string | undefined {
  const node = field(field(field(field(result, "_meta"), "harness"), "procedural"), "node");
  return typeof node === "string" ? node : undefined;
}

/** The active node and the transitions ahead of it: `hops[0]` is hop 1. */
export interface Neighborhood {
  active: NodeName;
  hops: EffectiveEdge[][];
}

const start: NodeName = NodeNameSchema.parse(START);

type Key = (n: EffectiveNode) => string | undefined;
const byId: Key = (n) => n.id;
const byBinding: Key = (n) => n.binding?.name;
const lower = (key: Key): Key => (n) => key(n)?.toLowerCase();

/**
 * The node an action names, or undefined when none does (the caller then falls back to
 * the full graph). No action yet is `Start`. `exact` is the paper's written definition:
 * the action equals a node id or the name of a node's binding. `case-insensitive` also
 * accepts either ignoring case, as the paper's own excerpt pairs `First_Hop_Retrieve`
 * with `first_hop_retrieve`. Earlier rules win, and within a rule the first node in
 * document order: an exact id, an exact binding name, then (case-insensitively) an id and
 * a binding name. These two modes read only an observed action's name.
 *
 * `state-tracker` (plan §5.2) localizes more than tool names: the node the tool's result
 * declared, when the graph has it; then a node bound to the tool, first one whose
 * binding's argument predicate accepts the call, then one whose binding has none; then a
 * node whose id is the tool's name. Every comparison is exact.
 */
export function match(observed: string | ObservedAction | undefined, g: EffectiveGraph, mode: MatchMode): NodeName | undefined {
  if (observed === undefined) return start;
  if (mode === "state-tracker") return track(typeof observed === "string" ? { name: observed } : observed, g);
  const action = typeof observed === "string" ? observed : observed.name;
  const rules: [Key, string][] = [
    [byId, action],
    [byBinding, action],
  ];
  if (mode === "case-insensitive") rules.push([lower(byId), action.toLowerCase()], [lower(byBinding), action.toLowerCase()]);
  for (const [key, wanted] of rules) {
    const found = g.nodes.find((n) => key(n) === wanted);
    if (found !== undefined) return found.id;
  }
  return undefined;
}

/** The state tracker's rules, in order: the declared node, a binding whose predicate holds, a bare binding, the id. */
function track(action: ObservedAction, g: EffectiveGraph): NodeName | undefined {
  const bound = (n: EffectiveNode): boolean => n.binding?.name === action.name;
  const rules: ((n: EffectiveNode) => boolean)[] = [
    (n) => n.id === action.declared,
    (n) => bound(n) && predicateOf(n) !== undefined && acceptsArguments(predicateOf(n)!, action.arguments),
    (n) => bound(n) && predicateOf(n) === undefined,
    (n) => n.id === action.name,
  ];
  for (const rule of rules) {
    const found = g.nodes.find(rule);
    if (found !== undefined) return found.id;
  }
  return undefined;
}

/** A node's argument predicate: only a tool binding carries one. */
// Stryker disable next-line ConditionalExpression,OptionalChaining: equivalent; it is asked only of bound nodes, and other bindings have no `arguments`
const predicateOf = (n: EffectiveNode): ArgumentPredicate | undefined => (n.binding?.kind === "tool" ? n.binding.arguments : undefined);

/**
 * What a hop counts (the preset's `hopUnit`): an `edge`, as the paper does, or an
 * `action`, where a hop runs through reasoning and status nodes to the next `ACTION`
 * node, so that nodes which are never active cannot hide the next tool behind them.
 */
export type HopUnit = "edge" | "action";

/** The node type a hop ends at when hops are counted in actions. */
const ACTION = "ACTION";

/**
 * `N_h(node)`: hop k holds the outgoing edges of the nodes first reached in k − 1 steps,
 * in document order, so every edge appears once, at the hop that first reaches its
 * source. There are always exactly `hops` hops; those past the horizon are empty.
 *
 * In `action` hops a step ends only at an `ACTION` node: the outgoing edges of a
 * non-action node a hop reaches first belong to that same hop (breadth first), and the
 * action nodes it reaches start the next.
 */
export function neighborhood(g: EffectiveGraph, node: NodeName, hops: number, unit: HopUnit = "edge"): Neighborhood {
  if (!Number.isInteger(hops) || hops < 0) throw new RangeError(`hops must be a whole number, not ${hops}`);
  if (nodeById(g, node) === undefined) throw new RangeError(`node ${node} is not in the graph`);
  // Stryker disable next-line OptionalChaining: equivalent; every edge of the effective graph ends at one of its nodes (I6)
  const ends = (id: string): boolean => unit === "edge" || nodeById(g, id)?.type === ACTION;
  const reached = new Set<string>([node]);
  let frontier: string[] = [node];
  const result: EffectiveEdge[][] = [];
  for (let hop = 0; hop < hops; hop++) {
    const edges: EffectiveEdge[] = [];
    // Stryker disable next-line ArrayDeclaration: equivalent; a placeholder id has no outgoing edges
    const next: string[] = [];
    // Sources of this hop: the frontier, then the non-action nodes the hop passes through.
    const sources = [...frontier];
    // Stryker disable next-line EqualityOperator: equivalent; the source past the end is undefined, which has no outgoing edges
    for (let i = 0; i < sources.length; i++) {
      for (const e of outgoing(g, sources[i]!)) {
        edges.push(e);
        // Each target not reached before, once, in the order the edges reach it.
        if (reached.has(e.to)) continue;
        reached.add(e.to);
        (ends(e.to) ? next : sources).push(e.to);
      }
    }
    frontier = next;
    result.push(edges);
  }
  return { active: node, hops: result };
}
