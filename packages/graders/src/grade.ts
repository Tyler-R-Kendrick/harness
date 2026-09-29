import { fromJSONSchema } from "zod";
import { promptfooSuite } from "@harness/adapters";
import type { Case, Score, Trial } from "@harness/ir";
import type { PortResult } from "./promptfoo.ts";
import { matchTrajectory } from "./trajectory.ts";

export interface GradePorts {
  evaluate(suite: ReturnType<typeof promptfooSuite>): Promise<PortResult>;
  judge(rubric: string, output: string): Promise<PortResult>;
  foreign(): Promise<PortResult>;
}

function mark(grader: string, passed: boolean, detail?: string): Score {
  return detail === undefined ? { grader, passed } : { grader, passed, detail };
}

function portMark(grader: string, result: PortResult): Score {
  return result.detail === undefined ? mark(grader, result.passed) : mark(grader, result.passed, result.detail);
}

function jsonSchema(value: object): value is Exclude<Parameters<typeof fromJSONSchema>[0], boolean> {
  return !Array.isArray(value);
}

function compile(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    throw new Error(`invalid pattern ${pattern}`);
  }
}

/**
 * Stop at the first failure. Order: schema, regex, files, tool trajectory,
 * Promptfoo assertions, an openevals judge on a different model, then Harbor or ASSERT.
 */
export async function grade(input: { specCase: Case; trial: Trial; sutModel: string; judgeModel: string }, ports: GradePorts): Promise<{ passed: boolean; scores: Score[] }> {
  const scores: Score[] = [];
  const expect = input.specCase.expect;
  const fail = (score: Score): { passed: boolean; scores: Score[] } => {
    scores.push(score);
    return { passed: false, scores };
  };
  if (expect?.schema !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(input.trial.output);
    } catch {
      return fail(mark("schema", false, "json"));
    }
    if (typeof expect.schema !== "object" || expect.schema === null || !jsonSchema(expect.schema)) throw new Error("schema is not an object");
    const parsed = fromJSONSchema(expect.schema).safeParse(value);
    if (!parsed.success) return fail(mark("schema", false, "schema"));
    scores.push(mark("schema", true));
  }
  if (expect?.regex !== undefined) {
    if (!compile(expect.regex).test(input.trial.output)) return fail(mark("regex", false));
    scores.push(mark("regex", true));
  }
  if (expect?.files !== undefined) {
    const missing = expect.files.find((file) => !input.trial.files.includes(file));
    if (missing !== undefined) return fail(mark("files", false, missing));
    scores.push(mark("files", true));
  }
  if (expect?.tools !== undefined) {
    const matched = await matchTrajectory(expect.toolMatch ?? "strict", expect.tools, input.trial.tools);
    if (!matched) return fail(mark("tools", false));
    scores.push(mark("tools", true));
  }
  const asserts = expect?.promptfoo;
  if (asserts !== undefined && asserts.length > 0) {
    const result = await ports.evaluate(promptfooSuite({ ...input.specCase, instruction: input.trial.output }));
    if (!result.passed) return fail(portMark("promptfoo", result));
    scores.push(portMark("promptfoo", result));
  }
  if (expect?.rubric !== undefined) {
    if (input.judgeModel === input.sutModel) throw new Error("judge model matches the system under test");
    const result = await ports.judge(expect.rubric, input.trial.output);
    if (!result.passed) return fail(portMark("judge", result));
    scores.push(portMark("judge", result));
  }
  if (input.specCase.source === "harbor" || input.specCase.source === "assert") {
    const result = await ports.foreign();
    if (!result.passed) return fail(portMark("foreign", result));
    scores.push(portMark("foreign", result));
  }
  return { passed: true, scores };
}
