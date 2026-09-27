import type { EffectiveEdge, EffectiveGraph, EffectiveNode } from "./overlay-types.ts";

/** Characters Mermaid reads inside a quoted label, as its entity codes; `#` first, since the codes use it. */
const ENTITIES: readonly (readonly [RegExp, string])[] = [
  [/#/g, "#35;"],
  [/"/g, "#quot;"],
  [/</g, "#lt;"],
  [/>/g, "#gt;"],
  [/\|/g, "#124;"],
  [/`/g, "#96;"],
];

/** Label lines as one quoted Mermaid label: each line escaped, joined by `<br/>`. */
function label(lines: readonly string[]): string {
  const escaped = lines.map((line) => ENTITIES.reduce((text, [pattern, code]) => text.replace(pattern, code), line));
  return `"${escaped.join("<br/>").replace(/\r\n|[\r\n]/g, "<br/>")}"`;
}

/** The learned label the serializer uses, for an overlay item. */
const learned = (item: { origin: "core" | "overlay"; status?: string }): string[] => (item.origin === "overlay" ? [item.status === "probation" ? "learned (provisional)" : "learned"] : []);

/** A node's shape says its type: statuses are stadiums, reasoning a rhombus, anything else a box. */
function shape(node: EffectiveNode, text: string): string {
  if (node.type === "STATUS") return `([${text}])`;
  if (node.type === "REASONING") return `{${text}}`;
  return `[${text}]`;
}

function edgeLine(edge: EffectiveEdge, from: string, to: string): string {
  const lines = [edge.relation, ...(edge.condition === null ? [] : [`when: ${edge.condition}`]), ...learned(edge), ...edge.cautions.map((c) => `Caution: ${c.text}`)];
  return `  ${from} ${edge.origin === "overlay" ? "-.->" : "-->"}|${label(lines)}| ${to}`;
}

/**
 * The effective graph as a Mermaid flowchart (plan §11, P12), for people to read. Node
 * names go into labels only (nodes are `n<index>`), so no name can collide with
 * Mermaid's syntax. Overlay nodes and edges are dashed and labeled "learned", or
 * "learned (provisional)" on probation; a caution is annotated on its edge's label and
 * the edge is drawn in the caution style. Notes and guidance text are left out.
 */
export function exportMermaid(g: EffectiveGraph): string {
  const ids = new Map(g.nodes.map((n, i) => [n.id, `n${i}`]));
  const nodes = g.nodes.map((n) => `  ${ids.get(n.id)!}${shape(n, label([n.id, n.type, ...learned(n)]))}${n.origin === "overlay" ? ":::overlay" : ""}`);
  const edges = g.edges.map((e) => edgeLine(e, ids.get(e.from)!, ids.get(e.to)!));
  const cautioned = g.edges.flatMap((e, i) => (e.cautions.length > 0 ? [i] : []));
  return [
    "flowchart TD",
    `  %% core ${g.core}, overlay ${g.overlay ?? "none"}`,
    ...nodes,
    ...edges,
    "  classDef overlay stroke-dasharray: 5 5",
    ...(cautioned.length > 0 ? [`  linkStyle ${cautioned.join(",")} stroke:#c0392b,stroke-width:2px`] : []),
  ].join("\n");
}
