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
  const ends = (id: string): boolean => unit === "edge" || nodeById(g, id)?.type === ACTION;
  const reached = new Set<string>([node]);
  let frontier: string[] = [node];
  const result: EffectiveEdge[][] = [];
  for (let hop = 0; hop < hops; hop++) {
    const edges: EffectiveEdge[] = [];
    const next: string[] = [];
    // Sources of this hop: the frontier, then the non-action nodes the hop passes through.
    const sources = [...frontier];
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
