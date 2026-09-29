import { describe, expect, it } from "vitest";
import { TaskGraph } from "@harness/core";

function run(g: TaskGraph, id: string): void {
  const started = g.start(id);
  if (!started.ok) throw new Error(`start ${id}: ${started.error.code}`);
  const completed = g.complete(id, "succeeded");
  if (!completed.ok) throw new Error(`complete ${id}: ${completed.error.code}`);
}

describe("TaskGraph branch elicitation", () => {
  it("EL1.1 a decision blocks only the branch that requires it", () => {
    const g = new TaskGraph();
    g.addNode("needs", { decision: "which-target" });
    g.addNode("after-needs");
    g.addEdge("needs", "after-needs", "data");
    g.addNode("free");
    g.addNode("after-free");
    g.addEdge("free", "after-free", "data");

    expect(g.blocked()).toEqual(["needs"]);
    expect(g.ready()).toEqual(["free"]);
    expect(g.status("needs")).toBe("pending");
    expect(g.status("after-needs")).toBe("pending");
    expect(g.start("needs").ok).toBe(false);

    run(g, "free");
    expect(g.ready()).toEqual(["after-free"]);
    run(g, "after-free");
    expect(g.status("free")).toBe("succeeded");
    expect(g.status("after-free")).toBe("succeeded");
    expect(g.blocked()).toEqual(["needs"]);
    expect(g.ready()).toEqual([]);

    expect(g.answer("needs", "production").ok).toBe(true);
    expect(g.blocked()).toEqual([]);
    expect(g.ready()).toEqual(["needs"]);
    expect(g.status("free")).toBe("succeeded");
    expect(g.status("after-free")).toBe("succeeded");
    expect(g.status("after-needs")).toBe("pending");

    run(g, "needs");
    expect(g.ready()).toEqual(["after-needs"]);
    expect(g.status("after-free")).toBe("succeeded");
    run(g, "after-needs");
    expect(g.status("needs")).toBe("succeeded");
    expect(g.status("after-needs")).toBe("succeeded");
  });

  it("EL1.2 a decision does not block a node until its predecessors have succeeded", () => {
    const g = new TaskGraph();
    g.addNode("prep");
    g.addNode("gated", { decision: "which-target" });
    g.addEdge("prep", "gated", "data");
    expect(g.blocked()).toEqual([]);
    expect(g.ready()).toEqual(["prep"]);
    run(g, "prep");
    expect(g.blocked()).toEqual(["gated"]);
    expect(g.ready()).toEqual([]);
  });

  it("EL1.3 answering a node with no decision, twice, or an unknown node is refused", () => {
    const g = new TaskGraph();
    g.addNode("free");
    g.addNode("needs", { decision: "which-target" });
    const missing = g.answer("missing", "production");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("unknown_node");
    const none = g.answer("free", "production");
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error.code).toBe("no_decision");
    expect(g.answer("needs", "production").ok).toBe(true);
    const again = g.answer("needs", "staging");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("already_answered");
    expect(g.toJSON().nodes.find((node) => node.id === "needs")?.answer).toBe("production");
  });

  it("EL1.4 a restored graph keeps the decision and its answer", () => {
    const g = new TaskGraph();
    g.addNode("needs", { decision: "which-target" });
    g.addNode("free");
    expect(g.answer("needs", "production").ok).toBe(true);
    run(g, "needs");
    const restored = TaskGraph.fromJSON(g.toJSON());
    expect(restored.toJSON()).toEqual(g.toJSON());
    expect(restored.status("needs")).toBe("succeeded");
    expect(restored.blocked()).toEqual([]);
    expect(restored.status("free")).toBe("pending");
    expect(restored.ready()).toEqual(["free"]);
    const needs = restored.toJSON().nodes.find((node) => node.id === "needs");
    expect(needs).toMatchObject({ decision: "which-target", answer: "production", status: "succeeded" });
  });

  it("EL1.5 a started node whose decision was never answered is refused on restore", () => {
    const g = new TaskGraph();
    g.addNode("needs", { decision: "which-target" });
    const data = g.toJSON();
    const node = data.nodes[0];
    if (node === undefined) throw new Error("missing node");
    const running = { ...data, nodes: [{ ...node, status: "running" as const }] };
    expect(() => TaskGraph.fromJSON(running)).toThrow("was never ready");
  });

  it("EL1.6 a decision or answer that is not a string is refused", () => {
    const base = { id: "needs", join: { kind: "all" as const }, resources: [], awaits: [], status: "pending" as const, sealed: false };
    expect(() => TaskGraph.fromJSON({ nodes: [{ ...base, decision: 1 }], edges: [] })).toThrow("invalid decision");
    expect(() => TaskGraph.fromJSON({ nodes: [{ ...base, decision: "which-target", answer: 1 }], edges: [] })).toThrow("invalid answer");
    expect(() => TaskGraph.fromJSON({ nodes: [{ ...base, answer: "production" }], edges: [] })).toThrow("invalid answer");
  });

  it("EL1.7 a decision does not block a node until the group it awaits is sealed", () => {
    const graph = new TaskGraph();
    expect(graph.addNode("group").ok).toBe(true);
    expect(graph.addNode("ship", { decision: "Ship the button?", awaits: ["group"] }).ok).toBe(true);
    expect(graph.blocked()).toEqual([]);
    expect(graph.ready()).toEqual(["group"]);
    expect(graph.seal("group").ok).toBe(true);
    expect(graph.blocked()).toEqual(["ship"]);
    expect(graph.ready()).toEqual(["group"]);
  });
});
