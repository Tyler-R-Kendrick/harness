import { describe, expect, it } from "vitest";
import { coreView, match, neighborhood, NodeNameSchema, parseGraph } from "@harness/procedural";
import type { EffectiveEdge, EffectiveGraph, EffectiveNode } from "@harness/procedural";
import { edge, hotpot } from "./fixtures.ts";
import type { DocInput } from "./fixtures.ts";

const view = (doc: DocInput): EffectiveGraph => {
  const parsed = parseGraph(doc);
  if (!parsed.ok) throw new Error(`fixture: ${parsed.diagnostics.map((d) => d.message).join("; ")}`);
  return coreView(parsed.graph);
};

const graphOf = (nodes: DocInput["nodes"], edges: DocInput["edges"]): DocInput => ({ ...hotpot(), nodes, edges });
const node = (id: string, binding?: { kind: string; name: string; code?: string; content?: string }): DocInput["nodes"][number] =>
  binding === undefined ? { id, type: "ACTION", description: `${id}.` } : { id, type: "ACTION", description: `${id}.`, binding };
const hex = "a".repeat(64);
const name = (n: string) => NodeNameSchema.parse(n);
const pairs = (hop: readonly EffectiveEdge[] | undefined) => (hop ?? []).map((e) => `${e.from}→${e.to}`);

describe("match", () => {
  const g = view(hotpot());

  it("PG3.1 no previous action locates the agent at Start (a₀ = Start)", () => {
    expect(match(undefined, g, "exact")).toBe("Start");
    expect(match(undefined, g, "case-insensitive")).toBe("Start");
  });

  it("PG3.2 exact matches an action equal to a node id", () => {
    expect(match("Scan_Index", g, "exact")).toBe("Scan_Index");
    expect(match("Bridge_Extract", g, "exact")).toBe("Bridge_Extract");
  });

  it("PG3.3 exact matches an action equal to a binding's name, whatever the binding's kind", () => {
    const bound = view(
      graphOf(
        [node("Start"), node("Retrieve", { kind: "tool", name: "first_hop_retrieve" }), node("Plan", { kind: "workflow", name: "plan_trip", code: hex }), node("Style", { kind: "skill", name: "house_style", content: hex }), node("End")],
        [edge("Start", "Retrieve"), edge("Retrieve", "Plan"), edge("Plan", "Style"), edge("Style", "End")],
      ),
    );
    expect(match("first_hop_retrieve", bound, "exact")).toBe("Retrieve");
    expect(match("plan_trip", bound, "exact")).toBe("Plan");
    expect(match("house_style", bound, "exact")).toBe("Style");
  });

  it("PG3.4 exact is the paper's written definition: a different case, a prefix or padding does not match", () => {
    expect(match("scan_index", g, "exact")).toBeUndefined();
    expect(match("SCAN_INDEX", g, "exact")).toBeUndefined();
    expect(match("Scan", g, "exact")).toBeUndefined();
    expect(match(" Scan_Index", g, "exact")).toBeUndefined();
    expect(match("FIRST_HOP_RETRIEVE", g, "exact")).toBeUndefined();
  });

  it("PG3.5 case-insensitive pairs First_Hop_Retrieve with first_hop_retrieve, as the paper's excerpt does, on ids and binding names", () => {
    const unbound = view(graphOf([node("Start"), node("First_Hop_Retrieve"), node("End")], [edge("Start", "First_Hop_Retrieve"), edge("First_Hop_Retrieve", "End")]));
    expect(match("first_hop_retrieve", unbound, "case-insensitive")).toBe("First_Hop_Retrieve");
    expect(match("first_hop_retrieve", unbound, "exact")).toBeUndefined();
    const bound = view(graphOf([node("Start"), node("Retrieve", { kind: "tool", name: "First_Hop" }), node("End")], [edge("Start", "Retrieve"), edge("Retrieve", "End")]));
    expect(match("FIRST_HOP", bound, "case-insensitive")).toBe("Retrieve");
    expect(match("FIRST_HOP", bound, "exact")).toBeUndefined();
  });

  it("PG3.6 nothing matched is undefined, in either mode (the caller falls back to the full graph)", () => {
    expect(match("grep", g, "exact")).toBeUndefined();
    expect(match("grep", g, "case-insensitive")).toBeUndefined();
    expect(match("", g, "case-insensitive")).toBeUndefined();
  });

  it("PG3.7 an exact match wins over a case-insensitive one, and an id over a binding name", () => {
    const g2 = view(
      graphOf(
        [node("Start"), node("scan"), node("Scan"), node("Other", { kind: "tool", name: "Fetch" }), node("Fetch"), node("Late", { kind: "tool", name: "late" }), node("LATE"), node("End")],
        [edge("Start", "scan"), edge("scan", "Scan"), edge("Scan", "Other"), edge("Other", "Fetch"), edge("Fetch", "Late"), edge("Late", "LATE"), edge("LATE", "End")],
      ),
    );
    // "Scan" is exact for the later node even though "scan" comes first case-insensitively.
    expect(match("Scan", g2, "case-insensitive")).toBe("Scan");
    expect(match("scan", g2, "case-insensitive")).toBe("scan");
    // Node Other is bound to the tool "Fetch", but a node named Fetch exists.
    expect(match("Fetch", g2, "exact")).toBe("Fetch");
    expect(match("Fetch", g2, "case-insensitive")).toBe("Fetch");
    // An exact binding match beats a case-insensitive id match.
    expect(match("late", g2, "case-insensitive")).toBe("Late");
    // With no exact candidate, a case-insensitive id beats a case-insensitive binding name; the first in document order wins.
    expect(match("FETCH", g2, "case-insensitive")).toBe("Fetch");
    expect(match("SCAN", g2, "case-insensitive")).toBe("scan");
    expect(match("lAtE", g2, "case-insensitive")).toBe("Late");
  });

  it("PG3.8 match reads the effective graph, so it finds an overlay node", () => {
    const withOverlay: EffectiveGraph = {
      ...g,
      overlay: 3,
      nodes: [...g.nodes, { id: name("Verify"), type: "REASONING", description: "Check.", origin: "overlay", status: "probation" } satisfies EffectiveNode],
    };
    expect(match("Verify", withOverlay, "exact")).toBe("Verify");
    expect(match("Verify", g, "exact")).toBeUndefined();
  });
});

describe("match: state-tracker (plan §5.2)", () => {
  const tests = { type: "object", properties: { command: { type: "string", pattern: "^npm test" } }, required: ["command"] };
  const edits = { type: "object", properties: { path: { type: "string", pattern: "\\.md$" } }, required: ["path"] };
  const bash = (id: string, args?: object): DocInput["nodes"][number] => ({ id, type: "ACTION", description: `${id}.`, binding: args === undefined ? { kind: "tool", name: "Bash" } : { kind: "tool", name: "Bash", arguments: args } });
  // Coarse harness tools: Bash runs tests, docs checks or anything else; a node is also named Edit.
  const g = view(
    graphOf(
      [node("Start"), bash("Shell"), bash("Run_Tests", tests), bash("Check_Docs", edits), node("Edit"), node("Edit_Docs", { kind: "tool", name: "Edit" }), node("End")],
      [edge("Start", "Shell"), edge("Shell", "Run_Tests"), edge("Run_Tests", "Check_Docs"), edge("Check_Docs", "Edit"), edge("Edit", "Edit_Docs"), edge("Edit_Docs", "End")],
    ),
  );

  it("PG3.30 a node the tool's result declares wins over the binding and the id; a declared node the graph lacks is ignored", () => {
    expect(match({ name: "Bash", arguments: { command: "npm test" }, declared: "Check_Docs" }, g, "state-tracker")).toBe("Check_Docs");
    expect(match({ name: "grep", declared: "End" }, g, "state-tracker")).toBe("End");
    expect(match({ name: "Bash", arguments: { command: "npm test" }, declared: "Nowhere" }, g, "state-tracker")).toBe("Run_Tests");
    expect(match({ name: "Edit", declared: "Edit_Docs" }, g, "state-tracker")).toBe("Edit_Docs");
  });

  it("PG3.31 a binding's argument predicate picks among nodes bound to one coarse tool; a node whose predicate rejects the call is not it", () => {
    expect(match({ name: "Bash", arguments: { command: "npm test -w procedural" } }, g, "state-tracker")).toBe("Run_Tests");
    expect(match({ name: "Bash", arguments: { path: "docs/features.md" } }, g, "state-tracker")).toBe("Check_Docs");
    // Nodes with a predicate that holds come before a bare binding, whatever the document order.
    expect(match({ name: "Bash", arguments: { command: "ls" } }, g, "state-tracker")).toBe("Shell");
    expect(match({ name: "Bash" }, g, "state-tracker")).toBe("Shell");
    expect(match("Bash", g, "state-tracker")).toBe("Shell");
    const narrow = view(graphOf([node("Start"), bash("Run_Tests", tests), node("End")], [edge("Start", "Run_Tests"), edge("Run_Tests", "End")]));
    expect(match({ name: "Bash", arguments: { command: "ls" } }, narrow, "state-tracker")).toBeUndefined();
    expect(match({ name: "Bash", arguments: "npm test" }, narrow, "state-tracker")).toBeUndefined();
  });

  it("PG3.32 then the id, exactly: a binding wins over an id, no action is Start and nothing named is undefined", () => {
    // Edit_Docs is bound to the tool Edit, and a node is named Edit: the tracker takes the binding.
    expect(match({ name: "Edit" }, g, "state-tracker")).toBe("Edit_Docs");
    expect(match("Edit", g, "exact")).toBe("Edit");
    expect(match("Run_Tests", g, "state-tracker")).toBe("Run_Tests");
    expect(match(undefined, g, "state-tracker")).toBe("Start");
    expect(match("run_tests", g, "state-tracker")).toBeUndefined();
    expect(match({ name: "grep", arguments: {} }, g, "state-tracker")).toBeUndefined();
  });

  it("PG3.33 the paper's modes read only the action's name: a declared node and the arguments change nothing", () => {
    expect(match({ name: "Bash", arguments: { command: "npm test" }, declared: "Check_Docs" }, g, "exact")).toBe(match("Bash", g, "exact"));
    expect(match({ name: "Bash", arguments: { command: "npm test" } }, g, "exact")).toBe("Shell");
    expect(match({ name: "grep", declared: "End" }, g, "exact")).toBeUndefined();
    expect(match({ name: "edit_docs", declared: "End" }, g, "case-insensitive")).toBe("Edit_Docs");
  });
});

describe("neighborhood", () => {
  it("PG3.9 hop 1 is the active node's outgoing edges in document order, hop 2 the edges leaving what hop 1 reaches", () => {
    const g = view(hotpot());
    const n = neighborhood(g, name("First_Hop_Retrieve"), 2);
    expect(n.active).toBe("First_Hop_Retrieve");
    expect(n.hops.map(pairs)).toEqual([["First_Hop_Retrieve→Scan_Index"], ["Scan_Index→Bridge_Extract"]]);
    expect(n.hops[0]![0]).toBe(g.edges[1]);

    const fan = view(
      graphOf(
        [node("Start"), node("A"), node("B"), node("C"), node("D"), node("End")],
        [edge("Start", "B"), edge("Start", "A"), edge("A", "C"), edge("B", "D"), edge("B", "End"), edge("C", "End"), edge("D", "End")],
      ),
    );
    expect(neighborhood(fan, name("Start"), 2).hops.map(pairs)).toEqual([
      ["Start→B", "Start→A"],
      ["B→D", "B→End", "A→C"],
    ]);
  });

  it("PG3.10 an edge appears once, at the hop that first reaches its source: cycles and diamonds do not repeat it", () => {
    const g = view(
      graphOf(
        [node("Start"), node("A"), node("B"), node("C"), node("D"), node("End")],
        [edge("Start", "A"), edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D"), edge("D", "A"), edge("D", "End")],
      ),
    );
    expect(neighborhood(g, name("A"), 4).hops.map(pairs)).toEqual([["A→B", "A→C"], ["B→D", "C→D"], ["D→A", "D→End"], []]);
    // A cycle away from the active node: A's edges are listed at hop 2, not again at hop 4.
    const away = view(graphOf([node("Start"), node("A"), node("B"), node("End")], [edge("Start", "A"), edge("A", "B"), edge("B", "A"), edge("B", "End")]));
    expect(neighborhood(away, name("Start"), 4).hops.map(pairs)).toEqual([["Start→A"], ["A→B"], ["B→A", "B→End"], []]);
    const loop = view(graphOf([node("Start"), node("End")], [edge("Start", "Start"), edge("Start", "End")]));
    expect(neighborhood(loop, name("Start"), 2).hops.map(pairs)).toEqual([["Start→Start", "Start→End"], []]);
  });

  it("PG3.11 parallel edges between the same endpoints (a multigraph) each appear once", () => {
    const g = view(graphOf([node("Start"), node("A"), node("End")], [edge("Start", "A", "LEADS_TO"), edge("Start", "A", "TRIGGERS"), edge("A", "End")]));
    const n = neighborhood(g, name("Start"), 2);
    expect(n.hops.map((h) => h.map((e) => e.relation))).toEqual([["LEADS_TO", "TRIGGERS"], ["LEADS_TO"]]);
  });

  it("PG3.12 there are exactly `hops` hops, empty past the horizon, and zero hops is the node alone", () => {
    const g = view(hotpot());
    expect(neighborhood(g, name("Bridge_Extract"), 3).hops.map(pairs)).toEqual([["Bridge_Extract→End"], [], []]);
    expect(neighborhood(g, name("End"), 2).hops).toEqual([[], []]);
    expect(neighborhood(g, name("Start"), 0)).toEqual({ active: "Start", hops: [] });
    expect(neighborhood(g, name("Start"), 1).hops.map(pairs)).toEqual([["Start→First_Hop_Retrieve"]]);
  });

  it("PG3.13 a node outside the graph or a hop count that is not a whole number is a RangeError", () => {
    const g = view(hotpot());
    expect(() => neighborhood(g, name("Nowhere"), 2)).toThrow(RangeError);
    expect(() => neighborhood(g, name("Nowhere"), 2)).toThrow("Nowhere");
    expect(() => neighborhood(g, name("Start"), -1)).toThrow(RangeError);
    expect(() => neighborhood(g, name("Start"), 1.5)).toThrow(RangeError);
    expect(() => neighborhood(g, name("Start"), Number.NaN)).toThrow("hops");
  });

  // Research §2.2 item 3 (plan §5.2): under exact matching a reasoning node is never active, so
  // with h = 2 two of them after an action hide the next tool node. Action hops end at ACTION nodes.
  const reasoning = (id: string): DocInput["nodes"][number] => ({ id, type: "REASONING", description: `${id}.` });
  const hidden = () =>
    view(
      graphOf(
        [{ id: "Start", type: "STATUS", description: "Begin." }, node("Retrieve"), reasoning("Scan_Index"), reasoning("Decide_Capital"), node("Answer_Lookup"), node("Verify"), { id: "End", type: "STATUS", description: "Done." }],
        [edge("Start", "Retrieve"), edge("Retrieve", "Scan_Index"), edge("Scan_Index", "Decide_Capital"), edge("Decide_Capital", "Answer_Lookup"), edge("Answer_Lookup", "Verify"), edge("Verify", "End")],
      ),
    );

  it("PG3.28 in action hops, two reasoning nodes after an action no longer hide the next tool: hop 1 runs through them to it", () => {
    const g = hidden();
    expect(neighborhood(g, name("Retrieve"), 2).hops.map(pairs)).toEqual([["Retrieve→Scan_Index"], ["Scan_Index→Decide_Capital"]]);
    expect(neighborhood(g, name("Retrieve"), 2, "edge")).toEqual(neighborhood(g, name("Retrieve"), 2));
    expect(neighborhood(g, name("Retrieve"), 2, "action").hops.map(pairs)).toEqual([["Retrieve→Scan_Index", "Scan_Index→Decide_Capital", "Decide_Capital→Answer_Lookup"], ["Answer_Lookup→Verify"]]);
    // A non-action active node (Start is a status) counts its first action as hop 1 too; a terminal ends a hop.
    expect(neighborhood(g, name("Start"), 3, "action").hops.map(pairs)).toEqual([["Start→Retrieve"], ["Retrieve→Scan_Index", "Scan_Index→Decide_Capital", "Decide_Capital→Answer_Lookup"], ["Answer_Lookup→Verify"]]);
    expect(neighborhood(g, name("Verify"), 2, "action").hops.map(pairs)).toEqual([["Verify→End"], []]);
  });

  it("PG3.29 in action hops an edge still appears once, breadth first, and a cycle among non-action nodes ends", () => {
    const g = view(
      graphOf(
        [node("Start"), reasoning("R1"), reasoning("R2"), node("A"), node("B"), { id: "End", type: "STATUS", description: "Done." }],
        [edge("Start", "R1"), edge("Start", "A"), edge("R1", "R2"), edge("R2", "R1"), edge("R2", "B"), edge("A", "B"), edge("B", "End")],
      ),
    );
    expect(neighborhood(g, name("Start"), 3, "action").hops.map(pairs)).toEqual([["Start→R1", "Start→A", "R1→R2", "R2→R1", "R2→B"], ["A→B", "B→End"], []]);
    expect(neighborhood(g, name("R1"), 1, "action").hops.map(pairs)).toEqual([["R1→R2", "R2→R1", "R2→B"]]);
    expect(neighborhood(g, name("Start"), 0, "action")).toEqual({ active: "Start", hops: [] });
  });
});
