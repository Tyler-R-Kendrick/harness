import { describe, expect, it } from "vitest";
import { TaskGraph } from "@harness/core";

function run(g: TaskGraph, id: string, outcome: "succeeded" | "failed" = "succeeded"): string[] {
  const s = g.start(id);
  if (!s.ok) throw new Error(`start ${id}: ${s.error.code}`);
  const c = g.complete(id, outcome);
  if (!c.ok) throw new Error(`complete ${id}: ${c.error.code}`);
  return c.value;
}

describe("TaskGraph readiness and joins", () => {
  it("TG1.1 a node with no dependencies is ready; a node with an unmet dependency is not", () => {
    const g = new TaskGraph();
    g.addNode("a");
    g.addNode("b");
    g.addEdge("a", "b", "data");
    expect(g.ready()).toEqual(["a"]);
  });

  it("TG1.2 an all-join becomes ready only when every predecessor succeeded", () => {
    const g = new TaskGraph();
    ["a", "b", "j"].forEach((n) => g.addNode(n));
    g.addEdge("a", "j", "data");
    g.addEdge("b", "j", "control");
    run(g, "a");
    expect(g.ready()).toEqual(["b"]);
    run(g, "b");
    expect(g.ready()).toEqual(["j"]);
  });

  it("TG1.3 a failed predecessor skips an all-join and the skip cascades", () => {
    const g = new TaskGraph();
    ["a", "b", "j", "after"].forEach((n) => g.addNode(n));
    g.addEdge("a", "j", "data");
    g.addEdge("b", "j", "data");
    g.addEdge("j", "after", "data");
    expect(run(g, "a", "failed").sort()).toEqual(["after", "j"]);
    expect(g.status("j")).toBe("skipped");
    expect(g.status("after")).toBe("skipped");
    expect(g.ready()).toEqual(["b"]);
  });

  it("TG1.4 an accepted-any join proceeds on the first success and skips only when all fail", () => {
    const g = new TaskGraph();
    ["a", "b", "c"].forEach((n) => g.addNode(n));
    g.addNode("j", { join: { kind: "any" } });
    ["a", "b", "c"].forEach((n) => g.addEdge(n, "j", "data"));
    run(g, "a", "failed");
    expect(g.ready()).not.toContain("j");
    run(g, "b");
    expect(g.ready()).toContain("j");

    const h = new TaskGraph();
    ["a", "b"].forEach((n) => h.addNode(n));
    h.addNode("j", { join: { kind: "any" } });
    h.addEdge("a", "j", "data");
    h.addEdge("b", "j", "data");
    run(h, "a", "failed");
    expect(h.status("j")).toBe("pending");
    expect(run(h, "b", "failed")).toEqual(["j"]);
  });

  it("TG1.5 a quorum join needs k successes and skips once k is unreachable", () => {
    const g = new TaskGraph();
    ["a", "b", "c"].forEach((n) => g.addNode(n));
    g.addNode("q", { join: { kind: "quorum", count: 2 } });
    ["a", "b", "c"].forEach((n) => g.addEdge(n, "q", "assurance"));
    run(g, "a");
    expect(g.ready()).not.toContain("q");
    run(g, "b");
    expect(g.ready()).toContain("q");

    const h = new TaskGraph();
    ["a", "b", "c"].forEach((n) => h.addNode(n));
    h.addNode("q", { join: { kind: "quorum", count: 2 } });
    ["a", "b", "c"].forEach((n) => h.addEdge(n, "q", "data"));
    run(h, "a", "failed");
    expect(h.status("q")).toBe("pending");
    expect(run(h, "b", "failed")).toEqual(["q"]);
  });

  it("TG1.6 parenthood is not a blocker: children of an unfinished parent can run", () => {
    const g = new TaskGraph();
    g.addNode("parent");
    g.addNode("child");
    g.addEdge("parent", "child", "contains");
    expect(g.ready().sort()).toEqual(["child", "parent"]);
    expect(g.parent("child")).toBe("parent");
    expect(g.children("parent")).toEqual(["child"]);
  });

  it("TG1.7 a join awaiting a fan-out group waits for the group to be sealed", () => {
    const g = new TaskGraph();
    g.addNode("fanout");
    g.addNode("w1");
    g.addEdge("fanout", "w1", "contains");
    g.addNode("join", { awaits: ["fanout"] });
    g.addEdge("w1", "join", "data");
    run(g, "w1");
    expect(g.ready()).not.toContain("join");
    g.addNode("w2");
    g.addEdge("fanout", "w2", "contains");
    g.addEdge("w2", "join", "data");
    g.seal("fanout");
    expect(g.ready()).not.toContain("join");
    run(g, "w2");
    expect(g.ready()).toContain("join");
  });

  it("TG1.8 a sealed group accepts no new members", () => {
    const g = new TaskGraph();
    g.addNode("fanout");
    g.addNode("late");
    expect(g.seal("fanout").ok).toBe(true);
    expect(g.isSealed("fanout")).toBe(true);
    expect(g.addEdge("fanout", "late", "contains")).toMatchObject({ ok: false, error: { code: "sealed" } });
  });

  it("TG1.9 awaiting an unknown group is rejected", () => {
    const g = new TaskGraph();
    expect(g.addNode("j", { awaits: ["ghost"] })).toMatchObject({ ok: false, error: { code: "unknown_node" } });
    expect(g.seal("ghost")).toMatchObject({ ok: false, error: { code: "unknown_node" } });
  });
});

describe("TaskGraph structure validation", () => {
  it("TG2.1 dependency cycles are rejected", () => {
    const g = new TaskGraph();
    ["a", "b", "c"].forEach((n) => g.addNode(n));
    g.addEdge("a", "b", "data");
    g.addEdge("b", "c", "control");
    expect(g.addEdge("c", "a", "assurance")).toMatchObject({ ok: false, error: { code: "cycle" } });
    expect(g.addEdge("a", "c", "data").ok).toBe(true);
  });

  it("TG2.2 containment must be a tree", () => {
    const g = new TaskGraph();
    ["a", "b", "c"].forEach((n) => g.addNode(n));
    g.addEdge("a", "b", "contains");
    expect(g.addEdge("c", "b", "contains")).toMatchObject({ ok: false, error: { code: "multiple_parents" } });
    g.addEdge("b", "c", "contains");
    expect(g.addEdge("c", "a", "contains")).toMatchObject({ ok: false, error: { code: "cycle" } });
  });

  it("TG2.3 self edges, duplicate edges, unknown nodes and duplicate nodes are rejected", () => {
    const g = new TaskGraph();
    g.addNode("a");
    g.addNode("b");
    expect(g.addNode("a")).toMatchObject({ ok: false, error: { code: "duplicate_node" } });
    expect(g.addEdge("a", "a", "data")).toMatchObject({ ok: false, error: { code: "self_edge" } });
    expect(g.addEdge("a", "ghost", "data")).toMatchObject({ ok: false, error: { code: "unknown_node" } });
    expect(g.addEdge("ghost", "a", "data")).toMatchObject({ ok: false, error: { code: "unknown_node" } });
    g.addEdge("a", "b", "data");
    expect(g.addEdge("a", "b", "data")).toMatchObject({ ok: false, error: { code: "duplicate_edge" } });
  });

  it("TG2.4 no new prerequisites may be added to a node that has started", () => {
    const g = new TaskGraph();
    g.addNode("a");
    g.addNode("b");
    g.start("b");
    expect(g.addEdge("a", "b", "data")).toMatchObject({ ok: false, error: { code: "target_started" } });
    expect(g.addEdge("a", "b", "exclusion").ok).toBe(true);
  });

  it("TG2.5 a quorum must require at least one success", () => {
    const g = new TaskGraph();
    expect(() => g.addNode("q", { join: { kind: "quorum", count: 0 } })).toThrow(/quorum/);
  });
});

describe("TaskGraph scheduling", () => {
  it("TG3.1 nodes sharing an exclusive resource never run together", () => {
    const g = new TaskGraph();
    g.addNode("a", { resources: ["port:3000"] });
    g.addNode("b", { resources: ["port:3000"] });
    g.addNode("c", { resources: ["db:test"] });
    expect(g.schedule(10)).toEqual(["a", "c"]);
    g.start("a");
    expect(g.schedule(10)).toEqual(["c"]);
    g.complete("a", "succeeded");
    expect(g.schedule(10)).toEqual(["b", "c"]);
  });

  it("TG3.2 an exclusion edge prevents two nodes running concurrently", () => {
    const g = new TaskGraph();
    g.addNode("a");
    g.addNode("b");
    g.addEdge("a", "b", "exclusion");
    expect(g.schedule(10)).toEqual(["a"]);
    g.start("b");
    expect(g.schedule(10)).toEqual([]);
  });

  it("TG3.3 schedule honours the parallelism limit", () => {
    const g = new TaskGraph();
    ["a", "b", "c"].forEach((n) => g.addNode(n));
    expect(g.schedule(2)).toEqual(["a", "b"]);
    expect(g.schedule(0)).toEqual([]);
  });

  it("TG3.4 start requires readiness and complete requires a running node", () => {
    const g = new TaskGraph();
    g.addNode("a");
    g.addNode("b");
    g.addEdge("a", "b", "data");
    expect(g.start("b")).toMatchObject({ ok: false, error: { code: "not_ready" } });
    expect(g.complete("a", "succeeded")).toMatchObject({ ok: false, error: { code: "not_running" } });
    expect(g.start("ghost")).toMatchObject({ ok: false, error: { code: "unknown_node" } });
    expect(g.complete("ghost", "failed")).toMatchObject({ ok: false, error: { code: "unknown_node" } });
    g.start("a");
    expect(g.start("a")).toMatchObject({ ok: false, error: { code: "not_ready" } });
  });

  it("TG3.5 cancellation stops pending or running work, skips dependents, and never undoes finished work", () => {
    const g = new TaskGraph();
    ["done", "running", "pending", "dependent"].forEach((n) => g.addNode(n));
    g.addEdge("pending", "dependent", "data");
    run(g, "done");
    g.start("running");
    expect(g.cancel("running")).toEqual({ ok: true, value: [] });
    expect(g.cancel("pending")).toEqual({ ok: true, value: ["dependent"] });
    expect(g.status("done")).toBe("succeeded");
    expect(g.status("running")).toBe("cancelled");
    expect(g.cancel("done")).toMatchObject({ ok: false, error: { code: "already_terminal" } });
    expect(g.cancel("ghost")).toMatchObject({ ok: false, error: { code: "unknown_node" } });
    expect(g.status("ghost")).toBeUndefined();
  });

  it("TG3.6 the revision advances on structural changes only", () => {
    const g = new TaskGraph();
    const r0 = g.revision();
    g.addNode("a");
    g.addNode("b");
    g.addEdge("a", "b", "data");
    g.seal("a");
    expect(g.revision()).toBe(r0 + 4);
    g.start("a");
    g.complete("a", "succeeded");
    g.addEdge("a", "a", "data");
    expect(g.revision()).toBe(r0 + 4);
  });
});
