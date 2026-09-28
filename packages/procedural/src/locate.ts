/**
 * Localization (arXiv:2609.09153 §3.2, eq. 2; plan §5.2): where on the graph the agent
 * is, and what lies ahead of it. `match` resolves the last action to a node (`a₀ =
 * Start`); `neighborhood` is `N_h(u)`, the node and the outgoing transitions reached in
 * up to `h` hops, grouped by hop as the paper's serializer prints them.
 */
import { NodeNameSchema, nodeById, outgoing, START } from "./graph.ts";
import type { NodeName } from "./graph.ts";
import type { EffectiveEdge, EffectiveGraph, EffectiveNode } from "./overlay-types.ts";

/** How an action is compared with node ids and binding names (the preset's `match`). */
export type MatchMode = "exact" | "case-insensitive";

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
 * a binding name.
 */
export function match(action: string | undefined, g: EffectiveGraph, mode: MatchMode): NodeName | undefined {
  if (action === undefined) return start;
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

/**
 * The terminal (a node with no outgoing edges) that `node` has an edge to, when there is
 * exactly one; undefined when it has none or several (which one the agent reached is then
 * unknown). The live learner walks a turn that ends with a final answer on to it.
 */
export function terminalAfter(g: EffectiveGraph, node: NodeName): NodeName | undefined {
  const ends = new Set(outgoing(g, node).flatMap((e) => (outgoing(g, e.to).length === 0 ? [e.to] : [])));
  return ends.size === 1 ? [...ends][0] : undefined;
}

/**
 * `N_h(node)`: hop k holds the outgoing edges of the nodes first reached in k − 1 steps,
 * in document order, so every edge appears once, at the hop that first reaches its
 * source. There are always exactly `hops` hops; those past the horizon are empty.
 */
export function neighborhood(g: EffectiveGraph, node: NodeName, hops: number): Neighborhood {
  if (!Number.isInteger(hops) || hops < 0) throw new RangeError(`hops must be a whole number, not ${hops}`);
  if (nodeById(g, node) === undefined) throw new RangeError(`node ${node} is not in the graph`);
  const reached = new Set<string>([node]);
  let frontier: string[] = [node];
  const result: EffectiveEdge[][] = [];
  for (let hop = 0; hop < hops; hop++) {
    const edges = frontier.flatMap((from) => outgoing(g, from));
    // The targets not reached before, once each, in the order the edges reach them.
    frontier = [...new Set(edges.map((e) => e.to))].filter((to) => !reached.has(to));
    for (const to of frontier) reached.add(to);
    result.push(edges);
  }
  return { active: node, hops: result };
}
