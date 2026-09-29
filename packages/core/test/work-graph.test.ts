import { describe, expect, it } from "vitest";
import { TaskGraph } from "@harness/core";

function run(g: TaskGraph, id: string): void {
  const started = g.start(id);
  if (!started.ok) throw new Error(`start ${id}: ${started.error.code}`);
  const completed = g.complete(id, "succeeded");
  if (!completed.ok) throw new Error(`complete ${id}: ${completed.error.code}`);
}

describe("TaskGraph atomic work", () => {
  it("WG1.1 two independent tasks are ready together, and a dependent stays pending until both succeed", () => {
    const g = new TaskGraph();
    g.addNode("write-notes");
    g.addNode("name-button");
    g.addNode("publish");
    g.addEdge("write-notes", "publish", "data");
    g.addEdge("name-button", "publish", "data");

    expect(g.status("write-notes")).toBe("pending");
    expect(g.status("name-button")).toBe("pending");
    expect(g.status("publish")).toBe("pending");
    expect(g.ready().sort()).toEqual(["name-button", "write-notes"]);

    run(g, "write-notes");
    expect(g.status("publish")).toBe("pending");
    expect(g.ready()).toEqual(["name-button"]);

    run(g, "name-button");
    expect(g.status("publish")).toBe("pending");
    expect(g.ready()).toEqual(["publish"]);
  });

  it("WG1.2 adding a cycle is refused", () => {
    const g = new TaskGraph();
    g.addNode("write-notes");
    g.addNode("publish");
    expect(g.addEdge("write-notes", "publish", "control").ok).toBe(true);
    const cycle = g.addEdge("publish", "write-notes", "control");
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.error.code).toBe("cycle");
    expect(g.ready()).toEqual(["write-notes"]);
  });
});
