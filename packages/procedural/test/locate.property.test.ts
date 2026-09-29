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
      nodes: fc.tuple(...ids.map((id) => fc.record({ description: line, binding: fc.option(nodeName, { nil: undefined }), declares: fc.boolean() }).map(({ description, binding, declares }): EffectiveNode => {
        const n = { id: NodeNameSchema.parse(id), type: "ACTION", description, origin: "core" as const };
        return binding === undefined ? n : { ...n, binding: { kind: "tool", name: binding, ...(declares ? { declares: true as const } : {}) } };
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
  test.prop([graph, fc.nat(), fc.nat({ max: 5 })])("PGR3.P1 hop k holds exactly the edges whose source is k − 1 steps away, each once", (g, i, hops) => {
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

  /** Some nodes turned into reasoning nodes, by a mask. */
  const mixed = fc.tuple(graph, fc.array(fc.boolean(), { minLength: 8, maxLength: 8 })).map(([g, mask]): EffectiveGraph => ({ ...g, nodes: g.nodes.map((n, i) => (mask[i] ? n : { ...n, type: "REASONING" })) }));

  /** 0-1 breadth-first distances: entering an ACTION node costs one hop, anything else none (the active node's own type does not count). */
  function actionDistances(g: EffectiveGraph, from: string): Map<string, number> {
    const d = new Map([[from, 0]]);
    const deque = [from];
    for (let u = deque.shift(); u !== undefined; u = deque.shift()) {
      for (const e of g.edges) {
        if (e.from !== u) continue;
        const cost = g.nodes.find((n) => n.id === e.to)!.type === "ACTION" ? 1 : 0;
        const via = d.get(u)! + cost;
        if (!d.has(e.to) || via < d.get(e.to)!) {
          d.set(e.to, via);
          if (cost === 0) deque.unshift(e.to);
          else deque.push(e.to);
        }
      }
    }
    return d;
  }

  test.prop([mixed, fc.nat(), fc.nat({ max: 5 })])("PGR3.P5 in action hops, hop k holds exactly the edges whose source is k − 1 action nodes away, each once; with every node an action it is the edge count", (g, i, hops) => {
    const active = pick(g, i).id;
    const n = neighborhood(g, active, hops, "action");
    const d = actionDistances(g, active);
    expect(n.hops).toHaveLength(hops);
    const listed = n.hops.flat();
    expect(new Set(listed).size).toBe(listed.length);
    n.hops.forEach((edges, k) => {
      const expected = g.edges.filter((e) => d.get(e.from) === k);
      expect(new Set(edges)).toEqual(new Set(expected));
    });
    const actions: EffectiveGraph = { ...g, nodes: g.nodes.map((x) => ({ ...x, type: "ACTION" })) };
    expect(neighborhood(actions, active, hops, "action")).toEqual(neighborhood(actions, active, hops, "edge"));
  });
});

describe("match", () => {
  const names = (n: EffectiveNode) => [n.id, n.binding?.name];

  test.prop([graph, fc.oneof(nodeName, fc.nat().map(String))])("PGR3.P2 exact finds a node exactly when one is named so, and case-insensitive agrees with every exact match", (g, action) => {
    const exact = match(action, g, "exact");
    const loose = match(action, g, "case-insensitive");
    expect(exact !== undefined).toBe(g.nodes.some((n) => names(n).includes(action)));
    if (exact !== undefined) {
      expect(names(g.nodes.find((n) => n.id === exact)!)).toContain(action);
      expect(loose).toBe(exact);
    }
    expect(loose !== undefined).toBe(g.nodes.some((n) => names(n).some((x) => x?.toLowerCase() === action.toLowerCase())));
  });

  test.prop([graph, fc.oneof(nodeName, fc.nat().map(String)), fc.option(nodeName, { nil: undefined })])("PGR3.P6 the state tracker takes a declared node the graph has only from a tool the core trusts to declare; otherwise, with no predicates, it finds a node exactly when exact does, preferring a binding", (g, action, declared) => {
    const tracked = match({ name: action, ...(declared === undefined ? {} : { declared }) }, g, "state-tracker");
    const trusted = g.nodes.some((n) => n.binding?.kind === "tool" && n.binding.name === action && n.binding.declares === true);
    if (trusted && declared !== undefined && g.nodes.some((n) => n.id === declared)) {
      expect(tracked).toBe(declared);
      return;
    }
    const exact = match(action, g, "exact");
    expect(tracked !== undefined).toBe(exact !== undefined);
    if (tracked !== undefined) expect(names(g.nodes.find((n) => n.id === tracked)!)).toContain(action);
    const boundTo = g.nodes.find((n) => n.binding?.name === action);
    if (boundTo !== undefined) expect(tracked).toBe(boundTo.id);
  });
});

describe("serialization", () => {
  test.prop([graph, fc.nat(), fc.nat({ max: 4 })])("PGR3.P3 a core view prints one transition per neighborhood edge, and never an overlay label", (g, i, hops) => {
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

  test.prop([fc.array(step, { maxLength: 12 }), fc.nat({ max: 6 })])("PGR3.P4 a wider window only adds earlier text: each window's text ends the next one's", (steps, w) => {
    const narrow = serializeWindow(steps, w);
    const wide = serializeWindow(steps, w + 1);
    expect(wide.endsWith(narrow)).toBe(true);
    expect(serializeWindow(steps, steps.length + 1)).toBe(serializeWindow(steps, steps.length + 2));
  });
});
