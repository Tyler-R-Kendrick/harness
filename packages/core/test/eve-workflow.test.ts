import { describe, expect, it } from "vitest";
import { existingEveAgents, eveAgentSource, finishTaskWorkflow, taskWorkflow } from "@harness/core";

const OUTCOME = "the release notes name the button";
const MODEL = "harness/delivery";

const DELIVERY = [
  "research",
  "analysis",
  "planning",
  "implementation",
  "verification",
  "production deployment monitoring",
  "live debugging",
] as const;

function meetingResults(): Record<string, string> {
  return Object.fromEntries(
    DELIVERY.map((step) => [step, step === "verification" ? `checked: ${OUTCOME}` : `done: ${step}`]),
  );
}

describe("task delivery workflows", () => {
  it("EW1.1 a task workflow assigns every delivery step to an eve agent and scripted results finish it", async () => {
    const workflow = taskWorkflow({ id: "item-1", outcome: OUTCOME, model: MODEL });
    expect(workflow.steps.map((step) => step.step)).toEqual([...DELIVERY]);

    const existing = workflow.steps.find((step) => step.origin === "existing");
    const generated = workflow.steps.filter((step) => step.origin === "generated");
    const researcher = existingEveAgents().researcher;
    expect(existing?.agentId).toBe("researcher");
    expect(existing?.path).toBe("agent/subagents/researcher/agent.ts");
    expect(existing?.definition).toBe(researcher.definition);
    expect(existing?.definition).toContain('import { defineAgent } from "eve"');
    expect(existing?.definition).toContain("export default defineAgent(");
    expect(existing?.definition).toContain(`model: ${JSON.stringify(researcher.model)}`);
    expect(existing?.definition).not.toMatch(/\bid\s*:/);
    expect(researcher.definition).not.toBe(
      eveAgentSource({
        description: "Researches a task before any other delivery step.",
        model: researcher.model,
      }),
    );
    expect(generated.length).toBe(DELIVERY.length - 1);
    for (const step of generated) {
      expect(step.path).toBe(`agent/subagents/${step.agentId}/agent.ts`);
      expect(step.definition).toBe(eveAgentSource({ description: `${step.step} for ${OUTCOME}`, model: MODEL }));
      expect(step.definition).toContain(`model: ${JSON.stringify(MODEL)}`);
      expect(step.definition).not.toMatch(/\bid\s*:/);
      expect(step.definition).not.toBe(researcher.definition);
      expect(step.definition).not.toBe(step.agentId);
    }
    const verification = workflow.steps.find((step) => step.step === "verification");
    expect(verification?.origin).toBe("generated");
    expect(verification?.definition).toContain(OUTCOME);
    expect(workflow.graph.payload("research")).toEqual(existing);
    expect(workflow.graph.payload("verification")).toEqual(verification);
    expect(workflow.steps.find((step) => step.step === "production deployment monitoring")?.agentId).toBe("item-1--production-deployment-monitoring");
    expect(workflow.steps.find((step) => step.step === "live debugging")?.agentId).toBe("item-1--live-debugging");
    expect(workflow.graph.ready()).toEqual(["research"]);
    expect(workflow.graph.status("analysis")).toBe("pending");
    expect(workflow.graph.toJSON().edges).toEqual(
      expect.arrayContaining([
        { from: "verification", to: "production deployment monitoring", kind: "data" },
        { from: "verification", to: "live debugging", kind: "data" },
      ]),
    );

    let eveImport = "imported";
    try {
      // @ts-expect-error eve is optional here and is not a dependency of this package
      await import("eve");
    } catch (error) {
      eveImport = error instanceof Error ? error.message : String(error);
    }
    console.error(`eve import: ${eveImport}`);

    const finished = finishTaskWorkflow(workflow, meetingResults());
    expect(finished.ok && finished.value.status).toBe("succeeded");
    if (finished.ok) {
      expect(finished.value.taskId).toBe("item-1");
      expect(finished.value.steps.map((step) => step.step)).toEqual([...DELIVERY]);
      expect(finished.value.steps.map((step) => step.result)).toEqual(DELIVERY.map((step) => meetingResults()[step]));
    }
    for (const step of DELIVERY) expect(workflow.graph.status(step)).toBe("succeeded");
  });

  it("EW1.2 a workflow with a missing step result does not finish", () => {
    const workflow = taskWorkflow({ id: "item-1", outcome: OUTCOME, model: MODEL });
    const finished = finishTaskWorkflow(workflow, { research: "done: research" });
    expect(finished.ok).toBe(false);
    if (!finished.ok) expect(finished.error.code).toBe("missing_step");
    expect(workflow.graph.status("research")).toBe("pending");
  });

  it("EW1.3 a step result that contradicts the outcome fails that graph node and does not finish the task", () => {
    const workflow = taskWorkflow({ id: "item-1", outcome: OUTCOME, model: MODEL });
    const results = meetingResults();
    results["verification"] = `not: ${OUTCOME}`;
    const finished = finishTaskWorkflow(workflow, results);
    expect(finished.ok).toBe(false);
    if (!finished.ok) expect(finished.error.code).toBe("contradicted");
    expect(workflow.graph.status("implementation")).toBe("succeeded");
    expect(workflow.graph.status("verification")).toBe("failed");
    expect(workflow.graph.status("production deployment monitoring")).toBe("skipped");
    expect(workflow.graph.status("live debugging")).toBe("skipped");
  });

  it("EW1.4 verification that does not state the outcome does not finish the task", () => {
    const workflow = taskWorkflow({ id: "item-1", outcome: OUTCOME, model: MODEL });
    const results = meetingResults();
    results["verification"] = "done: verification";
    const finished = finishTaskWorkflow(workflow, results);
    expect(finished.ok).toBe(false);
    if (!finished.ok) expect(finished.error.code).toBe("contradicted");
    expect(workflow.graph.status("verification")).toBe("failed");
    expect(workflow.graph.status("live debugging")).toBe("skipped");
  });

  it("EW1.5 a workflow whose graph can no longer progress does not finish", () => {
    const workflow = taskWorkflow({ id: "item-1", outcome: OUTCOME, model: MODEL });
    expect(workflow.graph.start("research").ok).toBe(true);
    expect(workflow.graph.complete("research", "failed").ok).toBe(true);
    const finished = finishTaskWorkflow(workflow, meetingResults());
    expect(finished.ok).toBe(false);
    if (!finished.ok) expect(finished.error.code).toBe("contradicted");
    expect(workflow.graph.status("research")).toBe("failed");
    expect(workflow.graph.status("analysis")).toBe("skipped");
  });

  it("EW1.6 a ready node that is not a delivery step stops the finish", () => {
    const workflow = taskWorkflow({ id: "item-1", outcome: OUTCOME, model: MODEL });
    expect(workflow.graph.addNode("aside").ok).toBe(true);
    const finished = finishTaskWorkflow(workflow, meetingResults());
    expect(finished.ok).toBe(false);
    if (!finished.ok) {
      expect(finished.error.code).toBe("contradicted");
      expect(finished.error.message).toBe("no delivery step aside");
    }
    expect(workflow.graph.status("research")).toBe("succeeded");
    expect(workflow.graph.status("aside")).toBe("pending");
  });
});
