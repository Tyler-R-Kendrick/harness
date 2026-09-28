import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProbabilitySchema } from "@harness/cognitive";
import {
  acceptsArguments,
  ArgumentPredicateSchema,
  BindingSchema,
  CandidateDocumentSchema,
  canonicalJson,
  checkGraph,
  DEFAULT_NODE_TYPES,
  DEFAULT_RELATIONS,
  DreamIdSchema,
  EditSetSchema,
  editSetJsonSchema,
  END,
  EntryIdSchema,
  GraphIdSchema,
  graphJsonSchema,
  incoming,
  nodeById,
  NodeNameSchema,
  NodeTypeNameSchema,
  outgoing,
  parseGraph,
  ProceduralGraphSchema,
  RelationNameSchema,
  revisionId,
  RevisionIdSchema,
  RevisionRecordSchema,
  ScoreSchema,
  seedGraph,
  sha256Hex,
  START,
  TrajectoryIdSchema,
} from "@harness/procedural";
import type { CandidateDocument, Diagnostic, ProceduralGraph } from "@harness/procedural";
import { edge, hotpot } from "./fixtures.ts";
import type { DocInput } from "./fixtures.ts";

const ok = (input: unknown, cycles?: "allowed" | "forbidden"): ProceduralGraph => {
  const result = parseGraph(input, cycles);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.graph;
};
const diagnostics = (patch: (d: DocInput) => void, cycles?: "allowed" | "forbidden"): Diagnostic[] => {
  const d = hotpot();
  patch(d);
  const result = parseGraph(d, cycles);
  return result.ok ? [] : result.diagnostics;
};
const accepts = (schema: { safeParse(v: unknown): { success: boolean } }, values: readonly unknown[]) => values.map((v) => schema.safeParse(v).success);
const hex = (c: string) => c.repeat(64);

describe("refined ids", () => {
  it("PG1.4 a GraphId is opaque: lowercase letters, digits and . _ / -, starting with a letter or digit, at most 200", () => {
    expect(accepts(GraphIdSchema, ["default", "team/web", "repo/harness", "a.b_c-d/9", "0", "a".repeat(200)])).toEqual([true, true, true, true, true, true]);
    expect(accepts(GraphIdSchema, ["", "Team", "/root", ".hidden", "-x", "a b", "a".repeat(201), 5])).toEqual([false, false, false, false, false, false, false, false]);
  });

  it("PG1.45 a refused id says what it should have been", () => {
    const why = (schema: { safeParse(v: unknown): { error?: { issues: { message: string }[] } } }, value: unknown) => schema.safeParse(value).error?.issues[0]?.message;
    expect(why(GraphIdSchema, "Team")).toBe("a graph id");
    expect(why(NodeNameSchema, "1st")).toBe("a node name");
    expect(why(NodeTypeNameSchema, "action")).toBe("an upper snake case node type");
    expect(why(RelationNameSchema, "next")).toBe("an upper snake case relation");
    expect(why(RevisionIdSchema, "abc")).toBe("a lowercase hex sha256");
    expect(why(EntryIdSchema, "abc")).toBe("a lowercase hex sha256");
    const r = parseGraph({ ...hotpot(), nodes: [{ id: "1st", type: "STATUS", description: "" }] });
    expect(!r.ok && r.diagnostics).toEqual([{ code: "malformed", message: "a node name", at: "nodes[0].id" }]);
  });

  it("PG1.5 node names start with a letter (at most 120); node types and relations are upper snake case", () => {
    expect(accepts(NodeNameSchema, ["Start", "First_Hop_Retrieve", "first_hop_retrieve", "a.b-c9", "x".repeat(120)])).toEqual([true, true, true, true, true]);
    expect(accepts(NodeNameSchema, ["", "1st", "_x", "a b", "a/b", "x".repeat(121)])).toEqual([false, false, false, false, false, false]);
    for (const schema of [NodeTypeNameSchema, RelationNameSchema]) {
      expect(accepts(schema, ["ACTION", "LEADS_TO", "A1", "X"])).toEqual([true, true, true, true]);
      expect(accepts(schema, ["", "action", "Action", "1A", "_A", "A-B", "A B"])).toEqual([false, false, false, false, false, false, false]);
    }
  });

  it("PG1.6 revision and entry ids are lowercase hex sha256; trajectory and dream ids are non-empty, at most 200", () => {
    for (const schema of [RevisionIdSchema, EntryIdSchema]) {
      expect(accepts(schema, [hex("a"), hex("0"), sha256Hex("x")])).toEqual([true, true, true]);
      expect(accepts(schema, [hex("A"), hex("g"), "a".repeat(63), "a".repeat(65), ` ${"a".repeat(63)}`])).toEqual([false, false, false, false, false]);
    }
    for (const schema of [TrajectoryIdSchema, DreamIdSchema]) {
      expect(accepts(schema, ["t", "session/turn 1", "x".repeat(200)])).toEqual([true, true, true]);
      expect(accepts(schema, ["", "x".repeat(201), 1])).toEqual([false, false, false]);
    }
  });

  it("PG1.7 a Score is cognitive's Probability, and the vocabularies and terminals are the paper's", () => {
    expect(ScoreSchema).toBe(ProbabilitySchema);
    expect(DEFAULT_NODE_TYPES).toEqual(["ACTION", "REASONING", "STATUS"]);
    expect(DEFAULT_RELATIONS).toEqual(["LEADS_TO", "TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO"]);
    expect([START, END]).toEqual(["Start", "End"]);
  });
});

describe("bindings", () => {
  it("PG1.8 a binding names a tool, or a workflow or skill by the sha256 of its code or content", () => {
    expect(accepts(BindingSchema, [{ kind: "tool", name: "search" }, { kind: "workflow", name: "w", code: hex("b") }, { kind: "skill", name: "s", content: hex("c") }])).toEqual([true, true, true]);
    expect(
      accepts(BindingSchema, [
        { kind: "tool", name: "" },
        { kind: "workflow", name: "w" },
        { kind: "workflow", name: "w", code: "not a hash" },
        { kind: "skill", name: "s", code: hex("c") },
        { kind: "tool", name: "t", extra: 1 },
        { kind: "grant", name: "t" },
      ]),
    ).toEqual([false, false, false, false, false, false]);
  });

  it("PG1.53 a tool binding may carry an argument predicate: an object JSON Schema over the call's arguments that compiles, kept in the document and its id", () => {
    const tests = { type: "object", properties: { command: { type: "string", pattern: "^npm test" } }, required: ["command"] };
    expect(accepts(BindingSchema, [{ kind: "tool", name: "Bash", arguments: tests }, { kind: "tool", name: "Bash", arguments: { type: "object" } }])).toEqual([true, true]);
    expect(
      accepts(BindingSchema, [
        { kind: "tool", name: "Bash", arguments: { properties: { command: { type: "string" } } } }, // not declared an object
        { kind: "tool", name: "Bash", arguments: { type: "string" } },
        { kind: "tool", name: "Bash", arguments: { type: "object", properties: { command: { type: "string", pattern: "(" } } } }, // does not compile
        { kind: "tool", name: "Bash", arguments: { type: "object", properties: { command: { $ref: "#/nowhere" } } } },
        { kind: "tool", name: "Bash", arguments: "npm test" },
        { kind: "workflow", name: "w", code: hex("b"), arguments: { type: "object" } },
      ]),
    ).toEqual([false, false, false, false, false, false]);
    const doc = { ...hotpot(), nodes: hotpot().nodes.map((n) => (n.id === "Scan_Index" ? { ...n, binding: { kind: "tool", name: "Bash", arguments: tests } } : n)) };
    const parsed = parseGraph(doc);
    expect(parsed.ok && nodeById(parsed.graph, "Scan_Index")?.binding).toEqual({ kind: "tool", name: "Bash", arguments: tests });
    expect(revisionId(ok(doc))).not.toBe(revisionId(ok(hotpot())));
    const bad = parseGraph({ ...doc, nodes: doc.nodes.map((n) => (n.id === "Scan_Index" ? { ...n, binding: { kind: "tool", name: "Bash", arguments: { type: "number" } } } : n)) });
    expect(bad.ok ? [] : bad.diagnostics.map((d) => [d.code, d.at, d.message])).toEqual([["malformed", "nodes[2].binding.arguments", 'an argument predicate is an object schema: its type must be "object"']]);
    expect(ArgumentPredicateSchema.safeParse({ type: "string" }).error?.issues.map((i) => i.code)).toEqual(["custom"]);
    const broken = ArgumentPredicateSchema.safeParse({ type: "object", properties: { command: { $ref: "#/nowhere" } } });
    expect(broken.error?.issues.map((i) => [i.code, i.message])).toEqual([["custom", "an argument predicate must compile: Reference not found: #/nowhere"]]);
  });

  it("PG1.54 a predicate accepts exactly the arguments its schema does, and asking again gives the same answer", () => {
    const tests = ArgumentPredicateSchema.parse({ type: "object", properties: { command: { type: "string", pattern: "^npm test" } }, required: ["command"] });
    expect([{ command: "npm test -w x" }, { command: "npm test", cwd: "/" }, { command: "ls" }, {}, "npm test", null].map((a) => acceptsArguments(tests, a))).toEqual([true, true, false, false, false, false]);
    expect(acceptsArguments(tests, { command: "npm test" })).toBe(true);
    expect(acceptsArguments(tests, { command: "rm" })).toBe(false);
  });
});

describe("parsing graphs", () => {
  it("PG1.9 a valid document parses to a ProceduralGraph with the same content, and cycles are allowed by default", () => {
    const g = ok(hotpot());
    expect(g).toEqual(hotpot());
    // A graph is shared by every session pinned to it, so parsing freezes it.
    expect([g, g.nodes, g.nodes[1], g.nodes[1]?.binding, g.edges, g.edges[0], g.nodeTypes, g.relations].every((x) => Object.isFrozen(x))).toBe(true);
    const cyclic = hotpot();
    cyclic.edges.push(edge("Scan_Index", "First_Hop_Retrieve"));
    expect(ok(cyclic).edges).toHaveLength(5);
    expect(ok({ ...hotpot(), $schema: "../data/graph.schema.json" }).$schema).toBe("../data/graph.schema.json");
  });

  it("PG1.10 a document that is not well formed is malformed, with where", () => {
    const malformed = (input: unknown) => {
      const r = parseGraph(input);
      return r.ok ? [] : r.diagnostics.map((d) => [d.code, d.at]);
    };
    expect(malformed(null)).toEqual([["malformed", undefined]]);
    expect(malformed({ ...hotpot(), format: "harness.procedural-graph/v2" })).toEqual([["malformed", "format"]]);
    expect(malformed({ ...hotpot(), extra: 1 })).toEqual([["malformed", undefined]]);
    const badNode = hotpot();
    badNode.nodes[2]!.id = "2nd";
    expect(malformed(badNode)).toEqual([["malformed", "nodes[2].id"]]);
    const badEdge = hotpot();
    (badEdge.edges[1] as { condition: unknown }).condition = undefined;
    expect(malformed(badEdge)).toEqual([["malformed", "edges[1].condition"]]);
    const r = parseGraph(badNode);
    expect(!r.ok && r.diagnostics[0]!.message.length).toBeGreaterThan(0);
  });

  it("PG1.11 node ids are unique", () => {
    expect(diagnostics((d) => d.nodes.push({ id: "Scan_Index", type: "REASONING", description: "again" }))).toEqual([
      { code: "duplicate-node", message: "node Scan_Index is defined more than once", at: "nodes[5].id" },
    ]);
  });

  it("PG1.12 node types and relations are in the document's vocabularies", () => {
    expect(diagnostics((d) => (d.nodes[3]!.type = "PLAN"))).toEqual([{ code: "unknown-type", message: "node Bridge_Extract has type PLAN, which is not in nodeTypes", at: "nodes[3].type" }]);
    expect(diagnostics((d) => (d.edges[2]!.relation = "CALLS"))).toEqual([{ code: "unknown-relation", message: "edge Scan_Index → Bridge_Extract has relation CALLS, which is not in relations", at: "edges[2].relation" }]);
    // The vocabulary is the document's own.
    expect(diagnostics((d) => ((d.nodeTypes = [...d.nodeTypes, "PLAN"]), (d.nodes[3]!.type = "PLAN")))).toEqual([]);
    expect(diagnostics((d) => (d.nodeTypes = ["ACTION", "STATUS"])).map((x) => x.code)).toEqual(["unknown-type"]);
  });

  it("PG1.13 every edge names nodes that exist", () => {
    expect(diagnostics((d) => d.edges.push(edge("Ghost", "End")))).toEqual([{ code: "missing-endpoint", message: "edge 4 starts at Ghost, which is not a node", at: "edges[4].from" }]);
    expect(diagnostics((d) => d.edges.push(edge("Start", "Nowhere")))).toEqual([{ code: "missing-endpoint", message: "edge 4 ends at Nowhere, which is not a node", at: "edges[4].to" }]);
    // A dangling edge is only that: it does not count as a way out of its source.
    expect(
      diagnostics((d) => {
        d.nodes.push({ id: "Dangling", type: "STATUS", description: "" });
        d.edges.push(edge("Dangling", "Nowhere"));
      }).map((x) => x.code),
    ).toEqual(["missing-endpoint"]);
  });

  it("PG1.14 there is a Start node", () => {
    const d = diagnostics((doc) => {
      doc.nodes[0]!.id = "Begin";
      doc.edges[0]!.from = "Begin";
    });
    expect(d).toEqual([{ code: "missing-start", message: "there is no Start node", at: "nodes" }]);
  });

  it("PG1.15 every node reaches some node with no outgoing edges, not necessarily End", () => {
    // Start → First_Hop_Retrieve ⇄ Scan_Index loops forever: neither reaches a terminal (and so neither does Start).
    const stuck = diagnostics((d) => (d.edges[2] = edge("Scan_Index", "First_Hop_Retrieve")));
    expect(stuck).toEqual([
      { code: "no-terminal", message: "node Start has no path to a terminal node (one with no outgoing edges)", at: "nodes[0]" },
      { code: "no-terminal", message: "node First_Hop_Retrieve has no path to a terminal node (one with no outgoing edges)", at: "nodes[1]" },
      { code: "no-terminal", message: "node Scan_Index has no path to a terminal node (one with no outgoing edges)", at: "nodes[2]" },
    ]);
    // Any sink will do: Bridge_Extract is a terminal once End is gone, and an isolated node is its own terminal.
    expect(
      diagnostics((d) => {
        d.nodes.pop();
        d.edges.pop();
        d.nodes.push({ id: "Aside", type: "REASONING", description: "unused" });
      }),
    ).toEqual([]);
    // A cycle with an exit is fine.
    expect(diagnostics((d) => d.edges.push(edge("Scan_Index", "First_Hop_Retrieve")))).toEqual([]);
  });

  it("PG1.16 under the forbidden cycle policy, every cycle is reported once, self-loops included", () => {
    expect(diagnostics((d) => d.edges.push(edge("Scan_Index", "First_Hop_Retrieve")), "forbidden")).toEqual([
      { code: "cycle", message: "cycle through First_Hop_Retrieve, Scan_Index", at: "nodes[1]" },
    ]);
    expect(
      diagnostics((d) => {
        d.edges.push(edge("Bridge_Extract", "Bridge_Extract"));
        d.edges.push(edge("Bridge_Extract", "Scan_Index"));
        d.edges.push(edge("Start", "Start"));
      }, "forbidden"),
    ).toEqual([
      { code: "cycle", message: "cycle through Start", at: "nodes[0]" },
      { code: "cycle", message: "cycle through Scan_Index, Bridge_Extract", at: "nodes[2]" },
    ]);
    expect(diagnostics(() => undefined, "forbidden")).toEqual([]);
    expect(ok(hotpot(), "forbidden")).toEqual(hotpot());
  });

  it("PG1.17 checkGraph reports every problem at once, grouped in a fixed order of checks", () => {
    const d = hotpot();
    d.nodes.push({ id: "End", type: "STATUS", description: "again" });
    d.nodes[1]!.type = "TOOL";
    d.edges[0]!.relation = "NEXT";
    d.edges.push(edge("Ghost", "End"));
    d.nodes[0]!.id = "Begin";
    d.edges.push(edge("Scan_Index", "Scan_Index"));
    const shape = CandidateDocumentSchema.parse(d);
    const all = checkGraph(shape, "forbidden").map((x) => x.code);
    expect(all).toEqual(["duplicate-node", "unknown-type", "unknown-relation", "missing-endpoint", "missing-endpoint", "missing-start", "cycle"]);
    expect(checkGraph(shape, "allowed").map((x) => x.code)).toEqual(all.slice(0, -1));
  });

  it("PG1.18 ProceduralGraphSchema refuses what checkGraph refuses (under allowed cycles), naming the code and where", () => {
    const d = hotpot();
    d.edges.push(edge("Start", "Nowhere"));
    const r = ProceduralGraphSchema.safeParse(d);
    expect(r.success).toBe(false);
    expect(r.error?.issues).toEqual([expect.objectContaining({ code: "custom", message: "missing-endpoint: edge 4 ends at Nowhere, which is not a node", path: ["edges", 4, "to"] })]);
    const cyclic = hotpot();
    cyclic.edges.push(edge("Scan_Index", "First_Hop_Retrieve"));
    expect(ProceduralGraphSchema.safeParse(cyclic).success).toBe(true);
    const noStart = hotpot();
    noStart.nodes[0]!.id = "Begin";
    noStart.edges[0]!.from = "Begin";
    expect(ProceduralGraphSchema.safeParse(noStart).error?.issues[0]?.path).toEqual(["nodes"]);
  });

  it("PG1.19 the JSON Schema for graph files is generated from the parser (data/graph.schema.json)", async () => {
    await expect(`${JSON.stringify(graphJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/graph.schema.json");
    const schema = JSON.parse(readFileSync(new URL("../data/graph.schema.json", import.meta.url), "utf8")) as { required: string[]; additionalProperties: boolean };
    expect(schema.required).toEqual(["format", "nodeTypes", "relations", "nodes", "edges"]);
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("the seed, revision ids and lookups", () => {
  it("PG1.20 the seed is the paper's scratch skeleton Start → End", () => {
    const g = seedGraph();
    expect(g).toEqual({
      format: "harness.procedural-graph/v1",
      nodeTypes: ["ACTION", "REASONING", "STATUS"],
      relations: ["LEADS_TO", "TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO"],
      nodes: [
        { id: "Start", type: "STATUS", description: expect.any(String) },
        { id: "End", type: "STATUS", description: expect.any(String) },
      ],
      edges: [{ from: "Start", relation: "LEADS_TO", to: "End", condition: null, guidance: "", pitfalls: "" }],
    });
    expect(parseGraph(g, "forbidden").ok).toBe(true);
    expect(g.nodes.every((n) => n.description.length > 0)).toBe(true);
  });

  it("PG1.21 a revision id is the sha256 of the canonical JSON of the sorted document, without $schema", () => {
    const d = CandidateDocumentSchema.parse({ ...hotpot(), $schema: "x" });
    const sorted = {
      format: d.format,
      nodeTypes: [...d.nodeTypes].sort(),
      relations: [...d.relations].sort(),
      nodes: [...d.nodes].sort((a, b) => (a.id < b.id ? -1 : 1)),
      edges: [...d.edges].sort((a, b) => (`${a.from} ${a.relation} ${a.to}` < `${b.from} ${b.relation} ${b.to}` ? -1 : 1)),
    };
    expect(revisionId(d)).toBe(sha256Hex(canonicalJson(sorted)));
    expect(RevisionIdSchema.safeParse(revisionId(d)).success).toBe(true);
    expect(revisionId(seedGraph())).toBe(revisionId(seedGraph()));
    expect(revisionId(seedGraph())).not.toBe(revisionId(d));
  });

  it("PG1.22 edges sort by from, then relation, then to, then content; nodes by id, then content", () => {
    const base = CandidateDocumentSchema.parse(hotpot());
    const withEdges = (edges: DocInput["edges"]) => revisionId(CandidateDocumentSchema.parse({ ...hotpot(), edges }));
    const a = edge("Start", "End", "LEADS_TO");
    const b = edge("Start", "End", "TRIGGERS");
    const c = edge("Start", "Bridge_Extract", "TRIGGERS");
    const a2 = { ...a, guidance: "other" };
    expect(withEdges([a, b, c, a2])).toBe(withEdges([a2, c, b, a]));
    expect(withEdges([a, b])).not.toBe(withEdges([a, a2]));
    // Exact duplicates (a candidate may hold them) are counted, wherever they are.
    expect(withEdges([a, b, a])).toBe(withEdges([a, a, b]));
    expect(withEdges([a, b, a])).not.toBe(withEdges([a, b]));
    const dup = { id: "Start", type: "ACTION", description: "twin" };
    const withNodes = (nodes: DocInput["nodes"]) => revisionId(CandidateDocumentSchema.parse({ ...hotpot(), nodes }));
    expect(withNodes([...hotpot().nodes, dup])).toBe(withNodes([dup, ...hotpot().nodes.reverse()]));
    expect(revisionId(base)).toBe(revisionId({ ...base, nodes: [...base.nodes].reverse(), edges: [...base.edges].reverse() }));
    // Field by field: a name that is a prefix of another sorts first, whatever follows it.
    const n = (id: string) => ({ id, type: "STATUS", description: "" });
    const prefixed = CandidateDocumentSchema.parse({ ...hotpot(), nodes: [n("Ab"), n("A")], edges: [edge("Ab", "A", "LEADS"), edge("A", "Ab", "LEADS_TO"), edge("A", "Ab", "LEADS")] });
    const expected = { ...prefixed, $schema: undefined, nodeTypes: [...prefixed.nodeTypes].sort(), relations: [...prefixed.relations].sort(), nodes: [n("A"), n("Ab")], edges: [edge("A", "Ab", "LEADS"), edge("A", "Ab", "LEADS_TO"), edge("Ab", "A", "LEADS")] };
    expect(revisionId(prefixed)).toBe(sha256Hex(canonicalJson(expected)));
  });

  it("PG1.23 outgoing and incoming return edges in document order, and nodeById finds a node", () => {
    const d = hotpot();
    d.edges.push(edge("Start", "Scan_Index", "TRIGGERS"), edge("First_Hop_Retrieve", "Scan_Index", "PROVIDES_INPUT_FOR"));
    const g = ok(d);
    expect(outgoing(g, "Start").map((e) => e.to)).toEqual(["First_Hop_Retrieve", "Scan_Index"]);
    expect(incoming(g, "Scan_Index").map((e) => [e.from, e.relation])).toEqual([
      ["First_Hop_Retrieve", "LEADS_TO"],
      ["Start", "TRIGGERS"],
      ["First_Hop_Retrieve", "PROVIDES_INPUT_FOR"],
    ]);
    expect(outgoing(g, "End")).toEqual([]);
    expect(incoming(g, "Start")).toEqual([]);
    expect(nodeById(g, "Bridge_Extract")?.type).toBe("REASONING");
    expect(nodeById(g, "Nope")).toBeUndefined();
  });

  it("PG1.24 a CandidateDocument has no cross-field checks, so a failing candidate can be stored with its diagnostics", () => {
    const d = hotpot();
    d.edges.push(edge("Start", "Nowhere"));
    d.nodes[0]!.type = "WHATEVER";
    const doc: CandidateDocument = CandidateDocumentSchema.parse(d);
    expect(doc.edges).toHaveLength(5);
  });
});

describe("edit sets and revision records", () => {
  const paperEdits = {
    add_nodes: [{ id: "Scan_Index", type: "ACTION", description: "Scan passages." }],
    delete_nodes: ["Old_Step"],
    add_edges: [{ source: "Start", target: "Scan_Index", relation: "LEADS_TO", condition: null, guidance: "Scan first.", pitfalls: "Do not guess." }],
    delete_edges: [{ source: "Start", target: "End" }],
  };

  it("PG1.25 an edit set is the paper's refiner output exactly; missing lists are empty and nothing else is allowed", () => {
    expect(EditSetSchema.parse(paperEdits)).toEqual(paperEdits);
    expect(EditSetSchema.parse({})).toEqual({ add_nodes: [], delete_nodes: [], add_edges: [], delete_edges: [] });
    const refused = [
      { ...paperEdits, rename: [] },
      { add_nodes: [{ id: "X", type: "ACTION", description: "x", binding: { kind: "tool", name: "t" } }] },
      { add_edges: [{ source: "A", target: "B", relation: "LEADS_TO", guidance: "g", pitfalls: "p" }] },
      { add_edges: [{ source: "A", target: "B", relation: "leads to", condition: null, guidance: "g", pitfalls: "p" }] },
      { delete_edges: [{ source: "A", target: "B", relation: "LEADS_TO" }] },
      { delete_nodes: ["not a name"] },
    ];
    expect(refused.map((e) => EditSetSchema.safeParse(e).success)).toEqual(refused.map(() => false));
  });

  it("PG1.26 the refiner's constraint requires all four lists, allows nothing else and lets a condition be null", () => {
    const schema = editSetJsonSchema() as {
      required: string[];
      additionalProperties: boolean;
      properties: { add_edges: { items: { required: string[]; additionalProperties: boolean; properties: { condition: unknown } } } };
    };
    expect(schema.required).toEqual(["add_nodes", "delete_nodes", "add_edges", "delete_edges"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.add_edges.items.required).toEqual(["source", "target", "relation", "condition", "guidance", "pitfalls"]);
    expect(schema.properties.add_edges.items.additionalProperties).toBe(false);
    expect(schema.properties.add_edges.items.properties.condition).toEqual({ type: ["string", "null"] });
  });

  const record = () => {
    const document = CandidateDocumentSchema.parse(hotpot());
    return { id: revisionId(document), graph: "repo/harness", parents: [revisionId(seedGraph())], document, edits: paperEdits, origin: "dream", dream: "d1", evidence: { score: 0.5 }, decision: { kind: "head" }, at: 1_700_000_000_000 };
  };

  it("PG1.27 a revision record names its graph, parents, document, edits, origin, evidence, decision and time", () => {
    const r = RevisionRecordSchema.parse(record());
    expect(r.id).toBe(revisionId(r.document));
    expect(r.edits?.add_nodes).toHaveLength(1);
    const decisions = [
      { kind: "head" },
      { kind: "rejected-structure", diagnostics: [{ code: "missing-start", message: "there is no Start node", at: "nodes" }] },
      { kind: "rejected-gate", gate: "evaluator-at-least-retained", reason: "0.4 < 0.5" },
      { kind: "pending-approval" },
    ];
    expect(decisions.map((decision) => RevisionRecordSchema.safeParse({ ...record(), decision }).success)).toEqual([true, true, true, true]);
    for (const origin of ["seed", "dream", "merge", "revert", "import"]) expect(RevisionRecordSchema.safeParse({ ...record(), origin }).success).toBe(true);
    const { dream: _dream, ...seed } = record();
    expect(RevisionRecordSchema.safeParse({ ...seed, origin: "seed", edits: null, parents: [] }).success).toBe(true);
  });

  it("PG1.28 a revision record's id is its document's revision id, unless the record was redacted", () => {
    const refused = [
      { ...record(), id: revisionId(seedGraph()) },
      { ...record(), origin: "live" },
      { ...record(), decision: { kind: "rejected-structure", diagnostics: [{ code: "bad", message: "x" }] } },
      { ...record(), decision: { kind: "rejected-gate", gate: "", reason: "x" } },
      { ...record(), decision: { kind: "accepted" } },
      { ...record(), at: -1 },
      { ...record(), at: 1.5 },
      { ...record(), redacted: false },
      { ...record(), graph: "Not A Graph" },
      { ...record(), extra: 1 },
    ];
    expect(refused.map((r) => RevisionRecordSchema.safeParse(r).success)).toEqual(refused.map(() => false));
    const wrong = RevisionRecordSchema.safeParse({ ...record(), id: revisionId(seedGraph()) });
    expect(wrong.error?.issues[0]).toEqual(expect.objectContaining({ message: "the id is not the revision id of the document", path: ["id"] }));
    expect(RevisionRecordSchema.safeParse({ ...record(), id: revisionId(seedGraph()), redacted: true }).success).toBe(true);
  });
});
