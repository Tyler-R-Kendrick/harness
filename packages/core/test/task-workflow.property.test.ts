import { describe, expect } from "vitest";
import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { DELIVERY_STEPS, existingEveAgents, eveAgentSource, finishTaskWorkflow, taskWorkflow } from "@harness/core";

const label = fc.stringMatching(/^[a-z0-9][a-z0-9 ]{0,20}$/);

function meeting(outcome: string): Record<string, string> {
  return Object.fromEntries(DELIVERY_STEPS.map((step) => [step, step === "verification" ? `checked: ${outcome}` : `done: ${step}`]));
}

describe("delivery workflow properties", () => {
  test.prop([label, label, label], { numRuns: 40 })(
    "EW2.1 every outcome yields the seven steps, with research authored and the rest generated for that outcome",
    (taskId, outcome, model) => {
      const workflow = taskWorkflow({ id: taskId, outcome, model });
      expect(workflow.steps.map((step) => step.step)).toEqual([...DELIVERY_STEPS]);
      const research = workflow.steps[0];
      expect(research).toEqual({
        step: "research",
        agentId: "researcher",
        path: "agent/subagents/researcher/agent.ts",
        origin: "existing",
        definition: existingEveAgents().researcher.definition,
      });
      expect(research?.definition).not.toBe(eveAgentSource({
        description: "Researches a task before any other delivery step.",
        model: "harness/researcher",
      }));
      for (const step of workflow.steps.slice(1)) {
        expect(step.origin).toBe("generated");
        expect(step.path).toBe(`agent/subagents/${step.agentId}/agent.ts`);
        expect(step.definition).toBe(eveAgentSource({ description: `${step.step} for ${outcome}`, model }));
        expect(step.definition).toContain(`model: ${JSON.stringify(model)}`);
        expect(step.definition).not.toMatch(/\bid\s*:/);
        expect(workflow.graph.payload(step.step)).toEqual(step);
      }
      expect(workflow.graph.ready()).toEqual(["research"]);
    },
  );

  test.prop([label, fc.integer({ min: 0, max: DELIVERY_STEPS.length - 1 })], { numRuns: 40 })(
    "EW2.2 scripted results finish the task only when every step is present and none contradicts the outcome",
    (outcome, index) => {
      const workflow = taskWorkflow({ id: "task", outcome, model: "harness/delivery" });
      const finished = finishTaskWorkflow(workflow, meeting(outcome));
      expect(finished.ok).toBe(true);
      for (const step of DELIVERY_STEPS) expect(workflow.graph.status(step)).toBe("succeeded");

      const missing = taskWorkflow({ id: "task", outcome, model: "harness/delivery" });
      const partial = meeting(outcome);
      delete partial[DELIVERY_STEPS[index] ?? "verification"];
      const refused = finishTaskWorkflow(missing, partial);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("missing_step");
      for (const step of DELIVERY_STEPS) expect(missing.graph.status(step)).toBe("pending");

      const contradicted = taskWorkflow({ id: "task", outcome, model: "harness/delivery" });
      const results = meeting(outcome);
      const step = DELIVERY_STEPS[index] ?? "verification";
      results[step] = `not: ${outcome}`;
      const rejected = finishTaskWorkflow(contradicted, results);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error.code).toBe("contradicted");
      expect(contradicted.graph.status(step)).toBe("failed");
    },
  );
});
