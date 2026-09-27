import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { match, neighborhood, NodeNameSchema, revisionId, seedGraph, serializeNeighborhood, serializeWindow } from "@harness/procedural";
import type { EffectiveEdge, EffectiveGraph, EffectiveNode, ScoredTrajectory } from "@harness/procedural";

const core = revisionId(seedGraph());
const nodeName = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,5}$/);
// One line of text that cannot spell a label, so any label in the output is the serializer's.
const line = fc.stringMatching(/^[a-z .,;]{0,12}$/);

/**
 * Any core view shape (no structural checks needed: localization reads any graph): unique
 * nodes, some with a tool binding, and edges between any two of them, loops and parallel
 * edges included.
 */
const graph = fc
  .uniqueArray(nodeName, { minLength: 1, maxLength: 8, comparator: (a, b) => a === b })
  .chain((ids) =>
    fc.record({
      nodes: fc.tuple(...ids.map((id) => fc.record({ description: line, binding: fc.option(nodeName, { nil: undefined }) }).map(({ description, binding }): EffectiveNode => {
        const n = { id: NodeNameSchema.parse(id), type: "ACTION", description, origin: "core" as const };
        return binding === undefined ? n : { ...n, binding: { kind: "tool", name: binding } };
      }))),
      edges: fc.array(
        fc.record({ from: fc.constantFrom(...ids), to: fc.constantFrom(...ids), condition: fc.option(line, { nil: null }), guidance: line, pitfalls: line }).map(
          (e): EffectiveEdge => ({ ...e, from: NodeNameSchema.parse(e.from), to: NodeNameSchema.parse(e.to), relation: "LEADS_TO", origin: "core", notes: [], cautions: [] }),
        ),
        { maxLength: 16 },
      ),
    }),
  )
  .map(({ nodes, edges }): EffectiveGraph => ({ core, overlay: null, nodes, edges }));

/** Breadth-first distances from a node, by the textbook definition. */
function distances(g: EffectiveGraph, from: string): Map<string, number> {
  const d = new Map([[from, 0]]);
  const queue = [from];
  for (let u = queue.shift(); u !== undefined; u = queue.shift()) {
    for (const e of g.edges) {
      if (e.from === u && !d.has(e.to)) {
        d.set(e.to, d.get(u)! + 1);
        queue.push(e.to);
      }
    }
  }
  return d;
}

const pick = (g: EffectiveGraph, i: number) => g.nodes[i % g.nodes.length]!;

describe("neighborhood", () => {
  test.prop([graph, fc.nat(), fc.nat({ max: 5 })])("PG3.P1 hop k holds exactly the edges whose source is k − 1 steps away, each once", (g, i, hops) => {
    const active = pick(g, i).id;
    const n = neighborhood(g, active, hops);
    const d = distances(g, active);
    expect(n.hops).toHaveLength(hops);
    const listed = n.hops.flat();
    expect(new Set(listed).size).toBe(listed.length);
    n.hops.forEach((edges, k) => {
      const expected = g.edges.filter((e) => d.get(e.from) === k);
      expect(new Set(edges)).toEqual(new Set(expected));
    });
  });
});

describe("match", () => {
  const names = (n: EffectiveNode) => [n.id, n.binding?.name];

  test.prop([graph, fc.oneof(nodeName, fc.nat().map(String))])("PG3.P2 exact finds a node exactly when one is named so, and case-insensitive agrees with every exact match", (g, action) => {
    const exact = match(action, g, "exact");
    const loose = match(action, g, "case-insensitive");
    expect(exact !== undefined).toBe(g.nodes.some((n) => names(n).includes(action)));
    if (exact !== undefined) {
      expect(names(g.nodes.find((n) => n.id === exact)!)).toContain(action);
      expect(loose).toBe(exact);
    }
    expect(loose !== undefined).toBe(g.nodes.some((n) => names(n).some((x) => x?.toLowerCase() === action.toLowerCase())));
  });
});

describe("serialization", () => {
  test.prop([graph, fc.nat(), fc.nat({ max: 4 })])("PG3.P3 a core view prints one transition per neighborhood edge, and never an overlay label", (g, i, hops) => {
    const n = neighborhood(g, pick(g, i).id, hops);
    const text = serializeNeighborhood(g, n);
    expect(text).not.toMatch(/Learned|Caution/);
    expect(text.split("\n").filter((l) => l.startsWith("- Transition: ["))).toHaveLength(n.hops.flat().length);
    expect(text.split("\n").filter((l) => l.startsWith("  * "))).toHaveLength(2 * n.hops.flat().length);
  });

  type Step = ScoredTrajectory["steps"][number];
  const step: fc.Arbitrary<Step> = fc.oneof(
    fc.record({ role: fc.constantFrom("user", "assistant", "tool", "observation"), content: line }),
    fc.record({ role: fc.constant("assistant"), content: line, call: fc.record({ name: nodeName, arguments: fc.dictionary(nodeName, fc.jsonValue(), { maxKeys: 2 }) }) }),
  );

  test.prop([fc.array(step, { maxLength: 12 }), fc.nat({ max: 6 })])("PG3.P4 a wider window only adds earlier text: each window's text ends the next one's", (steps, w) => {
    const narrow = serializeWindow(steps, w);
    const wide = serializeWindow(steps, w + 1);
    expect(wide.endsWith(narrow)).toBe(true);
    expect(serializeWindow(steps, steps.length + 1)).toBe(serializeWindow(steps, steps.length + 2));
  });
});
