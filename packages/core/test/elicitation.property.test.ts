import { describe, expect } from "vitest";
import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { TaskGraph } from "@harness/core";

const text = fc.stringMatching(/^[a-z0-9 ]{1,24}$/);

describe("branch-scoped elicitation properties", () => {
  test.prop([text, text, fc.boolean()], { numRuns: 50 })(
    "EL2.1 an unanswered decision stays out of ready, and answering it leaves its sibling alone",
    (question, answer, siblingFinishes) => {
      const graph = new TaskGraph();
      expect(graph.addNode("wait", { decision: question }).ok).toBe(true);
      expect(graph.addNode("free").ok).toBe(true);
      expect(graph.ready()).toEqual(["free"]);
      expect(graph.blocked()).toEqual(["wait"]);
      expect(graph.ready().includes("wait")).toBe(false);

      if (siblingFinishes) {
        expect(graph.start("free").ok).toBe(true);
        expect(graph.complete("free", "succeeded").ok).toBe(true);
      }
      expect(graph.status("wait")).toBe("pending");
      expect(graph.answer("free", answer).ok).toBe(false);
      expect(graph.answer("wait", answer).ok).toBe(true);
      expect(graph.answer("wait", answer).ok).toBe(false);
      expect(graph.blocked()).toEqual([]);
      expect(graph.ready()).toEqual(siblingFinishes ? ["wait"] : ["wait", "free"]);
      expect(graph.status("free")).toBe(siblingFinishes ? "succeeded" : "pending");

      const restored = TaskGraph.fromJSON(graph.toJSON());
      expect(restored.ready()).toEqual(graph.ready());
      expect(restored.blocked()).toEqual(graph.blocked());
      expect(restored.status("free")).toBe(graph.status("free"));
      expect(restored.status("wait")).toBe("pending");
    },
  );
});
