/**
 * Rubber duck, built in. A decision pass asks whether this checkpoint
 * (design, planning, verification, or another) would benefit from a critique.
 * The critique comes from a different model family than the session and does
 * not edit the work. Copilot's rubber duck is the same idea: a second opinion
 * at the checkpoints where a mistake is still cheap, and silence on a small change.
 */

import { executeDeclarative } from "./declarative.ts";
import type { DeclarativeCall, DeclarativeWorkflow } from "./declarative.ts";

const OPTIONS = [
  { name: "consult", description: "This checkpoint would benefit from a rubber-duck critique." },
  { name: "skip", description: "This checkpoint is small enough to continue without a critique." },
] as const;

export interface DuckRequest {
  readonly text: string;
  readonly context: string;
  readonly options: readonly { readonly name: string; readonly description: string }[];
}

export type DuckSeverity = "blocking" | "non-blocking" | "suggestion";

export interface DuckConcern {
  readonly severity: DuckSeverity;
  readonly issue: string;
  readonly impact: string;
  readonly change: string;
}

export interface RubberDuckReport {
  readonly status: "done" | "halted";
  readonly consulted: boolean;
  readonly concerns: readonly DuckConcern[];
  readonly calls: readonly DeclarativeCall[];
  readonly family?: string;
  readonly reason?: string;
}

/** Decide, then critique only when the pass says this checkpoint would benefit. */
export const rubberDuckWorkflow: DeclarativeWorkflow = {
  name: "rubber-duck",
  description: "A decision pass asks whether this checkpoint would benefit from a rubber-duck critique.",
  inputs: {
    work: { type: "string", description: "The work being considered." },
    checkpoint: { type: "string", description: "design, planning, verification, or another checkpoint." },
  },
  id: "rubber-duck",
  actions: [
    {
      kind: "InvokeFunctionTool",
      functionName: "decide-duck",
      arguments: { work: "=Workflow.Inputs.work", checkpoint: "=Workflow.Inputs.checkpoint" },
      output: "consult",
    },
    {
      kind: "If",
      condition: "Local.consult",
      then: [
        {
          kind: "InvokeFunctionTool",
          functionName: "critique",
          arguments: { work: "=Workflow.Inputs.work", checkpoint: "=Workflow.Inputs.checkpoint" },
          output: "critique",
        },
      ],
      else: [],
    },
    { kind: "EndWorkflow" },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a string`);
  return value;
}

function isSeverity(value: string): value is DuckSeverity {
  return value === "blocking" || value === "non-blocking" || value === "suggestion";
}

function scoresAreFinite(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    const score = value[key];
    if (typeof score !== "number" || !Number.isFinite(score)) return false;
  }
  return true;
}

function contrasting(sessionFamily: string, criticFamily: string): boolean {
  return sessionFamily.length > 0 && criticFamily.length > 0 && sessionFamily !== criticFamily;
}

function concernsOf(value: unknown): DuckConcern[] {
  if (!Array.isArray(value)) throw new TypeError("rubber duck concerns must be a list");
  return value.map((item) => {
    if (!isRecord(item)) throw new TypeError("rubber duck concern must be an object");
    const severity = item["severity"];
    const issue = item["issue"];
    const impact = item["impact"];
    const change = item["change"];
    if (typeof severity !== "string" || !isSeverity(severity)) throw new TypeError("rubber duck severity is invalid");
    if (typeof issue !== "string" || issue.length === 0) throw new TypeError("rubber duck issue must be a string");
    if (typeof impact !== "string" || impact.length === 0) throw new TypeError("rubber duck impact must be a string");
    if (typeof change !== "string" || change.length === 0) throw new TypeError("rubber duck change must be a string");
    return { severity, issue, impact, change };
  });
}

/** An untrusted pass consults. An explicit skip does not, whatever its probability. */
async function wantsCritique(
  decide: (request: DuckRequest) => unknown | Promise<unknown>,
  request: DuckRequest,
): Promise<boolean> {
  try {
    const answer = await decide(request);
    if (!isRecord(answer)) return true;
    const choice = answer["choice"];
    const complicated = answer["complicated"];
    if (typeof choice !== "string" || typeof complicated !== "boolean" || complicated) return true;
    if (choice !== "consult" && choice !== "skip") return true;
    if (!scoresAreFinite(answer["probabilities"])) return true;
    return choice === "consult";
  } catch {
    return true;
  }
}

/** Run the rubber-duck workflow. The critique is read-only and uses another model family. */
export async function runRubberDuck(options: {
  readonly work: string;
  readonly checkpoint: string;
  readonly sessionFamily: string;
  readonly criticFamily: string;
  decide(request: DuckRequest): unknown | Promise<unknown>;
  critique(request: { readonly work: string; readonly checkpoint: string }): unknown | Promise<unknown>;
}): Promise<RubberDuckReport> {
  requiredString(options.work, "work");
  requiredString(options.checkpoint, "checkpoint");
  let concerns: DuckConcern[] | undefined;
  const executed = await executeDeclarative({
    workflow: rubberDuckWorkflow,
    inputs: { work: options.work, checkpoint: options.checkpoint },
    tools: {
      "decide-duck": async (args) => {
        const work = requiredString(args["work"], "work");
        const checkpoint = requiredString(args["checkpoint"], "checkpoint");
        const request: DuckRequest = {
          text: work,
          context: `checkpoint ${checkpoint}; session ${options.sessionFamily}`,
          options: OPTIONS,
        };
        const wanted = await wantsCritique(options.decide, request);
        return wanted && contrasting(options.sessionFamily, options.criticFamily);
      },
      critique: async (args) => {
        const produced = await options.critique({
          work: requiredString(args["work"], "work"),
          checkpoint: requiredString(args["checkpoint"], "checkpoint"),
        });
        concerns = concernsOf(produced);
        return concerns;
      },
    },
  });
  if (executed.status === "halted") {
    return {
      status: "halted",
      consulted: false,
      concerns: [],
      calls: executed.calls,
      ...(executed.reason === undefined ? {} : { reason: executed.reason }),
    };
  }
  const consulted = concerns !== undefined;
  return {
    status: "done",
    consulted,
    concerns: concerns ?? [],
    calls: executed.calls,
    ...(consulted ? { family: options.criticFamily } : {}),
  };
}
