/**
 * Testing trophy. The roster says which agents apply. One decision pass then
 * keeps the band the work needs: static analysis as the base, a few unit
 * tests, integration as the bulk, a few end-to-end tests, or fuzz and mutation
 * when the pass asks to amplify. A pass that cannot be trusted stays on the
 * integration band. The task-verification workflow runs that pass, then reviews
 * only the selected agents.
 */

import { executeDeclarative } from "./declarative.ts";
import type { DeclarativeCall, DeclarativeWorkflow } from "./declarative.ts";
import { planTesting, reviewTesting } from "./testing-subagents.ts";
import type { TestSubject, TestingAgent, TestingDiscipline, TestingEvidence, TestingReport, TestingRoster, TestingVerdict } from "./testing-subagents.ts";

const BANDS = ["static", "unit", "integration", "e2e", "amplify"] as const;
type TrophyBand = (typeof BANDS)[number];

const MEMBERS: Readonly<Record<TrophyBand, readonly TestingDiscipline[]>> = {
  static: ["crap"],
  unit: ["crap", "atomic"],
  integration: ["crap", "contract", "atomic", "bdd"],
  e2e: ["crap", "contract", "atomic", "evals", "bdd", "ux"],
  amplify: ["fuzz", "mutation", "crap", "contract", "atomic", "bdd"],
};

const DESCRIPTIONS: Readonly<Record<TrophyBand, string>> = {
  static: "Static analysis only, the base of the trophy.",
  unit: "Static analysis and a few unit tests.",
  integration: "Static analysis, a few unit tests, and integration tests.",
  e2e: "The trophy through a few end-to-end tests.",
  amplify: "Integration tests plus fuzzing and mutation.",
};

/** Same fields as the interpreter's decision request. This pass does not import that port. */
export interface TrophyRequest {
  readonly text: string;
  readonly context: string;
  readonly options: readonly { readonly name: string; readonly description: string }[];
}

export interface TaskVerificationReport {
  readonly status: "pass" | "fail" | "halted";
  readonly reason?: string;
  readonly agents: readonly TestingDiscipline[];
  readonly verdicts: readonly TestingVerdict[];
  readonly calls: readonly DeclarativeCall[];
}

/** Select a band, then review it. Delivery's verify roles are not this workflow. */
export const taskVerificationWorkflow: DeclarativeWorkflow = {
  name: "task-verification",
  description: "One decision pass selects a testing-trophy band, then that band reviews the work.",
  inputs: { work: { type: "string", description: "The work being verified." } },
  id: "task-verification",
  actions: [
    {
      kind: "InvokeFunctionTool",
      functionName: "select-tests",
      arguments: { work: "=Workflow.Inputs.work" },
      output: "tests",
    },
    {
      kind: "InvokeFunctionTool",
      functionName: "review-tests",
      arguments: { tests: "=Local.tests" },
    },
    { kind: "EndWorkflow" },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBand(value: string): value is TrophyBand {
  return value === "static" || value === "unit" || value === "integration" || value === "e2e" || value === "amplify";
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

function describeSubject(subject: TestSubject): string {
  const boundaries = subject.boundaries.length === 0 ? "none" : subject.boundaries.map((item) => item.name).join(",");
  return `subject ${subject.name}; boundaries ${boundaries}; ui ${subject.ui}; layout ${subject.layout}`;
}

async function bandOf(
  decide: (request: TrophyRequest) => unknown | Promise<unknown>,
  request: TrophyRequest,
): Promise<TrophyBand> {
  try {
    const answer = await decide(request);
    if (!isRecord(answer)) return "integration";
    const choice = answer["choice"];
    const complicated = answer["complicated"];
    if (typeof choice !== "string" || typeof complicated !== "boolean" || complicated || !isBand(choice)) return "integration";
    if (!scoresAreFinite(answer["probabilities"])) return "integration";
    return choice;
  } catch {
    return "integration";
  }
}

/** The applicable agents in the band one decision pass chose, in roster order. */
export async function selectTrophy(options: {
  readonly roster: TestingRoster;
  readonly subject: TestSubject;
  readonly work: string;
  decide(request: TrophyRequest): unknown | Promise<unknown>;
}): Promise<readonly TestingAgent[]> {
  if (typeof options.work !== "string" || options.work.length === 0) throw new TypeError("work must be a string");
  const planned = planTesting(options.roster, options.subject);
  const request: TrophyRequest = {
    text: options.work,
    context: describeSubject(options.subject),
    options: BANDS.map((name) => ({ name, description: DESCRIPTIONS[name] })),
  };
  const band = await bandOf(options.decide, request);
  const members = new Set<string>(MEMBERS[band]);
  return planned.filter((agent) => members.has(agent.name));
}

function selectedNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    throw new TypeError("tests must be the selected agents");
  }
  return value;
}

/** Run the task-verification workflow. The decision is called once, then only that band is judged. */
export async function runTaskVerification(options: {
  readonly roster: TestingRoster;
  readonly subject: TestSubject;
  readonly evidence: TestingEvidence;
  readonly work: string;
  decide(request: TrophyRequest): unknown | Promise<unknown>;
}): Promise<TaskVerificationReport> {
  let agents: readonly TestingDiscipline[] = [];
  let report: TestingReport | undefined;
  const executed = await executeDeclarative({
    workflow: taskVerificationWorkflow,
    inputs: { work: options.work },
    tools: {
      "select-tests": async (args) => {
        const work = args["work"];
        if (typeof work !== "string") throw new TypeError("work must be a string");
        const chosen = await selectTrophy({ roster: options.roster, subject: options.subject, work, decide: options.decide });
        agents = chosen.map((agent) => agent.name);
        return agents;
      },
      "review-tests": async (args) => {
        report = reviewTesting(options.roster, options.subject, options.evidence, selectedNames(args["tests"]));
        return { status: report.status };
      },
    },
  });
  if (executed.status === "halted") {
    return {
      status: "halted",
      ...(executed.reason === undefined ? {} : { reason: executed.reason }),
      agents,
      verdicts: report === undefined ? [] : report.verdicts,
      calls: executed.calls,
    };
  }
  if (report === undefined) {
    return { status: "halted", reason: "testing review did not run", agents, verdicts: [], calls: executed.calls };
  }
  const failing = report.verdicts.find((verdict) => verdict.status === "fail");
  return {
    status: report.status,
    ...(failing?.reason === undefined ? {} : { reason: failing.reason }),
    agents,
    verdicts: report.verdicts,
    calls: executed.calls,
  };
}
