import { describe, expect } from "vitest";
import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { TaskGraph } from "@harness/core";

const dag = fc.integer({ min: 1, max: 12 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    edges: fc.array(fc.tuple(fc.nat(n - 1), fc.nat(n - 1)), { maxLength: 30 }),
    resources: fc.array(fc.subarray(["r1", "r2", "r3"]), { minLength: n, maxLength: n }),
    fails: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
    parallel: fc.integer({ min: 1, max: 4 }),
  }),
);

describe("TaskGraph execution properties", () => {
  test.prop([dag])("TG4.1 execution respects dependencies and resources and always terminates", ({ n, edges, resources, fails, parallel }) => {
    const g = new TaskGraph();
    for (let i = 0; i < n; i++) g.addNode(`n${i}`, { resources: resources[i]! });
    for (const [a, b] of edges) if (a < b) g.addEdge(`n${a}`, `n${b}`, "data"); // forward edges keep it acyclic
    const running = new Set<string>();
    for (let guard = 0; guard < 10 * n + 10; guard++) {
      const batch = g.schedule(parallel - running.size);
      for (const id of batch) {
        const held = [...running].flatMap((r) => resources[Number(r.slice(1))]!);
        expect(resources[Number(id.slice(1))]!.some((r) => held.includes(r))).toBe(false);
        for (const [a, b] of edges) if (a < b && `n${b}` === id) expect(g.status(`n${a}`)).toBe("succeeded");
        expect(g.start(id).ok).toBe(true);
        running.add(id);
      }
      const next = [...running][0];
      if (next === undefined) break;
      g.complete(next, fails[Number(next.slice(1))] ? "failed" : "succeeded");
      running.delete(next);
    }
    for (let i = 0; i < n; i++) expect(["succeeded", "failed", "skipped"]).toContain(g.status(`n${i}`));
  });
});
