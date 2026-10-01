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
    // The skip cascades whatever order the nodes were added in.
    const late = new TaskGraph();
    ["after", "j", "a"].forEach((n) => late.addNode(n));
    late.addEdge("a", "j", "data");
    late.addEdge("j", "after", "data");
    expect(run(late, "a", "failed")).toEqual(["j", "after"]);
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
    expect(g.isSealed("fanout")).toBe(false);
    expect(g.seal("fanout").ok).toBe(true);
    expect(g.isSealed("fanout")).toBe(true);
    expect(g.isSealed("ghost")).toBe(false);
    expect(g.parent("ghost")).toBeUndefined();
    expect(g.children("ghost")).toEqual([]);
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
    g.seal("a");
    g.start("a");
    g.complete("a", "succeeded");
    g.addEdge("a", "a", "data");
    expect(g.revision()).toBe(r0 + 4);
  });
});

describe("TaskGraph payloads", () => {
  it("TG5.1 a node carries an opaque payload, returned as given; a node without one has none", () => {
    const g = new TaskGraph<{ tool: string }>();
    const payload = { tool: "search" };
    g.addNode("a", { payload });
    g.addNode("b");
    expect(g.payload("a")).toBe(payload);
    expect(g.payload("b")).toBeUndefined();
    expect(g.payload("ghost")).toBeUndefined();
    expect(g.addNode("a", { payload: { tool: "other" } })).toMatchObject({ ok: false, error: { code: "duplicate_node" } });
    expect(g.payload("a")).toBe(payload);
  });
});

/** A graph mid-execution with every kind of structure: containment, a sealed group, joins, resources, exclusion, payloads. */
function sample(): TaskGraph<{ step: number }> {
  const g = new TaskGraph<{ step: number }>();
  g.addNode("group");
  g.addNode("a", { payload: { step: 1 }, resources: ["db"] });
  g.addNode("b", { join: { kind: "any" } });
  g.addNode("c", { join: { kind: "quorum", count: 1 }, awaits: ["group"], payload: { step: 3 } });
  g.addNode("d");
  g.addNode("e");
  g.addEdge("group", "a", "contains");
  g.addEdge("group", "b", "contains");
  g.addEdge("a", "b", "data");
  g.addEdge("a", "c", "control");
  g.addEdge("b", "c", "assurance");
  g.addEdge("d", "e", "data");
  g.addEdge("a", "d", "exclusion");
  g.seal("group");
  run(g, "a");
  g.start("b");
  g.start("d");
  g.complete("d", "failed");
  return g;
}

const roundTrip = <P>(g: TaskGraph<P>): TaskGraph<P> => TaskGraph.fromJSON<P>(JSON.parse(JSON.stringify(g.toJSON())));

describe("TaskGraph serialization", () => {
  it("TG5.2 toJSON lists nodes in the order added, with their spec, status, sealing and payload, and edges in the order added", () => {
    expect(sample().toJSON()).toStrictEqual({
      nodes: [
        { id: "group", join: { kind: "all" }, resources: [], awaits: [], status: "pending", sealed: true },
        { id: "a", join: { kind: "all" }, resources: ["db"], awaits: [], status: "succeeded", sealed: false, payload: { step: 1 } },
        { id: "b", join: { kind: "any" }, resources: [], awaits: [], status: "running", sealed: false },
        { id: "c", join: { kind: "quorum", count: 1 }, resources: [], awaits: ["group"], status: "pending", sealed: false, payload: { step: 3 } },
        { id: "d", join: { kind: "all" }, resources: [], awaits: [], status: "failed", sealed: false },
        { id: "e", join: { kind: "all" }, resources: [], awaits: [], status: "skipped", sealed: false },
      ],
      edges: [
        { from: "group", to: "a", kind: "contains" },
        { from: "group", to: "b", kind: "contains" },
        { from: "a", to: "b", kind: "data" },
        { from: "a", to: "c", kind: "control" },
        { from: "b", to: "c", kind: "assurance" },
        { from: "d", to: "e", kind: "data" },
        { from: "a", to: "d", kind: "exclusion" },
      ],
    });
  });

  it("TG5.3 fromJSON restores a graph that behaves as the original: statuses, readiness, scheduling, structure, revision and payloads", () => {
    const g = sample();
    const h = roundTrip(g);
    expect(h.toJSON()).toEqual(g.toJSON());
    expect(h.revision()).toBe(g.revision());
    expect(h.ready()).toEqual(g.ready());
    expect(h.ready()).toEqual(["group", "c"]);
    expect(h.children("group")).toEqual(["a", "b"]);
    expect(h.parent("b")).toBe("group");
    expect(h.isSealed("group")).toBe(true);
    expect(h.payload("c")).toEqual({ step: 3 });
    expect(h.addEdge("c", "a", "data")).toMatchObject({ ok: false, error: { code: "target_started" } });
    expect(h.addEdge("a", "group", "contains")).toMatchObject({ ok: false, error: { code: "cycle" } });
    h.addNode("x", { resources: ["db"] });
    h.addNode("y");
    h.addEdge("y", "x", "exclusion");
    expect(h.ready()).toEqual(["group", "c", "x", "y"]);
    expect(h.schedule(5)).toEqual(["group", "c", "x"]);
    expect(h.complete("b", "succeeded")).toEqual({ ok: true, value: [] });
    expect(h.status("b")).toBe("succeeded");
    h.start("y");
    expect(h.schedule(5)).toEqual(["group", "c"]);
  });

  it("TG5.4 fromJSON refuses data that is not a task graph, saying what is wrong", () => {
    const valid = sample().toJSON();
    const bad = (patch: (d: Record<string, unknown>) => void): unknown => {
      const d = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
      patch(d);
      return d;
    };
    const node = (d: Record<string, unknown>, i: number) => (d["nodes"] as Record<string, unknown>[])[i]!;
    const edge = (d: Record<string, unknown>, i: number) => (d["edges"] as Record<string, unknown>[])[i]!;
    const cases: [unknown, RegExp][] = [
      [null, /not an object/],
      ["graph", /not an object/],
      [{ nodes: [] }, /edges is not a list/],
      [{ edges: [] }, /nodes is not a list/],
      [bad((d) => (d["nodes"] = [5])), /node 0 is not an object/],
      [bad((d) => (node(d, 1)["id"] = 7)), /node 1 has no id/],
      [bad((d) => (node(d, 1)["join"] = { kind: "most" })), /node a has an invalid join/],
      [bad((d) => (node(d, 1)["join"] = { kind: "most", count: 2 })), /node a has an invalid join/],
      [bad((d) => (node(d, 1)["join"] = null)), /node a has an invalid join/],
      [bad((d) => (node(d, 1)["join"] = { kind: "quorum", count: "2" })), /node a has an invalid join/],
      [bad((d) => (node(d, 1)["join"] = { kind: "quorum", count: 0 })), /node a has an invalid join/],
      [bad((d) => (node(d, 1)["resources"] = "db")), /node a has invalid resources/],
      [bad((d) => (node(d, 1)["resources"] = [1])), /node a has invalid resources/],
      [bad((d) => (node(d, 3)["awaits"] = [null])), /node c has invalid awaits/],
      [bad((d) => (node(d, 1)["status"] = "done")), /node a has an invalid status/],
      [bad((d) => (node(d, 1)["sealed"] = "no")), /node a has an invalid sealed flag/],
      [bad((d) => (d["edges"] = [null])), /edge 0 is not an object/],
      [bad((d) => (edge(d, 2)["from"] = 1)), /edge 2 has no endpoints/],
      [bad((d) => (edge(d, 2)["to"] = undefined)), /edge 2 has no endpoints/],
      [bad((d) => (edge(d, 2)["kind"] = "blocks")), /edge 2 has an invalid kind/],
    ];
    for (const [data, message] of cases) expect(() => TaskGraph.fromJSON(data), String(message)).toThrow(message);
  });

  it("TG5.5 fromJSON refuses structure the graph itself refuses: duplicates, unknown nodes, cycles, a second parent, an unknown awaited group", () => {
    const n = (id: string, extra: Record<string, unknown> = {}) => ({ id, join: { kind: "all" }, resources: [], awaits: [], status: "pending", sealed: false, ...extra });
    const cases: [unknown, RegExp][] = [
      [{ nodes: [n("a"), n("a")], edges: [] }, /duplicate_node/],
      [{ nodes: [n("a", { awaits: ["g"] }), n("g")], edges: [] }, /unknown_node/],
      [{ nodes: [n("a")], edges: [{ from: "a", to: "ghost", kind: "data" }] }, /unknown_node/],
      [{ nodes: [n("a")], edges: [{ from: "a", to: "a", kind: "control" }] }, /self_edge/],
      [{ nodes: [n("a"), n("b")], edges: [{ from: "a", to: "b", kind: "data" }, { from: "a", to: "b", kind: "data" }] }, /duplicate_edge/],
      [{ nodes: [n("a"), n("b")], edges: [{ from: "a", to: "b", kind: "data" }, { from: "b", to: "a", kind: "control" }] }, /cycle/],
      [{ nodes: [n("p"), n("q"), n("c")], edges: [{ from: "p", to: "c", kind: "contains" }, { from: "q", to: "c", kind: "contains" }] }, /multiple_parents/],
    ];
    for (const [data, message] of cases) expect(() => TaskGraph.fromJSON(data), String(message)).toThrow(message);
  });

  it("TG5.6 fromJSON refuses statuses no execution reaches: a started node whose dependencies or awaited groups were not ready, a skipped node that can still be satisfied", () => {
    const n = (id: string, extra: Record<string, unknown> = {}) => ({ id, join: { kind: "all" }, resources: [], awaits: [], status: "pending", sealed: false, ...extra });
    const dep = [{ from: "a", to: "b", kind: "data" }];
    for (const status of ["running", "awaiting", "succeeded", "failed"]) {
      expect(() => TaskGraph.fromJSON({ nodes: [n("a"), n("b", { status })], edges: dep })).toThrow(/node b is .* but was never ready/);
      expect(() => TaskGraph.fromJSON({ nodes: [n("a", { status: "succeeded" }), n("b", { status })], edges: dep })).not.toThrow();
      expect(() => TaskGraph.fromJSON({ nodes: [n("g"), n("b", { status, awaits: ["g"] })], edges: [] })).toThrow(/node b is .* but was never ready/);
      expect(() => TaskGraph.fromJSON({ nodes: [n("g", { sealed: true }), n("b", { status, awaits: ["g"] })], edges: [] })).not.toThrow();
    }
    expect(() => TaskGraph.fromJSON({ nodes: [n("a"), n("b", { status: "skipped" })], edges: dep })).toThrow(/node b is skipped but can still run/);
    expect(TaskGraph.fromJSON({ nodes: [n("a", { status: "failed" }), n("b", { status: "skipped" })], edges: dep }).status("b")).toBe("skipped");
    expect(TaskGraph.fromJSON({ nodes: [n("a", { status: "failed" }), n("b", { status: "cancelled" })], edges: dep }).status("b")).toBe("cancelled");
    expect(TaskGraph.fromJSON({ nodes: [n("a", { status: "cancelled" }), n("b")], edges: dep }).ready()).toEqual([]);
  });

  it("TG5.7 fromJSON checks each payload with the parser it is given, and keeps payloads as given without one", () => {
    const data = sample().toJSON();
    const step = (raw: unknown): number => {
      const value = (raw as { step?: unknown }).step;
      if (typeof value !== "number") throw new RangeError("not a step");
      return value;
    };
    expect(TaskGraph.fromJSON(data, step).payload("c")).toBe(3);
    expect(TaskGraph.fromJSON(data, step).payload("b")).toBeUndefined();
    expect(TaskGraph.fromJSON(data).payload("a")).toEqual({ step: 1 });
    expect(TaskGraph.fromJSON(data).toJSON()).toStrictEqual(data);
    expect(() => TaskGraph.fromJSON({ ...data, nodes: data.nodes.map((node) => (node.id === "a" ? { ...node, payload: { step: "one" } } : node)) }, step)).toThrow(/node a has an invalid payload: not a step/);
  });

  it("TG7.1 background parks a running node off the scheduler without finishing it, freeing its exclusive resource, and it can finish from there", () => {
    const g = new TaskGraph();
    g.addNode("ask", { resources: ["ear"] });
    g.addNode("next", { resources: ["ear"] });
    g.addNode("after");
    g.addEdge("ask", "after", "control");
    expect(g.background("missing").ok).toBe(false);
    expect(g.background("ask").ok).toBe(false);
    g.start("ask");
    expect(g.schedule(4)).toEqual([]);
    const revision = g.revision();
    expect(g.background("ask")).toEqual({ ok: true, value: undefined });
    expect(g.revision()).toBe(revision);
    expect(g.status("ask")).toBe("awaiting");
    expect(["succeeded", "failed", "cancelled", "skipped"]).not.toContain(g.status("ask"));
    expect(g.ready()).toEqual(["next"]);
    expect(g.schedule(4)).toEqual(["next"]);
    expect(g.status("after")).toBe("pending");
    const parked = TaskGraph.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
    expect(parked.status("ask")).toBe("awaiting");
    expect(parked.ready()).toEqual(["next"]);
    expect(parked.schedule(4)).toEqual(["next"]);
    expect(g.complete("ask", "succeeded").ok).toBe(true);
    expect(g.status("ask")).toBe("succeeded");
    expect(g.ready()).toEqual(["next", "after"]);
  });
});
