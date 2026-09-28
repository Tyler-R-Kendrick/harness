import { describe, expect, it } from "vitest";
import type { TaskGraph } from "@harness/core";
import { coreView, DiagnosticSchema, effectiveGraph, foldAll, OverlayEventSchema, parseGraph, parsePlan, PLAN_RELATIONS, planFromSubgraph, PlanPayloadSchema, revisionId } from "@harness/procedural";
import type { EffectiveGraph, PlanPayload } from "@harness/procedural";
import { chainDoc } from "./compose-fixtures.ts";
import { edge, hotpot } from "./fixtures.ts";
import type { DocInput } from "./fixtures.ts";

const view = (doc: DocInput): EffectiveGraph => {
  const parsed = parseGraph(doc);
  if (!parsed.ok) throw new Error(`fixture: ${parsed.diagnostics.map((d) => d.message).join("; ")}`);
  return coreView(parsed.graph);
};

const doc = (nodes: [string, string][], edges: DocInput["edges"]): DocInput => ({
  ...hotpot(),
  nodes: nodes.map(([id, type]) => ({ id, type, description: `${id}.` })),
  edges,
});

/** The plan's tasks and dependencies, for comparing. */
function shape(plan: TaskGraph<PlanPayload>) {
  const data = plan.toJSON();
  return { tasks: data.nodes.map((n) => n.id), edges: data.edges.map((e) => `${e.from} -${e.kind}-> ${e.to}`) };
}

function planned(g: EffectiveGraph, from: string, to: string, options?: Parameters<typeof planFromSubgraph>[3]): TaskGraph<PlanPayload> {
  const result = planFromSubgraph(g, from, to, options);
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("; "));
  return result.plan;
}

describe("plans from subgraphs (planFromSubgraph)", () => {
  it("PC1.35 the paper's HotpotQA excerpt plans its two tool steps in order; the payload holds the node and its binding", () => {
    const plan = planned(view(hotpot()), "Start", "End");
    expect(shape(plan)).toEqual({ tasks: ["First_Hop_Retrieve", "Scan_Index"], edges: ["First_Hop_Retrieve -control-> Scan_Index"] });
    expect(plan.payload("First_Hop_Retrieve")).toStrictEqual({
      node: { id: "First_Hop_Retrieve", type: "ACTION", description: "Execute first_hop_retrieve to fetch primary evidence passages." },
      binding: { kind: "tool", name: "first_hop_retrieve" },
    });
    expect(plan.payload("Scan_Index")).toStrictEqual({ node: { id: "Scan_Index", type: "ACTION", description: "Scan the retrieved passages." }, binding: null });
    expect(plan.ready()).toEqual(["First_Hop_Retrieve"]);
  });

  it("PC1.36 the scratch skeleton (Start → End) plans no tasks", () => {
    const skeleton = doc([["Start", "STATUS"], ["End", "STATUS"]], [edge("Start", "End")]);
    expect(shape(planned(view(skeleton), "Start", "End"))).toEqual({ tasks: [], edges: [] });
  });

  it("PC1.37 PROVIDES_INPUT_FOR is a data edge, LEADS_TO and TRIGGERS are control edges, and non-action nodes contract away", () => {
    // Start → plan (REASONING) -TRIGGERS→ search; search -PROVIDES_INPUT_FOR→ Fetch_Page → summarize → End, summarize → review → End.
    const plan = planned(view(chainDoc()), "Start", "End");
    expect(shape(plan)).toEqual({
      tasks: ["search", "Fetch_Page", "summarize", "review"],
      edges: ["search -data-> Fetch_Page", "Fetch_Page -control-> summarize", "summarize -control-> review"],
    });
    const triggered = doc(
      [["a", "ACTION"], ["b", "ACTION"], ["c", "ACTION"], ["End", "STATUS"], ["Start", "STATUS"]],
      [edge("Start", "a"), edge("a", "b", "TRIGGERS"), edge("b", "c", "PROVIDES_INPUT_FOR"), edge("c", "End")],
    );
    expect(shape(planned(view(triggered), "Start", "End")).edges).toEqual(["a -control-> b", "b -data-> c"]);
  });

  it("PC1.38 through a reasoning or status node a dependency is data only when every edge on the way is; two ways of different kinds give both, nearest first", () => {
    const through = doc(
      [["Start", "STATUS"], ["a", "ACTION"], ["think", "REASONING"], ["note", "STATUS"], ["b", "ACTION"], ["c", "ACTION"], ["d", "ACTION"], ["End", "STATUS"]],
      [
        edge("Start", "a"),
        edge("a", "think", "PROVIDES_INPUT_FOR"),
        edge("think", "b", "PROVIDES_INPUT_FOR"),
        edge("think", "note", "PROVIDES_INPUT_FOR"),
        edge("note", "c", "LEADS_TO"),
        edge("a", "d", "PROVIDES_INPUT_FOR"),
        edge("a", "d", "LEADS_TO"),
        edge("b", "End"),
        edge("c", "End"),
        edge("d", "End"),
      ],
    );
    expect(shape(planned(view(through), "Start", "End")).edges).toEqual(["a -data-> d", "a -control-> d", "a -data-> b", "a -control-> c"]);
  });

  it("PC1.39 only the subgraph between the two nodes is planned: what `from` does not reach, or what does not reach `to`, is left out", () => {
    const plan = planned(view(chainDoc()), "Fetch_Page", "summarize");
    expect(shape(plan)).toEqual({ tasks: ["Fetch_Page", "summarize"], edges: ["Fetch_Page -control-> summarize"] });
    const single = planned(view(chainDoc()), "search", "search");
    expect(shape(single)).toEqual({ tasks: ["search"], edges: [] });
    // `review` is reached from Fetch_Page but does not lead back to summarize.
    expect(shape(planned(view(chainDoc()), "search", "summarize")).tasks).toEqual(["search", "Fetch_Page", "summarize"]);
  });

  it("PC1.40 a cycle through a task is refused with a cycle diagnostic (the paper allows cycles, a plan runs each task once)", () => {
    const retry = doc(
      [["Start", "STATUS"], ["search", "ACTION"], ["check", "ACTION"], ["End", "STATUS"]],
      [edge("Start", "search"), edge("search", "check", "PROVIDES_INPUT_FOR"), edge("check", "search", "LEADS_TO", "when nothing was found"), edge("check", "End")],
    );
    const result = planFromSubgraph(view(retry), "Start", "End");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostics).toEqual([{ code: "cycle", message: "the plan would hold a cycle between check and search: search already leads to check" }]);
    const self = doc(
      [["Start", "STATUS"], ["search", "ACTION"], ["judge", "REASONING"], ["End", "STATUS"]],
      [edge("Start", "search"), edge("search", "judge"), edge("judge", "search", "LEADS_TO", "when unsure"), edge("judge", "End")],
    );
    expect(planFromSubgraph(view(self), "Start", "End")).toEqual({ ok: false, diagnostics: [{ code: "cycle", message: "the plan would hold a cycle between search and search: search cannot depend on itself" }] });
  });

  it("PC1.41 a loop among reasoning and status nodes alone runs no task twice, so it contracts away", () => {
    const loop = doc(
      [["Start", "STATUS"], ["a", "ACTION"], ["think", "REASONING"], ["doubt", "REASONING"], ["b", "ACTION"], ["End", "STATUS"]],
      [edge("Start", "a"), edge("a", "think"), edge("think", "doubt"), edge("doubt", "think", "LEADS_TO", "when unsure"), edge("doubt", "b"), edge("b", "End")],
    );
    expect(shape(planned(view(loop), "Start", "End"))).toEqual({ tasks: ["a", "b"], edges: ["a -control-> b"] });
  });

  it("PC1.42 unknown endpoints, an unreachable `to` and a relation with no dependency kind are diagnostics", () => {
    const g = view(chainDoc());
    expect(planFromSubgraph(g, "Nowhere", "End")).toEqual({ ok: false, diagnostics: [{ code: "missing-endpoint", message: "node Nowhere is not in the graph", at: "from" }] });
    expect(planFromSubgraph(g, "Start", "Nowhere")).toEqual({ ok: false, diagnostics: [{ code: "missing-endpoint", message: "node Nowhere is not in the graph", at: "to" }] });
    const unreachable = planFromSubgraph(g, "End", "Start");
    expect(unreachable).toEqual({ ok: false, diagnostics: [{ code: "unreachable", message: "Start cannot be reached from End" }] });
    // Plan diagnostics are diagnostics like any other, so a record can keep them.
    expect(!unreachable.ok && DiagnosticSchema.array().parse(unreachable.diagnostics)).toEqual([{ code: "unreachable", message: "Start cannot be reached from End" }]);
    const custom = { ...chainDoc(), relations: [...chainDoc().relations, "ALTERNATIVE_TO"], edges: [...chainDoc().edges, edge("review", "summarize", "ALTERNATIVE_TO")] };
    expect(planFromSubgraph(view(custom), "Start", "End")).toEqual({
      ok: false,
      diagnostics: [{ code: "unknown-relation", message: "relation ALTERNATIVE_TO has no dependency kind for plans", at: "edges[8]" }],
    });
  });

  it("PC1.43 the relation kinds are an option: a relation mapped to null is no dependency, and another kind can be chosen", () => {
    const custom = { ...chainDoc(), relations: [...chainDoc().relations, "ALTERNATIVE_TO"], edges: [...chainDoc().edges, edge("review", "summarize", "ALTERNATIVE_TO")] };
    const relations = { ...PLAN_RELATIONS, ALTERNATIVE_TO: null, TRIGGERS: "assurance" as const };
    expect(shape(planned(view(custom), "Start", "End", { relations })).edges).toEqual(["search -data-> Fetch_Page", "Fetch_Page -control-> summarize", "summarize -control-> review"]);
    expect(PLAN_RELATIONS).toEqual({ PROVIDES_INPUT_FOR: "data", LEADS_TO: "control", TRIGGERS: "control", CONVERGES_TO: "control" });
    const triggered = doc([["Start", "STATUS"], ["a", "ACTION"], ["b", "ACTION"]], [edge("Start", "a"), edge("a", "b", "TRIGGERS")]);
    expect(shape(planned(view(triggered), "Start", "b", { relations })).edges).toEqual(["a -assurance-> b"]);
  });

  it("PC1.44 an effective graph's overlay nodes and edges are planned with the core's", () => {
    const parsed = parseGraph(hotpot());
    if (!parsed.ok) throw new Error("fixture");
    const base = revisionId(parsed.graph);
    const proposed = (entry: unknown) => OverlayEventSchema.parse({ kind: "proposed", entry, source: { sessions: ["s"], by: "stats" } });
    const state = foldAll(base, [
      proposed({ kind: "node", id: "Verify", type: "ACTION", description: "Verify the bridge." }),
      proposed({ kind: "edge", from: "Scan_Index", relation: "LEADS_TO", to: "Verify", condition: null, guidance: "Verify.", pitfalls: "None." }),
      proposed({ kind: "edge", from: "Verify", relation: "LEADS_TO", to: "Bridge_Extract", condition: null, guidance: "Go on.", pitfalls: "None." }),
    ]);
    const g = effectiveGraph(parsed.graph, state, { salt: "s", probationShare: 1 });
    expect(shape(planned(g, "Start", "End"))).toEqual({ tasks: ["First_Hop_Retrieve", "Scan_Index", "Verify"], edges: ["First_Hop_Retrieve -control-> Scan_Index", "Scan_Index -control-> Verify"] });
  });

  it("PC1.45 a plan survives JSON: parsePlan restores it and checks every payload", () => {
    const plan = planned(view(chainDoc()), "Start", "End");
    const data = JSON.parse(JSON.stringify(plan.toJSON())) as ReturnType<typeof plan.toJSON>;
    const restored = parsePlan(data);
    expect(restored.toJSON()).toStrictEqual(plan.toJSON());
    expect(restored.payload("Fetch_Page")).toEqual(PlanPayloadSchema.parse({ node: { id: "Fetch_Page", type: "ACTION", description: "Fetch the best hit." }, binding: { kind: "tool", name: "fetch" } }));
    const broken = { ...data, nodes: data.nodes.map((n) => (n.id === "search" ? { ...n, payload: { node: { id: "search" }, binding: null } } : n)) };
    expect(() => parsePlan(broken)).toThrow(/node search has an invalid payload/);
  });
});
