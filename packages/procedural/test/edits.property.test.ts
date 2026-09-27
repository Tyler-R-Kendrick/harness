import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { applyEdits, canonicalJson, DEFAULT_NODE_TYPES, DEFAULT_RELATIONS, EditSetSchema, FORMAT, parseGraph, prepareCandidate } from "@harness/procedural";
import type { CandidateDocument, CyclePolicy, EditSet, ProceduralGraph } from "@harness/procedural";

const UNKNOWN = "ZZ_UNKNOWN";
const name = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,5}$/).filter((n) => n !== "Start");
const text = fc.string({ maxLength: 10 });
const attributes = (relations: readonly string[]) => fc.record({ relation: fc.constantFrom(...relations), condition: fc.option(text, { nil: null }), guidance: text, pitfalls: text });

/** A valid base: Start and other nodes in topological order, forward edges (so every node reaches a sink), and back edges from nodes that have a forward edge. */
const base = fc
  .uniqueArray(name, { minLength: 1, maxLength: 6 })
  .chain((others) => {
    const ids = ["Start", ...others];
    const pair = fc.tuple(fc.nat({ max: ids.length - 1 }), fc.nat({ max: ids.length - 1 }), attributes(DEFAULT_RELATIONS));
    return fc.record({
      types: fc.array(fc.constantFrom(...DEFAULT_NODE_TYPES), { minLength: ids.length, maxLength: ids.length }),
      first: attributes(DEFAULT_RELATIONS),
      forward: fc.array(pair, { maxLength: 8 }),
      back: fc.array(pair, { maxLength: 3 }),
    }).map(({ types, first, forward, back }) => {
      const fwd = [{ from: "Start", to: ids[1]!, ...first }, ...forward.filter(([i, j]) => i !== j).map(([i, j, a]) => ({ from: ids[Math.min(i, j)]!, to: ids[Math.max(i, j)]!, ...a }))];
      const sources = new Set(fwd.map((e) => e.from));
      const bwd = back.filter(([i, j]) => sources.has(ids[Math.max(i, j)]!)).map(([i, j, a]) => ({ from: ids[Math.max(i, j)]!, to: ids[Math.min(i, j)]!, ...a }));
      const r = parseGraph({
        format: FORMAT,
        nodeTypes: DEFAULT_NODE_TYPES,
        relations: DEFAULT_RELATIONS,
        nodes: ids.map((id, i) => ({ id, type: types[i]!, description: `About ${id}.` })),
        edges: [...fwd, ...bwd].map(({ from, relation, to, condition, guidance, pitfalls }) => ({ from, relation, to, condition, guidance, pitfalls })),
      });
      if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
      return r.graph;
    });
  });

/** Edits over the base's names and some new ones, with an occasional unknown type or relation. */
const editsFor = (g: ProceduralGraph) => {
  const names = fc.oneof(fc.constantFrom(...g.nodes.map((n) => n.id)), name);
  return fc
    .record({
      add_nodes: fc.array(fc.record({ id: names, type: fc.constantFrom(...DEFAULT_NODE_TYPES, UNKNOWN), description: text }), { maxLength: 3 }),
      delete_nodes: fc.array(names, { maxLength: 2 }),
      add_edges: fc.array(fc.record({ source: names, target: names, relation: fc.constantFrom(...DEFAULT_RELATIONS, UNKNOWN), condition: fc.option(text, { nil: null }), guidance: text, pitfalls: text }), { maxLength: 4 }),
      delete_edges: fc.array(fc.record({ source: names, target: names }), { maxLength: 3 }),
    })
    .map((e): EditSet => EditSetSchema.parse(e));
};
const scenario = base.chain((g) => fc.record({ g: fc.constant(g), edits: editsFor(g), cycles: fc.constantFrom<CyclePolicy>("allowed", "forbidden") }));
/** A plain, unfrozen copy, so a mutation would show. */
const thaw = (d: CandidateDocument): CandidateDocument => JSON.parse(JSON.stringify(d));
const key = (from: string, to: string) => `${from}\u0000${to}`;

describe("edits", () => {
  test.prop([scenario])("PG2.P1 applying edits never mutates the base", ({ g, edits }) => {
    const copy = thaw(g);
    const before = canonicalJson(copy);
    applyEdits(copy, edits);
    expect(canonicalJson(copy)).toBe(before);
    const again = canonicalJson(g);
    prepareCandidate(g, edits, { cycles: "forbidden", tools: [], filter: { observations: [] } });
    expect(canonicalJson(g)).toBe(again);
  });

  test.prop([scenario])("PG2.P2 an accepted candidate parses with parseGraph under its cycle policy, to its own document", ({ g, edits, cycles }) => {
    const p = prepareCandidate(g, edits, { cycles });
    if (p.graph === undefined) return;
    const r = parseGraph(p.document, cycles);
    expect(r.ok && r.graph).toEqual(p.document);
    expect(p.graph).toEqual(p.document);
  });

  test.prop([scenario])("PG2.P3 a rejected candidate has diagnostics, an accepted one has none, and a document that does not parse is rejected", ({ g, edits, cycles }) => {
    const p = prepareCandidate(g, edits, { cycles });
    expect(p.graph === undefined).toBe(p.diagnostics.length > 0);
    if (!parseGraph(p.document, cycles).ok) expect(p.graph).toBeUndefined();
  });

  test.prop([scenario])("PG2.P4 delete_edges removes every relation between its endpoints, and deleting a node every edge it touches, unless re-added", ({ g, edits }) => {
    const out = applyEdits(g, edits);
    const readded = new Set(edits.add_edges.map((e) => key(e.source, e.target)));
    const gone = new Set<string>(edits.delete_nodes);
    for (const d of edits.delete_edges) {
      if (!readded.has(key(d.source, d.target))) expect(out.edges.some((e) => e.from === d.source && e.to === d.target)).toBe(false);
    }
    const survivors = out.edges.slice(0, out.edges.length - edits.add_edges.length);
    expect(survivors.some((e) => gone.has(e.from) || gone.has(e.to))).toBe(false);
    const cut = new Set(edits.delete_edges.map((d) => key(d.source, d.target)));
    expect(survivors).toEqual(g.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to) && !cut.has(key(e.from, e.to))));
  });

  test.prop([scenario])("PG2.P5 under forbidden cycles, repair leaves no cycle, and removes exactly the repaired edges", ({ g, edits }) => {
    const p = prepareCandidate(g, edits, { cycles: "forbidden" });
    expect(p.diagnostics.map((d) => d.code)).not.toContain("cycle");
    const applied = applyEdits(g, edits);
    expect(p.document.edges.length + p.repaired.length).toBe(applied.edges.length);
    const allowed = prepareCandidate(g, edits, { cycles: "allowed" });
    expect(allowed.repaired).toEqual([]);
    expect(allowed.document).toEqual(applied);
  });
});
