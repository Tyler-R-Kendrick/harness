import { describe, expect, it } from "vitest";
import { HookBus, TaskGraph, abandonBranch, completeBranch, intendBranch, recoverBranch } from "@harness/core";
import type { BranchPlan, HookError, HookEvent, PublishInput, Result } from "@harness/core";

const plan: BranchPlan = {
  id: "ship",
  budget: 2,
  paths: [
    { id: "first", nodes: ["a"] },
    { id: "second", nodes: ["b"] },
    { id: "third", nodes: ["c"] },
  ],
};

function graph(ids: readonly string[], edges: readonly [string, string][] = []): TaskGraph {
  const built = new TaskGraph();
  for (const id of ids) built.addNode(id);
  for (const [from, to] of edges) built.addEdge(from, to, "control");
  return built;
}

function types(bus: HookBus, branch = "ship"): string[] {
  return bus.saga(branch).events.map((event) => event.type);
}

class CrashBus extends HookBus {
  constructor() {
    super({ maxDepth: 4 });
  }

  override publish(input: PublishInput, at: number): Result<HookEvent, HookError> {
    super.publish(input, at);
    throw new Error("crash");
  }
}

describe("task-graph branch healing", () => {
  it("TG6.1 a crash after the write-ahead intention leaves the node unstarted", () => {
    const built = graph(["a", "b", "c"]);
    const bus = new CrashBus();
    expect(() => intendBranch(built, bus, plan, "a", 0)).toThrow(/crash/);
    expect(built.status("a")).toBe("pending");
    expect(types(bus)).toEqual(["branch.intention"]);
    expect(bus.saga("ship").events[0]?.payload).toMatchObject({ node: "a", path: "first" });
  });

  it("TG6.2 an open intention is recovered onto a path the trajectory has not named", () => {
    const built = graph(["a", "b", "c"]);
    const bus = new HookBus({ maxDepth: 4 });
    expect(bus.publish({
      type: "branch.intention",
      source: "task-graph",
      correlationId: "ship",
      payload: { node: "a", path: "first" },
    }, 0).ok).toBe(true);
    const recovered = recoverBranch(built, bus, plan, 1);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value.failure).toBe("interrupted");
    expect(recovered.value.avoided).toEqual(["a"]);
    expect(recovered.value.path).toBe("second");
    expect(recovered.value.started).toBe("b");
    expect(built.status("a")).toBe("cancelled");
    expect(built.status("b")).toBe("running");
    expect(built.status("c")).toBe("pending");
    expect(types(bus)).toEqual(["branch.intention", "branch.failure", "branch.correction", "branch.intention"]);
  });

  it("TG6.3 a cancelled branch skips a path the trajectory already failed", () => {
    const built = graph(["a", "b", "c"]);
    const bus = new HookBus({ maxDepth: 4 });
    expect(intendBranch(built, bus, plan, "a", 0).ok).toBe(true);
    expect(bus.publish({
      type: "branch.failure",
      source: "other",
      correlationId: "ship",
      payload: { node: "b", path: "second", failure: "failed" },
    }, 1).ok).toBe(true);
    const abandoned = abandonBranch(built, bus, plan, "a", 2);
    expect(abandoned.ok).toBe(true);
    if (!abandoned.ok) return;
    expect(abandoned.value.started).toBe("c");
    expect(abandoned.value.avoided).toEqual(["a", "b"]);
    expect(built.status("b")).toBe("pending");
    expect(built.status("c")).toBe("running");
  });

  it("TG6.4 an over-budget node is not started and the failure is written ahead of the correction", () => {
    const built = graph(["s1", "s2", "f"], [["s1", "s2"]]);
    const narrow: BranchPlan = {
      id: "ship",
      budget: 1,
      paths: [
        { id: "slow", nodes: ["s1", "s2"] },
        { id: "fast", nodes: ["f"] },
      ],
    };
    const bus = new HookBus({ maxDepth: 4 });
    expect(intendBranch(built, bus, narrow, "s1", 0)).toEqual({ ok: true, value: { status: "started", node: "s1" } });
    expect(completeBranch(built, bus, narrow, "s1", "succeeded", 1)).toEqual({ ok: true, value: { status: "succeeded", node: "s1" } });
    expect(built.status("f")).toBe("pending");
    const stepped = intendBranch(built, bus, narrow, "s2", 2);
    expect(stepped.ok).toBe(true);
    if (!stepped.ok) return;
    expect(stepped.value).toMatchObject({ status: "recovered", failure: "over-budget", path: "fast", started: "f" });
    expect(built.status("s1")).toBe("succeeded");
    expect(built.status("s2")).toBe("cancelled");
    expect(built.status("f")).toBe("running");
    const names = types(bus);
    expect(names.indexOf("branch.failure")).toBeLessThan(names.indexOf("branch.correction"));
    expect(bus.saga("ship").events.find((event) => event.type === "branch.failure")?.payload).toMatchObject({ node: "s2", failure: "over-budget" });
  });

  it("TG6.5 a failed node keeps a succeeded predecessor and attempts another path", () => {
    const built = graph(["s1", "s2", "f"], [["s1", "s2"]]);
    const wide: BranchPlan = {
      id: "ship",
      budget: 5,
      paths: [
        { id: "slow", nodes: ["s1", "s2"] },
        { id: "fast", nodes: ["f"] },
      ],
    };
    const bus = new HookBus({ maxDepth: 4 });
    expect(intendBranch(built, bus, wide, "s1", 0).ok).toBe(true);
    expect(completeBranch(built, bus, wide, "s1", "succeeded", 1).ok).toBe(true);
    expect(intendBranch(built, bus, wide, "s2", 2).ok).toBe(true);
    const failed = completeBranch(built, bus, wide, "s2", "failed", 3);
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value).toMatchObject({ status: "recovered", failure: "failed", started: "f" });
    expect(built.status("s1")).toBe("succeeded");
    expect(built.status("s2")).toBe("failed");
    expect(built.status("f")).toBe("running");
  });

  it("TG6.6 a branch with no unused path attempts nothing", () => {
    const built = graph(["a", "b"]);
    const short: BranchPlan = {
      id: "ship",
      budget: 2,
      paths: [
        { id: "first", nodes: ["a"] },
        { id: "second", nodes: ["b"] },
      ],
    };
    const bus = new HookBus({ maxDepth: 4 });
    expect(intendBranch(built, bus, short, "a", 0).ok).toBe(true);
    expect(bus.publish({
      type: "branch.failure",
      source: "task-graph",
      correlationId: "ship",
      payload: { node: "b", path: "second", failure: "cancelled" },
    }, 1).ok).toBe(true);
    const abandoned = abandonBranch(built, bus, short, "a", 2);
    expect(abandoned.ok).toBe(true);
    if (!abandoned.ok) return;
    expect(abandoned.value.failure).toBe("cancelled");
    expect(abandoned.value.path).toBeUndefined();
    expect(abandoned.value.started).toBeUndefined();
    expect(built.status("a")).toBe("cancelled");
    expect(built.status("b")).toBe("pending");
    expect(types(bus)).not.toContain("branch.correction");
  });

  it("TG6.7 a budget below one, an empty path, or a repeated node is refused before the bus", () => {
    const built = graph(["a", "b"]);
    const bus = new HookBus({ maxDepth: 4 });
    expect(() => intendBranch(built, bus, { id: "ship", budget: 0, paths: [{ id: "first", nodes: ["a"] }] }, "a", 0)).toThrow(/budget/);
    expect(() => intendBranch(built, bus, { id: "ship", budget: 1, paths: [{ id: "first", nodes: [] }] }, "a", 0)).toThrow(/empty/);
    expect(() => intendBranch(built, bus, {
      id: "ship",
      budget: 1,
      paths: [
        { id: "first", nodes: ["a"] },
        { id: "second", nodes: ["a"] },
      ],
    }, "a", 0)).toThrow(/two paths/);
    expect(bus.head()).toBe(0);
    expect(built.status("a")).toBe("pending");
  });
});
