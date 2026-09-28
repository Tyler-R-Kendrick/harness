/**
 * The graph as text for the guidance model (arXiv:2609.09153 App. B.5; plan §5.2 step 4).
 * The local variant is the paper's serializer: the active node's header, then its
 * transitions grouped by hop, each with its condition, guidance and pitfalls; relation
 * labels are not printed, as the paper's are not. Overlay content is labeled so the
 * guidance model can weigh it: "Learned (provisional): " on probation, "Learned: " once
 * active, "Learned note" and "Caution" bullets. A core view has no overlay content, so
 * it prints exactly the paper's text.
 */
import { canonicalJson } from "./canonical.ts";
import { nodeById } from "./graph.ts";
import type { Neighborhood } from "./locate.ts";
import type { EffectiveEdge, EffectiveGraph, EffectiveNode, EntryStatus } from "./overlay-types.ts";
import type { ScoredTrajectory } from "./trajectory.ts";

type Step = ScoredTrajectory["steps"][number];

/** The label an item carries: none from the core; provisional unless the overlay promoted it. */
const learned = (item: { origin: "core" | "overlay"; status?: EntryStatus }): string =>
  item.origin === "core" ? "" : item.status === "active" ? "Learned: " : "Learned (provisional): ";

function transition(e: EffectiveEdge): string[] {
  return [
    `- ${learned(e)}Transition: [${e.from}] → [${e.to}] (Condition: ${e.condition ?? ""})`,
    `  * Guidance: ${e.guidance}`,
    `  * Pitfalls to Avoid: ${e.pitfalls}`,
    ...e.notes.map((n) => `  * Learned note${n.status === "active" ? "" : " (provisional)"}: ${n.text}`),
    ...e.cautions.map((c) => `  * Caution: ${c.text}`),
  ];
}

/** Transitions in the serializer's words, one after another (a plan task's guidance: the transitions into its node). */
export const serializeTransitions = (edges: readonly EffectiveEdge[]): string => edges.flatMap(transition).join("\n");

const heading = (hop: number): string => (hop === 1 ? "Immediate Transition Options (Hop 1):" : `Subsequent Horizon (Hop ${hop}):`);

/** The paper's local graph context: the active node, then each hop's transitions; a hop with none prints nothing. */
export function serializeNeighborhood(g: EffectiveGraph, n: Neighborhood): string {
  const active: EffectiveNode | undefined = nodeById(g, n.active);
  if (active === undefined) throw new RangeError(`node ${n.active} is not in the graph`);
  const lines = [`${learned(active)}Active Cognitive Node: [${active.id}] (Type: ${active.type})`, `Description: ${active.description}`];
  n.hops.forEach((edges, i) => {
    if (edges.length > 0) lines.push(heading(i + 1), ...edges.flatMap(transition));
  });
  return lines.join("\n");
}

/** The full-graph variant (the fallback when nothing matches): every node, then every transition, in document order. */
export function serializeGraph(g: EffectiveGraph): string {
  return [
    "Procedural Graph Nodes:",
    ...g.nodes.flatMap((n) => [`- ${learned(n)}Node: [${n.id}] (Type: ${n.type})`, `  * Description: ${n.description}`]),
    "Procedural Graph Transitions:",
    ...g.edges.flatMap(transition),
  ].join("\n");
}

const PREFIX: Record<Step["role"], string> = { user: "User", assistant: "Thought", tool: "Observation", observation: "Observation" };

function stepLines(s: Step): string[] {
  const lines = s.content === "" ? [] : [`${PREFIX[s.role]}: ${s.content}`];
  if (s.call !== undefined) {
    const args = Object.entries(s.call.arguments).map(([k, v]) => `${k}=${canonicalJson(v)}`);
    lines.push(`Action: ${s.call.name}(${args.join(", ")})`);
  }
  return lines;
}

/**
 * The recent trajectory `T_{t-w:t}` as the solver's ReAct text. The paper's window
 * counts decisions, not messages: a decision is a run of assistant steps (a thought and
 * its calls, parallel calls included) with the results and messages that follow it.
 * Steps before the first decision are the query, which the guidance prompt has in its
 * own slot, so they are never part of the window.
 */
export function serializeWindow(steps: readonly Step[], w: number): string {
  if (!Number.isInteger(w) || w < 0) throw new RangeError(`the window must be a whole number of steps, not ${w}`);
  const starts = steps.flatMap((s, i) => (s.role === "assistant" && steps[i - 1]?.role !== "assistant" ? [i] : []));
  if (w === 0 || starts.length === 0) return "";
  const from = starts[Math.max(0, starts.length - w)]!;
  return steps.slice(from).flatMap(stepLines).join("\n");
}
