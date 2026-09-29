import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { CandidateDocumentSchema, DEFAULT_NODE_TYPES, DEFAULT_RELATIONS, FORMAT, parseGraph, revisionId } from "@harness/procedural";
import type { CandidateDocument, DiagnosticCode } from "@harness/procedural";
import type { DocInput } from "./fixtures.ts";

// Generated names are at most 9 characters, so the longer names below never collide with them.
const name = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_.-]{0,8}$/).filter((n) => n !== "Start");
const vocabulary = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,6}$/);
const text = fc.string({ maxLength: 12 });
const hex64 = fc.stringMatching(/^[0-9a-f]{64}$/);
const binding = fc.oneof(
  fc.record({ kind: fc.constant("tool"), name: fc.string({ minLength: 1, maxLength: 8 }) }),
  fc.record({ kind: fc.constant("workflow"), name: fc.string({ minLength: 1, maxLength: 8 }), code: hex64 }),
  fc.record({ kind: fc.constant("skill"), name: fc.string({ minLength: 1, maxLength: 8 }), content: hex64 }),
);
const UNKNOWN = "ZZ_UNKNOWN_WORD";

/**
 * A valid graph: Start and some other nodes in a topological order, forward edges only
 * (so every node reaches a sink), Start always leading somewhere, and, when `cyclic`,
 * back edges only from nodes that already have a forward edge (so their sinks remain).
 */
const validGraph = (cyclic: boolean) =>
  fc
    .record({
      others: fc.uniqueArray(name, { minLength: 1, maxLength: 7 }),
      nodeTypes: fc.uniqueArray(vocabulary, { maxLength: 2 }).map((extra) => [...new Set([...DEFAULT_NODE_TYPES, ...extra])]),
      relations: fc.uniqueArray(vocabulary, { maxLength: 2 }).map((extra) => [...new Set([...DEFAULT_RELATIONS, ...extra])]),
    })
    .chain(({ others, nodeTypes, relations }) => {
      const ids = ["Start", ...others];
      const node = (id: string) =>
        fc.record({ type: fc.constantFrom(...nodeTypes), description: text, binding: fc.option(binding, { nil: undefined }) }).map(({ type, description, binding: b }) => (b === undefined ? { id, type, description } : { id, type, description, binding: b }));
      const attributes = fc.record({ relation: fc.constantFrom(...relations), condition: fc.option(text, { nil: null }), guidance: text, pitfalls: text });
      const pair = fc.tuple(fc.nat({ max: ids.length - 1 }), fc.nat({ max: ids.length - 1 }), attributes);
      return fc.record({
        nodes: fc.tuple(...ids.map(node)).chain((nodes) => fc.shuffledSubarray(nodes, { minLength: nodes.length })),
        first: attributes,
        pairs: fc.array(pair, { maxLength: 12 }),
        back: fc.array(pair, { maxLength: cyclic ? 4 : 0 }),
      }).map(({ nodes, first, pairs, back }): DocInput => {
        const forward = [{ from: "Start", to: ids[1]!, ...first }, ...pairs.filter(([i, j]) => i !== j).map(([i, j, a]) => ({ from: ids[Math.min(i, j)]!, to: ids[Math.max(i, j)]!, ...a }))];
        const hasForward = new Set(forward.map((e) => e.from));
        const backward = back.filter(([i, j]) => hasForward.has(ids[Math.max(i, j)]!)).map(([i, j, a]) => ({ from: ids[Math.max(i, j)]!, to: ids[Math.min(i, j)]!, ...a }));
        return { format: FORMAT, nodeTypes, relations, nodes, edges: [...forward, ...backward].map(({ from, to, relation, condition, guidance, pitfalls }) => ({ from, relation, to, condition, guidance, pitfalls })) };
      });
    });

const doc = (input: DocInput): CandidateDocument => CandidateDocumentSchema.parse(input);
const permutation = <T>(items: readonly T[]) => fc.shuffledSubarray([...items], { minLength: items.length });
const codes = (input: unknown, cycles: "allowed" | "forbidden" = "allowed"): DiagnosticCode[] => {
  const r = parseGraph(input, cycles);
  return r.ok ? [] : [...new Set(r.diagnostics.map((d) => d.code))];
};

describe("revision ids", () => {
  test.prop([
    validGraph(true).chain((g) =>
      fc.record({ g: fc.constant(g), nodes: permutation(g.nodes), edges: permutation(g.edges), nodeTypes: permutation(g.nodeTypes), relations: permutation(g.relations) }),
    ),
  ])("PGR1.P1 a revision id does not depend on the order of nodes, edges or vocabularies", ({ g, ...shuffled }) => {
    expect(revisionId(doc({ ...g, ...shuffled }))).toBe(revisionId(doc(g)));
  });

  test.prop([validGraph(false), fc.string()])("PGR1.P2 $schema is never part of the id", (g, schema) => {
    expect(revisionId(doc({ ...g, $schema: schema }))).toBe(revisionId(doc(g)));
  });

  test.prop([validGraph(false), fc.string().filter((f) => f !== FORMAT)])("PGR1.P3 the format is part of the id, so a format migration changes every id", (g, format) => {
    const migrated = { ...doc(g), format } as unknown as CandidateDocument;
    expect(revisionId(migrated)).not.toBe(revisionId(doc(g)));
  });

  test.prop([validGraph(false), fc.nat(), fc.nat(), fc.string({ minLength: 1, maxLength: 4 })])("PGR1.P4 any change to a node's or an edge's text changes the id", (g, n, e, extra) => {
    const node = n % g.nodes.length;
    const edge = e % g.edges.length;
    const nodes = g.nodes.map((x, i) => (i === node ? { ...x, description: x.description + extra } : x));
    const edges = g.edges.map((x, i) => (i === edge ? { ...x, pitfalls: x.pitfalls + extra } : x));
    expect(revisionId(doc({ ...g, nodes }))).not.toBe(revisionId(doc(g)));
    expect(revisionId(doc({ ...g, edges }))).not.toBe(revisionId(doc(g)));
  });
});

describe("parsing generated graphs", () => {
  test.prop([fc.boolean().chain((cyclic) => fc.tuple(fc.constant(cyclic), validGraph(cyclic)))])("PGR1.P5 every valid graph parses, unchanged, and an acyclic one parses when cycles are forbidden", ([cyclic, g]) => {
    const r = parseGraph(g, cyclic ? "allowed" : "forbidden");
    expect(r.ok && r.graph).toEqual(g);
  });

  const corruptions: readonly [DiagnosticCode, (g: DocInput, pick: number) => DocInput][] = [
    ["duplicate-node", (g, k) => ({ ...g, nodes: [...g.nodes, { ...g.nodes[k % g.nodes.length]!, description: "twin" }] })],
    ["unknown-type", (g, k) => ({ ...g, nodes: g.nodes.map((n, i) => (i === k % g.nodes.length ? { ...n, type: UNKNOWN } : n)) })],
    ["unknown-relation", (g, k) => ({ ...g, edges: g.edges.map((e, i) => (i === k % g.edges.length ? { ...e, relation: UNKNOWN } : e)) })],
    ["missing-endpoint", (g, k) => ({ ...g, edges: [...g.edges, { ...g.edges[k % g.edges.length]!, to: "Missing_Endpoint" }] })],
    ["missing-endpoint", (g, k) => ({ ...g, edges: [...g.edges, { ...g.edges[k % g.edges.length]!, from: "Missing_Endpoint" }] })],
    ["missing-start", (g) => {
      const rename = (id: string) => (id === "Start" ? "Renamed_Start" : id);
      return { ...g, nodes: g.nodes.map((n) => ({ ...n, id: rename(n.id) })), edges: g.edges.map((e) => ({ ...e, from: rename(e.from), to: rename(e.to) })) };
    }],
    ["no-terminal", (g) => {
      const loop = (from: string, to: string) => ({ from, relation: g.relations[0]!, to, condition: null, guidance: "", pitfalls: "" });
      return { ...g, nodes: [...g.nodes, { id: "Loop_Node_One", type: "STATUS", description: "" }, { id: "Loop_Node_Two", type: "STATUS", description: "" }], edges: [...g.edges, loop("Loop_Node_One", "Loop_Node_Two"), loop("Loop_Node_Two", "Loop_Node_One")] };
    }],
  ];

  test.prop([validGraph(true), fc.nat(), fc.constantFrom(...corruptions.keys())])("PGR1.P6 each single structural corruption of a valid graph is refused with its own diagnostic code", (g, pick, which) => {
    const [code, corrupt] = corruptions[which]!;
    expect(codes(corrupt(g, pick))).toEqual([code]);
  });

  test.prop([validGraph(false), fc.nat()])("PGR1.P7 under the forbidden cycle policy, a cycle is refused as a cycle and nothing else", (g, pick) => {
    const e = g.edges[pick % g.edges.length]!;
    const looped = { ...g, edges: [...g.edges, { ...e, to: e.from }] };
    expect(codes(looped, "forbidden")).toEqual(["cycle"]);
    expect(codes(looped, "allowed")).toEqual([]);
  });
});
