import type { Case, Trial } from "@harness/ir";
import type { Agent, AgentContext, Environment } from "./environment.ts";

function base(specCase: Case, ctx: AgentContext, split: "train" | "test"): Pick<Trial, "caseId" | "split" | "index" | "scores"> {
  return { caseId: specCase.id, split, index: ctx.trial, scores: [] };
}

/** Run one case. A Harbor handle fills the trial from the parsed view and does not call the agent. */
export async function executeCase(agent: Agent, env: Environment, specCase: Case, ctx: AgentContext, split: "train" | "test"): Promise<Trial> {
  if (env.kind === "harbor") {
    const trial: Trial = {
      ...base(specCase, ctx, split),
      output: env.view.output,
      tools: env.view.tools,
      files: env.view.files,
      behavior: env.view.behavior,
      passed: env.view.passed,
    };
    if (env.view.failureClass !== undefined) trial.failureClass = env.view.failureClass;
    return trial;
  }
  try {
    await agent.run(specCase.instruction, env, ctx);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      ...base(specCase, ctx, split),
      output: env.turns.join("\n"),
      tools: env.tools,
      files: env.files,
      behavior: "errored",
      failureClass: name.toLowerCase().includes("timeout") ? "timeout" : "harness",
      passed: false,
    };
  }
  const trial: Trial = {
    ...base(specCase, ctx, split),
    output: env.turns.join("\n"),
    tools: env.tools,
    files: env.files,
    behavior: env.behavior,
    passed: env.behavior === "complied",
  };
  if (env.behavior === "refused") trial.failureClass = "refusal";
  return trial;
}
