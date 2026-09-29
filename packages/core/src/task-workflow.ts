import { TaskGraph } from "./task-graph.ts";
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";

/** Delivery steps for one task, from research through production monitoring and live debugging. */
export const DELIVERY_STEPS = [
  "research",
  "analysis",
  "planning",
  "implementation",
  "verification",
  "production deployment monitoring",
  "live debugging",
] as const;

export type DeliveryStep = (typeof DELIVERY_STEPS)[number];

export type AgentOrigin = "existing" | "generated";

/**
 * An eve subagent assignment. Identity is `path` (`agent/subagents/<id>/agent.ts`).
 * `definition` is `defineAgent` source from `eve` with a model, and no id field.
 */
export interface EveAssignment {
  readonly step: DeliveryStep;
  readonly agentId: string;
  readonly path: string;
  readonly origin: AgentOrigin;
  readonly definition: string;
}

export interface TaskWorkflow {
  readonly taskId: string;
  readonly outcome: string;
  readonly steps: readonly EveAssignment[];
  /** Delivery steps as atomic graph nodes. Later steps wait on the ones they depend on. */
  readonly graph: TaskGraph<EveAssignment>;
}

export interface FinishedStep {
  readonly step: DeliveryStep;
  readonly agentId: string;
  readonly result: string;
}

export interface FinishedWorkflow {
  readonly status: "succeeded";
  readonly taskId: string;
  readonly steps: readonly FinishedStep[];
}

export type WorkflowError = "missing_step" | "contradicted";

/** Source for a generated eve subagent. The playground authors this shape; the path, not an id field, names it. */
export function eveAgentSource(agent: { readonly description: string; readonly model: string }): string {
  return [
    "// Generated eve subagent. Identity is the agent/subagents path, not a field on defineAgent.",
    'import { defineAgent } from "eve";',
    "",
    "export default defineAgent({",
    `  description: ${JSON.stringify(agent.description)},`,
    `  model: ${JSON.stringify(agent.model)},`,
    "});",
    "",
  ].join("\n");
}

/**
 * The researcher subagent, authored before any task asks for it.
 * Not produced by `eveAgentSource`. The file path is its identity.
 */
function existingResearcher(): {
  readonly id: "researcher";
  readonly path: "agent/subagents/researcher/agent.ts";
  readonly model: string;
  readonly definition: string;
} {
  const model = "harness/researcher";
  const definition = [
    "// The researcher subagent, authored before a delivery task assigns it.",
    'import { defineAgent } from "eve";',
    "",
    "export default defineAgent({",
    '  description: "Researches a task before any other delivery step.",',
    `  model: ${JSON.stringify(model)},`,
    "});",
    "",
  ].join("\n");
  return { id: "researcher", path: "agent/subagents/researcher/agent.ts", model, definition };
}

/** Eve subagents that already exist and can be assigned without generating one. */
export function existingEveAgents(): {
  readonly researcher: ReturnType<typeof existingResearcher>;
} {
  return { researcher: existingResearcher() };
}

/** Data edges: monitoring and live debugging both wait on verification, so they can run together. */
function deliveryEdges(): readonly (readonly [DeliveryStep, DeliveryStep])[] {
  return [
    ["research", "analysis"],
    ["analysis", "planning"],
    ["planning", "implementation"],
    ["implementation", "verification"],
    ["verification", "production deployment monitoring"],
    ["verification", "live debugging"],
  ];
}

function agentPath(agentId: string): string {
  return `agent/subagents/${agentId}/agent.ts`;
}

/** The workflow a task starts with: one graph node per delivery stage, each assigned to an eve subagent. */
export function taskWorkflow(task: { readonly id: string; readonly outcome: string; readonly model: string }): TaskWorkflow {
  const steps: EveAssignment[] = DELIVERY_STEPS.map((step) => {
    const existing = step === "research" ? existingEveAgents().researcher : undefined;
    if (existing !== undefined) {
      return { step, agentId: existing.id, path: existing.path, origin: "existing", definition: existing.definition };
    }
    const agentId = `${task.id}--${step.split(" ").join("-")}`;
    return {
      step,
      agentId,
      path: agentPath(agentId),
      origin: "generated",
      definition: eveAgentSource({ description: `${step} for ${task.outcome}`, model: task.model }),
    };
  });
  const graph = new TaskGraph<EveAssignment>();
  for (const step of steps) graph.addNode(step.step, { payload: step });
  for (const [from, to] of deliveryEdges()) graph.addEdge(from, to, "data");
  return { taskId: task.id, outcome: task.outcome, steps, graph };
}

function contradicts(outcome: string, result: string): boolean {
  return result.includes(`not: ${outcome}`);
}

function meets(outcome: string, result: string): boolean {
  return result.includes(outcome) && !contradicts(outcome, result);
}

/**
 * Applies scripted step results to the delivery graph, in ready order.
 * A result that contradicts the outcome fails that node. Verification must state the outcome.
 * The task succeeds only when every delivery node has succeeded.
 */
export function finishTaskWorkflow(
  workflow: TaskWorkflow,
  results: Readonly<Record<string, string>>,
): Result<FinishedWorkflow, WorkflowError> {
  for (const step of workflow.steps) {
    if (results[step.step] === undefined) return err("missing_step", `step ${step.step} has no result`);
  }
  const byStep = new Map<string, EveAssignment>(workflow.steps.map((step) => [step.step, step]));
  const done: FinishedStep[] = [];
  while (done.length < workflow.steps.length) {
    const ready = workflow.graph.ready();
    if (ready.length === 0) return err("contradicted", "delivery stopped before every step succeeded");
    for (const id of ready) {
      const assignment = byStep.get(id);
      if (assignment === undefined) return err("contradicted", `no delivery step ${id}`);
      // Stryker disable next-line all: equivalent; the loop above already rejected a missing result
      const result = results[assignment.step] ?? "";
      const rejected = contradicts(workflow.outcome, result) || (assignment.step === "verification" && !meets(workflow.outcome, result));
      const started = workflow.graph.start(id);
      // Stryker disable next-line all: equivalent; ready() only returns a node start() accepts
      if (!started.ok) return err("contradicted", started.error.message);
      if (rejected) {
        workflow.graph.complete(id, "failed");
        return err("contradicted", `step ${assignment.step} contradicts the outcome`);
      }
      const completed = workflow.graph.complete(id, "succeeded");
      // Stryker disable next-line all: equivalent; complete() accepts the node start() just set running
      if (!completed.ok) return err("contradicted", completed.error.message);
      done.push({ step: assignment.step, agentId: assignment.agentId, result });
    }
  }
  return ok({ status: "succeeded", taskId: workflow.taskId, steps: done });
}
